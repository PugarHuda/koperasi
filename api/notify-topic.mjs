// A member's private ntfy.sh topic. ntfy.sh takes anonymous posts, so a topic anyone can compute is a topic anyone can
// spoof; this one is an HMAC under NOTIFY_SECRET, which only this function and .github/workflows/notify.yml hold.
// The member proves the account is theirs by signing notifyText (NEP-413, recipient: the contract) with a key of it.
// Env: NOTIFY_SECRET (the same value as the GitHub Actions secret).
import { createHmac } from "node:crypto";
import dep from "../deployment.testnet.json" with { type: "json" };
import { nep413Verify, notifyText } from "../web/share.js";

const RPC = "https://rpc.testnet.fastnear.com";
const WINDOW = 10 * 60_000;

/** `koperasi-` + the first 20 hex of HMAC-SHA256(secret, "contract:account"). The script and this function agree on it. */
export function ntfyTopic(secret, contract, account) {
  if (!secret) throw new Error("no NOTIFY_SECRET");
  return `koperasi-${createHmac("sha256", secret).update(`${contract}:${account}`).digest("hex").slice(0, 20)}`;
}

/** Whether `pk` is an access key (full-access or function-call) of `account` now. */
const isKey = (account, pk) => fetch(RPC, { method: "POST", signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_access_key", finality: "final", account_id: account, public_key: pk } }) })
  .then((r) => r.json()).then((j) => !!j.result?.permission); // an unknown key comes back as a result with an error field

/**
 * Why this request is refused, or null. Exported for the unit test.
 * @param {any} b { account, ts, pk, sig, nonce } (sig and nonce base64, ts in ms)
 * @param {{ now?: number, keyOf?: typeof isKey, contract?: string }} [opts]
 */
export async function refuse(b, { now = Date.now(), keyOf = isKey, contract = dep.contract } = {}) {
  const account = String(b?.account ?? "");
  if (!/^(?=.{2,64}$)[a-z0-9]+([-_][a-z0-9]+)*(\.[a-z0-9]+([-_][a-z0-9]+)*)*$/.test(account)) return "bad account";
  const ts = Number(b.ts);
  if (!Number.isSafeInteger(ts) || Math.abs(now - ts) > WINDOW) return "the signed time is more than 10 minutes off: sign again";
  const pk = String(b.pk ?? "");
  if (!(await nep413Verify({ message: notifyText(contract, account, ts), recipient: contract, pk, sig: String(b.sig ?? ""), nonce: String(b.nonce ?? "") }))) return "bad signature";
  if (!(await keyOf(account, pk))) return `the signing key is not a key of ${account}`;
  return null;
}

export async function POST(request) {
  const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
  const secret = process.env.NOTIFY_SECRET;
  if (!secret) return json({ error: "push topics are off (no NOTIFY_SECRET)" }, 503);
  let b;
  try { b = await request.json(); } catch { return json({ error: "send { account, ts, pk, sig, nonce }" }, 400); }
  const why = await refuse(b).catch((e) => `could not check: ${e.message}`);
  if (why) return json({ error: why }, 403);
  return json({ topic: ntfyTopic(secret, dep.contract, b.account) });
}
