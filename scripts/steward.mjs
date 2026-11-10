// node scripts/steward.mjs <steward> <bond NEAR> <proposer> [voter ...]
// The members (re)appoint the steward by a DAO vote (set_steward), so the 7-day rule of slash_overdue applies to them
// from now on; then the steward posts the bond. In this order: a bond posted before the vote would be returned by it.
import fs from "node:fs";
import { DEPLOYMENT, NEAR, account, callRaw, decide, fnCall, txUrl, view } from "./lib.mjs";

const [steward, bond, proposer, ...voters] = process.argv.slice(2);
if (!steward || !bond || !proposer) throw new Error("usage: node scripts/steward.mjs <steward> <bond NEAR> <proposer> [voter ...]");
const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const { id } = await decide(account(proposer), voters.map(account), dep.dao, `Appoint ${steward} as steward under contract 0.2.3: anyone can slash the bond if a paid job's earnings are more than 7 days late`,
  fnCall(dep.contract, "set_steward", { steward }, { tgas: 50 }));
console.log(`proposal #${id} approved: set_steward(${steward})`);
const out = await callRaw(account(steward), dep.contract, "bond_steward", {}, { deposit: BigInt(Math.round(Number(bond) * 1000)) * NEAR / 1000n, tgas: 30 });
const info = await view(dep.contract, "get_info");
console.log(`bond posted${out?.transaction ? `: ${txUrl(out.transaction.hash)}` : ""}; steward ${info.steward}, bond ${Number(BigInt(info.steward_bond) / 10n ** 21n) / 1000} NEAR, overdue ${await view(dep.contract, "get_overdue")}`);
