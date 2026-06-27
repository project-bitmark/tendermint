// Publish each Mark to a Solid pod (JSS) as a dereferenceable JSON-LD resource,
// authenticated with NIP-98 signed by the did:nostr agent key (git config).
// The gifting graph becomes linked data anyone can GET, fork, or query.
//
//   POD_BASE       Solid pod base URL (default http://localhost:4000)
//   POD_CONTAINER  container path (default /bitmark/marks/)
//   UI_URL         bridge-state source (default http://localhost:8080)
//   NOSTR_SK       agent secret hex (default: git config nostr.privkey)
//   STATE          published-ids file (default ./pod-published.json)
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const POD_BASE = (process.env.POD_BASE || "http://localhost:4000").replace(/\/$/, "");
const CONTAINER = process.env.POD_CONTAINER || "/bitmark/marks/";
const UI_URL = (process.env.UI_URL || "http://localhost:8080").replace(/\/$/, "");
const STATE = process.env.STATE || "./pod-published.json";
const SK = (process.env.NOSTR_SK ||
  execSync("git -C " + import.meta.dirname + "/.. config nostr.privkey").toString().trim()).replace(/^0x/, "");

const toHex = (b) => Buffer.from(b).toString("hex");
const AGENT = toHex(schnorr.getPublicKey(SK)); // x-only pubkey == did:nostr subject

// NIP-98: a kind-27235 event over (url, method), schnorr-signed, base64.
function nip98(url, method) {
  const pubkey = AGENT, created_at = Math.floor(Date.now() / 1000), kind = 27235;
  const tags = [["u", url], ["method", method.toUpperCase()]], content = "";
  const id = toHex(sha256(new TextEncoder().encode(JSON.stringify([0, pubkey, created_at, kind, tags, content]))));
  const sig = toHex(schnorr.sign(id, SK));
  return Buffer.from(JSON.stringify({ id, pubkey, created_at, kind, tags, content, sig })).toString("base64");
}

const seen = new Set(existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : []);
const persist = () => writeFileSync(STATE, JSON.stringify([...seen], null, 2));
const slugOf = (atId) => String(atId).replace(/^urn:mark:/, "").replace(/[^0-9a-zA-Z]+/g, "_");

function resource(url, m) {
  return {
    "@context": { "@vocab": "https://project-bitmark.github.io/ns#", by: { "@type": "@id" }, to: { "@type": "@id" } },
    "@id": url,
    "@type": "Mark",
    by: m.byDid || null,
    to: m.toDid || null,
    fromAddress: m.from,
    toAddress: m.to,
    amount: m.amount,
    unit: "wBTMK",
    reason: m.reason || "",
    evmTx: m.evmTx,
    evmBlock: m.evmBlock,
    chainId: 9000,
  };
}

async function publish(m) {
  const url = `${POD_BASE}${CONTAINER}${slugOf(m["@id"])}.jsonld`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Authorization": `Nostr ${nip98(url, "PUT")}`, "Content-Type": "application/ld+json" },
    body: JSON.stringify(resource(url, m), null, 2),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
  return url;
}

async function poll() {
  let marks = [];
  try { marks = (await (await fetch(`${UI_URL}/bridge-state.jsonld`)).json()).marks?.recent || []; }
  catch (e) { return; }
  for (const m of marks) {
    if (!m["@id"] || seen.has(m["@id"])) continue;
    try {
      const url = await publish(m);
      seen.add(m["@id"]); persist();
      console.log(`published ${m["@id"]} -> ${url}`);
    } catch (e) { console.error(`publish failed for ${m["@id"]}: ${e.message}`); }
  }
}

console.log(`pod-publisher: agent did:nostr:${AGENT.slice(0, 12)}… -> ${POD_BASE}${CONTAINER}`);
await poll();
setInterval(() => poll().catch(() => {}), 5000);
console.log("watching for new marks to publish…");
