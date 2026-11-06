// node scripts/approve-requests.mjs
// The members (whose keys are in .keys/) vote on open requests to join the showcase co-op. Only requests from accounts
// that already paid the join deposit are approved; the rest are left for a human to look at.
import fs from "node:fs";
import { DEPLOYMENT, account, hasKey, view, vote } from "./lib.mjs";

const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const policy = await view(dep.dao, "get_policy");
const voters = (policy.roles.find((r) => r.name === "member")?.kind?.Group ?? []).filter(hasKey);
const last = await view(dep.dao, "get_last_proposal_id");
const open = (await view(dep.dao, "get_proposals", { from_index: Math.max(0, last - 100), limit: 100 }))
  .filter((p) => p.status === "InProgress" && p.kind.AddMemberToRole?.role === "member");

for (const p of open) {
  const who = p.kind.AddMemberToRole.member_id;
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
  console.log(`#${p.id} ${who}: ${(await view(dep.dao, "get_proposal", { id: p.id })).status}`);
}
if (!open.length) console.log("no open requests to join");
