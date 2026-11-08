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

// 1. by-laws
const fileHash = sha256(fs.readFileSync(path.join(ROOT, d.configUri)));
const p7 = await proposal(7);
const voted = p7.status === "Approved" && argsOf(p7).some((a) => a.method === "set_config" && a.args.hash === info.config.hash);
check(fileHash === info.config.hash && voted, `the agent's by-laws ${d.configUri} are the ones the members voted (proposal #7)`,
  `file sha256 ${fileHash.slice(0, 16)}…, contract ${info.config.hash.slice(0, 16)}… v${info.config.version}, proposal #7 ${p7.status}`);

// 2. contract code: the global contract the members voted, no full-access key
const acct = await rawQuery({ request_type: "view_account", account_id: d.contract });
const code = acct.global_contract_hash ?? acct.code_hash;
const want = baseEncode(Buffer.from(d.codeSha256, "hex"));
const p25 = await proposal(25);
const upgraded = p25.status === "Approved" && argsOf(p25).some((a) => a.method === "upgrade" && a.args.code_hash === code);
check(code === want && upgraded, "the contract runs the global contract the members voted (proposal #25)",
  `on-chain ${code}, deployment.testnet.json ${want}, proposal #25 ${p25.status}`);
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

// 5. earned trust: every point of every record names a task or DAO proposal that really paid that account
const r = board.rule;
check(r && BigInt(r.auto_max) <= BigInt(r.one_vote_max) && r.trusted_after >= 1, "the trust tiers were voted and trust must be earned",
  r ? `auto ≤ ${near(r.auto_max)} NEAR after ${r.trusted_after} finished task(s), one other member ≤ ${near(r.one_vote_max)} NEAR, above: DAO bounty; budget ${near(board.budget)} NEAR` : "no rule");
const tasks = await view(d.contract, "get_tasks", { from: 0, limit: 200 });
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
  check(bad.length === 0 && rec.refs.length === rec.done, `${who}'s record: ${rec.done} finished, each traced to its source`,
    `${rec.refs.join(", ")}${bad.length ? `; does not check out: ${bad.join(", ")}` : ""}`);
}
const paidBy = (t) => (t.approved_by ? `approved by ${t.approved_by}` : "earned trust, no vote");
for (const t of tasks) console.log(`      task #${t.id} ${t.status}, ${near(t.amount)} NEAR to ${t.contributor ?? "-"}${t.status === "Paid" ? `, ${paidBy(t)}` : ""}`);

// 6. what the README admits: no real jobs yet, audit red on purpose, treasury empty
const receipts = await view(d.contract, "get_receipts", { from: 0, limit: 200 });
const proven = (await Promise.all(receipts.map((x) => view(d.contract, "get_proof", { job_id: x.job_id })))).filter(Boolean).length;
console.log(`INFO  receipts: ${receipts.length}, ${proven} with a TEE inference proof (0 = no real Agent Market job yet, as the README says)`);
console.log(`INFO  audit: expected ${usd(audit.expected)} USDC, deposited ${usd(audit.deposited)}, owed ${usd(audit.owed)} (red on purpose: the demo's last step has the steward keep a payout)`);
const usdc = await view(info.usdc_id, "ft_balance_of", { account_id: d.dao });
console.log(`INFO  DAO treasury: ${usd(usdc)} USDC (${info.usdc_id.slice(0, 12)}…)`);

console.log(`\n${failed ? `${failed} claim(s) FAILED` : "every claim checks out"}. Explorer: ${accountUrl(d.contract)}`);
process.exit(failed ? 1 : 0);
