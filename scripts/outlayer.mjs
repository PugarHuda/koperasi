// node scripts/outlayer.mjs [member]   check the agent's by-laws inside an Intel TDX enclave, on-chain, through OutLayer
//
// A member calls outlayer.testnet `request_execution` with the program outlayer/bylaws-check (WASI, built with
// `cargo build --release --target wasm32-wasip2` and served at /outlayer/ next to the page, addressed by its sha256).
// Inside the enclave the program reads the hash the members voted from NEAR's RPC, downloads the by-laws file, hashes
// it and returns whether they match; OutLayer resumes the member's transaction with that result. The tx is saved in the
// deployment files; `npm run verify` reads it back.
import fs from "node:fs";
import path from "node:path";
import { DEPLOYMENT, ROOT, account, callRaw, sha256, txUrl, view } from "./lib.mjs";

const OUTLAYER = "outlayer.testnet";
const PAGE = "https://koperasi-kohl.vercel.app";
const WASM = path.join(ROOT, "web/outlayer/bylaws-check.wasm");
const member = process.argv[2] ?? "kop-alice-mw4i3w8f.testnet";
const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));

const hash = sha256(fs.readFileSync(WASM));
const url = `${PAGE}/outlayer/bylaws-check.wasm?v=${hash.slice(0, 12)}`; // past a stale edge cache; the hash pins the bytes
const page = await fetch(url, { signal: AbortSignal.timeout(30_000) });
if (!page.ok) throw new Error(`${url}: HTTP ${page.status}`);
const served = sha256(Buffer.from(await page.arrayBuffer()));
if (served !== hash) throw new Error(`the page serves ${served.slice(0, 12)}…, not this build ${hash.slice(0, 12)}…: deploy first`);

const limits = { max_instructions: 10_000_000_000, max_memory_mb: 128, max_execution_seconds: 30 };
const input = JSON.stringify({ contract: dep.contract, rpc: "https://rpc.testnet.fastnear.com", page: PAGE });
const cost = BigInt(String(await view(OUTLAYER, "estimate_execution_cost", { resource_limits: limits, input_size: input.length })).replace(/"/g, ""));
const source = { WasmUrl: { url, hash, build_target: "wasm32-wasip2" } };
const r = await callRaw(account(member), OUTLAYER, "request_execution",
  { source, resource_limits: limits, input_data: input, secrets_ref: null, response_format: "Json", payer_account_id: null, params: null },
  { deposit: cost * 2n, tgas: 300 }); // unused deposit is refunded
const value = JSON.parse(Buffer.from(r.status.SuccessValue ?? "", "base64").toString() || "null");
console.log(`${txUrl(r.transaction.hash)}\n${JSON.stringify(value, null, 1)}`);
if (!value?.match) throw new Error("the enclave did not find the by-laws file to match the voted hash");

const o = { provider: "OutLayer (Intel TDX), outlayer.testnet", program: "outlayer/bylaws-check", wasm: source.WasmUrl.url, wasm_sha256: hash,
  tx: r.transaction.hash, sender: member, version: value.version };
for (const f of [DEPLOYMENT, path.join(ROOT, "web/deployment.json")]) {
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  fs.writeFileSync(f, JSON.stringify({ ...d, outlayer: o }, null, 2) + "\n");
}
