// node scripts/v038.mjs [poll] [share]   contract 0.3.8 on the showcase co-op and its sister
//   poll:  the founding agent opens a technical poll itself, from its own record: the average inference cost of its
//          TEE-proven jobs (get_receipts + get_proof); it signs the poll, a relayer submits it. The members vote later.
//   share: on the sister co-op (the one that took referral #2), its members vote a 30% referral share and this co-op's
//          DAO as its treasury; the sister's agent records the referred job's receipt (4 USDC) and its steward deposits
//          the earnings ("earnings:<job_id>"): the contract pays this co-op's DAO its share, cut from the receipt's price.
// Results are saved in the deployment files (`v038`); `npm run verify` reads them back.
import fs from "node:fs";
import path from "node:path";
import { KeyPair } from "near-api-js";
import { DEPLOYMENT, LOCAL_DEPLOYMENT, NEAR, ROOT, account, all, callRaw, decide, fnCall, sha256, txUrl, view } from "./lib.mjs";

const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const sis = JSON.parse(fs.readFileSync(LOCAL_DEPLOYMENT, "utf8"));
const K = dep.contract, D = dep.dao;
const want = process.argv.slice(2);
const run = (p) => !want.length || want.includes(p);
// re-read both files right before writing: another process may have written them
const saved = (patch) => {
  for (const f of [DEPLOYMENT, path.join(ROOT, "web/deployment.json")]) {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    d.v038 = { ...d.v038, ...patch };
    fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
  }
};
const ret = (r) => JSON.parse(Buffer.from(r.status.SuccessValue || "bnVsbA==", "base64").toString());
const logs = (r) => r.receipts_outcome.flatMap((o) => o.outcome.logs);
const sign = (who, msg) => Buffer.from(KeyPair.fromString(JSON.parse(fs.readFileSync(path.join(ROOT, ".keys", `${who}.json`), "utf8")).private_key)
  .sign(Buffer.from(msg)).signature).toString("base64");

if (run("poll")) {
  // ponytail: one view per receipt (42 now); page get_proof if the receipts grow past a few hundred
  const receipts = await all(K, "get_receipts");
  const proven = [];
  for (const r of receipts) {
    const p = await view(K, "get_proof", { job_id: r.job_id });
    try { if (p && JSON.parse(p).model) proven.push(r); } catch { /* not a TEE proof */ }
  }
  if (!proven.length) throw new Error("no TEE-proven job to average");
  const total = proven.reduce((s, r) => s + BigInt(r.inference_cost), 0n);
  const avg = Number(total) / proven.length / 1e6; // inference_cost is in USDC micro-units
  const usd = (x) => `$${x.toFixed(6)}`;
  const question = `Inference averages ${usd(avg)} per job under by-laws v11: keep the current model or try a cheaper one?`;
  const options = ["keep deepseek-v3.2", "try a cheaper model"];
  const hours = 1;
  const reason = `My receipts: ${proven.length} TEE-proven jobs of ${receipts.length} cost ${usd(Number(total) / 1e6)} of inference in all, ${usd(avg)} each on average. The members should decide whether that is worth it.`;
  // the message is built here and checked against the contract's before the agent signs it
  const content = sha256(JSON.stringify({ question, options, bylaws: null }));
  const msg = await view(K, "get_agent_poll_message", { question, options, hours, reason });
  const nonce = msg.match(/^koperasi-agent-poll\/1 \S+ #(\d+) /)?.[1];
  if (msg !== `koperasi-agent-poll/1 ${K} #${nonce} ${hours} ${content}\n${reason}`) throw new Error(`unexpected message to sign: ${msg}`);
  const relayer = `kop-relayer-${dep.tag}.testnet`;
  const r = await callRaw(account(relayer), K, "agent_open_poll", { question, options, hours, reason, signature: sign(dep.agent, msg) },
    { deposit: NEAR / 100n, tgas: 50 });
  const id = ret(r);
  const p = await view(K, "get_poll", { id });
  console.log(`agent poll #${id} (${p.kind}, ${p.mode}, by ${p.by}), closes ${new Date(Number(BigInt(p.closes_at) / 1_000_000n)).toISOString()}: ${txUrl(r.transaction.hash)}\n${question}\n${reason}`);
  saved({ poll: { id, tx: r.transaction.hash, relayer, nonce: Number(nonce), question, options, reason, hours, content,
    proven: proven.length, receipts: receipts.length, inference_total: String(total), closes_at: p.closes_at,
    left_to_members: "the script does not vote: the members vote the agent's poll" } });
}

if (run("share")) {
  const S = sis.contract, SD = sis.dao;
  const sv = [`kop-bob-${sis.tag}.testnet`, sis.steward].map(account);
  const ref = (await view(S, "get_accepted_referrals", {})).find((a) => a.from_coop === K && a.referral_id === 2);
  if (!ref) throw new Error(`${S} has not accepted referral #2 from ${K}`);
  const job = ref.job_id;
  // once per job: a second deposit would only add earnings, never a second share
  const done = await view(S, "get_referral_share_paid", { job_id: job });
  if (done) throw new Error(`${job}: referral share already paid ${JSON.stringify(done)}`);
  const bps = 3000, price = "4000000";
  if ((await view(S, "get_referral_share")) !== bps) {
    const { id } = await decide(sv[0], sv, SD, `Pay a sister co-op that referred a job ${bps / 100}% of that job's earnings (at most its receipt's price and the referral's budget), automatically`,
      fnCall(S, "set_referral_share", { bps }, { tgas: 30 }));
    saved({ share: { ...(JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8")).v038?.share), share_proposal: id } });
    console.log(`${SD} #${id}: referral share ${await view(S, "get_referral_share")} bps`);
  }
  if ((await view(S, "get_coop_treasury", { coop: K })) !== D) {
    const { id } = await decide(sv[0], sv, SD, `${K}'s referral shares are paid to its treasury, ${D}`,
      fnCall(S, "set_coop_treasury", { coop: K, treasury: D }, { tgas: 30 }));
    saved({ share: { ...(JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8")).v038?.share), treasury_proposal: id } });
    console.log(`${SD} #${id}: treasury of ${K} = ${await view(S, "get_coop_treasury", { coop: K })}`);
  }
  const info = await view(S, "get_info");
  const token = info.usdc_id;
  let receiptTx = null;
  if (!(await view(S, "get_receipt_with_referral", { job_id: job }))) {
    // the sister's agent key opens only record_receipt/update_receipt on its contract (a function-call key)
    const r = await callRaw(account(sis.agent), S, "record_receipt", { job_id: job, price, inference_cost: "0", config_hash: info.config.hash,
      deliverable_hash: sha256(`referred job ${job}`), proof: null }, { tgas: 30 });
    receiptTx = r.transaction.hash;
    console.log(`${sis.agent} recorded the receipt of ${job} (${Number(price) / 1e6} USDC): ${txUrl(receiptTx)}`);
  }
  const bal = (a) => view(token, "ft_balance_of", { account_id: a });
  let mintTx = null;
  const short = BigInt(price) - BigInt(await bal(sis.steward));
  if (short > 0n) {
    // usdc.fakes.testnet is a public test token anyone mints: the stand-in for the market paying the steward
    if (token !== "usdc.fakes.testnet") throw new Error(`the steward holds ${await bal(sis.steward)} of ${token}, needs ${price}`);
    mintTx = (await callRaw(sv[1], token, "mint", { account_id: sis.steward, amount: String(short) }, { tgas: 30 })).transaction.hash;
    console.log(`minted ${short} test ${token} to ${sis.steward}: ${txUrl(mintTx)}`);
  }
  const before = await bal(D);
  const t = await callRaw(sv[1], token, "ft_transfer_call", { receiver_id: S, amount: price, msg: `earnings:${job}` }, { deposit: 1n, tgas: 150 });
  const after = await bal(D);
  const paid = await view(S, "get_referral_share_paid", { job_id: job });
  const ev = logs(t).filter((x) => /"event":"referral_share/.test(x));
  console.log(`steward deposited ${Number(price) / 1e6} ${token} for ${job}: ${txUrl(t.transaction.hash)}\nshare paid ${JSON.stringify(paid)}; ${D} ${before} -> ${after}\n${ev.join("\n")}`);
  saved({ share: { ...(JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8")).v038?.share), coop: S, dao: SD, from: K, treasury: D, bps, job, referral: ref.referral_id,
    budget: ref.budget_usdc, price, receipt_tx: receiptTx, token, mint_tx: mintTx, deposit_tx: t.transaction.hash, steward: sis.steward,
    paid, treasury_before: before, treasury_after: after, events: ev } });
}
