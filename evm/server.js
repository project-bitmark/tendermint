// Bridge UI server — zero client build.
// Serves the static ../ui directory and a live /bridge-state.jsonld document
// aggregating the EVM sidechain, the Bitmark L1 reserve (via ElectrumX), and the
// did:nostr identity. Same-origin, so the browser fetches JSON-LD without CORS.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";
import { ethers } from "ethers";
import { Electrum, scripthashOfAddress } from "./electrum.js";
import { buildSignedTx } from "./btmk-tx.js";
import { opReturnScript, p2pkhAddress } from "./btmk.js";
import * as secp from "@noble/secp256k1";

const __dir = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dir, "..", "ui");
const DID_PATH = join(__dir, "..", "agent.did.json");

const PORT = +(process.env.UI_PORT || 8080);
const RPC = process.env.RPC || "http://localhost:8545";
const WBTMK = process.env.WBTMK || "0x816644F8bc4633D268842628EB10ffC0AdcB6099";
const RESERVE = process.env.RESERVE_ADDR || "bV7H8TVVfvcstcoftiZ9cJuDYkaG9FSVwG";
const RECIPIENT = process.env.USER_ADDR || "0xC6Fe5D33615a1C52c08018c47E8Bc53646A0E101";
const EHOST = process.env.ELECTRUM_HOST || "electrum.bitmark.rocks";
const EPORT = +(process.env.ELECTRUM_PORT || 50002);

const ABI = [
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function owner() view returns (address)",
  "event PegMint(address indexed to, uint256 value, string btmkTxid)",
  "event PegBurn(address indexed from, uint256 value, string btmkAddress)",
];

const MARKING = process.env.MARKING || "0x0F5575BC344f6F0b595A7B3a0bDEdE9a90859c6f";
const MARK_ABI = ["event Marked(address indexed from, address indexed to, uint256 amount, string identity, string reason, uint256 index)"];

const FAUCET_PK = process.env.FAUCET_PK || "0xE9B1D63E8ACD7FE676ACB43AFB390D4B0202DAB61ABEC9CF2A561E4BECB147DE";

const provider = new ethers.JsonRpcProvider(RPC);
const wbtmk = new ethers.Contract(WBTMK, ABI, provider);
const marking = new ethers.Contract(MARKING, MARK_ABI, provider);
const faucet = new ethers.Wallet(FAUCET_PK, provider);
const faucetToken = new ethers.Contract(WBTMK, ["function pegMint(address,uint256,string)", "function balanceOf(address) view returns (uint256)"], faucet);

const readBody = (req) => new Promise((resolve, reject) => {
  let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => resolve(d)); req.on("error", reject);
});

// demo depositor: a funded Bitmark L1 key used by /deposit to send a real
// deposit (to the reserve, recipient EVM addr in OP_RETURN). PoC convenience.
const DEPOSITOR_PK = (process.env.DEPOSITOR_PK || "").replace(/^0x/, "");
const SECP_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
async function simulateDeposit(toAddr, amountBTMK) {
  const to = ethers.getAddress(toAddr);
  const sats = BigInt(Math.round(Number(amountBTMK) * 1e8));
  let d = BigInt("0x" + DEPOSITOR_PK);
  let pub = Buffer.from(secp.getPublicKey(d, true));
  if (pub[0] === 0x03) pub = Buffer.from(secp.getPublicKey(SECP_N - d, true));
  const sender = p2pkhAddress(pub.toString("hex"));
  const e = await elec();
  const utxos = (await e.request("blockchain.scripthash.listunspent", [scripthashOfAddress(sender)]))
    .map((u) => ({ txid: u.tx_hash, vout: u.tx_pos, value: u.value }));
  const built = buildSignedTx({
    utxos, privHex: DEPOSITOR_PK,
    outputs: [{ address: RESERVE, value: sats }, { script: opReturnScript(to) }],
    changeAddress: sender, fee: 100000n,
  });
  const txid = await e.request("blockchain.transaction.broadcast", [built.hex]);
  return { txid, sender, to, amountBTMK };
}

// reuse one Electrum connection; reconnect on demand
let electrum = null;
async function elec() {
  if (electrum?.sock && !electrum.sock.destroyed) return electrum;
  electrum = new Electrum(EHOST, EPORT);
  await electrum.connect();
  await electrum.request("server.version", ["bridge-ui", "1.4"]);
  return electrum;
}

async function reserveBTMK() {
  try {
    const e = await elec();
    const sh = scripthashOfAddress(RESERVE);
    const b = await e.request("blockchain.scripthash.get_balance", [sh]);
    const tip = (await e.request("blockchain.headers.subscribe")).height;
    return { balanceBTMK: (b.confirmed + b.unconfirmed) / 1e8, confirmed: b.confirmed / 1e8, pending: b.unconfirmed / 1e8, tip };
  } catch (err) {
    electrum = null;
    return { balanceBTMK: null, error: String(err.message || err) };
  }
}

async function bridgeState() {
  const [net, height, sym, supply, recipBal, did, reserve] = await Promise.all([
    provider.getNetwork(),
    provider.getBlockNumber(),
    wbtmk.symbol().catch(() => "wBTMK"),
    wbtmk.totalSupply().catch(() => 0n),
    wbtmk.balanceOf(RECIPIENT).catch(() => 0n),
    readFile(DID_PATH, "utf8").then(JSON.parse).catch(() => null),
    reserveBTMK(),
  ]);
  const [mints, burns] = await Promise.all([
    wbtmk.queryFilter(wbtmk.filters.PegMint(), 0, "latest").catch(() => []),
    wbtmk.queryFilter(wbtmk.filters.PegBurn(), 0, "latest").catch(() => []),
  ]);
  let redeem = {};
  try { redeem = JSON.parse(await readFile(join(__dir, "redeem-state.json"), "utf8")); } catch {}
  const activity = [
    ...mints.filter((e) => e.args.btmkTxid !== "faucet").map((e) => ({
      "@type": "PegIn", direction: "in",
      amount: ethers.formatEther(e.args.value),
      party: e.args.to, l1Txid: e.args.btmkTxid, l1Address: RESERVE,
      evmBlock: e.blockNumber, evmTx: e.transactionHash,
    })),
    ...burns.map((e) => ({
      "@type": "PegOut", direction: "out",
      amount: ethers.formatEther(e.args.value),
      party: e.args.from, l1Txid: redeem[e.transactionHash]?.l1Txid || null, l1Address: e.args.btmkAddress,
      evmBlock: e.blockNumber, evmTx: e.transactionHash,
    })),
  ].sort((a, b) => b.evmBlock - a.evmBlock);

  // marks (the gifting contract)
  const markEvs = await marking.queryFilter(marking.filters.Marked(), 0, "latest").catch(() => []);
  const recentMarks = markEvs.map((e) => ({
    "@type": "Mark", from: e.args.from, to: e.args.to,
    amount: ethers.formatEther(e.args.amount), identity: e.args.identity, reason: e.args.reason,
    evmBlock: e.blockNumber,
  })).reverse();
  const totals = {};
  for (const e of markEvs) totals[e.args.to] = (totals[e.args.to] || 0n) + e.args.amount;
  const leaderboard = Object.entries(totals)
    .map(([address, total]) => ({ address, total: ethers.formatEther(total) }))
    .sort((a, b) => Number(b.total) - Number(a.total));

  const consKey = did?.service?.[0]?.serviceEndpoint?.consensusPubkeyHex || null;
  const attested = !!did?.service?.[0]?.serviceEndpoint?.attestation;

  return {
    "@context": ["https://www.w3.org/ns/did/v1", { btmk: "https://project-bitmark.github.io/#" }],
    "@type": "BridgeState",
    generatedAt: new Date().toISOString(),
    identity: { did: did?.id || null, validatorConsensusKeyHex: consKey, attested },
    sidechain: {
      chainId: Number(net.chainId),
      height,
      token: { symbol: sym, address: WBTMK, totalSupply: ethers.formatEther(supply) },
      recipient: { address: RECIPIENT, balance: ethers.formatEther(recipBal) },
    },
    l1: { network: "Bitmark", reserveAddress: RESERVE, ...reserve },
    activity,
    marks: { contract: MARKING, total: markEvs.length, recent: recentMarks, leaderboard },
  };
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/bridge-state.jsonld") {
      const body = JSON.stringify(await bridgeState(), null, 2);
      res.writeHead(200, { "content-type": "application/ld+json", "cache-control": "no-store" });
      return res.end(body);
    }
    // same-origin JSON-RPC proxy (lets the browser sign+send without CORS)
    if (url.pathname === "/rpc" && req.method === "POST") {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: await readBody(req) });
      res.writeHead(r.status, { "content-type": "application/json" });
      return res.end(await r.text());
    }
    // faucet: drip native gas + a little wBTMK to a fresh (nostr-derived) address
    if (url.pathname === "/faucet" && req.method === "POST") {
      const { address } = JSON.parse((await readBody(req)) || "{}");
      if (!ethers.isAddress(address)) { res.writeHead(400); return res.end(JSON.stringify({ error: "bad address" })); }
      const out = { address, funded: {} };
      if ((await provider.getBalance(address)) < ethers.parseEther("0.05")) {
        const t = await faucet.sendTransaction({ to: address, value: ethers.parseEther("0.5") }); await t.wait(1); out.funded.gas = t.hash;
      }
      if ((await faucetToken.balanceOf(address)) < ethers.parseEther("0.5")) {
        const t = await faucetToken.pegMint(address, ethers.parseEther("1"), "faucet"); await t.wait(1); out.funded.wbtmk = t.hash;
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(out));
    }
    // simulate a real L1 deposit to the reserve, recipient = caller's EVM address
    if (url.pathname === "/deposit" && req.method === "POST") {
      const { address, amount } = JSON.parse((await readBody(req)) || "{}");
      if (!ethers.isAddress(address)) { res.writeHead(400); return res.end(JSON.stringify({ error: "bad address" })); }
      if (!DEPOSITOR_PK) { res.writeHead(501); return res.end(JSON.stringify({ error: "no demo depositor configured (set DEPOSITOR_PK)" })); }
      try {
        const r = await simulateDeposit(address, amount || "0.05");
        res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(r));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: String(err.message || err) }));
      }
    }
    // static files from ui/
    let p = url.pathname === "/" ? "/index.html" : url.pathname;
    p = normalize(p).replace(/^(\.\.[/\\])+/, "");
    const full = join(UI_DIR, p);
    if (!full.startsWith(UI_DIR)) { res.writeHead(403); return res.end("forbidden"); }
    const data = await readFile(full);
    res.writeHead(200, { "content-type": TYPES[extname(full)] || "application/octet-stream" });
    res.end(data);
  } catch (err) {
    res.writeHead(err.code === "ENOENT" ? 404 : 500, { "content-type": "text/plain" });
    res.end(err.code === "ENOENT" ? "not found" : "error: " + err.message);
  }
});

server.listen(PORT, () => console.log(`bridge UI on http://localhost:${PORT}  (state: /bridge-state.jsonld)`));
