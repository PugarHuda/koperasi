// The co-op's keeper (Vercel cron, twice a day): reads the stake of every member. A waiting increase (S12) keeps its
// run of readings at most a day apart while nobody opens the page, and a stake someone took out counts within 12 hours
// (before, nobody read a member with nothing waiting, so their savings weight outlived their stake). Paid by the relayer
// account. Only Vercel's cron may run it (it sends CRON_SECRET), so nobody can make the relayer pay for the same
// reading many times over; a waiting increase read in the last 6 hours is skipped.
// It also does what the contract lets anyone do but nobody may remember to: close a court case whose jurors had their
// 3 days, end a steward's term that ran out, and slash a steward whose paid job is 7 days late (`duties`).
// ponytail: one call per member per run; page the members across runs if the co-op grows past a few hundred.
// Env: RELAYER_ID, RELAYER_KEY, CRON_SECRET.
import { Account, JsonRpcProvider } from "near-api-js";
import dep from "../deployment.testnet.json" with { type: "json" };

const STALE_NS = 6n * 3600n * 10n ** 9n;
const provider = new JsonRpcProvider({ url: "https://rpc.testnet.fastnear.com" });
const view = (method, args) => provider.callFunction({ contractId: dep.contract, method, args, blockQuery: { finality: "final" } });

/** Members to read: everyone, except a waiting increase read after `now - STALE_NS` (ns). Exported for the unit test. */
export async function stale(now, read = view) {
  const out = [];
  for (let from = 0; ; from += 100) {
    const page = /** @type {any[]} */ (await read("get_members", { from, limit: 100 }));
    for (const [id] of page) {
      const p = /** @type {any} */ (await read("get_pending_savings", { account_id: id }));
      if (!p || now - BigInt(p[2]) > STALE_NS) out.push(id);
    }
    if (page.length < 100) return out;
  }
}

const CASE_NS = 3n * 86_400n * 10n ** 9n;
/** Calls anyone may make now: { method, args, why }. Exported for the unit test. */
export async function duties(now, read = view) {
  const out = [];
  for (let from = 0; ; from += 100) {
    const page = /** @type {any[]} */ (await read("get_cases", { from, limit: 100 }));
    for (const c of page) {
      if (c.status === "Open" && now >= BigInt(c.opened) + CASE_NS) out.push({ method: "close_case", args: { id: c.id }, why: `case #${c.id}: the jurors had their 3 days` });
    }
    if (page.length < 100) break;
  }
  const [, ends] = /** @type {any} */ (await read("get_steward_term", {}));
  if (ends !== null && now >= BigInt(ends)) out.push({ method: "end_steward_term", args: {}, why: "the steward's term ran out" });
  const overdue = BigInt(/** @type {any} */ (await read("get_overdue", {})));
  const info = /** @type {any} */ (await read("get_info", {}));
  if (overdue > 0n && BigInt(info.steward_bond) > 0n) out.push({ method: "slash_overdue", args: {}, why: `${overdue} USDC units of paid jobs are 7 days late` });
  return out;
}

export async function GET(request) {
  if (!process.env.RELAYER_ID || !process.env.RELAYER_KEY || !process.env.CRON_SECRET) return Response.json({ error: "the keeper is off" }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) return Response.json({ error: "only the co-op's cron" }, { status: 401 });
  const ids = await stale(BigInt(Date.now()) * 1_000_000n);
  const keeper = new Account(process.env.RELAYER_ID, provider, /** @type {any} */ (process.env.RELAYER_KEY));
  const read = [];
  for (const account_id of ids) {
    const out = await keeper.callFunctionRaw({ contractId: dep.contract, methodName: "sync_savings", args: { account_id }, gas: 30n * 10n ** 12n })
      .then((o) => ({ account_id, hash: o.transaction.hash }), (e) => ({ account_id, error: e.message }));
    read.push(out);
  }
  const done = [];
  for (const d of await duties(BigInt(Date.now()) * 1_000_000n)) {
    done.push(await keeper.callFunctionRaw({ contractId: dep.contract, methodName: d.method, args: d.args, gas: 50n * 10n ** 12n })
      .then((o) => ({ ...d, hash: o.transaction.hash }), (e) => ({ ...d, error: e.message })));
  }
  return Response.json({ read, done });
}
