// The co-op's keeper (Vercel cron, twice a day): reads the stake of every member. A waiting increase (S12) keeps its
// run of readings at most a day apart while nobody opens the page, and a stake someone took out counts within 12 hours
// (before, nobody read a member with nothing waiting, so their savings weight outlived their stake). Paid by the relayer
// account. Only Vercel's cron may run it (it sends CRON_SECRET), so nobody can make the relayer pay for the same
// reading many times over; a waiting increase read in the last 6 hours is skipped.
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
  return Response.json({ read });
}
