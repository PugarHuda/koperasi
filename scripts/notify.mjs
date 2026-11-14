// Push notifications while the dashboard is closed: for each member, what waits on them (the same list as /api/inbox and
// the dashboard's "Needs you"), and anything not told before is posted to their ntfy.sh topic. A member subscribes to
// their private topic (an HMAC under NOTIFY_SECRET, api/notify-topic.mjs) in the ntfy app; nobody needs an account.
// No NOTIFY_SECRET: nothing is posted and the state is left as it was (never a topic anyone could compute).
// Run every 15 minutes by .github/workflows/notify.yml; what was told is kept in a small JSON file (the workflow's cache).
//   node scripts/notify.mjs [state.json]   (KOP_NOTIFY_DRY=1: print, post nothing)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import dep from "../deployment.testnet.json" with { type: "json" };
import { setTimeout as sleep } from "node:timers/promises";
import { readInbox, readShared, view } from "../api/inbox.mjs";
import { ntfyTopic } from "../api/notify-topic.mjs";

const PAGE = "https://koperasi-kohl.vercel.app";

/** The items not told before (by id). Ids carry what changes (a due date, an amount), so a new deadline is new. */
export const fresh = (items, sent = []) => items.filter((i) => !sent.includes(i.id));

async function post(topic, item) {
  const r = await fetch("https://ntfy.sh/", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ topic, title: `Koperasi: ${item.title}`, message: item.text, click: `${PAGE}/dashboard.html`, tags: ["handshake"] }) });
  if (!r.ok) throw new Error(`ntfy ${r.status}: ${(await r.text()).slice(0, 120)}`);
}

if (import.meta.main) {
  const secret = process.env.NOTIFY_SECRET;
  if (!secret) {
    console.warn("NOTIFY_SECRET is not set: no push this run (set it as a GitHub Actions secret)");
    process.exit(0);
  }
  const file = process.argv[2] ?? ".notify/state.json";
  let state = null;
  try { state = JSON.parse(readFileSync(file, "utf8")); } catch { /* first run */ }
  // ponytail: the first 100 members, one at a time (the public RPC rate-limits); page get_members when the co-op outgrows that
  const members = (await view(dep.contract, "get_members", { from: 0, limit: 100 })).map(([a]) => a);
  const shared = await readShared();
  const next = {};
  for (const who of members) {
    await sleep(1000);
    try {
      const items = await readInbox(who, shared);
      next[who] = items.map((i) => i.id);
      // the very first run only learns what is already waiting: it does not push a backlog to everyone
      const out = state ? fresh(items, state[who]) : [];
      const topic = ntfyTopic(secret, dep.contract, who);
      for (const item of out) {
        if (process.env.KOP_NOTIFY_DRY) console.log(topic, item.title);
        else await post(topic, item);
      }
      console.log(`${who}: ${items.length} waiting, ${out.length} pushed`);
    } catch (e) {
      next[who] = state?.[who] ?? []; // try again next run
      console.warn(`${who}: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next));
}
