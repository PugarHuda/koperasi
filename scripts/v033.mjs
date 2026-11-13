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
import { DEPLOYMENT, NEAR, ROOT, account, all, b64, callRaw, decide, propose, txUrl, view, vote } from "./lib.mjs";

const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const sis = JSON.parse(fs.readFileSync(path.join(ROOT, "deployment.testnet.local.json"), "utf8"));
const K = dep.contract, D = dep.dao, USDC = dep.usdc, FED = dep.federation.dao;
const A = "kop-alice-mw4i3w8f.testnet", B = "kop-bob-mw4i3w8f.testnet", S = dep.steward, BUYER = "kop-publisher-mw5tkpfo.testnet"; // a buyer outside the co-op: never on its jury
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
    const text = `Resolution ${4 + CO_OPS.indexOf(target)}: resolution 2's loan ceiling (at most 2% flat, 30 days) becomes binding in ${target.contract}'s code`;
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
  const text = "Loans at 4% flat (above the federation's ceiling of 2%: the contract should refuse it)";
  // the deciding vote's transaction fails with the contract's refusal; Sputnik v2 on testnet still marks it Approved
  await decideIn(CO_OPS[0], text, fc(K, act("set_loan_rule", { rule: over, add_to_fund: "0" })))
    .catch((e) => { if (!/above the federation's loan ceiling/.test(String(e.message))) throw e; });
  const last = await view(D, "get_last_proposal_id");
  const id = (await view(D, "get_proposals", { from_index: Math.max(0, last - 5), limit: 5 })).reverse().find((p) => p.description === text).id;
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
  // RISK_RESUME="<fund before> <court job>": the payment and the deposit landed on an earlier run (do not pay twice)
  const [resumeFund, resumeJob] = (process.env.RISK_RESUME ?? "").split(" ");
  let fund0 = BigInt(resumeFund || (await view(K, "get_risk_fund"))[0]), dep1 = null;
  if (!resumeJob) {
    say(`bob (the demo buyer) paid the steward ${usd(net)} USDC for ${job.job_id}`, await callRaw(account(B), USDC, "ft_transfer", { receiver_id: S, amount: net, memo: job.job_id }, { deposit: 1n, tgas: 30 }));
    dep1 = await callRaw(account(S), USDC, "ft_transfer_call", { receiver_id: K, amount: net, msg: "earnings" }, { deposit: 1n, tgas: 150 });
    await new Promise((ok) => setTimeout(ok, 4000));
  }
  const fund1 = BigInt((await view(K, "get_risk_fund"))[0]);
  say(`the steward deposited it as earnings; the agent saved ${usd(fund1 - fund0)} USDC into the risk fund`, dep1);
  // a case upheld against an agent's job: refunded from the risk fund at once
  const agent = account(dep.agent);
  const info = await view(K, "get_info");
  const cjob = resumeJob || `demo-court-${Date.now().toString(36)}`;
  if (!resumeJob) {
    say(`agent recorded ${cjob} (1 USDC)`, await callRaw(agent, K, "record_receipt", { job_id: cjob, price: "1000000", inference_cost: "0",
      config_hash: info.config.hash, deliverable_hash: "0".repeat(64), proof: null }, { tgas: 30 }));
    await callRaw(agent, K, "update_receipt", { job_id: cjob, status: "Disputed" }, { tgas: 30 });
    await callRaw(agent, K, "update_receipt", { job_id: cjob, status: "Paid" }, { tgas: 30 });
  }
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
  saved({ risk: { job: job.job_id, paid: net, deposit: dep1?.transaction.hash ?? null, saved: String(fund1 - fund0), case: id, refund: amount,
    proposal: done.refund_proposal ?? null, fund: { before: String(fund0), after_deposit: String(fund1), after_refund: String(fund2) } } });
}

if (run("propose")) {
  // agent/propose.mjs: the same step the agent's runtime takes on its own once jobs settle under the current by-laws
  const { agentPropose } = await import("../agent/propose.mjs");
  const r = await agentPropose({ dep });
  saved({ propose: r });
  if (r.proposed && !want.includes("--no-vote")) {
    for (const v of [A, B, S]) {
      if ((await view(D, "get_proposal", { id: r.proposal })).status !== "InProgress") break;
      await vote(account(v), D, r.proposal);
    }
    const now = await view(K, "get_config");
    console.log(`   the members' vote: ${(await view(D, "get_proposal", { id: r.proposal })).status}; by-laws v${now.version}`);
    if (now.hash === r.hash) for (const f of [DEPLOYMENT, path.join(ROOT, "web/deployment.json")]) {
      const d = JSON.parse(fs.readFileSync(f, "utf8"));
      fs.writeFileSync(f, JSON.stringify({ ...d, configUri: r.uri, configHash: r.hash }, null, 2) + "\n");
    }
  }
}
