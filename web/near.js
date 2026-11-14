// Shared by the page and the wallet panel: the deployment, read-only calls to NEAR, small formatters.
export const dep = await (await fetch("deployment.json")).json();
export const testnet = dep.network !== "mainnet";
const RPCS = testnet
  ? ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org", "https://rpc.testnet.fastnear.com", "https://archival-rpc.testnet.fastnear.com", "https://rpc.testnet.near.org"]
  : ["https://free.rpc.fastnear.com", "https://near.drpc.org", "https://rpc.mainnet.fastnear.com"];
export const RPC_URLS = RPCS;
// stick to the last RPC that answered: a rate-limited one (429, which also fails CORS) is then tried once, not per call
let good = 0;
// Public RPCs limit each IP in bursts, and the page reads ~100 things on load: at most 4 requests are in flight at once
// (the rest wait their turn), and an RPC that said 429 is skipped for 15 s.
// ponytail: a plain queue, not JSON-RPC batching (nearcore answers one call per request).
const MAX_IN_FLIGHT = 4;
let inFlight = 0;
const queue = [];
const turn = () => (inFlight < MAX_IN_FLIGHT ? (inFlight++, Promise.resolve()) : new Promise((ok) => queue.push(ok)));
const done = () => { const next = queue.shift(); if (next) next(); else inFlight--; };
const cooling = new Map(); // RPC index → until when it is skipped
const limited = (status, r) => status === 429 || r?.error?.code === -429 || /rate limit/i.test(JSON.stringify(r?.error ?? ""));
async function post(url, body) {
  await turn();
  try {
    // a hung RPC must not hang the page: give up after 8 s and try the next one
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(8000) });
    return { status: res.status, r: await res.json().catch(() => null) };
  } finally {
    done();
  }
}
async function rpc(body) {
  let last;
  // two rounds over every RPC, a short pause between: public RPCs rate-limit in bursts
  for (let k = 0; k < RPCS.length * 2; k++) {
    if (k === RPCS.length) await new Promise((ok) => setTimeout(ok, 1500));
    const i = (good + k) % RPCS.length;
    if (k < RPCS.length && (cooling.get(i) ?? 0) > Date.now()) continue;
    try {
      const { status, r } = await post(RPCS[i], body);
      if (!r || limited(status, r)) {
        cooling.set(i, Date.now() + 15_000);
        throw new Error(r?.error ? JSON.stringify(r.error) : `RPC ${status}`);
      }
      if (r.error || r.result?.error) {
        // the chain's own answer (no such account, a contract's refusal) is the same on every RPC: do not ask the others
        const final = r.result?.error || /UNKNOWN_ACCOUNT|NO_CONTRACT_CODE|CONTRACT_EXECUTION_ERROR/.test(JSON.stringify(r.error));
        throw Object.assign(new Error(JSON.stringify(r.error ?? r.result.error)), { final });
      }
      good = i;
      return r.result;
    } catch (e) {
      if (e.final) throw e;
      last = e;
    }
  }
  throw last;
}
// config/ and evidence/ are copied next to the page at deploy (npm run web:files), so the page works while the repo is private
export const RAW = "/";
export const explorer = (id) => `https://${testnet ? "testnet." : ""}nearblocks.io/address/${id}`;
export const txUrl = (hash) => `https://${testnet ? "testnet." : ""}nearblocks.io/txns/${hash}`;

/** Raw RPC `query` (accounts, access keys), with the same fallbacks as `view`. */
export async function query(params) {
  return rpc(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { finality: "final", ...params } }));
}

// The same read asked twice (the page and the wallet panel each read get_info, the proposals…) goes out once: a view's
// answer is kept 30 s, a final transaction's for good. `forget()` drops the views after the member's own transaction.
const kept = new Map();
function once(body, ttl) {
  const hit = kept.get(body);
  if (hit && Date.now() - hit.at < ttl) return hit.p;
  const p = rpc(body).catch((e) => { kept.delete(body); throw e; });
  kept.set(body, { at: Date.now(), p, ttl });
  return p;
}
export const forget = () => { for (const [k, v] of kept) if (v.ttl !== Infinity) kept.delete(k); };

/** A transaction's full outcome (all receipts and their logs), once final. */
export async function txStatus(hash, sender) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "EXPERIMENTAL_tx_status", params: { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" } });
  return once(body, Infinity);
}

export async function view(contract, method, args = {}) {
  const result = await once(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "query",
    params: { request_type: "call_function", finality: "optimistic", account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) },
  }), 30_000);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result)));
}

export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// a micro-USDC amount (e.g. a 1e-6 USDC refund) reads "<0.01", not "0.00"
export const usdc = (u) => (Number(u) > 0 && Number(u) < 10_000 ? "<0.01" : (Number(u) / 1e6).toFixed(2));
export const nearAmt = (y) => (Number(BigInt(y) / 10n ** 21n) / 1000).toLocaleString("en", { maximumFractionDigits: 2 });

/** Every item of a paged view (get_members, get_receipts: `from`/`limit`), page by page. */
export async function all(contract, method, size = 200) {
  const out = [];
  for (let from = 0; ; from += size) {
    const page = await view(contract, method, { from, limit: size });
    out.push(...page);
    if (page.length < size) return out;
  }
}
