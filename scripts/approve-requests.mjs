// node scripts/approve-requests.mjs
// The members (whose keys are in .keys/) vote on open requests to join the showcase co-op.
//  - only accounts that already paid the join deposit are approved, at most MAX_PER_RUN per run;
//  - right after approval the script syncs the membership, which locks the deposit as a member's deposit;
//  - then it sweeps: anyone holding the DAO's member role without being a member of the contract (for example someone
//    who cancelled their deposit between the vote and the sync) is proposed for removal and voted out.
// ponytail: closing the vote→sync gap in the contract itself (refuse cancel_join while a request is open) needs a
// contract upgrade; the sweep bounds it to "until the next run" instead.
import fs from "node:fs";
import { DEPLOYMENT, account, call, decide, hasKey, view, vote } from "./lib.mjs";

const MAX_PER_RUN = 3;
const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const roleOf = async () => (await view(dep.dao, "get_policy")).roles.find((r) => r.name === "member")?.kind?.Group ?? [];
const voters = (await roleOf()).filter(hasKey);
if (!voters.length) throw new Error("no member keys in .keys/");
const isMember = async (who) => (await view(dep.contract, "get_member", { account_id: who })) !== null;

const last = await view(dep.dao, "get_last_proposal_id");
const open = (await view(dep.dao, "get_proposals", { from_index: Math.max(0, last - 100), limit: 100 }))
  .filter((p) => p.status === "InProgress" && p.kind.AddMemberToRole?.role === "member");

let approved = 0;
for (const p of open) {
  const who = p.kind.AddMemberToRole.member_id;
  if (approved >= MAX_PER_RUN) { console.log(`#${p.id} ${who}: left for the next run (limit ${MAX_PER_RUN})`); continue; }
  if (!(await view(dep.contract, "is_pending", { account_id: who }))) {
    console.log(`#${p.id} ${who}: has not paid the join deposit; skipped`);
    continue;
  }
  for (const v of voters) {
    const now = await view(dep.dao, "get_proposal", { id: p.id });
    if (now.status !== "InProgress") break;
    if (now.votes[v]) continue;
    await vote(account(v), dep.dao, p.id);
  }
  const status = (await view(dep.dao, "get_proposal", { id: p.id })).status;
  if (status === "Approved") {
    approved++;
    await call(account(voters[0]), dep.contract, "sync_member", { account_id: who }, { tgas: 60 });
  }
  console.log(`#${p.id} ${who}: ${status}${status === "Approved" ? `, member of the contract: ${await isMember(who)}` : ""}`);
}
if (!open.length) console.log("no open requests to join");

// sweep: the DAO role must match the contract's members
for (const who of await roleOf()) {
  if (await isMember(who)) continue;
  console.log(`${who} holds the member role but is not a member of the contract (no deposit): voting them out`);
  const members = (await roleOf()).filter(hasKey).map(account);
  await decide(members[0], members, dep.dao, `Remove ${who}: holds the member role without a join deposit`,
    { RemoveMemberFromRole: { member_id: who, role: "member" } });
}
