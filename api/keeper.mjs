// The co-op's keeper (Vercel cron, twice a day): reads the stake of every member whose savings increase is waiting
// (S12), so the run of readings at most a day apart is not broken while nobody opens the page. Paid by the relayer
// account. Anyone may call it: it only reads members not read in the last 6 hours, so calling it often costs nothing.
// Env: RELAYER_ID, RELAYER_KEY.
import { Account, JsonRpcProvider } from "near-api-js";
import dep from "../deployment.testnet.json" with { type: "json" };

const STALE_NS = 6n * 3600n * 10n ** 9n;
const provider = new JsonRpcProvider({ url: "https://rpc.testnet.fastnear.com" });
const view = (method, args) => provider.callFunction({ contractId: dep.contract, method, args, blockQuery: { finality: "final" } });

/** Members whose waiting increase was last read before `now - STALE_NS` (ns). Exported for the unit test. */
export async function stale(now, read = view) {
  const out = [];
  for (let from = 0; ; from += 100) {
    const page = /** @type {any[]} */ (await read("get_members", { from, limit: 100 }));
    for (const [id] of page) {
      const p = /** @type {any} */ (await read("get_pending_savings", { account_id: id }));
      if (p && now - BigInt(p[2]) > STALE_NS) out.push(id);
    }
    if (page.length < 100) return out;
  }
}

export async function GET() {
  if (!process.env.RELAYER_ID || !process.env.RELAYER_KEY) return Response.json({ error: "the keeper is off" }, { status: 503 });
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
