// Tasks with earned trust (contract/src/tasks.rs). Keys in .keys/; testnet demo accounts. Payouts are Transfer proposals
// from the DAO treasury, filed and approved by the contract's DAO role `tasks` (scripts/lib.mjs: tasksRole).
//   node scripts/tasks.mjs rule <auto NEAR> <one-vote NEAR> <trusted by n sources> <per-poster NEAR a day> <points>
//                                                                              members vote the trust rule
//   node scripts/tasks.mjs budget <NEAR>                                       members vote how much the contract may pay
//   node scripts/tasks.mjs post <member> <NEAR> "<task>"                       a member posts a task
//   node scripts/tasks.mjs claim|submit <id> <account> ["<link to the work>"]  anyone takes it, then delivers
//   node scripts/tasks.mjs accept <id> <poster>                                paid at once if small and trusted
//   node scripts/tasks.mjs approve <id> <member>                               one other member approves the rest
//   node scripts/tasks.mjs credit <proposal id> <account>                      count an approved DAO bounty payout
//   node scripts/tasks.mjs settle <id> <account>                               re-read a payout the members voted by hand
//   node scripts/tasks.mjs list
// Larger tasks than the one-vote limit are Sputnik bounties (scripts/bounty.mjs), voted by all; `credit` adds them.
import fs from "node:fs";
import { DEPLOYMENT, NEAR, account, callRaw, decide, fnCall, hasKey, txUrl, view } from "./lib.mjs";

const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const [cmd, ...a] = process.argv.slice(2);
const yocto = (n) => {
  if (!/^\d+(\.\d{1,24})?$/.test(n ?? "")) throw new Error(`not a NEAR amount: ${n}`);
  const [w, f = ""] = n.split(".");
  return (BigInt(w) * NEAR + BigInt(f.padEnd(24, "0"))).toString();
};
const near = (y) => (Number(BigInt(y) / 10n ** 21n) / 1000).toString();
const voters = async () => ((await view(dep.dao, "get_policy")).roles.find((r) => r.name === "member")?.kind?.Group ?? [])
  .filter(hasKey).map(account);
const send = async (who, method, args, deposit = 0n, tgas = 100) => {
  const r = await callRaw(account(who), dep.contract, method, args, { deposit, tgas });
  const fail = r.receipts_outcome.find((o) => o.outcome.status.Failure);
  if (fail) throw new Error(`${method}: ${JSON.stringify(fail.outcome.status.Failure)}`);
  const logs = r.receipts_outcome.flatMap((o) => o.outcome.logs);
  console.log(`${who} ${method}: ${txUrl(r.transaction.hash)}${logs.length ? `\n   ${logs.join("\n   ")}` : ""}`);
};
const byVote = async (what, method, args, deposit = "0") => {
  const v = await voters();
  const { id } = await decide(v[0], v, dep.dao, what, fnCall(dep.contract, method, args, { deposit, tgas: 50 }));
  console.log(`proposal #${id} approved: ${what}`);
};

if (cmd === "rule") {
  const [auto, one, n, day, points] = a;
  await byVote(`Tasks: no vote up to ${auto} NEAR once trusted by ${n} sources, ${day} NEAR a day per poster; one member up to ${one} NEAR; ${points} points a task`,
    "set_trust", { rule: { auto_max: yocto(auto), one_vote_max: yocto(one), trusted_after: Number(n), poster_daily_auto: yocto(day), points: Number(points) } });
} else if (cmd === "budget") {
  await byVote(`Tasks: the contract may pay ${a[0]} NEAR more from the treasury`, "set_task_budget", { amount: yocto(a[0]) });
} else if (cmd === "post") {
  const [who, amount, what] = a;
  await send(who, "post_task", { description: what, amount: yocto(amount) }, NEAR / 100n);
} else if (cmd === "claim") {
  await send(a[1], "claim_task", { id: Number(a[0]) });
} else if (cmd === "submit") {
  await send(a[1], "submit_task", { id: Number(a[0]), deliverable: a[2] });
} else if (cmd === "accept") {
  await send(a[1], "accept_task", { id: Number(a[0]) }, 0n, 200);
} else if (cmd === "approve") {
  await send(a[1], "approve_task", { id: Number(a[0]) }, 0n, 300);
} else if (cmd === "settle") {
  await send(a[1], "settle_task", { id: Number(a[0]) });
} else if (cmd === "credit") {
  await send(a[1], "credit_dao_bounty", { proposal_id: Number(a[0]) });
} else {
  const b = await view(dep.contract, "get_board");
  const r = b.rule;
  console.log(r ? `rule: no vote ≤ ${near(r.auto_max)} NEAR once trusted by ${r.trusted_after} sources, ${near(r.poster_daily_auto)} NEAR a day per poster; one member ≤ ${near(r.one_vote_max)} NEAR; ${r.points} points`
    : "no trust rule yet", `| the contract may pay ${near(b.budget)} NEAR more`);
  for (const t of await view(dep.contract, "get_tasks", { limit: 200 })) {
    const pid = await view(dep.contract, "get_payout_proposal", { id: t.id });
    console.log(`#${t.id} ${t.status} ${near(t.amount)} NEAR "${t.description}" by ${t.poster}` +
      `${t.contributor ? `, to ${t.contributor}` : ""}${t.approved_by ? `, approved by ${t.approved_by}` : ""}${pid === null ? "" : `, DAO proposal #${pid}`}`);
  }
  for (const [who, rec] of await view(dep.contract, "get_contributors")) {
    console.log(`${who}: ${rec.done} done, ${await view(dep.contract, "get_trust_sources", { account_id: who })} sources (${rec.refs.join(", ")})`);
  }
}
