// node scripts/v037.mjs [jury] [loan] [repay] [poll] [close]   contract 0.3.7 on the showcase co-op and its sister
//   jury:  the members vote (DAO) that court juries are drawn by reputation weight (square-root flattened)
//   loan:  the co-op's agent asks the members to lend the sister co-op 1 USDC for 30 days at 500 bps: it signs the
//          request, a relayer submits it, the contract files the DAO proposal; the members vote it and the loan is lent
//   repay: the sister co-op's members vote their DAO repays principal + interest (1.05 USDC) with ft_transfer_call
//          "sister_repay:<id>": the principal back into the risk fund, the interest forwarded to this co-op's DAO treasury
//   poll:  alice opens a technical poll whose second option carries by-laws v11 (config/config.v11.yaml); three members vote
//   close: waits for the poll's deadline, closes it and files its winning by-laws as a DAO proposal (left for the members)
// Results are saved in the deployment files (`v037`); `npm run verify` reads them back.
import fs from "node:fs";
import path from "node:path";
import { KeyPair } from "near-api-js";
import { DEPLOYMENT, LOCAL_DEPLOYMENT, NEAR, ROOT, account, callRaw, decide, fnCall, landed, propose, sha256, sleep, txUrl, view, vote } from "./lib.mjs";

const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const sis = JSON.parse(fs.readFileSync(LOCAL_DEPLOYMENT, "utf8"));
const K = dep.contract, D = dep.dao;
const voters = ["kop-alice-mw4i3w8f.testnet", "kop-bob-mw4i3w8f.testnet", dep.steward].map(account);
const want = process.argv.slice(2);
const run = (p) => !want.length || want.includes(p);
// re-read both files right before writing: another process may have written them (e.g. `outside_buyer`)
const saved = (patch) => {
  for (const f of [DEPLOYMENT, path.join(ROOT, "web/deployment.json")]) {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    d.v037 = { ...d.v037, ...patch };
    fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
  }
};
const current = () => JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8")).v037 ?? {};
const ret = (r) => JSON.parse(Buffer.from(r.status.SuccessValue || "bnVsbA==", "base64").toString());
const logs = (r) => r.receipts_outcome.flatMap((o) => o.outcome.logs);
const usdcId = (await view(K, "get_info")).usdc_id;
const usdc = (id) => view(usdcId, "ft_balance_of", { account_id: id });

/** Vote proposal `id` of `dao` with each voter until it leaves InProgress; the last vote's tx (it executed the proposal). */
async function voteThrough(dao, id, vs) {
  let last = null;
  for (const v of vs) {
    if ((await view(dao, "get_proposal", { id })).status !== "InProgress") break;
    const r = await vote(v, dao, id);
    if (r !== landed) last = r;
  }
  const p = await view(dao, "get_proposal", { id });
  if (p.status !== "Approved") throw new Error(`${dao} #${id} ended ${p.status}`);
  return last;
}

if (run("jury")) {
  if (!(await view(K, "get_jury_by_reputation"))) {
    const { id } = await decide(voters[0], voters, D, "Court juries are drawn by reputation weight (square-root flattened, so no one member captures the draw) instead of uniformly",
      fnCall(K, "set_jury_by_reputation", { on: true }, { tgas: 30 }));
    console.log(`DAO #${id}: juries drawn by reputation = ${await view(K, "get_jury_by_reputation")}`);
    saved({ jury: { proposal: id, on: true } });
  } else console.log("juries are already drawn by reputation");
}

if (run("loan")) {
  const terms = { coop: sis.contract, paid_to: sis.dao, amount: "1000000", days: 30, interest_bps: 500,
    reason: "The sister co-op took our referral and has paid work booked; 1 USDC for 30 days at 5% bridges it, half our risk fund stays untouched" };
  const [risk] = await view(K, "get_risk_fund");
  if (BigInt(terms.amount) * 2n > BigInt(risk)) throw new Error(`risk fund ${Number(risk) / 1e6} USDC: a loan may take at most half; too low for ${Number(terms.amount) / 1e6}`);
  const msg = await view(K, "get_loan_suggestion_message", terms);
  const nonce = msg.match(/^koperasi-agent-loan\/1 \S+ #(\d+) /)?.[1];
  if (msg !== `koperasi-agent-loan/1 ${K} #${nonce} ${terms.coop} ${terms.paid_to} ${terms.amount} ${terms.days} ${terms.interest_bps}\n${terms.reason}`)
    throw new Error(`unexpected message to sign: ${msg}`);
  const { private_key } = JSON.parse(fs.readFileSync(path.join(ROOT, ".keys", `${dep.agent}.json`), "utf8"));
  const signature = Buffer.from(KeyPair.fromString(private_key).sign(Buffer.from(msg)).signature).toString("base64");
  const s = await callRaw(account(`kop-relayer-${dep.tag}.testnet`), K, "agent_suggest_sister_loan", { ...terms, signature },
    { deposit: NEAR / 10n, tgas: 100 });
  const sug = await view(K, "get_loan_suggestion", { coop: sis.contract });
  if (typeof sug?.proposal !== "number") throw new Error(`no proposal filed: ${JSON.stringify(sug)} ${txUrl(s.transaction.hash)}`);
  console.log(`the agent asked (nonce ${nonce}), relayed: ${txUrl(s.transaction.hash)}; DAO #${sug.proposal}`);
  const v = await voteThrough(D, sug.proposal, voters);
  const l = (await view(K, "get_sister_loans")).at(-1);
  const due = (await view(K, "get_sister_interest")).find(([id]) => id === l.id);
  console.log(`loan #${l.id}: ${JSON.stringify(l)}; interest due ${due[1]}; risk fund now ${JSON.stringify(await view(K, "get_risk_fund"))}`);
  saved({ loan: { ...terms, nonce: Number(nonce), suggest_tx: s.transaction.hash, relayer: `kop-relayer-${dep.tag}.testnet`,
    proposal: sug.proposal, vote_tx: v?.transaction.hash, id: l.id, status: l.status, interest_due: due[1], risk_before: risk } });
}

if (run("repay")) {
  const id = current().loan.id;
  const l = (await view(K, "get_sister_loans")).find((x) => x.id === id);
  const [, due, paid] = (await view(K, "get_sister_interest")).find(([x]) => x === id);
  const amount = String(BigInt(l.amount) - BigInt(l.repaid) + BigInt(due) - BigInt(paid));
  const short = BigInt(amount) - BigInt(await usdc(sis.dao));
  let topup = null;
  if (short > 0n) {
    // the steward's USDC is the agent's market earnings holder (the market pays one person): the top-up comes from there
    const have = BigInt(await usdc(dep.steward));
    if (have < short) throw new Error(`the steward holds ${have}, the sister DAO needs ${short} more`);
    const t = await callRaw(account(dep.steward), usdcId, "ft_transfer", { receiver_id: sis.dao, amount: String(short), memo: `top-up for sister loan #${id} interest` },
      { deposit: 1n, tgas: 30 });
    topup = { from: dep.steward, amount: String(short), tx: t.transaction.hash,
      note: "from the steward's USDC, which holds the agent's Agent Market earnings: the sister co-op had no income of its own to pay the interest from" };
    console.log(`steward topped up ${sis.dao} by ${short}: ${txUrl(t.transaction.hash)}`);
  }
  const before = await usdc(D);
  const sv = [`kop-bob-${sis.tag}.testnet`, sis.steward].map(account);
  const pid = await propose(sv[0], sis.dao, `Repay loan #${id} from ${K}: ${Number(amount) / 1e6} USDC (principal ${Number(l.amount) / 1e6} into its risk fund, interest ${Number(due) / 1e6} to its treasury)`,
    fnCall(usdcId, "ft_transfer_call", { receiver_id: K, amount, msg: `sister_repay:${id}` }, { deposit: "1", tgas: 100 }));
  const v = await voteThrough(sis.dao, pid, sv);
  const ev = v ? logs(v).filter((x) => /"event":"sister_(interest|repaid)"/.test(x)) : [];
  const after = await usdc(D);
  const now = (await view(K, "get_sister_loans")).find((x) => x.id === id);
  const int = (await view(K, "get_sister_interest")).find(([x]) => x === id);
  console.log(`${sis.dao} #${pid}: loan ${JSON.stringify(now)}; interest ${JSON.stringify(int)}; DAO treasury ${before} -> ${after}\n${ev.join("\n")}`);
  saved({ repay: { dao: sis.dao, proposal: pid, voter: v?.transaction.signer_id, vote_tx: v?.transaction.hash, loan: id, amount, topup,
    status: now.status, repaid: now.repaid, interest: { due: int[1], paid: int[2] }, treasury_before: before, treasury_after: after, events: ev } });
}

if (run("poll")) {
  const file = "config/config.v11.yaml";
  const text = fs.readFileSync(path.join(ROOT, file));
  if (!fs.readFileSync(path.join(ROOT, "web", file)).equals(text)) throw new Error(`web/${file} differs from ${file}: npm run web:files`);
  const bylaws = { version: 11, hash: sha256(text), uri: file };
  const options = ["keep v10", "adopt v11: the prompt asks for a link to each cited source"];
  const r = await callRaw(voters[0], K, "open_poll", { question: "Should the agent's by-laws ask it to link every source it cites, where a link exists?",
    options, kind: "Technical", hours: 1, bylaws: [null, bylaws] }, { deposit: 2n * 10n ** 22n, tgas: 50 });
  const pid = ret(r);
  const votes = [];
  for (const [i, o] of [[0, 1], [1, 0], [2, 1]]) {
    const x = await callRaw(voters[i], K, "vote_poll", { id: pid, option: o }, { tgas: 150 });
    votes.push({ by: voters[i].accountId, option: o, weight: ret(x), tx: x.transaction.hash });
  }
  const p = await view(K, "get_poll", { id: pid });
  console.log(`poll #${pid} (${p.mode}), closes ${new Date(Number(BigInt(p.closes_at) / 1_000_000n)).toISOString()}: ${JSON.stringify(votes)}`);
  saved({ poll: { id: pid, open_tx: r.transaction.hash, options, bylaws, closes_at: p.closes_at, votes,
    change: "system_prompt: \"Cite every source you use.\" -> \"Cite every source you use, with a link where one exists.\"; nothing else" } });
}

if (run("close")) {
  const poll = current().poll;
  // ponytail: an until-loop on the clock; the chain's block time trails it by seconds, so wait a minute past the deadline
  while (Date.now() * 1e6 < Number(poll.closes_at) + 60e9) await sleep(60_000);
  const c = await callRaw(voters[1], K, "close_poll", { id: poll.id }, { tgas: 30 });
  const f = await callRaw(voters[1], K, "poll_to_proposal", { id: poll.id }, { deposit: NEAR / 10n, tgas: 150 });
  const p = await view(K, "get_poll", { id: poll.id });
  console.log(`poll #${poll.id} closed: result ${p.result}, tallies ${JSON.stringify(p.tallies)}; DAO #${p.proposal}: ${txUrl(f.transaction.hash)}`);
  saved({ poll: { ...poll, closed_tx: c.transaction.hash, result: p.result, tallies: p.tallies, proposal_tx: f.transaction.hash, proposal: p.proposal,
    left_to_members: "the script does not vote this by-laws proposal: the members decide it in the DAO" } });
}
