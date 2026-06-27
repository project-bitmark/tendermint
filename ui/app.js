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

function renderFeed(deposits = []) {
  const tbody = $("[data-feed]");
  $("[data-count]").textContent = deposits.length;
  tbody.innerHTML = "";
  if (!deposits.length) {
    tbody.innerHTML = `<tr class="empty"><td colspan="4">no deposits yet — send BTMK to the reserve address</td></tr>`;
    return;
  }
  const tpl = $("#row");
  for (const d of deposits) {
    const row = tpl.content.cloneNode(true);
    $(".amt b", row).textContent = fmtAmount(d.amount);
    $(".recip", row).textContent = short(d.recipient);
    const a = $(".txid", row);
    a.textContent = short(d.btmkTxid);
    a.href = txUrl(d.btmkTxid);
    $(".blk", row).textContent = "#" + d.evmBlock;
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
    renderFeed(state.deposits);
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
