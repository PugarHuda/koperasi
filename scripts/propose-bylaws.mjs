// node scripts/propose-bylaws.mjs <config file> <proposer> <points> "<why>" [voter ...]
// A member proposes new by-laws for the agent; the listed members vote. Uses keys in .keys/ (testnet demo accounts).
import fs from "node:fs";
import path from "node:path";
import { ROOT, DEPLOYMENT, account, decide, fnCall, sha256, view } from "./lib.mjs";

const [file, proposer, points, why, ...voters] = process.argv.slice(2);
if (!file || !proposer || !why) {
  console.error('usage: node scripts/propose-bylaws.mjs config/config.v3.yaml kop-bob-….testnet 5 "why" [voter ...]');
  process.exit(1);
}
const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const raw = fs.readFileSync(path.join(ROOT, file));
const version = Number(raw.toString().match(/^version:\s*(\d+)/m)?.[1]);
const hash = sha256(raw);
const before = await view(dep.contract, "get_config");
if (version !== before.version + 1) throw new Error(`${file} says version ${version}; the next version is ${before.version + 1}`);

const { id, status } = await decide(account(proposer), [proposer, ...voters].map(account), dep.dao, `By-laws v${version}: ${why}`,
  fnCall(dep.contract, "set_config", { version, hash, uri: file, contributor: proposer, points: Number(points) || 0 }));
const after = await view(dep.contract, "get_config");
console.log(`proposal #${id} ${status}; the contract now holds by-laws v${after.version} ${after.hash.slice(0, 12)}…`);
if (after.hash !== hash) process.exit(1);
dep.configUri = file;
dep.configHash = hash;
fs.writeFileSync(DEPLOYMENT, JSON.stringify(dep, null, 2) + "\n");
