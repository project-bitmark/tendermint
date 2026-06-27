// Send a Bitmark L1 deposit to the reserve, embedding the EVM recipient in an
// OP_RETURN so the peg-watcher mints wBTMK to *that* address (multi-user peg-in).
//   SENDER_PK=<btmk privkey hex> node deposit.js <amount-BTMK> <0xEvmRecipient>
import { ethers } from "ethers";
import * as secp from "@noble/secp256k1";
import { Electrum, scripthashOfAddress } from "./electrum.js";
import { buildSignedTx } from "./btmk-tx.js";
import { opReturnScript, p2pkhAddress } from "./btmk.js";

const RESERVE = process.env.RESERVE_ADDR || "bV7H8TVVfvcstcoftiZ9cJuDYkaG9FSVwG";
const FEE = BigInt(process.env.FEE_SATS || 100000);
const HOST = process.env.ELECTRUM_HOST || "electrum.bitmark.rocks";
const PORT = +(process.env.ELECTRUM_PORT || 50002);
const PK = (process.env.SENDER_PK || "").replace(/^0x/, "");
const [amountStr, evmRecipient] = process.argv.slice(2);

if (!PK || !amountStr || !evmRecipient) {
  console.error("usage: SENDER_PK=<hex> node deposit.js <amount-BTMK> <0xEvmRecipient>");
  process.exit(1);
}
const to = ethers.getAddress(evmRecipient);
const sats = BigInt(Math.round(Number(amountStr) * 1e8));

// derive the sender's (even-Y) Bitmark address for change
const N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
let d = BigInt("0x" + PK);
let pub = Buffer.from(secp.getPublicKey(d, true));
if (pub[0] === 0x03) pub = Buffer.from(secp.getPublicKey(N - d, true));
const sender = p2pkhAddress(pub.toString("hex"));

const e = new Electrum(HOST, PORT);
await e.connect();
await e.request("server.version", ["deposit", "1.4"]);
const utxos = (await e.request("blockchain.scripthash.listunspent", [scripthashOfAddress(sender)]))
  .map((u) => ({ txid: u.tx_hash, vout: u.tx_pos, value: u.value }));
console.log(`sender ${sender} -> reserve ${RESERVE}, ${amountStr} BTMK, recipient ${to}`);

const built = buildSignedTx({
  utxos, privHex: PK,
  outputs: [{ address: RESERVE, value: sats }, { script: opReturnScript(to) }],
  changeAddress: sender, fee: FEE,
});
const txid = await e.request("blockchain.transaction.broadcast", [built.hex]);
console.log("broadcast L1 deposit:", txid);
console.log("the peg-watcher will mint", amountStr, "wBTMK to", to);
e.close();
