// node scripts/sync-savings.mjs
// Reads every member's stake in the co-op's staking pool on-chain and writes it as their savings (sync_savings is
// open to anyone; this signs with any key in .keys/ that belongs to a member).
import fs from "node:fs";
import { DEPLOYMENT, account, all, call, hasKey, view } from "./lib.mjs";

const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const pool = await view(dep.contract, "get_staking_pool");
if (!pool) throw new Error("the DAO has not chosen a staking pool (set_staking_pool)");
const members = await all(dep.contract, "get_members");
const signer = members.map(([a]) => a).find(hasKey);
if (!signer) throw new Error("no member key in .keys/ to sign with");
for (const [who] of members) {
  await call(account(signer), dep.contract, "sync_savings", { account_id: who }, { tgas: 40 });
  const m = await view(dep.contract, "get_member", { account_id: who });
  console.log(`${who.padEnd(34)} staked in ${pool}: ${(Number(BigInt(m.savings) / 10n ** 21n) / 1000).toFixed(3)} NEAR`);
}
