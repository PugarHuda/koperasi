// node --env-file=.env scripts/taskbond.mjs [job id]   the co-op's agent takes a job on Taskbond, a third-party testnet market
//
// Agent Market has no testnet. Taskbond (github.com/demir-sama/taskbond, another hackathon entry) does: a NEAR escrow
// where a poster locks a reward, agents join with their system prompt, Taskbond's own Guardrail AI approves or rejects
// each agent, agents submit a summary with citations quoted from a pinned source pack, Taskbond's Reviewer AI scores the
// submissions and the escrow pays the winner. Its operator, its AIs and its escrow are not ours.
//
// By-laws v5 (vote #96) let the agent take research jobs there (`job_filter.testnet_markets.taskbond`); the agent checks
// the voted by-laws first. Without a job id, a job is posted by a buyer from outside the co-op (kop-publisher, never a
// member) with the minimum reward. Then: the steward (who holds the agent's market accounts, as on Agent Market) joins
// with the by-laws' system prompt; Taskbond's guard runs; the co-op's agent does the work on NEAR AI Cloud after checking
// its TEE, quoting the pinned sources exactly; the steward submits; Taskbond's reviewer scores and its escrow pays.
// The agent records a receipt on the co-op's contract (price 0 USDC: the reward is testnet NEAR) whose proof names the
// market, the job and the payout; the run is saved in the deployment files and `npm run verify` reads it back.
import fs from "node:fs";
import path from "node:path";
import { infer, loadApprovedConfig } from "../agent/runtime.mjs";
import { DEPLOYMENT, NEAR, ROOT, account, call, callRaw, sha256, txUrl, view } from "./lib.mjs";

const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const API = "https://taskbond-iota.vercel.app/api";
const RAW = "https://raw.githubusercontent.com/demir-sama/taskbond/HEAD/sources";
const PACK = [["account-model", "account-model.txt"], ["access-keys", "access-keys.txt"], ["faucet", "faucet.txt"]];
const BUYER = "kop-publisher-mw5tkpfo.testnet"; // not a member: the court demos' buyer
const OWNER = dep.steward;

const { config, hash, version } = await loadApprovedConfig(dep);
const rules = config.job_filter?.testnet_markets?.taskbond;
if (!rules) throw new Error(`by-laws v${version} do not let the agent work on Taskbond`);
const ESCROW = rules.escrow;

// the pinned source pack, as Taskbond hashes it (lib/sources.ts): sha256 of "id\nsha256(body)\n" for each source
const sources = await Promise.all(PACK.map(async ([id, file]) => ({ id, body: await (await fetch(`${RAW}/${file}`)).text() })));
const packHash = sha256(sources.map((s) => `${s.id}\n${sha256(s.body)}\n`).join(""));

let jobId = process.argv[2] ? Number(process.argv[2]) : null;
if (jobId === null) {
  const reward = BigInt(Math.round(rules.min_reward_near * 1000)) * (NEAR / 1000n);
  const r = await callRaw(account(BUYER), ESCROW, "create_job", {
    title: "How function-call access keys bound an agent",
    topic: "Explain how a NEAR function-call access key limits what an AI agent's account can do (which contract, which methods, how much gas allowance), how that differs from a full-access key, and where a newcomer gets testnet NEAR. Cite the pinned sources.",
    source_pack_hash: packHash, deadline_ns: String(BigInt(Date.now() + 6 * 3600_000) * 1_000_000n),
  }, { deposit: reward + 3n * NEAR / 100n, tgas: 100 });
  jobId = JSON.parse(Buffer.from(r.status.SuccessValue, "base64").toString());
  console.log(`${BUYER} posted job #${jobId} on ${ESCROW} (${rules.min_reward_near} NEAR): ${txUrl(r.transaction.hash)}`);
}
const job = await view(ESCROW, "get_job", { job_id: jobId });
if (job.source_pack_hash !== packHash) throw new Error(`job #${jobId} pins another source pack`);

// join with the by-laws' system prompt
let me = (await view(ESCROW, "list_agents", { job_id: jobId })).find((a) => a.owner === OWNER);
if (!me) {
  const cap = BigInt(Math.round(rules.max_inference_cap_near * 1000)) * (NEAR / 1000n);
  const r = await callRaw(account(OWNER), ESCROW, "register_agent", { job_id: jobId, name: `Koperasi agent (by-laws v${version})`, prompt: config.system_prompt.trim() },
    { deposit: 8n * NEAR / 100n + 5n * NEAR / 1000n + cap, tgas: 100 });
  console.log(`the steward joined job #${jobId} for the co-op's agent: ${txUrl(r.transaction.hash)}`);
  me = (await view(ESCROW, "list_agents", { job_id: jobId })).find((a) => a.owner === OWNER);
}
const post = async (route, body) => {
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${API}/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
    const j = await res.json().catch(() => ({}));
    if (res.status !== 429) return j;
    console.log(`Taskbond: ${j.error}; waiting`);
    await new Promise((ok) => setTimeout(ok, 30_000));
  }
  throw new Error(`Taskbond ${route}: still busy`);
};
if (me.status === "PendingGuard") {
  const g = await post("guard", { jobId });
  console.log("Taskbond's guard:", JSON.stringify(g.result ?? g.error).slice(0, 300));
  me = await view(ESCROW, "get_agent", { agent_id: me.id });
}
if (me.status !== "Approved") throw new Error(`Taskbond's guard did not approve the agent: ${me.status} ${me.guard_reason}`);

// the work, by the co-op's agent, from the pinned sources only
let done = null;
if (me.review === "None") {
  // the reasoning model the by-laws name ran out of time on all three sources (12 KB); the topic needs two of them
  done = await infer(config, {
    title: job.title,
    description: `${job.topic}\n\nAnswer ONLY from the two sources below. Reply with JSON only, no prose around it: {"summary": "at most 900 characters", "steps": ["at most 6 steps, each under 180 characters"], "citations": [{"sourceId": "access-keys or faucet", "quote": "an EXACT sentence copied character for character from that source, under 200 characters"}]} with 3 or 4 citations.\n\n${sources.filter((s) => s.id !== "account-model").map((s) => `=== ${s.id} ===\n${s.body}`).join("\n\n")}`,
  }, Math.round(config.limits.max_inference_per_job_usd * 1e6), { maxTokens: 6000, brief: true });
  const out = JSON.parse(done.text.slice(done.text.indexOf("{"), done.text.lastIndexOf("}") + 1));
  // keep only quotes that are really in the sources: Taskbond's reviewer rejects any other
  const citations = (out.citations ?? []).filter((c) => sources.find((s) => s.id === c.sourceId)?.body.includes(c.quote)).slice(0, 4);
  if (!citations.length) throw new Error("the model quoted nothing exactly from the sources: nothing submitted");
  const summary = String(out.summary).slice(0, 1000);
  const steps = (out.steps ?? []).map((s) => String(s).slice(0, 200)).slice(0, 8);
  const evidence = JSON.stringify({ citations });
  const r = await callRaw(account(OWNER), ESCROW, "submit_result", { agent_id: me.id, summary, steps, evidence }, { tgas: 50 });
  console.log(`submitted the agent's work (${citations.length} exact citations, inference ${done.costMicroUsd / 1e6} USD): ${txUrl(r.transaction.hash)}`);
  me = await view(ESCROW, "get_agent", { agent_id: me.id });
}

// Taskbond's reviewer scores it; its escrow pays a winner
const rv = await post("review", { jobId });
console.log("Taskbond's reviewer:", JSON.stringify(rv.result ?? rv.error).slice(0, 300));
me = await view(ESCROW, "get_agent", { agent_id: me.id });
const after = await view(ESCROW, "get_job", { job_id: jobId });
console.log(`job #${jobId}: ${after.status}; winner ${after.winner_agent_id ?? "none"}; our agent: review ${me.review} (${me.review_reason}); winning score ${after.score ?? "none"}`);

// the receipt on the co-op's contract, and the record
const id = `taskbond-${jobId}`;
if (done && !(await view(dep.contract, "get_receipts", { from: 0, limit: 500 })).some((x) => x.job_id === id)) {
  await call(account(dep.agent), dep.contract, "record_receipt", {
    job_id: id, price: "0", inference_cost: String(done.costMicroUsd), config_hash: hash, deliverable_hash: me.result_hash,
    proof: JSON.stringify({ ...done.proof, market: { name: "taskbond", escrow: ESCROW, job: jobId, agent_id: me.id, owner: OWNER } }),
  }, { tgas: 50 });
  console.log(`receipt ${id} recorded on ${dep.contract}`);
}
const run = { escrow: ESCROW, job: jobId, poster: job.poster, agent_id: me.id, owner: OWNER, review: me.review, reason: me.review_reason, score: after.winner_agent_id === me.id ? after.score : null,
  winner: after.winner_agent_id ?? null, status: after.status, receipt: id, at: new Date().toISOString() };
for (const f of [DEPLOYMENT, path.join(ROOT, "web/deployment.json")]) {
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  fs.writeFileSync(f, JSON.stringify({ ...d, taskbond: [...(d.taskbond ?? []).filter((x) => x.job !== jobId), run] }, null, 2) + "\n");
}
process.exit(0);
