// Bitmark (BTMK) address helpers — legacy base58check P2PKH, version byte 0x55.
import { createHash } from "node:crypto";

const sha256 = (b) => createHash("sha256").update(b).digest();
export const hash160 = (b) => createHash("ripemd160").update(sha256(b)).digest();

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function encodeBase58(buf) {
  let num = buf.length ? BigInt("0x" + buf.toString("hex")) : 0n;
  let out = "";
  while (num > 0n) { out = B58[Number(num % 58n)] + out; num /= 58n; }
  for (const b of buf) { if (b === 0) out = "1" + out; else break; }
  return out;
}
export function encodeBase58Check(version, payload) {
  const v = Buffer.concat([Buffer.from([version]), payload]);
  const chk = sha256(sha256(v)).subarray(0, 4);
  return encodeBase58(Buffer.concat([v, chk]));
}
// Bitmark P2PKH address from a (compressed) secp256k1 public key hex.
export const BTMK_P2PKH_VERSION = 0x55;
export function p2pkhAddress(pubkeyHex, version = BTMK_P2PKH_VERSION) {
  return encodeBase58Check(version, hash160(Buffer.from(pubkeyHex, "hex")));
}

// OP_RETURN output script carrying up to 75 bytes (e.g. a 20-byte EVM address).
export function opReturnScript(data) {
  const d = Buffer.isBuffer(data) ? data : Buffer.from(String(data).replace(/^0x/, ""), "hex");
  if (d.length > 75) throw new Error("opReturn data too long");
  return Buffer.concat([Buffer.from([0x6a, d.length]), d]);
}

