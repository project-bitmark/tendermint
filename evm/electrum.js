// Minimal ElectrumX client (TLS, protocol 1.4) — just what the peg watcher needs.
// No deps: newline-delimited JSON-RPC over a tls socket, plus address->scripthash.
import tls from "node:tls";
import { createHash } from "node:crypto";

const sha256 = (b) => createHash("sha256").update(b).digest();

// --- address / scripthash helpers (Bitmark = standard Bitcoin P2PKH/P2SH) ---
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function decodeBase58Check(addr) {
  let num = 0n;
  for (const ch of addr) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error(`bad base58 char: ${ch}`);
    num = num * 58n + BigInt(v);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  let bytes = Buffer.from(hex, "hex");
  // restore leading zero bytes (each leading '1' == 0x00)
  let pad = 0;
  for (const ch of addr) { if (ch === "1") pad++; else break; }
  bytes = Buffer.concat([Buffer.alloc(pad), bytes]);
  const payload = bytes.subarray(0, -4);
  const check = bytes.subarray(-4);
  const exp = sha256(sha256(payload)).subarray(0, 4);
  if (!check.equals(exp)) throw new Error("bad base58check checksum");
  return { version: payload[0], hash160: payload.subarray(1) };
}

// scriptPubKey for a P2PKH hash160 (Buffer or hex)
export function p2pkhScript(hash160) {
  const h = Buffer.isBuffer(hash160) ? hash160 : Buffer.from(hash160, "hex");
  return Buffer.concat([Buffer.from("76a914", "hex"), h, Buffer.from("88ac", "hex")]);
}

// Electrum scripthash = sha256(scriptPubKey), byte-reversed, hex
export function scripthashOfScript(script) {
  return Buffer.from(sha256(script)).reverse().toString("hex");
}
export function scripthashOfHash160(hash160) {
  return scripthashOfScript(p2pkhScript(hash160));
}
export function scripthashOfAddress(addr) {
  const { hash160 } = decodeBase58Check(addr);
  return scripthashOfScript(p2pkhScript(hash160));
}

// --- the client ---
export class Electrum {
  constructor(host, port, { rejectUnauthorized = false } = {}) {
    this.host = host;
    this.port = port;
    this.rejectUnauthorized = rejectUnauthorized;
    this.sock = null;
    this.buf = "";
    this.id = 0;
    this.pending = new Map();
    this.subs = new Map(); // method -> handler(params)
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.sock = tls.connect(
        { host: this.host, port: this.port, rejectUnauthorized: this.rejectUnauthorized },
        () => resolve(),
      );
      this.sock.setEncoding("utf8");
      this.sock.on("data", (d) => this._onData(d));
      this.sock.on("error", (e) => {
        reject(e);
        for (const { reject: rj } of this.pending.values()) rj(e);
        this.pending.clear();
      });
    });
  }
  _onData(d) {
    this.buf += d;
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method && this.subs.has(msg.method)) {
        this.subs.get(msg.method)(msg.params);
      }
    }
  }
  request(method, params = []) {
    const id = this.id++;
    const payload = JSON.stringify({ id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sock.write(payload);
    });
  }
  on(method, handler) { this.subs.set(method, handler); }
  close() { if (this.sock) this.sock.end(); }
}
