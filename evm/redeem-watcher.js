// Bitmark peg-out watcher.
// Watches wBTMK PegBurn events on the EVM sidechain and, for each new burn,
// releases the corresponding BTMK from the reserve back to the burner's L1
// address by building + broadcasting a real Bitmark transaction (btmk-tx.js)
// via ElectrumX. Idempotent via redeem-state.json.
//
//   RPC, WBTMK, RESERVE_ADDR     as elsewhere
//   RESERVE_PK   reserve private key hex (default: git config nostr.privkey)
//   FEE_SATS     L1 fee (default 100000 = 0.001 BTMK)
//   STATE        processed-burns file (default ./redeem-state.json)
import { ethers } from "ethers";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { Electrum, scripthashOfAddress } from "./electrum.js";
import { buildSignedTx } from "./btmk-tx.js";
import { RPC, WBTMK, RESERVE } from "./config.js";

const FEE = BigInt(process.env.FEE_SATS || 100000);
const STATE = process.env.STATE || "./redeem-state.json";
const EHOST = process.env.ELECTRUM_HOST || "electrum.bitmark.rocks";
const EPORT = +(process.env.ELECTRUM_PORT || 50002);
const WEI_PER_SAT = 10_000_000_000n; // wBTMK 18dp -> BTMK 8dp

const RESERVE_PK = (process.env.RESERVE_PK ||
  execSync("git -C " + import.meta.dirname + "/.. config nostr.privkey").toString().trim());

const ABI = ["event PegBurn(address indexed from, uint256 value, string btmkAddress)"];
const provider = new ethers.JsonRpcProvider(RPC);
const wbtmk = new ethers.Contract(WBTMK, ABI, provider);

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const persist = () => writeFileSync(STATE, JSON.stringify(state, null, 2));

let electrum = null;
async function elec() {
  if (electrum?.sock && !electrum.sock.destroyed) return electrum;
  electrum = new Electrum(EHOST, EPORT);
  await electrum.connect();
  await electrum.request("server.version", ["redeem", "1.4"]);
  return electrum;
}

async function releaseToL1(dest, sats) {
  const e = await elec();
  const sh = scripthashOfAddress(RESERVE);
  const utxos = (await e.request("blockchain.scripthash.listunspent", [sh]))
    .map((u) => ({ txid: u.tx_hash, vout: u.tx_pos, value: u.value }));
  const built = buildSignedTx({ utxos, privHex: RESERVE_PK, outputs: [{ address: dest, value: sats }], changeAddress: RESERVE, fee: FEE });
  const txid = await e.request("blockchain.transaction.broadcast", [built.hex]);
  return { txid, change: built.change };
}

async function poll() {
  const evs = await wbtmk.queryFilter(wbtmk.filters.PegBurn(), 0, "latest").catch(() => []);
  for (const ev of evs) {
    if (state[ev.transactionHash]) continue;
    const sats = BigInt(ev.args.value) / WEI_PER_SAT;
    const dest = ev.args.btmkAddress;
    console.log(`\n[burn] ${ev.transactionHash} -> release ${Number(sats) / 1e8} BTMK to ${dest}`);
    try {
      const { txid, change } = await releaseToL1(dest, sats);
      state[ev.transactionHash] = { l1Txid: txid, dest, sats: sats.toString(), amount: ethers.formatEther(ev.args.value), evmBlock: ev.blockNumber };
      persist();
      console.log(`  released on Bitmark L1: ${txid} (reserve change ${Number(change) / 1e8} BTMK)`);
    } catch (err) {
      console.error(`  release failed: ${err.message}`);
    }
  }
}

console.log(`redeem-watcher: wBTMK PegBurn -> release BTMK from ${RESERVE}`);
await poll();
setInterval(() => poll().catch(console.error), 4000);
console.log("watching for burns... (Ctrl-C to stop)");
