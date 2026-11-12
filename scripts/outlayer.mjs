// node scripts/outlayer.mjs [member]   check the agent's by-laws inside an Intel TDX enclave, on-chain, through OutLayer
//
// The same gate the agent runs before every job (agent/gate.mjs), run once by hand: a member calls outlayer.testnet
// `request_execution` with the program outlayer/bylaws-check (WASI, built with `cargo build --release --target
// wasm32-wasip2` and served at /outlayer/ next to the page, addressed by its sha256). The tx is saved in the deployment
// files; `npm run verify` reads it back.
import fs from "node:fs";
import path from "node:path";
import { bylawsGate } from "../agent/gate.mjs";
import { DEPLOYMENT, ROOT, txUrl } from "./lib.mjs";

const member = process.argv[2] ?? "kop-alice-mw4i3w8f.testnet";
const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));

const g = await bylawsGate(member, dep.contract);
console.log(`${txUrl(g.tx)}\n${JSON.stringify(g.out, null, 1)}`);
if (!g.out?.match) throw new Error("the enclave did not find the by-laws file to match the voted hash");

const o = { provider: "OutLayer (Intel TDX), outlayer.testnet", program: "outlayer/bylaws-check", wasm: g.wasm, wasm_sha256: g.wasm_sha256,
  tx: g.tx, sender: member, version: g.out.version };
for (const f of [DEPLOYMENT, path.join(ROOT, "web/deployment.json")]) {
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  fs.writeFileSync(f, JSON.stringify({ ...d, outlayer: o }, null, 2) + "\n");
}
