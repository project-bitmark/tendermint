// Bridge UI — one small ESM island controller, no build.
// Polls /bridge-state.jsonld, hydrates [data-bind] islands, and (when a nostr
// identity is connected via xlogin) lets you give a Mark, signed by the same key.
import { ethers } from "https://esm.sh/ethers@6.13.4";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const get = (obj, path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
const short = (s, n = 8) => (s && s.length > 2 * n ? `${s.slice(0, n)}…${s.slice(-6)}` : s);
const fmtAmount = (v) => {
  const n = Number(v);
  if (!isFinite(n)) return String(v ?? "—");
  return n.toLocaleString(undefined, { maximumFractionDigits: 8 });
};
// best-effort explorer link for a Bitmark txid
const txUrl = (txid) => `https://bitmark.rocks/tx/${txid}`;

function hydrate(state) {
  for (const el of $$("[data-bind]")) {
    const v = get(state, el.dataset.bind);
    el.textContent = v == null ? "—" : el.dataset.fmt === "amount" ? fmtAmount(v) : v;
  }
  const att = $("[data-attested]");
  if (att) att.hidden = !get(state, "identity.attested");
}

const isTxid = (s) => /^[0-9a-f]{64}$/i.test(s || "");

function renderFeed(activity = []) {
  const tbody = $("[data-feed]");
  $("[data-count]").textContent = activity.length;
  tbody.innerHTML = "";
  if (!activity.length) {
    tbody.innerHTML = `<tr class="empty"><td colspan="5">no activity yet — send BTMK to the reserve address</td></tr>`;
    return;
  }
  const tpl = $("#row");
  for (const a of activity) {
    const row = tpl.content.cloneNode(true);
    const flow = $(".flow", row);
    flow.textContent = a.direction === "in" ? "peg-in ↓" : "peg-out ↑";
    flow.className = "flow " + a.direction;
    $(".amt b", row).textContent = fmtAmount(a.amount);
    $(".party", row).textContent = short(a.party);
    // L1 txid: link only when it's a real 64-hex txid (skip demo stubs / pending)
    const l1 = $(".l1", row);
    if (isTxid(a.l1Txid)) {
      const link = document.createElement("a");
      link.className = "txid"; link.target = "_blank"; link.rel = "noopener";
      link.textContent = short(a.l1Txid); link.href = txUrl(a.l1Txid);
      l1.appendChild(link);
    } else {
      l1.textContent = a.l1Txid ? short(a.l1Txid) : (a.direction === "out" ? "pending…" : "—");
      l1.classList.add("muted-cell");
    }
    $(".blk", row).textContent = "#" + a.evmBlock;
    tbody.appendChild(row);
  }
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---- nostr identity resolution (read-only) ----
const RELAYS = ["wss://relay.nostr.band", "wss://relay.damus.io", "wss://nos.lol"];
const profileCache = new Map();
const didToHex = (id) => { const m = String(id || "").match(/(?:did:nostr:)?([0-9a-f]{64})/i); return m ? m[1].toLowerCase() : null; };
const avatarUrl = (hex, prof) => prof?.picture || `https://api.dicebear.com/9.x/identicon/svg?seed=${hex}`;

function resolveProfile(hex) {
  if (profileCache.has(hex)) return profileCache.get(hex);
  const p = new Promise((resolve) => {
    let left = RELAYS.length, best = null, done = false;
    const finish = () => { if (!done) { done = true; resolve(best); } };
    for (const url of RELAYS) {
      let ws; try { ws = new WebSocket(url); } catch { if (--left === 0) finish(); continue; }
      const t = setTimeout(() => { try { ws.close(); } catch {} if (--left === 0) finish(); }, 5000);
      ws.onopen = () => ws.send(JSON.stringify(["REQ", "p", { kinds: [0], authors: [hex], limit: 1 }]));
      ws.onmessage = (m) => {
        const o = JSON.parse(m.data);
        if (o[0] === "EVENT") { try { best = JSON.parse(o[2].content); } catch {} clearTimeout(t); try { ws.close(); } catch {} finish(); }
        else if (o[0] === "EOSE") { clearTimeout(t); try { ws.close(); } catch {} if (--left === 0) finish(); }
      };
      ws.onerror = () => { clearTimeout(t); if (--left === 0) finish(); };
    }
  });
  profileCache.set(hex, p);
  return p;
}

function patchProfile(hex) {
  resolveProfile(hex).then((prof) => {
    for (const el of $$(`.who[data-pk="${hex}"]`)) {
      const img = $(".av", el), name = $(".idname", el);
      if (prof?.picture && img) img.src = prof.picture;
      const nm = prof?.display_name || prof?.name;
      if (nm && name) name.textContent = nm;
    }
  });
}

let agentDone = false;
function maybeResolveAgent() {
  if (agentDone || !latest?.identity?.did) return;
  const hex = didToHex(latest.identity.did);
  if (!hex) return;
  agentDone = true;
  const wrap = $("[data-agent]"), img = $("[data-agent-av]"), name = $("[data-agent-name]");
  if (img) img.src = avatarUrl(hex);
  if (name) name.textContent = short("did:nostr:" + hex, 14);
  if (wrap) wrap.hidden = false;
  resolveProfile(hex).then((prof) => {
    if (prof?.picture && img) img.src = prof.picture;
    const nm = prof?.display_name || prof?.name;
    if (nm && name) name.textContent = nm;
  });
}

function renderMarks(marks) {
  const m = marks || { recent: [], leaderboard: [] };
  $("[data-marks-count]").textContent = m.total ?? (m.recent?.length || 0);
  const tb = $("[data-marks]");
  tb.innerHTML = "";
  const pks = new Set();
  if (!m.recent?.length) {
    tb.innerHTML = `<tr class="empty"><td colspan="3">no marks yet</td></tr>`;
  } else {
    for (const k of m.recent) {
      const tr = document.createElement("tr");
      let tag = "";
      if (k.identity) {
        const hex = didToHex(k.identity);
        if (hex) {
          pks.add(hex);
          tag = ` <span class="idtag who" data-pk="${hex}" title="did:nostr:${hex}"><img class="av" src="${avatarUrl(hex)}" alt=""><span class="idname">${short("did:nostr:" + hex, 12)}</span></span>`;
        } else {
          tag = ` <span class="idtag">${esc(k.identity)}</span>`;
        }
      }
      tr.innerHTML =
        `<td class="sm"><code>${short(k.from, 5)}</code> → <code>${short(k.to, 5)}</code></td>` +
        `<td class="amt"><b>${fmtAmount(k.amount)}</b> wBTMK</td>` +
        `<td>${esc(k.reason)}${tag}</td>`;
      tb.appendChild(tr);
    }
  }
  for (const hex of pks) patchProfile(hex);
  const ol = $("[data-leaderboard]");
  ol.innerHTML = "";
  for (const r of (m.leaderboard || []).slice(0, 5)) {
    const li = document.createElement("li");
    li.innerHTML = `<code class="sm">${short(r.address, 6)}</code><span class="lb-amt">${fmtAmount(r.total)}</span>`;
    ol.appendChild(li);
  }
}

function setStatus(ok) {
  $("[data-state-dot]").className = "dot " + (ok ? "ok" : "bad");
  $("[data-state-label]").textContent = ok ? "live" : "offline";
}

let latest = null;
async function tick() {
  try {
    const r = await fetch("/bridge-state.jsonld", { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    const state = await r.json();
    latest = state;
    hydrate(state);
    renderFeed(state.activity);
    renderMarks(state.marks);
    maybeResolveAgent();
    setStatus(true);
  } catch {
    setStatus(false);
  }
}

// ---- wallet / give-a-mark (signed by the connected nostr key) ----
const ERC20 = [
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];
const MARK = ["function mark(address to, uint256 amount, string identity, string reason)"];
const provider = new ethers.JsonRpcProvider(location.origin + "/rpc");
let wallet = null, did = null;
const markStatus = (msg, cls = "") => { const el = $("[data-markstatus]"); el.textContent = msg; el.className = "markstatus " + cls; };

function loadAccount() {
  let acct;
  try { acct = JSON.parse(localStorage.getItem("currentAccount") || "null"); } catch { acct = null; }
  if (!acct) return;
  did = acct["@id"] || (acct.pubkey ? `did:nostr:${acct.pubkey}` : null);
  if (acct.privkey) {
    wallet = new ethers.Wallet(acct.privkey.startsWith("0x") ? acct.privkey : "0x" + acct.privkey, provider);
    refreshYou();
  } else {
    // NIP-07 extension: schnorr only, can't sign EVM
    $("[data-you]").innerHTML = `Connected as <code class="sm">${short(did, 14)}</code> — but extension (NIP-07) keys can't sign EVM. Use a guest/key login to give marks.`;
  }
}

async function refreshYou() {
  if (!wallet) return;
  $("[data-connect]").textContent = short(wallet.address, 5);
  $("[data-marksubmit]").textContent = "Mark";
  const token = new ethers.Contract(latest?.sidechain?.token?.address || ethers.ZeroAddress, ERC20, provider);
  let bal = "0", gas = "0";
  try { gas = ethers.formatEther(await provider.getBalance(wallet.address)); } catch {}
  try { bal = ethers.formatEther(await token.balanceOf(wallet.address)); } catch {}
  $("[data-you]").innerHTML =
    `You: <code class="sm">${short(did, 14)}</code> · <code class="sm">${short(wallet.address, 6)}</code> · ` +
    `<b>${fmtAmount(bal)}</b> wBTMK · ${fmtAmount(gas)} gas ` +
    `<button type="button" class="linkbtn" data-faucet>get test funds</button>`;
}

async function faucet() {
  if (!wallet) return;
  markStatus("requesting test funds…");
  await fetch("/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: wallet.address }) });
  await refreshYou();
  markStatus("funded ✓", "ok");
}

async function ensureFunded(amount) {
  const token = new ethers.Contract(latest.sidechain.token.address, ERC20, wallet);
  const gas = await provider.getBalance(wallet.address);
  const bal = await token.balanceOf(wallet.address);
  if (gas < ethers.parseEther("0.01") || bal < amount) {
    markStatus("getting test funds…");
    await fetch("/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: wallet.address }) });
  }
}

async function submitMark(e) {
  e.preventDefault();
  if (!wallet) return connect();
  const fd = new FormData(e.target);
  const to = (fd.get("to") || "").trim();
  const reason = (fd.get("reason") || "").trim();
  let amount;
  try { amount = ethers.parseEther(String(fd.get("amount") || "0")); } catch { return markStatus("bad amount", "bad"); }
  if (!ethers.isAddress(to)) return markStatus("enter a valid 0x recipient", "bad");
  if (amount <= 0n) return markStatus("amount must be > 0", "bad");
  try {
    await ensureFunded(amount);
    const token = new ethers.Contract(latest.sidechain.token.address, ERC20, wallet);
    const marking = new ethers.Contract(latest.marks.contract, MARK, wallet);
    if ((await token.allowance(wallet.address, latest.marks.contract)) < amount) {
      markStatus("approving…"); await (await token.approve(latest.marks.contract, ethers.MaxUint256)).wait(1);
    }
    markStatus("signing mark…");
    const r = await (await marking.mark(to, amount, did || "", reason)).wait(1);
    markStatus(`marked ✓ (block #${r.blockNumber})`, "ok");
    e.target.reset();
    await refreshYou();
    tick();
  } catch (err) {
    markStatus("failed: " + (err.shortMessage || err.message || err), "bad");
  }
}

function connect() {
  if (window.xlogin?.login) window.xlogin.login();
  else markStatus("xlogin unavailable", "bad");
}

document.addEventListener("xlogin", loadAccount);
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-connect]")) { if (!wallet) connect(); }
  if (e.target.closest("[data-faucet]")) faucet();
});
$("[data-markform]").addEventListener("submit", submitMark);

// copy-to-clipboard island
document.addEventListener("click", (e) => {
  const box = e.target.closest("[data-copy]");
  if (!box || !e.target.closest(".copy")) return;
  const text = $("code", box)?.textContent?.trim();
  if (text) navigator.clipboard?.writeText(text).then(() => {
    const b = box.querySelector(".copy");
    b.textContent = "✓"; setTimeout(() => (b.textContent = "⧉"), 900);
  });
});

tick().then(loadAccount);
setInterval(tick, 4000);
