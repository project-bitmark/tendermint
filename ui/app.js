// Bridge UI — one small ESM island controller, no build, no deps.
// Polls /bridge-state.jsonld and hydrates [data-bind] elements + the feed.
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

function setStatus(ok) {
  $("[data-state-dot]").className = "dot " + (ok ? "ok" : "bad");
  $("[data-state-label]").textContent = ok ? "live" : "offline";
}

async function tick() {
  try {
    const r = await fetch("/bridge-state.jsonld", { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    const state = await r.json();
    hydrate(state);
    renderFeed(state.activity);
    setStatus(true);
  } catch {
    setStatus(false);
  }
}

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

tick();
setInterval(tick, 4000);
