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
];

const provider = new ethers.JsonRpcProvider(RPC);
const wbtmk = new ethers.Contract(WBTMK, ABI, provider);

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
  const evs = await wbtmk.queryFilter(wbtmk.filters.PegMint(), 0, "latest").catch(() => []);
  const deposits = evs.map((e) => ({
    "@type": "PegMint",
    btmkTxid: e.args.btmkTxid,
    amount: ethers.formatEther(e.args.value),
    recipient: e.args.to,
    evmBlock: e.blockNumber,
    evmTx: e.transactionHash,
  })).reverse();

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
    deposits,
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
