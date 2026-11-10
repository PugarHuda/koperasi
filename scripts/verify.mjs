// Read-only: checks the README's claims about the showcase co-op against NEAR testnet. No keys, no transactions.
// Usage: npm run verify   (exit code 1 if any claim fails)
import fs from "node:fs";
import path from "node:path";
import { baseEncode } from "near-api-js";
import { DEPLOYMENT, ROOT, rawQuery, sha256, accountUrl } from "./lib.mjs";

const d = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
// ponytail: rawQuery (plain fetch with a timeout, RPC failover) for every read, so a hung RPC fails instead of hanging
const view = async (account_id, method_name, args = {}) => {
  const r = await rawQuery({ request_type: "call_function", account_id, method_name, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  return JSON.parse(Buffer.from(r.result).toString());
};
const argsOf = (p) => p.kind.FunctionCall?.actions.map((a) => ({ method: a.method_name, args: JSON.parse(Buffer.from(a.args, "base64").toString()) })) ?? [];

const near = (y) => Number(BigInt(y) / 10n ** 18n) / 1e6;
const usd = (u) => (Number(u) / 1e6).toFixed(2);
let failed = 0;
const check = (ok, claim, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${claim}\n      ${detail}`);
};

console.log(`Koperasi showcase co-op, ${d.network}: contract ${d.contract}, DAO ${d.dao}\n`);
const [info, policy, board, contributors, audit] = await Promise.all([
  view(d.contract, "get_info"), view(d.dao, "get_policy"), view(d.contract, "get_board"),
  view(d.contract, "get_contributors"), view(d.contract, "get_audit"),
]);
const proposal = (id) => view(d.dao, "get_proposal", { id });
// every DAO proposal, to find the vote behind each claim instead of trusting a number in the README
const last = await view(d.dao, "get_last_proposal_id");
const proposals = [];
for (let from = 0; from < last; from += 100) proposals.push(...await view(d.dao, "get_proposals", { from_index: from, limit: 100 }));
const approvedCall = (method, ok) => proposals.find((p) => p.status === "Approved" && argsOf(p).some((a) => a.method === method && ok(a.args)));

// 1. by-laws
const fileHash = sha256(fs.readFileSync(path.join(ROOT, d.configUri)));
const byLaws = approvedCall("set_config", (a) => a.hash === info.config.hash);
check(fileHash === info.config.hash && byLaws, `the agent's by-laws ${d.configUri} are the ones the members voted`,
  `file sha256 ${fileHash.slice(0, 16)}…, contract ${info.config.hash.slice(0, 16)}… v${info.config.version}, voted in proposal #${byLaws?.id}`);

// 2. contract code: the global contract the members voted, no full-access key
const acct = await rawQuery({ request_type: "view_account", account_id: d.contract });
const code = acct.global_contract_hash ?? acct.code_hash;
const want = baseEncode(Buffer.from(d.codeSha256, "hex"));
const upgraded = approvedCall("upgrade", (a) => a.code_hash === code);
check(code === want && upgraded, "the contract runs the global contract the members voted",
  `on-chain ${code}, deployment.testnet.json ${want}, voted in proposal #${upgraded?.id}`);
const keys = (await rawQuery({ request_type: "view_access_key_list", account_id: d.contract })).keys;
const full = keys.filter((k) => k.access_key.permission === "FullAccess").length;
check(full === 0, "nobody holds a full-access key to the contract, the builder included", `${keys.length} keys, ${full} full-access`);

// 3. the agent can only record receipts
const agentKeys = (await rawQuery({ request_type: "view_access_key_list", account_id: d.agent })).keys;
const scoped = agentKeys.length > 0 && agentKeys.every((k) => {
  const fc = k.access_key.permission.FunctionCall;
  return fc && fc.receiver_id === d.contract && fc.method_names.length > 0 && fc.method_names.every((m) => ["record_receipt", "update_receipt"].includes(m));
});
check(scoped, "the agent account has only function-call keys for record_receipt / update_receipt",
  agentKeys.map((k) => JSON.stringify(k.access_key.permission)).join("; "));

// 4. membership comes from the DAO policy
const role = policy.roles.find((r) => r.name === "member");
const daoMembers = new Set(role?.kind.Group ?? []);
const members = await view(d.contract, "get_members", { from: 0, limit: 200 });
const outside = members.filter(([a]) => !daoMembers.has(a)).map(([a]) => a);
check(outside.length === 0 && members.length === info.members, "every member in the contract holds role `member` in the Sputnik DAO",
  `${members.length} in the contract, ${daoMembers.size} in the DAO role${outside.length ? `; not in the DAO: ${outside.join(", ")}` : ""}`);
const vp = role?.vote_policy?.["*"] ?? policy.default_vote_policy;
check(vp.weight_kind === "RoleWeight" && JSON.stringify(vp.threshold) === "[1,2]", "one member, one vote: RoleWeight, threshold 1/2",
  `${vp.weight_kind}, threshold ${JSON.stringify(vp.threshold)}`);

// 5. earned trust: the contract pays only through its own DAO role, and every point of a record traces to a payout
const tasksRole = policy.roles.find((x) => x.name === "tasks");
check(JSON.stringify(tasksRole?.kind) === JSON.stringify({ Group: [d.contract] })
  && [...tasksRole.permissions].sort().join() === "transfer:AddProposal,transfer:VoteApprove",
  "the contract's DAO role `tasks` may only file and approve transfer proposals", JSON.stringify(tasksRole && [tasksRole.kind, tasksRole.permissions]));
const r = board.rule;
const ruleVote = approvedCall("set_trust", (a) => JSON.stringify(a.rule) === JSON.stringify(r));
check(r && ruleVote && BigInt(r.auto_max) <= BigInt(r.one_vote_max) && r.trusted_after >= 1, "the trust tiers were voted and trust must be earned",
  r ? `no vote ≤ ${near(r.auto_max)} NEAR once trusted by ${r.trusted_after} different source(s), ≤ ${near(r.poster_daily_auto)} NEAR a day per poster; one other member ≤ ${near(r.one_vote_max)} NEAR; above: DAO bounty; ${r.points} points a task; the contract may pay ${near(board.budget)} NEAR more; voted in proposal #${ruleVote?.id}` : "no rule");
const tasks = await view(d.contract, "get_tasks", { from: 0, limit: 200 });
for (const t of tasks.filter((x) => x.status === "Paid")) {
  const pid = await view(d.contract, "get_payout_proposal", { id: t.id });
  const how = t.approved_by ? `approved by ${t.approved_by}` : "earned trust, no vote";
  if (pid === null) {
    console.log(`INFO  task #${t.id}: ${near(t.amount)} NEAR to ${t.contributor}, ${how}; paid by the contract itself, before payouts moved into the DAO`);
    continue;
  }
  const p = await proposal(pid);
  const tr = p.kind.Transfer;
  check(p.status === "Approved" && p.proposer === d.contract && tr?.token_id === "" && tr.receiver_id === t.contributor && tr.amount === t.amount,
    `task #${t.id} was paid from the treasury by DAO proposal #${pid}, filed by the contract`,
    `${near(t.amount)} NEAR to ${t.contributor}, ${how}; proposal ${p.status}, proposer ${p.proposer}, ${JSON.stringify(tr)}`);
}
for (const [who, rec] of contributors) {
  const bad = [];
  for (const ref of rec.refs) {
    const [kind, id] = ref.split(":");
    if (kind === "task") {
      const t = tasks.find((x) => x.id === Number(id));
      if (!(t?.status === "Paid" && t.contributor === who)) bad.push(ref);
    } else if (kind === "dao-proposal") {
      const p = await proposal(Number(id));
      if (!(p.status === "Approved" && p.kind.BountyDone?.receiver_id === who)) bad.push(ref);
    } else bad.push(ref);
  }
  const sources = await view(d.contract, "get_trust_sources", { account_id: who });
  check(bad.length === 0 && rec.refs.length === rec.done, `${who}'s record: ${rec.done} finished, each traced to its source`,
    `${rec.refs.join(", ")}; trusted by ${sources} different source(s)${bad.length ? `; does not check out: ${bad.join(", ")}` : ""}`);
}

// 6. profit shares: USDC left the treasury only by a members' vote, through the contract's split
const shares = proposals.filter((p) => p.status === "Approved" && argsOf(p).some((a) => a.method === "ft_transfer_call" && a.args.receiver_id === d.contract && a.args.msg === "share"));
check(shares.length > 0, "the members voted every profit share out of the treasury, split by the contract",
  shares.map((p) => `#${p.id}: ${usd(argsOf(p)[0].args.amount)} USDC, approved by ${Object.keys(p.votes).length} members`).join("; ") || "none");

// 7. what the README admits: no real jobs yet, audit red on purpose, treasury empty
const receipts = await view(d.contract, "get_receipts", { from: 0, limit: 200 });
const proven = (await Promise.all(receipts.map((x) => view(d.contract, "get_proof", { job_id: x.job_id })))).filter(Boolean).length;
console.log(`INFO  receipts: ${receipts.length}, ${proven} with a TEE inference proof (0 = no real Agent Market job yet, as the README says)`);
console.log(`INFO  audit: expected ${usd(audit.expected)} USDC, deposited ${usd(audit.deposited)}, owed ${usd(audit.owed)} (red on purpose: the demo's last step has the steward keep a payout)`);
const usdc = await view(info.usdc_id, "ft_balance_of", { account_id: d.dao });
console.log(`INFO  DAO treasury: ${usd(usdc)} USDC (${info.usdc_id.slice(0, 12)}…)`);

console.log(`\n${failed ? `${failed} claim(s) FAILED` : "every claim checks out"}. Explorer: ${accountUrl(d.contract)}`);
process.exit(failed ? 1 : 0);
