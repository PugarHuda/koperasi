// node --env-file=.env scripts/agent-review.mjs [year]   the members' meeting reviews the agent, as it reviews the board
//
// The annual meeting (scripts/rat.mjs) approves the year's accounts. A co-op that owns an agent also asks how the agent
// did: here the facts about the agent are read from the chain (its jobs and their outcomes, the cases against it and its
// strikes, its savings and its share of the surplus, every by-laws proposal it made and what came of it, its TEE
// worker's attestation, work passed between co-ops) and saved as web/rat/agent-<year>.facts.json; the agent writes its
// own review from those facts only, with the voted model on a TEE-verified server, including its mistakes; the members
// vote to accept the review (a Sputnik "Vote" proposal whose description carries both files' sha256). Rejected, the
// review stands as written but unaccepted. `npm run verify` hashes the files against the proposal.
import fs from "node:fs";
import path from "node:path";
import { infer, loadApprovedConfig } from "../agent/runtime.mjs";
import { DEPLOYMENT, ROOT, account, all, propose, sha256, view, vote } from "./lib.mjs";

const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const K = dep.contract, D = dep.dao;
const year = Number(process.argv[2] ?? new Date().getUTCFullYear());
const usd = (x) => Number(x) / 1e6;
const [receipts, cases, standing, risk, member, proposals, history] = await Promise.all([all(K, "get_receipts"), all(K, "get_cases"),
  view(K, "get_agent_standing"), view(K, "get_risk_fund"), view(K, "get_agent_member"), view(K, "get_agent_proposals"), view(K, "get_config_history", {})]);
const props = await Promise.all(proposals.map(async (p) => ({ ...p, status: (await view(D, "get_proposal", { id: p.proposal })).status })));
// plain names: the first review (DAO #141, rejected) read "stand_in_market" as an outside market and the TEE worker as itself
const kind = (r) => (r.job_id.startsWith("taskbond-") ? "judged_and_paid_by_an_outside_market_taskbond"
  : r.job_id.startsWith("demo-court") ? "demo_jobs_made_for_court_cases" : "demo_jobs_from_the_builders_stand_in_market_not_outside");
const facts = {
  agent: dep.agent, contract: K, year, read_at: new Date().toISOString(),
  jobs: {
    total: receipts.length,
    by_kind: Object.fromEntries(["judged_and_paid_by_an_outside_market_taskbond", "demo_jobs_from_the_builders_stand_in_market_not_outside",
      "demo_jobs_made_for_court_cases"].map((k) => [k, receipts.filter((r) => kind(r) === k).length])),
    taskbond_jobs_each_scored_95_of_100_by_taskbonds_reviewer: receipts.filter((r) => kind(r) === "judged_and_paid_by_an_outside_market_taskbond").length,
    by_status: Object.fromEntries(["Paid", "Submitted", "Refunded", "Disputed"].map((s) => [s, receipts.filter((r) => r.status === s).length])),
    done_by_a_tee_verified_model: receipts.filter((r) => BigInt(r.inference_cost) > 0n || r.job_id.startsWith("taskbond-")).length,
  },
  court: { cases_brought_against_its_jobs: cases.length, upheld: cases.filter((c) => c.status === "Upheld").length, live_strikes: standing.strikes.length,
    suspended_now: standing.suspended, was_suspended_and_reinstated: Boolean(standing.reinstated_at) },
  money: { risk_fund_usdc_its_savings_that_refund_buyers: usd(risk[0]), percent_of_its_earnings_it_saves: risk[1] / 100,
    percent_of_each_profit_share_voted_to_it: member.share_bps / 100, its_share_now_scaled_to_percent_by_court_strikes: member.standing_bps / 100,
    surplus_received_into_its_savings_usdc: usd(member.shu_total) },
  by_laws_proposals: props.map((p) => ({ version: p.version, dao_proposal: p.proposal, status: p.status, reason: p.reason.slice(0, 300) })),
  by_laws_history: history.map((h) => ({ version: h.version, contributor: h.contributor, at: new Date(Number(h.activated_at) / 1e6).toISOString().slice(0, 10) })),
  known_mistakes: [
    "by-laws proposal for v7 (DAO #123) named the agent as contributor, so its call failed; the members passed the same file by #124",
    "by-laws v9 (DAO #139) cut the price from an average that counted a Taskbond job (paid in testnet NEAR, 0 USDC on its receipt) as a sale; the members approved it, then restored v8 as v10 (#140); the agent's facts now average USDC sales only",
  ],
  a_second_agent_not_this_one_runs_in_a_tee: dep.tee?.receipt ? { worker: dep.tee.worker, registry: dep.tee.registry, receipt: dep.tee.receipt, approved_by: dep.tee.approve, admitted_by: dep.tee.admit } : null,
  work_passed_between_coops: (dep.federation?.trades ?? []).map((t) => ({ job: t.job, coop: t.coop, share: usd(t.share), proposal: t.proposal })),
};
const dir = path.join(ROOT, "web", "rat");
// this agent (dep.agent) runs outside a TEE; the TEE worker is a second agent the members admitted
const factsText = `${JSON.stringify(facts, null, 2)}\n`;
fs.writeFileSync(path.join(dir, `agent-${year}.facts.json`), factsText);
const { config } = await loadApprovedConfig(dep);
const job = {
  title: `The members' meeting ${year}: the agent's own review`,
  description: `You are the co-op's agent. Write your own review for the members' meeting, in English, from ONLY the FACTS (read from the chain); add nothing, and say plainly what they do not show. Sections: 1. The work (how many jobs, of which kinds, how they ended; which were judged by an outside market); 2. The court (cases upheld against your work, strikes, suspension); 3. Your money (what you saved, your share of the surplus, the risk fund); 4. Your by-laws proposals and what came of each, including your mistakes, stated plainly; 5. Running in a TEE and working with the sister co-op; 6. What you ask the members to watch next year. Six short paragraphs, under 250 words, plain sentences, no tables, no praise of yourself.\n\nFACTS:\n${factsText}`,
};
const done = await infer(config, job, Math.round(config.limits.max_inference_per_job_usd * 1e6), { maxTokens: 6000, brief: true });
if (!done.proof?.model) throw new Error("no TEE proof: the review is not written");
const known = new Set((factsText.match(/\d+(\.\d+)?/g) ?? []).map(Number));
const unknown = [...new Set((done.text.match(/\d+\.\d+/g) ?? []).filter((x) => ![...known].some((k) => Math.abs(k - Number(x)) < 0.006)))];
const report = `# The agent's review, ${year}: ${K}\n\n_Written by the co-op's agent (model ${done.proof.model}) inside a TEE-verified NEAR AI Cloud server from [the facts read from the chain](agent-${year}.facts.json) (sha256 ${sha256(factsText)}). Inference ${done.proof.inference_id}, response signed by TEE key ${done.proof.tee_signer}. The members accept it or not by DAO vote.${unknown.length ? ` Figures not found as such in the facts (check them): ${unknown.join(", ")}.` : " Every decimal figure in it is in the facts."}_\n\n${done.text.trim()}\n`;
fs.writeFileSync(path.join(dir, `agent-${year}.md`), report);
console.log(report);
const desc = `The members' meeting ${year} accepts the agent's own review: web/rat/agent-${year}.md sha256 ${sha256(report)}, from facts web/rat/agent-${year}.facts.json sha256 ${sha256(factsText)}`;
const id = await propose(account("kop-alice-mw4i3w8f.testnet"), D, desc, "Vote");
console.log(`DAO proposal #${id} (Vote): ${desc}`);
for (const f of [DEPLOYMENT, path.join(ROOT, "web/deployment.json")]) {
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  d.agentReview = { year, proposal: id, report: `rat/agent-${year}.md`, facts: `rat/agent-${year}.facts.json`, report_sha256: sha256(report), facts_sha256: sha256(factsText),
    inference: done.proof.inference_id };
  fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
}
if (process.argv.includes("--accept")) for (const v of ["kop-alice-mw4i3w8f.testnet", "kop-bob-mw4i3w8f.testnet", dep.steward]) {
  if ((await view(D, "get_proposal", { id })).status !== "InProgress") break;
  await vote(account(v), D, id);
}
