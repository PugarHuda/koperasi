// node scripts/v036.mjs [accept] [poll] [close] [lend]   contract 0.3.6 on the showcase co-op and its sister
//   accept: the sister co-op's agent accepts referral #1 from this co-op's board; the sister's contract reads the board
//           itself (a cross-contract call) and links the job
//   poll:   the members vote that technical polls weigh reputation (DAO), then alice opens a technical poll and three
//           members vote: each vote counts its reputation weight
//   close:  anyone closes the poll after its hour
//   lend:   the members lend the sister co-op 1 USDC from the risk fund, paid to the sister's DAO treasury (DAO vote)
// Results are saved in the deployment files (`v036`); `npm run verify` reads them back.
import fs from "node:fs";
import path from "node:path";
import { KeyPair } from "near-api-js";
import { DEPLOYMENT, LOCAL_DEPLOYMENT, ROOT, account, callRaw, decide, fnCall, txUrl, view } from "./lib.mjs";

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
  for (const [v, o] of [[voters[0], 1], [voters[1], 0], [voters[2], 1]]) {
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
