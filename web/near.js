// Shared by the page and the wallet panel: the deployment, read-only calls to NEAR, small formatters.
export const dep = await (await fetch("deployment.json")).json();
export const testnet = dep.network !== "mainnet";
const RPCS = testnet
  ? ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org", "https://rpc.testnet.fastnear.com"]
  : ["https://free.rpc.fastnear.com", "https://near.drpc.org", "https://rpc.mainnet.fastnear.com"];
export const RPC_URLS = RPCS;
// stick to the last RPC that answered: a rate-limited one (429, which also fails CORS) is then tried once, not per call
let good = 0;
async function rpc(body) {
  let last;
  // two rounds over every RPC, a short pause between: public RPCs rate-limit in bursts
  for (let k = 0; k < RPCS.length * 2; k++) {
    if (k === RPCS.length) await new Promise((ok) => setTimeout(ok, 1500));
    const i = (good + k) % RPCS.length;
    try {
      // a hung RPC must not hang the page: give up after 8 s and try the next one
      const r = await (await fetch(RPCS[i], { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(8000) })).json();
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

/** A transaction's full outcome (all receipts and their logs), once final. */
export async function txStatus(hash, sender) {
  return rpc(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "EXPERIMENTAL_tx_status", params: { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" } }));
}

export async function view(contract, method, args = {}) {
  const result = await rpc(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "query",
    params: { request_type: "call_function", finality: "optimistic", account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) },
  }));
  return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result)));
}

export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const usdc = (u) => (Number(u) / 1e6).toFixed(2);
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
