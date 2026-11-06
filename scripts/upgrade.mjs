// node scripts/upgrade.mjs [deployment file]
// Deploys contract/target/near/koperasi.wasm to an existing co-op's contract account (needs that account's key in
// .keys/). Only for changes that keep the stored state layout; checks that the state still reads afterwards.
import fs from "node:fs";
import path from "node:path";
import { ROOT, DEPLOYMENT, account, sha256, view } from "./lib.mjs";

const file = process.argv[2] ? path.resolve(process.argv[2]) : DEPLOYMENT;
const dep = JSON.parse(fs.readFileSync(file, "utf8"));
const wasm = fs.readFileSync(path.join(ROOT, "contract/target/near/koperasi.wasm"));
const before = await view(dep.contract, "get_info");
await account(dep.contract).deployContract(new Uint8Array(wasm));
const after = await view(dep.contract, "get_info");
for (const k of ["members", "receipts", "periods"]) {
  if (before[k] !== after[k]) throw new Error(`state changed across the upgrade: ${k} ${before[k]} → ${after[k]}`);
}
if (after.config.hash !== before.config.hash) throw new Error("config changed across the upgrade");
console.log(`upgraded ${dep.contract} to code sha256 ${sha256(wasm).slice(0, 12)}…; ${after.members} members, ${after.receipts} receipts, by-laws v${after.config.version} intact`);
