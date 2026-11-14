// The agent's own by-laws proposal (contract 0.3.2 `agent_propose_bylaws`), used by its runtime and by scripts/v033.mjs.
//
// The agent reads its record from the chain (and how the jobs went since its last proposal), writes its next by-laws
// with the voted model on a TEE-verified server, from those facts only (published, their sha256 in the proposal), and
// signs it with its own key; a relayer submits it (the agent's key opens only its receipts); the contract files the DAO
// proposal and pays its bond; the members vote. It may change only the price, the minimum price, the inference caps and
// the job tags, within set ranges, and may propose nothing: that is the answer when the facts do not support a change.
import fs from "node:fs";
import path from "node:path";
import { KeyPair } from "near-api-js";
import { ROOT, account, all, callRaw, hasKey, sha256, view } from "../scripts/lib.mjs";
import { infer, loadApprovedConfig } from "./runtime.mjs";

const usd = (x) => Number(x) / 1e6;
const ALLOWED = {
  "bid.price_usdc": (v) => typeof v === "number" && v >= 1 && v <= 20,
  "job_filter.min_price_usdc": (v) => typeof v === "number" && v >= 1 && v <= 20,
  "limits.max_inference_per_job_usd": (v) => typeof v === "number" && v >= 0.05 && v <= 1,
  "limits.max_inference_per_day_usd": (v) => typeof v === "number" && v >= 0.5 && v <= 10,
  "job_filter.tags_any": (v) => Array.isArray(v) && v.length >= 1 && v.length <= 12 && v.every((t) => typeof t === "string" && /^[a-z0-9-]{1,24}$/.test(t)),
};

/** The facts the agent reasons from, read from the chain. */
export async function agentFacts(dep, config) {
  const K = dep.contract;
  const [receipts, cfg, history, standing, fund, member, proposals, cases] = await Promise.all([all(K, "get_receipts"), view(K, "get_config"),
    view(K, "get_config_history", {}), view(K, "get_agent_standing"), view(K, "get_risk_fund"), view(K, "get_agent_member"),
    view(K, "get_agent_proposals"), all(K, "get_cases")]);
  const since = Number(cfg.activated_at);
  // prices only from jobs paid in USDC: Taskbond pays in testnet NEAR (its receipts carry 0 USDC) and court demo jobs are
  // not sales; counting them made the average look low (by-laws v9, proposed from that figure, was a mistake)
  const usdcJobs = (rs) => rs.filter((r) => BigInt(r.price) > 0n && !r.job_id.startsWith("demo-court") && !r.job_id.startsWith("taskbond-"));
  const tally = (rs) => ({ jobs: rs.length, paid: rs.filter((r) => r.status === "Paid").length, refunded: rs.filter((r) => r.status === "Refunded").length,
    disputed: rs.filter((r) => r.status === "Disputed").length, submitted: rs.filter((r) => r.status === "Submitted").length,
    usdc_sales: usdcJobs(rs).length,
    avg_price_usdc_of_sales: usdcJobs(rs).length ? usdcJobs(rs).reduce((s, r) => s + usd(r.price), 0) / usdcJobs(rs).length : 0,
    taskbond_jobs_paid_in_near: rs.filter((r) => r.job_id.startsWith("taskbond-")).length,
    avg_inference_usd: rs.length ? rs.reduce((s, r) => s + usd(r.inference_cost), 0) / rs.length : 0 });
  return {
    cfg,
    facts: {
      contract: K, read_at: new Date().toISOString(),
      by_laws: { version: cfg.version, active_since: new Date(since / 1e6).toISOString(), price_usdc: config.bid.price_usdc,
        limits: config.limits, job_filter: { tags_any: config.job_filter.tags_any, min_price_usdc: config.job_filter.min_price_usdc } },
      jobs_before_these_by_laws: tally(receipts.filter((r) => Number(r.ts) < since)),
      jobs_under_these_by_laws: tally(receipts.filter((r) => Number(r.ts) >= since)),
      jobs_by_kind: Object.fromEntries(["demo-court", "demo-", "taskbond-"].map((p) => [p, receipts.filter((r) => r.job_id.startsWith(p)).length])),
      court: { cases: cases.length, upheld: cases.filter((c) => c.status === "Upheld").length, strikes_live: standing.strikes.length, suspended: standing.suspended },
      risk_fund_usdc: usd(fund[0]), agent_share_bps: member.share_bps, standing_bps: member.standing_bps,
      my_last_proposal: proposals.at(-1) ? { version: proposals.at(-1).version, reason: proposals.at(-1).reason, dao_proposal: proposals.at(-1).proposal } : null,
      by_laws_history: history.map((h) => ({ version: h.version, at: new Date(Number(h.activated_at) / 1e6).toISOString().slice(0, 10) })),
    },
    settledUnder: receipts.filter((r) => Number(r.ts) >= since && r.status !== "Submitted").length,
  };
}

/**
 * Think, and if the facts support it, propose. Returns what happened (written to web/agent-proposals/v<next>.*).
 * @param {{ dep: any, log?: (s: string) => void, relayer?: string }} o
 * @returns {Promise<any>}
 */
export async function agentPropose({ dep, log = console.log, relayer = `kop-relayer-${dep.tag}.testnet` }) {
  const K = dep.contract;
  const { config, text: yaml } = await loadApprovedConfig(dep);
  const { cfg, facts } = await agentFacts(dep, config);
  const factsText = `${JSON.stringify(facts, null, 2)}\n`;
  const job = {
    title: "The agent's own by-laws proposal",
    description: `You are the co-op's agent. From the FACTS (read from the chain) propose at most three changes to your by-laws, or none. You may change only: bid.price_usdc (1 to 20), job_filter.min_price_usdc (1 to 20, not above the price), limits.max_inference_per_job_usd (0.05 to 1), limits.max_inference_per_day_usd (0.5 to 10), job_filter.tags_any (a list of lowercase tags). First judge your last proposal (my_last_proposal): did the jobs under these by-laws (jobs_under_these_by_laws) bear it out, or are there too few to say? Then propose only what the facts support, and say plainly what they cannot show. Answer with JSON only, no prose around it: {"changes": {"<dotted key>": <value>, ...}, "evaluation": "<one sentence on the last proposal>", "reason": "<at most 300 characters, citing the figures>"}.\n\nFACTS:\n${factsText}`,
  };
  const done = await infer(config, job, Math.round(config.limits.max_inference_per_job_usd * 1e6), { maxTokens: 1500, brief: true });
  if (!done.proof?.model) throw new Error("no TEE proof: nothing is proposed");
  const out = JSON.parse(done.text.slice(done.text.indexOf("{"), done.text.lastIndexOf("}") + 1));
  const changes = Object.fromEntries(Object.entries(out.changes ?? {}).filter(([k, v]) => ALLOWED[k]?.(v)).slice(0, 3));
  const dropped = Object.keys(out.changes ?? {}).filter((k) => !(k in changes));
  const minP = changes["job_filter.min_price_usdc"] ?? config.job_filter.min_price_usdc, price = changes["bid.price_usdc"] ?? config.bid.price_usdc;
  if (minP > price) delete changes["job_filter.min_price_usdc"];
  const version = cfg.version + 1, factsSha = sha256(factsText);
  const base = { version, changes, dropped, evaluation: out.evaluation, factsSha, costMicroUsd: done.costMicroUsd, inference: done.proof.inference_id, model: done.proof.model,
    tee_signer: done.proof.tee_signer, at: new Date().toISOString() };
  fs.mkdirSync(path.join(ROOT, "web/agent-proposals"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, `web/agent-proposals/v${version}.facts.json`), factsText);
  log(`the agent's evaluation: ${out.evaluation}; changes: ${JSON.stringify(changes)}${dropped.length ? ` (dropped, outside its remit: ${dropped.join(", ")})` : ""}`);
  if (!Object.keys(changes).length) {
    fs.writeFileSync(path.join(ROOT, `web/agent-proposals/v${version}.json`), `${JSON.stringify({ ...base, proposed: false }, null, 2)}\n`);
    return { ...base, proposed: false };
  }
  if (!hasKey(relayer)) throw new Error(`no key for ${relayer} to submit the agent's signed proposal`);
  const line = (k) => k.split(".").at(-1);
  let body = yaml
    .replace(/^# By-laws v\d+[^\n]*\n/, `# By-laws v${version}, written by the co-op's agent from its own record (facts web/agent-proposals/v${version}.facts.json, sha256 ${factsSha}; model ${done.proof.model}, inference ${done.proof.inference_id}, signed by TEE key ${done.proof.tee_signer}): the only config the Koperasi agent may run.\n`)
    .replace(/^version:\s*\d+/m, `version: ${version}`);
  for (const [k, v] of Object.entries(changes)) {
    const re = new RegExp(`^(\\s+${line(k)}:\\s*).*$`, "m");
    if (!re.test(body)) throw new Error(`${k} not found in the by-laws`);
    body = body.replace(re, `$1${Array.isArray(v) ? `[${v.join(", ")}]` : v}`);
  }
  const uri = `config/config.v${version}.yaml`;
  for (const f of [uri, `web/${uri}`]) fs.writeFileSync(path.join(ROOT, f), body);
  const hash = sha256(Buffer.from(body));
  const reason = `${String(out.reason).slice(0, 300)} | facts sha256 ${factsSha.slice(0, 16)}…, inference ${done.proof.inference_id.slice(0, 13)}… (TEE)`.slice(0, 500);
  const { private_key } = JSON.parse(fs.readFileSync(path.join(ROOT, ".keys", `${dep.agent}.json`), "utf8"));
  const msg = await view(K, "get_agent_proposal_message", { version, hash, uri, reason });
  const signature = Buffer.from(KeyPair.fromString(private_key).sign(Buffer.from(msg)).signature).toString("base64");
  const r = await callRaw(account(relayer), K, "agent_propose_bylaws", { version, hash, uri, reason, signature }, { tgas: 100 });
  await new Promise((ok) => setTimeout(ok, 4000));
  const p = (await view(K, "get_agent_proposals")).at(-1);
  if (p?.version !== version || p.proposal === null) throw new Error("the DAO did not file the agent's proposal");
  const result = { ...base, proposed: true, uri, hash, reason, proposal: p.proposal, submitted: r.transaction.hash, relayer };
  fs.writeFileSync(path.join(ROOT, `web/agent-proposals/v${version}.json`), `${JSON.stringify(result, null, 2)}\n`);
  log(`the agent proposed by-laws v${version}: DAO proposal #${p.proposal}`);
  return result;
}

/**
 * Called by the runtime after each pass: think again only when the members' interval has passed (at least a day here,
 * so a model is not asked every 45 s) and at least 3 jobs settled under the current by-laws since it last thought.
 */
export async function maybePropose({ dep, log, state, save }) {
  const every = Math.max(1, Number(await view(dep.contract, "get_agent_propose_every").catch(() => 7)));
  const last = state.lastPropose ?? { at: 0, settled: -1 };
  if (Date.now() - last.at < every * 86_400_000) return null;
  const { config } = await loadApprovedConfig(dep);
  const { settledUnder } = await agentFacts(dep, config);
  if (settledUnder < 3 || settledUnder === last.settled) {
    log(`not thinking about the by-laws yet: ${settledUnder} job(s) settled under them (3 needed, new since last time)`);
    return null;
  }
  // within the day's inference budget the by-laws set, like any job; the attempt is noted first, so a failure waits
  // for the next interval instead of asking the model again on every pass
  const cap = Math.round(config.limits.max_inference_per_job_usd * 1e6);
  if ((state.spentMicroUsd ?? 0) + cap > config.limits.max_inference_per_day_usd * 1e6) {
    log("not thinking about the by-laws today: the day's inference budget is spent");
    return null;
  }
  state.lastPropose = { at: Date.now(), settled: settledUnder };
  save(state);
  const r = await agentPropose({ dep, log });
  state.spentMicroUsd = (state.spentMicroUsd ?? 0) + (r.costMicroUsd ?? cap);
  state.lastPropose = { ...state.lastPropose, version: r.version, proposed: r.proposed };
  save(state);
  return r;
}
