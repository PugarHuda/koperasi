// Shared by the page and the wallet panel: the deployment, read-only calls to NEAR, small formatters.
export const dep = await (await fetch("deployment.json")).json();
export const testnet = dep.network !== "mainnet";
const RPCS = testnet
  ? ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org", "https://rpc.testnet.near.org"]
  : ["https://free.rpc.fastnear.com", "https://near.drpc.org", "https://rpc.mainnet.near.org"];
export const RPC_URLS = RPCS;
export const RAW = "https://raw.githubusercontent.com/PugarHuda/koperasi/main/";
export const explorer = (id) => `https://${testnet ? "testnet." : ""}nearblocks.io/address/${id}`;
export const txUrl = (hash) => `https://${testnet ? "testnet." : ""}nearblocks.io/txns/${hash}`;

export async function view(contract, method, args = {}) {
  const body = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "query",
    params: { request_type: "call_function", finality: "optimistic", account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) },
  });
  let last;
  for (const url of RPCS) {
    try {
      const r = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body })).json();
      if (r.error || r.result?.error) throw new Error(JSON.stringify(r.error ?? r.result.error));
      return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result.result)));
    } catch (e) { last = e; }
  }
  throw last;
}

export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
export const usdc = (u) => (Number(u) / 1e6).toFixed(2);
export const nearAmt = (y) => (Number(BigInt(y) / 10n ** 21n) / 1000).toLocaleString("en", { maximumFractionDigits: 2 });
