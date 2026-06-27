// Bitmark peg-in watcher.
// Watches a reserve address on Bitmark L1 (via ElectrumX) and, for each new
// confirmed deposit, mints wBTMK to a recipient on the EVM sidechain by calling
// wBTMK.pegMint(recipient, amount, btmkTxid). First slice: every deposit credits
// one fixed demo recipient (USER_ADDR). Idempotent via a processed-txid file.
//
//   ELECTRUM_HOST   default electrum.bitmark.rocks
//   ELECTRUM_PORT   default 50002 (TLS)
//   RESERVE_ADDR    Bitmark address to watch (required)
//   USER_ADDR       EVM recipient credited for deposits (required)
//   WBTMK           deployed wBTMK address (required)
//   RPC             default http://localhost:8545
//   PEG_OPERATOR_PK wBTMK owner key (default = evmos local test deployer key)
//   MIN_CONF        confirmations required (default 1)
//   STATE           processed-txids file (default ./peg-state.json)
import { ethers } from "ethers";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Electrum, scripthashOfAddress } from "./electrum.js";

const HOST = process.env.ELECTRUM_HOST || "electrum.bitmark.rocks";
const PORT = +(process.env.ELECTRUM_PORT || 50002);
const RESERVE = process.env.RESERVE_ADDR;
const USER = process.env.USER_ADDR;
const RPC = process.env.RPC || "http://localhost:8545";
const WBTMK = process.env.WBTMK;
const PK = process.env.PEG_OPERATOR_PK ||
  "0xE9B1D63E8ACD7FE676ACB43AFB390D4B0202DAB61ABEC9CF2A561E4BECB147DE";
const MIN_CONF = +(process.env.MIN_CONF || 1);
const STATE = process.env.STATE || "./peg-state.json";
const SATS_TO_WEI = 10_000_000_000n; // BTMK 8dp -> wBTMK 18dp

const ABI = [
  "function pegMint(address to, uint256 value, string btmkTxid)",
  "function balanceOf(address) view returns (uint256)",
  "function owner() view returns (address)",
];

if (!RESERVE || !USER || !WBTMK) {
  console.error("required env: RESERVE_ADDR, USER_ADDR, WBTMK");
  process.exit(1);
}

const seen = new Set(existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : []);
const persist = () => writeFileSync(STATE, JSON.stringify([...seen], null, 2));

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PK, provider);
const wbtmk = new ethers.Contract(WBTMK, ABI, wallet);

// sum the value (sats) paid to RESERVE across a verbose tx's outputs
function depositSats(tx) {
  let sats = 0n;
  for (const o of tx.vout || []) {
    const spk = o.scriptPubKey || {};
    const addrs = spk.addresses || (spk.address ? [spk.address] : []);
    if (addrs.includes(RESERVE)) sats += BigInt(Math.round(Number(o.value) * 1e8));
  }
  return sats;
}

// read a recipient EVM address from an OP_RETURN output (6a14<20 bytes>), if present
function opReturnRecipient(tx) {
  for (const o of tx.vout || []) {
    const hex = (o.scriptPubKey?.hex || "").toLowerCase();
    if (!hex.startsWith("6a")) continue;
    const op = parseInt(hex.slice(2, 4), 16);
    if (op >= 0x4c) continue; // skip OP_PUSHDATA1+ for simplicity
    const data = hex.slice(4, 4 + op * 2);
    if (/^[0-9a-f]{40}$/.test(data)) return ethers.getAddress("0x" + data); // 20-byte address
  }
  return null;
}

// true if any input is spent from the reserve itself (i.e. this is our own
// peg-out change returning, not a real inbound deposit)
async function isOwnChange(tx, e) {
  for (const vin of tx.vin || []) {
    if (!vin.txid) continue;
    try {
      const p = await e.request("blockchain.transaction.get", [vin.txid, true]);
      const o = (p.vout || [])[vin.vout];
      const addrs = o?.scriptPubKey?.addresses || (o?.scriptPubKey?.address ? [o.scriptPubKey.address] : []);
      if (addrs.includes(RESERVE)) return true;
    } catch {}
  }
  return false;
}

async function main() {
  console.log(`peg-watcher: ${RESERVE} (Bitmark) -> wBTMK ${WBTMK}`);
  console.log(`operator ${wallet.address}, recipient ${USER}, min_conf ${MIN_CONF}`);
  const e = new Electrum(HOST, PORT);
  await e.connect();
  await e.request("server.version", ["pegwatcher", "1.4"]);
  let tip = (await e.request("blockchain.headers.subscribe")).height;
  e.on("blockchain.headers.subscribe", (p) => { if (p?.[0]?.height) tip = p[0].height; });
  const sh = scripthashOfAddress(RESERVE);
  console.log(`watching scripthash ${sh}, tip ${tip}`);

  async function scan(reason) {
    const hist = await e.request("blockchain.scripthash.get_history", [sh]);
    for (const { tx_hash, height } of hist) {
      if (seen.has(tx_hash)) continue;
      const conf = height > 0 ? tip - height + 1 : 0;
      if (conf < MIN_CONF) continue;
      const tx = await e.request("blockchain.transaction.get", [tx_hash, true]);
      const sats = depositSats(tx);
      if (sats <= 0n) { seen.add(tx_hash); continue; } // not an inbound deposit
      if (await isOwnChange(tx, e)) { seen.add(tx_hash); continue; } // our own peg-out change
      const amount = sats * SATS_TO_WEI;
      const recipient = opReturnRecipient(tx) || USER; // OP_RETURN-encoded EVM addr, else default
      const via = opReturnRecipient(tx) ? "OP_RETURN" : "default";
      console.log(`\n[deposit] ${tx_hash} conf=${conf} ${Number(sats) / 1e8} BTMK -> mint ${ethers.formatEther(amount)} wBTMK to ${recipient} (${via})`);
      try {
        const txr = await (await wbtmk.pegMint(recipient, amount, tx_hash)).wait(1);
        seen.add(tx_hash); persist();
        console.log(`  minted in block #${txr.blockNumber} (final). recipient wBTMK: ${ethers.formatEther(await wbtmk.balanceOf(recipient))}`);
      } catch (err) {
        console.error(`  pegMint failed: ${err.shortMessage || err.message}`);
      }
    }
  }

  await scan("startup");
  await e.request("blockchain.scripthash.subscribe", [sh]);
  e.on("blockchain.scripthash.subscribe", () => scan("subscribe").catch(console.error));
  console.log("watching for deposits... (Ctrl-C to stop)");
}

main().catch((e) => { console.error(e); process.exit(1); });
