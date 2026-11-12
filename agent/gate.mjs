// The by-laws gate inside an Intel TDX enclave, through OutLayer: before every job the agent has `payer` call
// outlayer.testnet `request_execution` with this repo's WASI program (outlayer/bylaws-check, served by sha256 next to the
// page). Inside the enclave the program reads the hash the members voted from NEAR's RPC, downloads the by-laws file,
// hashes it and returns whether they match; OutLayer resumes the transaction with that result, so the check is on-chain.
// The agent's own key can only record receipts and cannot attach the execution's deposit: the steward, who runs the
// agent, pays for it (unused deposit is refunded). The receipt names the gate's transaction; `npm run verify` reads it.
import fs from "node:fs";
import path from "node:path";
import { ROOT, account, callRaw, sha256, view } from "../scripts/lib.mjs";

export const OUTLAYER = "outlayer.testnet";
export const PAGE = "https://koperasi-kohl.vercel.app";
export const GATE_RPC = "https://rpc.testnet.fastnear.com";
const WASM = path.join(ROOT, "web/outlayer/bylaws-check.wasm");
const LIMITS = { max_instructions: 10_000_000_000, max_memory_mb: 128, max_execution_seconds: 30 };

/** The program as built in the repo, and as the page serves it (they must be the same bytes). */
export async function program() {
  const hash = sha256(fs.readFileSync(WASM));
  const url = `${PAGE}/outlayer/bylaws-check.wasm?v=${hash.slice(0, 12)}`; // past a stale edge cache; the hash pins the bytes
  const page = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!page.ok) throw new Error(`${url}: HTTP ${page.status}`);
  const served = sha256(Buffer.from(await page.arrayBuffer()));
  if (served !== hash) throw new Error(`the page serves ${served.slice(0, 12)}…, not this build ${hash.slice(0, 12)}…: deploy first`);
  return { url, hash };
}

/**
 * Runs the gate on-chain, paid by `payer`. Returns the enclave's output and the transaction.
 * @param {string} payer @param {string} contract
 * @returns {Promise<{ tx: string, sender: string, wasm: string, wasm_sha256: string, out: any }>}
 */
export async function bylawsGate(payer, contract) {
  const { url, hash } = await program();
  const input = JSON.stringify({ contract, rpc: GATE_RPC, page: PAGE });
  const cost = BigInt(String(await view(OUTLAYER, "estimate_execution_cost", { resource_limits: LIMITS, input_size: input.length })).replace(/"/g, ""));
  const r = await callRaw(account(payer), OUTLAYER, "request_execution",
    { source: { WasmUrl: { url, hash, build_target: "wasm32-wasip2" } }, resource_limits: LIMITS, input_data: input,
      secrets_ref: null, response_format: "Json", payer_account_id: null, params: null },
    { deposit: cost * 2n, tgas: 300 }); // unused deposit is refunded
  const out = JSON.parse(Buffer.from(r.status.SuccessValue ?? "", "base64").toString() || "null");
  return { tx: r.transaction.hash, sender: payer, wasm: url, wasm_sha256: hash, out };
}
