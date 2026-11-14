// node scripts/v036.mjs [accept] [poll] [close] [lend]   contract 0.3.6 on the showcase co-op and its sister
//   accept: the sister co-op's agent accepts referral #1 from this co-op's board; the sister's contract reads the board
//           itself (a cross-contract call) and links the job
//   poll:   the members vote that technical polls weigh reputation (DAO), then alice opens a technical poll and three
//           members vote: each vote counts its reputation weight
//   close:  anyone closes the poll after its hour
//   lend:   the members lend the sister co-op 1 USDC from the risk fund, paid to the sister's DAO treasury (DAO vote)
//   repay:  the sister co-op's members vote their DAO repays loan #1: ft_transfer_call "sister_repay:1" into the risk fund
//   recover: the co-op court upholds cases against the agent's jobs until it is suspended (3 live strikes; each a
//           demo job priced 0.000001 USDC, refunded from the risk fund); the steward files the recovery plan
//           (web/rat/recovery-plan.md, by sha256); the members approve it by DAO vote; the agent's standing ramps back up.
//           Stops after the suspension when the plan file is not written yet.
// Results are saved in the deployment files (`v036`); `npm run verify` reads them back.
import fs from "node:fs";
import path from "node:path";
import { KeyPair } from "near-api-js";
import { DEPLOYMENT, LOCAL_DEPLOYMENT, NEAR, ROOT, account, callRaw, decide, fnCall, sha256, txUrl, view } from "./lib.mjs";

const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const sis = JSON.parse(fs.readFileSync(LOCAL_DEPLOYMENT, "utf8"));
const K = dep.contract, D = dep.dao;
const voters = ["kop-alice-mw4i3w8f.testnet", "kop-bob-mw4i3w8f.testnet", dep.steward].map(account);
const want = process.argv.slice(2);
const run = (p) => !want.length || want.includes(p);
const saved = (patch) => {
  for (const f of [DEPLOYMENT, path.join(ROOT, "web/deployment.json")]) {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    d.v036 = { ...d.v036, ...patch };
    fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
  }
};
const ret = (r) => JSON.parse(Buffer.from(r.status.SuccessValue || "bnVsbA==", "base64").toString());

if (run("accept")) {
  // a fresh referral (one with no receipt at the sister yet: the sister refuses to link work already on its books)
  const args = { job_id: `demo-referral-${Date.now().toString(36)}`, to_coop: sis.contract, budget_usdc: "4000000",
    reason: "Budget 4 USDC is below our voted price (5); the sister co-op's voted by-laws take localization at 4" };
  const rmsg = await view(K, "get_referral_message", args);
  const rn = rmsg.match(/^koperasi-agent-referral\/1 \S+ #(\d+) /)?.[1];
  if (rmsg !== `koperasi-agent-referral/1 ${K} #${rn} ${args.job_id} ${args.to_coop} ${args.budget_usdc}
${args.reason}`) throw new Error("unexpected referral message");
  const mk = JSON.parse(fs.readFileSync(path.join(ROOT, ".keys", `${dep.agent}.json`), "utf8")).private_key;
  const posted = await callRaw(account(`kop-relayer-${dep.tag}.testnet`), K, "post_referral",
    { ...args, signature: Buffer.from(KeyPair.fromString(mk).sign(Buffer.from(rmsg)).signature).toString("base64") }, { tgas: 50 });
  const id = ret(posted);
  console.log(`referral #${id} posted by ${K}'s agent: ${txUrl(posted.transaction.hash)}`);
  // the agent's key opens only its receipts: it signs the acceptance, a relayer submits it (as for referrals)
  const msg = await view(sis.contract, "get_accept_message", { from_coop: K, referral_id: id });
  const nonce = msg.match(/^koperasi-agent-accept\/1 \S+ #(\d+) /)?.[1];
  if (msg !== `koperasi-agent-accept/1 ${sis.contract} #${nonce} ${K} ${id}`) throw new Error(`unexpected message to sign: ${msg}`);
  const { private_key } = JSON.parse(fs.readFileSync(path.join(ROOT, ".keys", `${sis.agent}.json`), "utf8"));
  const signature = Buffer.from(KeyPair.fromString(private_key).sign(Buffer.from(msg)).signature).toString("base64");
  const r = await callRaw(account(`kop-relayer-${dep.tag}.testnet`), sis.contract, "accept_referral", { from_coop: K, referral_id: id, signature }, { tgas: 80 });
  const got = await view(sis.contract, "get_accepted_referrals", {});
  console.log(`${sis.contract} accepted referral #${id} from ${K}: ${txUrl(r.transaction.hash)}\n${JSON.stringify(got.at(-1))}`);
  saved({ accept: { coop: sis.contract, from: K, referral: id, posted_tx: posted.transaction.hash, tx: r.transaction.hash, job: got.at(-1).job_id } });
}

if (run("poll")) {
  if ((await view(K, "get_technical_vote_mode")) !== "reputation") {
    const { id } = await decide(voters[0], voters, D, "Technical polls weigh each member's reputation (court record and task quality); general ones stay one member one vote",
      fnCall(K, "set_technical_vote", { mode: "reputation" }, { tgas: 30 }));
    saved({ mode: { proposal: id } });
  }
  const r = await callRaw(voters[0], K, "open_poll", { question: "Which embedding model should the agent use for research jobs?",
    options: ["keep the current model", "switch to a larger one"], kind: "Technical", hours: 1 }, { deposit: 10n ** 22n, tgas: 50 });
  const pid = ret(r);
  const votes = [];
  for (const [i, o] of [[0, 1], [1, 0], [2, 1]]) {
    const v = voters[i];
    const x = await callRaw(v, K, "vote_poll", { id: pid, option: o }, { tgas: 150 });
    votes.push({ by: v.accountId, option: o, weight: ret(x), tx: x.transaction.hash });
  }
  console.log(`poll #${pid}: ${JSON.stringify(votes)}`);
  saved({ poll: { id: pid, open_tx: r.transaction.hash, votes } });
}

if (run("close")) {
  const pid = dep.v036.poll.id;
  const r = await callRaw(voters[1], K, "close_poll", { id: pid }, { tgas: 30 });
  const p = await view(K, "get_poll", { id: pid });
  console.log(`poll #${pid} closed: result ${p.result}, tallies ${JSON.stringify(p.tallies)} (${p.mode})`);
  saved({ poll: { ...dep.v036.poll, closed_tx: r.transaction.hash, result: p.result, tallies: p.tallies } });
}

if (run("lend")) {
  const { id } = await decide(voters[0], voters, D, `Lend the sister co-op ${sis.contract} 1 USDC from the risk fund for 30 days, paid to its DAO ${sis.dao}`,
    fnCall(K, "lend_to_sister", { coop: sis.contract, paid_to: sis.dao, amount: "1000000", days: 30 }, { tgas: 150 }));
  const loans = await view(K, "get_sister_loans");
  console.log(`DAO #${id}: ${JSON.stringify(loans.at(-1))}; risk fund now ${JSON.stringify(await view(K, "get_risk_fund"))}`);
  saved({ loan: { proposal: id, ...loans.at(-1) } });
}

if (run("repay")) {
  const id = dep.v036.loan.id;
  const usdc = (await view(K, "get_info")).usdc_id;
  const owed = await view(K, "get_sister_loans").then((ls) => ls.find((l) => l.id === id));
  const amount = String(BigInt(owed.amount) - BigInt(owed.repaid));
  const sv = [`kop-bob-${sis.tag}.testnet`, sis.steward].map(account);
  const { id: pid } = await decide(sv[0], sv, sis.dao, `Repay loan #${id} from ${K}: ${Number(amount) / 1e6} USDC back into its risk fund`,
    fnCall(usdc, "ft_transfer_call", { receiver_id: K, amount, msg: `sister_repay:${id}` }, { deposit: "1", tgas: 100 }));
  const l = (await view(K, "get_sister_loans")).find((x) => x.id === id);
  console.log(`${sis.dao} #${pid}: ${JSON.stringify(l)}; risk fund now ${JSON.stringify(await view(K, "get_risk_fund"))}`);
  saved({ repay: { dao: sis.dao, proposal: pid, loan: id, amount, status: l.status, repaid: l.repaid } });
}

if (run("recover")) {
  const BUYER = "kop-publisher-mw5tkpfo.testnet", B = voters[1];
  const agent = account(dep.agent), hash = (await view(K, "get_info")).config.hash;
  const cases = [];
  while (!(await view(K, "get_agent_standing")).suspended) {
    // ponytail: demo jobs priced 0.000001 USDC: the strike is real, the refund (and the steward's owed balance) a micro-USDC
    const job = `demo-strike-${Date.now().toString(36)}`;
    await callRaw(agent, K, "record_receipt", { job_id: job, price: "1", inference_cost: "0", config_hash: hash, deliverable_hash: "0".repeat(64), proof: null }, { tgas: 30 });
    await callRaw(agent, K, "update_receipt", { job_id: job, status: "Disputed" }, { tgas: 30 });
    await callRaw(agent, K, "update_receipt", { job_id: job, status: "Paid" }, { tgas: 30 });
    const o = await callRaw(B, K, "open_case", { job_id: job, refund_to: BUYER, amount: "1",
      reason: "Demo of the recovery path: the buyer disputed the job, the market paid the agent; the court refunds a micro-USDC" }, { deposit: NEAR / 2n, tgas: 30 });
    const id = ret(o);
    const c = (await view(K, "get_cases", { from: id, limit: 1 }))[0];
    const rulings = [];
    for (const j of c.jurors) {
      if ((await view(K, "get_cases", { from: id, limit: 1 }))[0].status !== "Open") break;
      rulings.push((await callRaw(account(j), K, "rule_case", { id, uphold: true }, { tgas: 300 })).transaction.hash);
    }
    const s = await view(K, "get_agent_standing");
    console.log(`case #${id} (${job}) upheld: ${txUrl(o.transaction.hash)}; live strikes ${s.strikes.length}, suspended ${s.suspended}`);
    cases.push({ id, job, open_tx: o.transaction.hash, rulings });
  }
  const standing = await view(K, "get_agent_standing");
  if (cases.length) saved({ recovery: { ...dep.v036.recovery, cases, strikes: standing.strikes.map(([c]) => c) } });
  const plan = path.join(ROOT, "web/rat/recovery-plan.md");
  if (!fs.existsSync(plan)) {
    console.log(`suspended (strikes ${standing.strikes.map(([c]) => `#${c}`).join(", ")}); write ${plan} and run again`);
    process.exit(0);
  }
  const plan_sha256 = sha256(fs.readFileSync(plan));
  const p = await callRaw(account(dep.steward), K, "propose_recovery", { plan_uri: "rat/recovery-plan.md", plan_sha256 }, { tgas: 30 });
  console.log(`the steward filed the plan (sha256 ${plan_sha256}): ${txUrl(p.transaction.hash)}`);
  const { id } = await decide(voters[0], voters, D, `Approve the agent's recovery plan rat/recovery-plan.md (sha256 ${plan_sha256}): reinstate it, standing ramps from 25% back to 100%`,
    fnCall(K, "approve_recovery", { plan_sha256 }, { tgas: 30 }));
  const [rec, ramp_bps] = await view(K, "get_recovery");
  const m = await view(K, "get_agent_member");
  console.log(`DAO #${id} approved: ramp ${ramp_bps} bps over ${rec.ramp_days} days; agent standing ${m.standing_bps} bps, strikes ${m.strikes}, suspended ${m.suspended}`);
  const now = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8")).v036.recovery;
  saved({ recovery: { ...now, plan: rec.plan_uri, plan_sha256, propose_tx: p.transaction.hash, proposal: id,
    approved_at: rec.approved_at, ramp_days: rec.ramp_days, ramp_bps, standing_bps: m.standing_bps } });
}
