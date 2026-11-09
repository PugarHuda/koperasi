// node scripts/flows.mjs [deployment file]
//
// Runs the co-op's main flows for real on the network (testnet by default) with the member keys in .keys/, and prints
// one line per transaction: the call, its tx link, the gas it burnt (all receipts), and the NEP-297 events it emitted.
// The last lines are a gas table in Markdown for docs/reports/03-contracts.md. It spends a little testnet NEAR and
// USDC from the DAO treasury (a 1 USDC profit share), and creates proposals the members vote.
//
// Flows: join → voted in → leave → deposit back; a task paid on earned trust; a task paid after one approval;
// a profit share voted and claimed; the steward's kill switch and the DAO's restart.
import fs from "node:fs";
import path from "node:path";
import { KeyPair } from "near-api-js";
import { DEPLOYMENT, NEAR, account, callRaw, decide, fnCall, hasKey, rawQuery, saveKey, txUrl, view } from "./lib.mjs";

const dep = JSON.parse(fs.readFileSync(process.argv[2] ? path.resolve(process.argv[2]) : DEPLOYMENT, "utf8"));
const K = dep.contract, D = dep.dao;
const info = await view(K, "get_info");
const USDC = info.usdc_id;
const policy = await view(D, "get_policy");
const members = policy.roles.find((r) => r.name === "member").kind.Group.filter(hasKey).map(account);
const by = (prefix) => members.find((m) => m.accountId.startsWith(prefix)) ?? members[0];
const [alice, bob, steward] = [by("kop-alice"), by("kop-bob"), by("kop-steward")];
const carol = account(fs.existsSync(path.join(import.meta.dirname, "..", ".keys")) && hasKey(`kop-carol-${dep.tag}.testnet`) ? `kop-carol-${dep.tag}.testnet` : alice.accountId);
const gasRows = new Map();

/** One transaction: gas burnt over all its receipts, its events, and its first failure (if any). */
async function tx(who, receiver, method, args = {}, { deposit = 0n, tgas = 100, label = method } = {}) {
  const r = await callRaw(who, receiver, method, args, { deposit, tgas });
  const outcomes = [r.transaction_outcome, ...r.receipts_outcome];
  const gas = outcomes.reduce((s, o) => s + BigInt(o.outcome.gas_burnt), 0n);
  const events = outcomes.flatMap((o) => o.outcome.logs).filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => JSON.parse(l.slice(11)).event);
  const fail = outcomes.find((o) => o.outcome.status.Failure);
  const tg = Number(gas / 10n ** 9n) / 1000;
  console.log(`${label.padEnd(26)} ${tg.toFixed(2).padStart(7)} Tgas  ${txUrl(r.transaction.hash)}${events.length ? `  [${events.join(", ")}]` : ""}${fail ? `  FAILURE ${JSON.stringify(fail.outcome.status.Failure).slice(0, 160)}` : ""}`);
  if (!fail && !gasRows.has(label)) gasRows.set(label, { tg, hash: r.transaction.hash, events });
  return r;
}
const decideLogged = async (proposer, description, kind) => {
  const { id } = await decide(proposer, members, D, description, kind);
  console.log(`${"DAO vote".padEnd(26)} proposal #${id} approved: ${description}`);
  return id;
};

// ---------- join, leave ----------
{
  const id = `kop-flow-${Date.now().toString(36)}.testnet`;
  const kp = KeyPair.fromRandom("ed25519");
  await callRaw(steward, "testnet", "create_account", { new_account_id: id, new_public_key: kp.getPublicKey().toString() }, { deposit: NEAR * 9n / 10n });
  saveKey(id, kp);
  const me = account(id);
  await tx(me, K, "join", {}, { deposit: BigInt(info.join_deposit), tgas: 30 });
  await tx(me, D, "add_proposal", { proposal: { description: `Accept ${id} as a member`, kind: { AddMemberToRole: { member_id: id, role: "member" } } } },
    { deposit: BigInt(policy.proposal_bond), tgas: 50, label: "add_proposal (join)" });
  const join = (await view(D, "get_last_proposal_id")) - 1;
  for (const v of members) {
    if ((await view(D, "get_proposal", { id: join })).status !== "InProgress") break;
    await tx(v, D, "act_proposal", { id: join, action: "VoteApprove", proposal: { AddMemberToRole: { member_id: id, role: "member" } } }, { tgas: 200, label: "act_proposal (vote)" });
  }
  await tx(me, K, "sync_member", { account_id: id }, { tgas: 60, label: "sync_member (admit)" });
  const leave = { RemoveMemberFromRole: { member_id: id, role: "member" } };
  await tx(me, D, "add_proposal", { proposal: { description: `Remove ${id}: they asked to leave`, kind: leave } },
    { deposit: BigInt(policy.proposal_bond), tgas: 50, label: "add_proposal (leave)" });
  const pid = (await view(D, "get_last_proposal_id")) - 1;
  for (const v of [...members, me]) {
    if ((await view(D, "get_proposal", { id: pid })).status !== "InProgress") break;
    await tx(v, D, "act_proposal", { id: pid, action: "VoteApprove", proposal: leave }, { tgas: 200, label: "act_proposal (vote)" });
  }
  await tx(me, K, "sync_member", { account_id: id }, { tgas: 60, label: "sync_member (leave)" });
}

// ---------- tasks with earned trust ----------
const post = async (amount) => {
  await tx(alice, K, "post_task", { description: `flows.mjs: a task paid from the treasury, ${amount} NEAR`, amount: (BigInt(Math.round(amount * 1000)) * NEAR / 1000n).toString() },
    { deposit: NEAR / 100n, tgas: 30 });
  return (await view(K, "get_board")).tasks - 1;
};
{
  // carol is trusted by 2 different sources: a small task pays when alice accepts
  const id = await post(0.02);
  await tx(carol, K, "claim_task", { id }, { tgas: 30 });
  await tx(carol, K, "submit_task", { id, deliverable: "https://github.com/PugarHuda/koperasi/blob/main/docs/reports/03-contracts.md" }, { tgas: 30 });
  await tx(alice, K, "accept_task", { id }, { tgas: 200, label: "accept_task (on trust)" });
  // a newcomer's task waits for one other member
  const id2 = await post(0.02);
  const newcomer = steward;
  await tx(newcomer, K, "claim_task", { id: id2 }, { tgas: 30, label: "claim_task" });
  await tx(newcomer, K, "submit_task", { id: id2, deliverable: "https://github.com/PugarHuda/koperasi/blob/main/scripts/flows.mjs" }, { tgas: 30 });
  await tx(alice, K, "accept_task", { id: id2 }, { tgas: 200, label: "accept_task (needs vote)" });
  await tx(bob, K, "approve_task", { id: id2 }, { tgas: 300 });
  for (const t of await view(K, "get_tasks", { from: id, limit: 2 })) console.log(`   task #${t.id}: ${t.status}, DAO proposal #${await view(K, "get_payout_proposal", { id: t.id })}`);
}

// ---------- profit share ----------
{
  const treasury = BigInt(await view(USDC, "ft_balance_of", { account_id: D }));
  if (treasury >= 1_000_000n) {
    await decideLogged(alice, "flows.mjs: profit share of 1 USDC", fnCall(USDC, "ft_transfer_call", { receiver_id: K, amount: "1000000", msg: "share" }, { deposit: "1", tgas: 200 }));
    for (const m of members) {
      if (BigInt(await view(K, "get_claimable", { account_id: m.accountId })) === 0n) continue;
      if (!(await view(USDC, "storage_balance_of", { account_id: m.accountId }))) {
        await tx(m, USDC, "storage_deposit", { account_id: m.accountId, registration_only: true }, { deposit: NEAR / 100n, tgas: 30 });
      }
      await tx(m, K, "claim_share", {}, { tgas: 60 });
      break;
    }
  } else console.log("treasury below 1 USDC: profit share skipped");
}

// ---------- kill switch ----------
if (info.steward && hasKey(info.steward)) {
  await tx(account(info.steward), K, "pause", {}, { tgas: 30 });
  await decideLogged(alice, "flows.mjs: restart the agent after the steward's pause", fnCall(K, "unpause", {}, { tgas: 30 }));
  console.log(`   paused now: ${(await view(K, "get_info")).paused}`);
}

console.log("\n| Function | Gas burnt (all receipts) | Events | Transaction |\n|---|---|---|---|");
for (const [label, g] of gasRows) {
  console.log(`| \`${label}\` | ${g.tg.toFixed(2)} Tgas | ${g.events.join(", ") || "–"} | [${g.hash.slice(0, 8)}…](${txUrl(g.hash)}) |`);
}
const acct = await rawQuery({ request_type: "view_account", account_id: K });
console.log(`\ncontract storage: ${acct.storage_usage} bytes`);
