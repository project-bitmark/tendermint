// Minimal legacy P2PKH transaction builder + signer for Bitmark (BTMK).
// Standard Bitcoin tx format, SIGHASH_ALL, secp256k1 ECDSA (low-S). Pure JS.
import * as secp from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { hmac } from "@noble/hashes/hmac";
import { decodeBase58Check } from "./electrum.js";
import { hash160 } from "./btmk.js";

// enable sync ECDSA in @noble/secp256k1 v2
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
const dsha256 = (b) => sha256(sha256(b));

// --- serialization helpers ---
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
function varint(n) {
  n = Number(n);
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) return Buffer.concat([Buffer.from([0xfd]), (() => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; })()]);
  if (n <= 0xffffffff) return Buffer.concat([Buffer.from([0xfe]), u32le(n)]);
  return Buffer.concat([Buffer.from([0xff]), u64le(n)]);
}
const pushData = (buf) => Buffer.concat([varint(buf.length), buf]); // ok for <0x4c byte pushes (sig/pubkey)
const revHex = (h) => Buffer.from(h, "hex").reverse();

// DER-encode an ECDSA (r,s) — @noble/secp256k1 v2 exposes bigints, not DER.
function toDER(r, s) {
  const enc = (n) => {
    let h = n.toString(16); if (h.length % 2) h = "0" + h;
    let b = Buffer.from(h, "hex");
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); // pad if high bit set
    return b;
  };
  const R = enc(r), S = enc(s);
  return Buffer.concat([
    Buffer.from([0x30, 2 + R.length + 2 + S.length]),
    Buffer.from([0x02, R.length]), R,
    Buffer.from([0x02, S.length]), S,
  ]);
}

export function p2pkhScriptFromHash160(h160) {
  return Buffer.concat([Buffer.from("76a914", "hex"), h160, Buffer.from("88ac", "hex")]);
}
export function scriptForAddress(addr) {
  const { hash160: h } = decodeBase58Check(addr);
  return p2pkhScriptFromHash160(h);
}

// serialize a tx. inputs:[{txid,vout,scriptSig?}], outputs:[{script,value(sats BigInt)}]
function serialize(inputs, outputs, { version = 1, locktime = 0 } = {}) {
  const parts = [u32le(version), varint(inputs.length)];
  for (const i of inputs) {
    const s = i.scriptSig || Buffer.alloc(0);
    parts.push(revHex(i.txid), u32le(i.vout), varint(s.length), s, u32le(0xffffffff));
  }
  parts.push(varint(outputs.length));
  for (const o of outputs) parts.push(u64le(o.value), varint(o.script.length), o.script);
  parts.push(u32le(locktime));
  return Buffer.concat(parts);
}

// Build + sign. utxos:[{txid,vout,value(sats)}] all paying `reserveScript`.
// outputs:[{address|script, value(sats BigInt)}]. Change (if > dust) -> changeAddress.
const N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");

export function buildSignedTx({ utxos, privHex, outputs, changeAddress, fee = 100000n, dust = 1000n }) {
  // Normalize to the even-Y key: nostr/x-only (BIP340) pubkeys imply even-Y, so the
  // address derived from the x-only key is spent by `d` if its pubkey is even, else `n-d`.
  let d = BigInt("0x" + privHex);
  let pub = Buffer.from(secp.getPublicKey(d, true));
  if (pub[0] === 0x03) { d = N - d; pub = Buffer.from(secp.getPublicKey(d, true)); }
  const priv = Buffer.from(d.toString(16).padStart(64, "0"), "hex");
  const reserveScript = p2pkhScriptFromHash160(hash160(pub));

  const outs = outputs.map((o) => ({ value: BigInt(o.value), script: o.script || scriptForAddress(o.address) }));
  const need = outs.reduce((s, o) => s + o.value, 0n) + BigInt(fee);

  // select utxos
  const ins = [];
  let inSum = 0n;
  for (const u of utxos) {
    ins.push({ txid: u.txid, vout: u.vout });
    inSum += BigInt(u.value);
    if (inSum >= need) break;
  }
  if (inSum < need) throw new Error(`insufficient reserve: have ${inSum} need ${need} sats`);
  const change = inSum - need;
  if (change > dust) outs.push({ value: change, script: scriptForAddress(changeAddress) });

  // sign each input (SIGHASH_ALL, legacy)
  const SIGHASH_ALL = 1;
  for (let i = 0; i < ins.length; i++) {
    const copy = ins.map((x, j) => ({ ...x, scriptSig: j === i ? reserveScript : Buffer.alloc(0) }));
    const preimage = Buffer.concat([serialize(copy, outs), u32le(SIGHASH_ALL)]);
    const z = dsha256(preimage);
    const sig = secp.sign(z, priv); // low-S enforced
    if (!secp.verify(sig, z, pub)) throw new Error("self-verify failed");
    const der = Buffer.concat([toDER(sig.r, sig.s), Buffer.from([SIGHASH_ALL])]);
    ins[i].scriptSig = Buffer.concat([pushData(der), pushData(pub)]);
  }

  const raw = serialize(ins, outs);
  return { hex: raw.toString("hex"), txid: Buffer.from(dsha256(raw)).reverse().toString("hex"), change, fee: BigInt(fee), outputs: outs };
}
