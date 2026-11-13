// node --env-file=.env scripts/v033.mjs [vote] [federation] [share] [risk] [propose]   contract 0.3.3, by vote
//   vote:       the showcase votes the agent 5% of every profit share (into the risk fund), lets the agent propose with no
//               wait (the members can raise it) and names the federation whose rules bind it; the sister co-op names it too
//   federation: resolution #2's loan ceiling made binding: one federation resolution per co-op calls its contract's
//               set_federation_rules(200 bps, 30 days), each passed by both co-ops' own votes; then a members' vote for a
//               4% loan rule is approved and refused by the code
//   share:      a 2 USDC profit share: the agent's share goes into the risk fund, the reputation dividend by decaying weights
//   risk:       the risk fund's whole cycle: the demo buyer pays the job the agent did (the stand-in market never pays),
//               the steward deposits it as earnings and the agent saves 10% of it; a case upheld against an agent's job
//               is refunded from the risk fund at once, with no proposal (and is a strike, which halves the agent's share)
//   propose:    the agent reads its record from the chain (and how its last proposal turned out), writes new by-laws with
//               the voted model on a TEE-verified server, signs them; a relayer submits; the members vote
// The result is saved in the deployment files (`v033`); `npm run verify` reads every step back.
import fs from "node:fs";
import path from "node:path";
import { KeyPair } from "near-api-js";
import { infer, loadApprovedConfig } from "../agent/runtime.mjs";
import { DEPLOYMENT, NEAR, ROOT, account, all, b64, callRaw, decide, propose, sha256, txUrl, view, vote } from "./lib.mjs";

const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const sis = JSON.parse(fs.readFileSync(path.join(ROOT, "deployment.testnet.local.json"), "utf8"));
const K = dep.contract, D = dep.dao, USDC = dep.usdc, FED = dep.federation.dao;
const A = "kop-alice-mw4i3w8f.testnet", B = "kop-bob-mw4i3w8f.testnet", S = dep.steward, BUYER = "kop-guest-984702.testnet";
const RELAYER = `kop-relayer-${dep.tag}.testnet`;
const CO_OPS = [
  { name: "showcase", dao: D, contract: K, voters: [A, B, S] },
  { name: "sister", dao: sis.dao, contract: sis.contract, voters: ["kop-bob-mw80aczw.testnet", "kop-steward-mw80aczw.testnet"] },
];
const want = process.argv.slice(2);
const run = (part) => !want.length || want.includes(part);
const say = (what, out) => console.log(`${what}${out?.transaction ? `: ${txUrl(out.transaction.hash)}` : ""}`);
const saved = (patch) => {
  for (const f of [DEPLOYMENT, path.join(ROOT, "web/deployment.json")]) {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    d.v033 = { ...d.v033, ...patch };
    fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
  }
};
const act = (method_name, args, tgas = 30, deposit = "0") => ({ method_name, args: b64(args), deposit, gas: String(BigInt(tgas) * 10n ** 12n) });
const fc = (receiver_id, ...actions) => ({ FunctionCall: { receiver_id, actions } });
const usd = (x) => Number(x) / 1e6;
const decideIn = (c, text, kind) => decide(account(c.voters[0]), c.voters.map(account), c.dao, text, kind);

if (run("vote")) {
  const a = await decideIn(CO_OPS[0], `Contract 0.3.3: the agent gets 5% of every profit share into the risk fund (halved per strike); it may put by-laws to us with no wait (we can set one); our loans follow the federation ${FED}`,
    fc(K, act("set_agent_share", { bps: 500 }), act("set_agent_propose_every", { days: 0 }), act("set_federation", { federation: FED })));
  console.log(`showcase #${a.id}: agent share ${(await view(K, "get_agent_member")).share_bps / 100}%, federation ${JSON.stringify(await view(K, "get_federation"))}`);
  const b = await decideIn(CO_OPS[1], `Contract 0.3.3: our loans follow the federation ${FED}`, fc(sis.contract, act("set_federation", { federation: FED })));
  console.log(`sister #${b.id}: federation ${JSON.stringify(await view(sis.contract, "get_federation"))}`);
  saved({ vote: { showcase: a.id, sister: b.id, agentShareBps: 500, proposeEveryDays: 0 } });
}

if (run("federation")) {
  const resolutions = [];
  for (const target of CO_OPS) {
    const text = `Resolution ${3 + CO_OPS.indexOf(target)}: resolution 2's loan ceiling (at most 2% flat, 30 days) becomes binding in ${target.contract}'s code`;
    const filed = (await view(FED, "get_proposals", { from_index: 0, limit: 50 })).find((p) => p.description === text);
    const id = filed ? filed.id : await propose(account(A), FED, text, fc(target.contract, act("set_federation_rules", { max_rate_bps: 200, max_term_days: 30 })));
    const kind = (await view(FED, "get_proposal", { id })).kind;
    const votes = [];
    for (const c of CO_OPS) {
      if ((await view(FED, "get_proposal", { id })).votes[c.dao]) continue;
      const r = await decideIn(c, `Vote for our co-op in the federation ${FED}: approve its proposal #${id} ("${text}")`,
        fc(FED, act("act_proposal", { id, action: "VoteApprove", proposal: kind }, 200)));
      console.log(`  ${c.name}: its members approved #${r.id}, which cast the co-op's vote`);
      votes.push({ dao: c.dao, proposal: r.id });
    }
    const p = await view(FED, "get_proposal", { id });
    const rules = (await view(target.contract, "get_federation"))?.[1];
    console.log(`federation #${id}: ${p.status}; ${target.contract} rules ${JSON.stringify(rules)}`);
    if (!rules) throw new Error("the federation's call did not land");
    resolutions.push({ id, text, contract: target.contract, votes, rules });
  }
  // the members of the showcase vote a loan rule above the ceiling: Sputnik approves it, the contract refuses it
  const before = await view(K, "get_loan_rule");
  const over = { max_loan: before[0].max_loan, rate_bps: 400, term_days: 30 };
  const { id } = await decideIn(CO_OPS[0], "Loans at 4% flat (above the federation's ceiling of 2%: the contract should refuse it)",
    fc(K, act("set_loan_rule", { rule: over, add_to_fund: "0" })));
  const after = await view(K, "get_loan_rule");
  console.log(`showcase #${id} (4% loans) approved by the members; the loan rule is still ${after[0].rate_bps} bps`);
  if (after[0].rate_bps !== before[0].rate_bps) throw new Error("the ceiling did not hold");
  saved({ federation: { resolutions, refused: { proposal: id, rate_bps: 400, kept_bps: after[0].rate_bps } } });
}

if (run("share")) {
  const members = (await view(K, "get_members", {})).map(([a]) => a);
  const [weights, fund0] = [await view(K, "get_reputation_weights"), (await view(K, "get_risk_fund"))[0]];
  const before = await Promise.all(members.map((a) => view(K, "get_claimable", { account_id: a })));
  const { id } = await decideIn(CO_OPS[0], "Profit share of 2 USDC from the treasury (the first that pays the agent's share and a decaying reputation dividend)",
    fc(USDC, act("ft_transfer_call", { receiver_id: K, amount: "2000000", msg: "share" }, 200, "1")));
  await new Promise((ok) => setTimeout(ok, 5000));
  const fund1 = (await view(K, "get_risk_fund"))[0];
  const after = await Promise.all(members.map((a) => view(K, "get_claimable", { account_id: a })));
  console.log(`#${id}: risk fund ${usd(fund0)} → ${usd(fund1)} USDC (the agent's share); weights ${JSON.stringify(weights)}`);
  members.forEach((a, i) => console.log(`  ${a}: +${usd(BigInt(after[i]) - BigInt(before[i]))} USDC`));
  saved({ share: { proposal: id, agentShare: String(BigInt(fund1) - BigInt(fund0)), weights } });
}

if (run("risk")) {
  // the job the agent did on 13 Nov (Paid, 4 USDC): the stand-in market never pays, so the demo buyer pays its net
  const job = (await all(K, "get_receipts")).filter((r) => r.status === "Paid" && r.job_id.startsWith("demo-") && r.inference_cost !== "0").at(-1);
  const net = (BigInt(job.price) * 95n / 100n).toString();
  say(`bob (the demo buyer) paid the steward ${usd(net)} USDC for ${job.job_id}`, await callRaw(account(B), USDC, "ft_transfer", { receiver_id: S, amount: net, memo: job.job_id }, { deposit: 1n, tgas: 30 }));
  const fund0 = BigInt((await view(K, "get_risk_fund"))[0]);
  const dep1 = await callRaw(account(S), USDC, "ft_transfer_call", { receiver_id: K, amount: net, msg: "earnings" }, { deposit: 1n, tgas: 150 });
  await new Promise((ok) => setTimeout(ok, 4000));
  const fund1 = BigInt((await view(K, "get_risk_fund"))[0]);
  say(`the steward deposited it as earnings; the agent saved ${usd(fund1 - fund0)} USDC into the risk fund`, dep1);
  // a case upheld against an agent's job: refunded from the risk fund at once
  const agent = account(dep.agent);
  const info = await view(K, "get_info");
  const cjob = `demo-court-${Date.now().toString(36)}`;
  say(`agent recorded ${cjob} (1 USDC)`, await callRaw(agent, K, "record_receipt", { job_id: cjob, price: "1000000", inference_cost: "0",
    config_hash: info.config.hash, deliverable_hash: "0".repeat(64), proof: null }, { tgas: 30 }));
  await callRaw(agent, K, "update_receipt", { job_id: cjob, status: "Disputed" }, { tgas: 30 });
  await callRaw(agent, K, "update_receipt", { job_id: cjob, status: "Paid" }, { tgas: 30 });
  const amount = (fund1 < 400000n ? fund1 : 400000n).toString();
  const before = BigInt(await view(USDC, "ft_balance_of", { account_id: BUYER }));
  const o = await callRaw(account(B), K, "open_case", { job_id: cjob, refund_to: BUYER, amount,
    reason: "The buyer disputed the translation: two paragraphs were left in English. The market paid the agent anyway; refund the part." }, { deposit: NEAR / 2n, tgas: 30 });
  const id = JSON.parse(Buffer.from(o.status.SuccessValue, "base64").toString());
  say(`bob took the buyer's case to court: case #${id}`, o);
  const c = (await view(K, "get_cases", { from: id, limit: 1 }))[0];
  for (const j of c.jurors) {
    if ((await view(K, "get_cases", { from: id, limit: 1 }))[0].status !== "Open") break;
    say(`${j} upholds`, await callRaw(account(j), K, "rule_case", { id, uphold: true }, { tgas: 300 }));
  }
  await new Promise((ok) => setTimeout(ok, 5000));
  const done = (await view(K, "get_cases", { from: id, limit: 1 }))[0];
  const after = BigInt(await view(USDC, "ft_balance_of", { account_id: BUYER }));
  const fund2 = BigInt((await view(K, "get_risk_fund"))[0]);
  console.log(`case #${id}: ${done.status}, refund proposal ${done.refund_proposal ?? "none"}; buyer ${usd(before)} → ${usd(after)} USDC; risk fund ${usd(fund1)} → ${usd(fund2)}`);
  console.log(`agent: ${JSON.stringify(await view(K, "get_agent_member"))}`);
  saved({ risk: { job: job.job_id, paid: net, deposit: dep1.transaction.hash, saved: String(fund1 - fund0), case: id, refund: amount,
    proposal: done.refund_proposal ?? null, fund: { before: String(fund0), after_deposit: String(fund1), after_refund: String(fund2) } } });
}

if (run("propose")) {
  // 1. the facts, read from the chain
  const [receipts, cfg, history, standing, fund, member, proposals, cases] = await Promise.all([all(K, "get_receipts"), view(K, "get_config"),
    view(K, "get_config_history", {}), view(K, "get_agent_standing"), view(K, "get_risk_fund"), view(K, "get_agent_member"),
    view(K, "get_agent_proposals"), all(K, "get_cases")]);
  const { config, text: yaml } = await loadApprovedConfig(dep);
  const since = Number(cfg.activated_at);
  const tally = (rs) => ({ jobs: rs.length, paid: rs.filter((r) => r.status === "Paid").length, refunded: rs.filter((r) => r.status === "Refunded").length,
    disputed: rs.filter((r) => r.status === "Disputed").length, submitted: rs.filter((r) => r.status === "Submitted").length,
    avg_price_usdc: rs.length ? rs.reduce((s, r) => s + usd(r.price), 0) / rs.length : 0,
    avg_inference_usd: rs.length ? rs.reduce((s, r) => s + usd(r.inference_cost), 0) / rs.length : 0 });
  const facts = {
    contract: K, read_at: new Date().toISOString(),
    by_laws: { version: cfg.version, active_since: new Date(since / 1e6).toISOString(), price_usdc: config.bid.price_usdc,
      limits: config.limits, job_filter: { tags_any: config.job_filter.tags_any, min_price_usdc: config.job_filter.min_price_usdc } },
    jobs_before_these_by_laws: tally(receipts.filter((r) => Number(r.ts) < since)),
    jobs_under_these_by_laws: tally(receipts.filter((r) => Number(r.ts) >= since)),
    jobs_by_tag_prefix: Object.fromEntries(["demo-court", "demo-", "taskbond-"].map((p) => [p, receipts.filter((r) => r.job_id.startsWith(p)).length])),
    court: { cases: cases.length, upheld: cases.filter((c) => c.status === "Upheld").length, strikes_live: standing.strikes.length, suspended: standing.suspended },
    risk_fund_usdc: usd(fund[0]), agent_share_bps: member.share_bps, standing_bps: member.standing_bps,
    my_last_proposal: proposals.at(-1) ? { version: proposals.at(-1).version, reason: proposals.at(-1).reason, dao_proposal: proposals.at(-1).proposal } : null,
    by_laws_history: history.map((h) => ({ version: h.version, at: new Date(Number(h.activated_at) / 1e6).toISOString().slice(0, 10) })),
  };
  const factsText = `${JSON.stringify(facts, null, 2)}\n`;
  // 2. the agent writes its proposal with the voted model, on a TEE-verified server, from those facts only
  const job = {
    title: "The agent's own by-laws proposal",
    description: `You are the co-op's agent. From the FACTS (read from the chain) propose at most three changes to your by-laws, or none. You may change only: bid.price_usdc (1 to 20), job_filter.min_price_usdc (1 to 20, not above the price), limits.max_inference_per_job_usd (0.05 to 1), limits.max_inference_per_day_usd (0.5 to 10), job_filter.tags_any (a list of lowercase tags). First judge your last proposal (my_last_proposal): did the jobs under these by-laws (jobs_under_these_by_laws) bear it out, or are there too few to say? Then propose only what the facts support, and say plainly what they cannot show. Answer with JSON only, no prose around it: {"changes": {"<dotted key>": <value>, ...}, "evaluation": "<one sentence on the last proposal>", "reason": "<at most 300 characters, citing the figures>"}.\n\nFACTS:\n${factsText}`,
  };
  const done = await infer(config, job, Math.round(config.limits.max_inference_per_job_usd * 1e6), { maxTokens: 1500, brief: true });
  if (!done.proof?.model) throw new Error("no TEE proof: nothing is proposed");
  const out = JSON.parse(done.text.slice(done.text.indexOf("{"), done.text.lastIndexOf("}") + 1));
  // 3. only the keys and ranges above; anything else is dropped, and said so
  const allowed = {
    "bid.price_usdc": (v) => typeof v === "number" && v >= 1 && v <= 20,
    "job_filter.min_price_usdc": (v) => typeof v === "number" && v >= 1 && v <= 20,
    "limits.max_inference_per_job_usd": (v) => typeof v === "number" && v >= 0.05 && v <= 1,
    "limits.max_inference_per_day_usd": (v) => typeof v === "number" && v >= 0.5 && v <= 10,
    "job_filter.tags_any": (v) => Array.isArray(v) && v.length >= 1 && v.length <= 12 && v.every((t) => typeof t === "string" && /^[a-z0-9-]{1,24}$/.test(t)),
  };
  const changes = Object.fromEntries(Object.entries(out.changes ?? {}).filter(([k, v]) => allowed[k]?.(v)).slice(0, 3));
  const dropped = Object.keys(out.changes ?? {}).filter((k) => !(k in changes));
  const minP = changes["job_filter.min_price_usdc"] ?? config.job_filter.min_price_usdc, price = changes["bid.price_usdc"] ?? config.bid.price_usdc;
  if (minP > price) delete changes["job_filter.min_price_usdc"];
  console.log(`the agent's evaluation: ${out.evaluation}\nits changes: ${JSON.stringify(changes)}${dropped.length ? ` (dropped, outside its remit: ${dropped.join(", ")})` : ""}`);
  const factsSha = sha256(factsText);
  const version = cfg.version + 1;
  fs.mkdirSync(path.join(ROOT, "web/agent-proposals"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, `web/agent-proposals/v${version}.facts.json`), factsText);
  if (!Object.keys(changes).length) { console.log("the agent proposes nothing this time"); saved({ propose: { version, changes, evaluation: out.evaluation, factsSha, inference: done.proof.inference_id } }); process.exit(0); }
  // 4. the new by-laws file: the same text with those values, and a header naming the facts and the inference
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
  const reason = `${out.reason.slice(0, 300)} | facts sha256 ${factsSha.slice(0, 16)}…, inference ${done.proof.inference_id.slice(0, 13)}… (TEE)`.slice(0, 500);
  // 5. the agent signs; a relayer submits (the agent's key opens only its receipts)
  const { private_key } = JSON.parse(fs.readFileSync(path.join(ROOT, ".keys", `${dep.agent}.json`), "utf8"));
  const msg = await view(K, "get_agent_proposal_message", { version, hash, uri, reason });
  const signature = Buffer.from(KeyPair.fromString(private_key).sign(Buffer.from(msg)).signature).toString("base64");
  const r = await callRaw(account(RELAYER), K, "agent_propose_bylaws", { version, hash, uri, reason, signature }, { tgas: 100 });
  say(`the agent proposed by-laws v${version} (signed by the agent, submitted by ${RELAYER})`, r);
  await new Promise((ok) => setTimeout(ok, 4000));
  const p = (await view(K, "get_agent_proposals")).at(-1);
  if (p?.version !== version || p.proposal === null) throw new Error("the DAO did not file the agent's proposal");
  console.log(`   DAO proposal #${p.proposal}`);
  saved({ propose: { version, uri, hash, changes, dropped, evaluation: out.evaluation, reason, factsSha, inference: done.proof.inference_id,
    model: done.proof.model, tee_signer: done.proof.tee_signer, proposal: p.proposal, submitted: r.transaction.hash } });
  if (!want.includes("--no-vote")) {
    for (const v of [A, B, S]) {
      if ((await view(D, "get_proposal", { id: p.proposal })).status !== "InProgress") break;
      await vote(account(v), D, p.proposal);
    }
    const now = await view(K, "get_config");
    console.log(`   the members' vote: ${(await view(D, "get_proposal", { id: p.proposal })).status}; by-laws v${now.version}`);
    if (now.hash === hash) for (const f of [DEPLOYMENT, path.join(ROOT, "web/deployment.json")]) {
      const d = JSON.parse(fs.readFileSync(f, "utf8"));
      fs.writeFileSync(f, JSON.stringify({ ...d, configUri: uri, configHash: hash }, null, 2) + "\n");
    }
  }
}
