// Live activity: the co-op's NEP-297 events as members act. The NearBlocks indexer says which transactions touched the
// contract or the DAO; the NEAR RPC gives their logs; each event is checked against the contract's schema (share.js)
// before it is shown. Polled every 30 s while the tab is visible; a new event refreshes the wallet panel at once.
// ponytail: polling, because no indexer streams testnet NEP-297 events; switch to a websocket when one does.
import { dep, testnet, txStatus, txUrl, $, esc } from "./near.js";
import { describeEvent, parseEvents, txList } from "./share.js";
import { t } from "./lang.js";

const API = `https://api${testnet ? "-testnet" : ""}.nearblocks.io/v3/accounts`;
const list = $("live-list");
const state = $("live-state");
const seen = new Set();
let first = true;
let shown = 0;

async function poll() {
  const lists = await Promise.all([dep.contract, dep.dao].map((id) =>
    fetch(`${API}/${id}/txns?limit=4`, { signal: AbortSignal.timeout(8000) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`indexer ${r.status}`)))).then(txList)));
  const fresh = lists.flat().filter((t) => !seen.has(t.hash)).sort((a, b) => a.ts - b.ts);
  const found = [];
  for (const t of fresh) {
    const out = await txStatus(t.hash, t.signer).catch(() => null);
    if (!out) continue; // retried on the next poll
    seen.add(t.hash);
    // shown as soon as read: newest at the top
    const evs = parseEvents(out, dep.contract).map((e) => ({ ...e, hash: t.hash, ts: t.ts }));
    found.push(...evs);
    show(evs);
  }
  while (list.children.length > 12) list.lastElementChild?.remove();
  if (!first && found.length) {
    window.dispatchEvent(new CustomEvent("koperasi:events", { detail: found }));
    $("live-refresh").hidden = false;
  }
  first = false;
  const at = new Date().toLocaleTimeString(t("en", "id-ID"), { hour: "2-digit", minute: "2-digit" });
  state.textContent = shown ? t(`Updated ${at}; checks again every 30 s.`, `Diperbarui ${at}; diperiksa lagi setiap 30 detik.`)
    : t("No co-op events in the latest transactions yet; checking every 30 s.", "Belum ada event koperasi di transaksi terbaru; diperiksa setiap 30 detik.");
}

function show(evs) {
  for (const e of evs) {
    const li = document.createElement("li");
    li.innerHTML = `<time datetime="${new Date(e.ts).toISOString()}">${new Date(e.ts).toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
      <span>${esc(describeEvent(e))}</span><a href="${esc(txUrl(e.hash))}" aria-label="Transaction of: ${esc(e.event.replace(/_/g, " "))}">tx</a>`;
    if (!first) li.className = "new";
    list.prepend(li);
    shown++;
  }
}

let running = false;
const run = () => {
  if (running) return;
  running = true;
  poll().catch((e) => { state.textContent = t(`Could not read the indexer (${e.message}); retrying in 30 s.`, `Belum bisa membaca indexer (${e.message}); mencoba lagi dalam 30 detik.`); })
    .finally(() => { running = false; });
};
// the page's own reads go first (public RPCs rate-limit bursts): start when the section comes near, or after 6 s
const start = () => { if (!started) { started = true; run(); } };
let started = false;
new IntersectionObserver((es, o) => { if (es.some((e) => e.isIntersecting)) { o.disconnect(); start(); } }, { rootMargin: "400px" }).observe($("live"));
setTimeout(start, 6000);
setInterval(() => { if (started && !document.hidden) run(); }, 30_000);
document.addEventListener("visibilitychange", () => { if (started && !document.hidden) run(); });
$("live-refresh").onclick = () => location.reload();
