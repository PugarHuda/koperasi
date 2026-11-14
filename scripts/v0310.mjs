// node scripts/v0310.mjs [cap] [market] [award]   contract 0.3.10 on the showcase co-op and its sister
//   cap:    the members vote a payout cap of 1 USDC per payment to the sister co-op's DAO (set_payout_cap)
//   market: this co-op's agent offers its sister co-ops a job (post_coop_job, 3 USDC budget, bids open 1 hour); the
//           sister's agent bids 2.5 USDC on the SISTER's own contract (place_bid). Both sign; a relayer submits.
//   award:  after the deadline, anyone calls award_coop_job on this co-op: it reads each sister's bid and picks the best
//           (credit x budget / price). Fails with "bids are still open" before the deadline.
// Results are saved in the deployment files (`v0310`); `npm run verify` reads them back.
import fs from "node:fs";
import path from "node:path";
import { KeyPair } from "near-api-js";
import { DEPLOYMENT, LOCAL_DEPLOYMENT, ROOT, account, callRaw, decide, fnCall, sleep, txUrl, view } from "./lib.mjs";

const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const sis = JSON.parse(fs.readFileSync(LOCAL_DEPLOYMENT, "utf8"));
const K = dep.contract, D = dep.dao, S = sis.contract, SD = sis.dao;
const voters = ["kop-alice-mw4i3w8f.testnet", "kop-bob-mw4i3w8f.testnet", dep.steward].map(account);
const relayer = `kop-relayer-${dep.tag}.testnet`;
const want = process.argv.slice(2);
const run = (p) => !want.length || want.includes(p);
// re-read both files right before writing: another process may have written them
const cur = () => JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8")).v0310 ?? {};
const saved = (patch) => {
  for (const f of [DEPLOYMENT, path.join(ROOT, "web/deployment.json")]) {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    d.v0310 = { ...d.v0310, ...patch };
    fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
  }
};
const ret = (r) => JSON.parse(Buffer.from(r.status.SuccessValue || "bnVsbA==", "base64").toString());
const logs = (r) => r.receipts_outcome.flatMap((o) => o.outcome.logs);
const events = (r, re) => logs(r).filter((x) => re.test(x)).map((x) => JSON.parse(x.slice(11)));
const sign = (who, msg) => Buffer.from(KeyPair.fromString(JSON.parse(fs.readFileSync(path.join(ROOT, ".keys", `${who}.json`), "utf8")).private_key)
  .sign(Buffer.from(msg)).signature).toString("base64");

if (run("cap")) {
  const destination = SD, max = "1000000";
  let proposal = cur().cap?.proposal ?? null;
  if ((await view(K, "get_payout_cap", { destination })) !== max) {
    ({ id: proposal } = await decide(voters[0], voters, D, `Cap any single payment from ${K} to the sister co-op's treasury ${destination} at ${Number(max) / 1e6} USDC (a referral share over it is cut to it)`,
      fnCall(K, "set_payout_cap", { destination, max_per_payment: max }, { tgas: 30 })));
  }
  const cap = await view(K, "get_payout_cap", { destination });
  console.log(`${D} #${proposal}: payout cap to ${destination} = ${cap}`);
  saved({ cap: { dao: D, proposal, destination, max_per_payment: max, read: cap } });
}

if (run("market")) {
  let job = cur().market?.job;
  if (!job) {
    const job_id = `fedjob-${Date.now()}`, budget_usdc = "3000000", deadline_hours = 1;
    const description = "Translate a 2-page member notice (Bahasa Indonesia to English) for the federation newsletter";
    // the message is built here and checked against the contract's before the agent signs it
    const msg = await view(K, "get_coop_job_message", { job_id, budget_usdc, deadline_hours, description });
    const nonce = msg.match(/^koperasi-agent-job\/1 \S+ #(\d+) /)?.[1];
    if (msg !== `koperasi-agent-job/1 ${K} #${nonce} ${job_id} ${budget_usdc} ${deadline_hours}\n${description}`) throw new Error(`unexpected message to sign: ${msg}`);
    const r = await callRaw(account(relayer), K, "post_coop_job", { job_id, budget_usdc, deadline_hours, description, signature: sign(dep.agent, msg) }, { tgas: 30 });
    const j = await view(K, "get_coop_job", { job_id });
    console.log(`${dep.agent} offered ${job_id} (#${ret(r)}), bids close ${new Date(Number(BigInt(j.deadline) / 1_000_000n)).toISOString()}: ${txUrl(r.transaction.hash)}`);
    job = { contract: K, agent: dep.agent, relayer, nonce: Number(nonce), id: ret(r), job_id, budget_usdc, deadline_hours, description,
      posted_at: j.posted_at, deadline: j.deadline, tx: r.transaction.hash, events: events(r, /"event":"coop_job_posted"/) };
    saved({ market: { ...cur().market, job } });
  }
  if (!cur().market?.bid) {
    const price_usdc = "2500000", from_coop = K, job_id = job.job_id;
    const msg = await view(S, "get_bid_message", { from_coop, job_id, price_usdc });
    const nonce = msg.match(/^koperasi-agent-bid\/1 \S+ #(\d+) /)?.[1];
    if (msg !== `koperasi-agent-bid/1 ${S} #${nonce} ${from_coop} ${job_id} ${price_usdc}`) throw new Error(`unexpected message to sign: ${msg}`);
    const r = await callRaw(account(relayer), S, "place_bid", { from_coop, job_id, price_usdc, signature: sign(sis.agent, msg) }, { tgas: 30 });
    // an RPC behind the one that took the tx may not see the bid yet
    let read = null;
    for (let i = 0; i < 5 && !read; i++) read = await view(S, "get_bids_for", { from_coop, job_id }) ?? (await sleep(2000), null);
    console.log(`${sis.agent} bid ${Number(price_usdc) / 1e6} USDC on ${S}: ${txUrl(r.transaction.hash)}\n${JSON.stringify(read)}`);
    saved({ market: { ...cur().market, bid: { contract: S, agent: sis.agent, relayer, nonce: Number(nonce), from_coop, job_id, price_usdc,
      tx: r.transaction.hash, read, events: events(r, /"event":"coop_bid_placed"/) } } });
  }
}

if (run("award")) {
  const job_id = cur().market?.job?.job_id;
  if (!job_id) throw new Error("run `market` first");
  let j = await view(K, "get_coop_job", { job_id });
  let tx = cur().award?.tx ?? null;
  if (!j.winner) {
    // anyone may award; the relayer pays the gas (2 sisters read: 2 x 5 Tgas + 20 Tgas callback)
    const r = await callRaw(account(relayer), K, "award_coop_job", { job_id }, { tgas: 100 });
    tx = r.transaction.hash;
    j = await view(K, "get_coop_job", { job_id });
    console.log(`awarded ${job_id}: ${txUrl(tx)}\n${logs(r).join("\n")}`);
  }
  console.log(`${job_id}: winner ${j.winner} at ${j.price}`);
  saved({ award: { contract: K, job_id, caller: relayer, tx, winner: j.winner, price: j.price, sisters_read: await view(K, "get_sister_coops") } });
}
