// node --env-file=.env scripts/job.mjs   one job for the showcase co-op's agent, from a demo buyer
//
// Agent Market has no testnet, so a local stand-in (agent/mock-market.mjs) plays the buyer and the market; everything
// else is what the agent does on the real market: it bids, checks its by-laws inside an Intel TDX enclave on-chain
// (OutLayer, agent/gate.mjs) before it starts, does the work on NEAR AI Cloud after checking the model's TEE (with
// NEARAI_API_KEY; without it, a draft that says no model wrote it), and records a "demo-" receipt that names the gate's
// transaction. `npm run verify` reads the gate back.
// KOP_BUYER=<account with a key in .keys/>: that wallet is the buyer. Its account goes into the receipt's proof, and
// once the job is accepted it pays the steward (who holds the agent's market accounts) the price in the co-op's USDC
// on-chain, memo = the receipt's job id; saved as `outside_buyer.direct`, which `npm run verify` checks.
import fs from "node:fs";
import path from "node:path";
import { startMockMarket } from "../agent/mock-market.mjs";
import { loadApprovedConfig, runOnce } from "../agent/runtime.mjs";
import { DEPLOYMENT, ROOT, account, callRaw, sleep, txUrl, view } from "./lib.mjs";

const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
process.env.KOP_MARKET_URL = "http://localhost:8787";
process.env.KOP_MARKET_TOKEN = "aat_mock";
const mock = await startMockMarket();
// the jobs run so far, newest last (`node scripts/job.mjs 0` runs the first again); the enclave judges each by job_filter
const JOBS = [
  { title: "Research: how Indonesian village co-ops (koperasi) share surplus (SHU)", tags: ["research"], budgetAmount: "3",
    description: "Five short bullet points: how a koperasi splits its sisa hasil usaha (SHU) between members by their transactions and their savings, under Indonesia's co-op law. Name your sources; say what you could not verify." },
  { title: "Localization: a co-op's welcome note, English to Indonesian", tags: ["localization", "translation"], budgetAmount: "3",
    description: "Translate into Indonesian, plainly, for village members: \"Welcome to the co-op. You own an equal share of the vote. Profit is shared by what you put in and what you do. Ask any member to see the books.\" Keep it under 60 words." },
];
// the buyer must hold the voted price first: Circle's testnet USDC mints only to its minters (faucet.circle.com, a web form)
const usdc = (await view(dep.contract, "get_info")).usdc_id;
if (process.env.KOP_BUYER) {
  const price = BigInt(Math.round((await loadApprovedConfig(dep)).config.bid.price_usdc * 1e6));
  if (BigInt(await view(usdc, "ft_balance_of", { account_id: process.env.KOP_BUYER })) < price) {
    mock.server.close();
    throw new Error(`${process.env.KOP_BUYER} holds less than ${Number(price) / 1e6} USDC (${usdc}): fund it at faucet.circle.com (NEAR testnet) first`);
  }
}
// KOP_REFERRED_BY=<co-op contract>: a job another co-op of the federation passed on (its receipt names it)
// KOP_JOB_BUDGET: the buyer's budget (USDC); below the voted price the agent does not bid
mock.addJob({ ...JOBS[Number(process.argv[2] ?? JOBS.length - 1)], ...(process.env.KOP_REFERRED_BY ? { referredBy: process.env.KOP_REFERRED_BY } : {}),
  ...(process.env.KOP_JOB_BUDGET ? { budgetAmount: process.env.KOP_JOB_BUDGET } : {}), ...(process.env.KOP_BUYER ? { buyer: process.env.KOP_BUYER } : {}) });
const before = (await view(dep.contract, "get_info")).receipts;
await runOnce({ dep });
await sleep(2500); // the stand-in accepts the bid after 1.5 s
await runOnce({ dep });
await sleep(2500);
await runOnce({ dep }); // mirrors the buyer's acceptance into the receipt
const after = await view(dep.contract, "get_receipts", { from: before, limit: 10 });
for (const r of after) console.log(r.job_id, r.status, "proof:", await view(dep.contract, "get_proof", { job_id: r.job_id }));
const BUYER = process.env.KOP_BUYER;
for (const r of BUYER ? after : []) {
  if (r.status !== "Paid" || JSON.parse((await view(dep.contract, "get_proof", { job_id: r.job_id })) ?? "{}").buyer !== BUYER) continue;
  const paid = await callRaw(account(BUYER), usdc, "ft_transfer", { receiver_id: dep.steward, amount: r.price, memo: r.job_id }, { deposit: 1n, tgas: 30 });
  console.log(`${BUYER} paid the steward ${Number(r.price) / 1e6} USDC for ${r.job_id}: ${txUrl(paid.transaction.hash)}`);
  const direct = { receipt: r.job_id, price: r.price, token: usdc, paid_to: dep.steward, payment_tx: paid.transaction.hash, at: new Date().toISOString() };
  for (const f of [DEPLOYMENT, path.join(ROOT, "web/deployment.json")]) {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    fs.writeFileSync(f, JSON.stringify({ ...d, outside_buyer: { ...d.outside_buyer, account: BUYER, direct, direct_skipped: undefined } }, null, 2) + "\n");
  }
}
mock.server.close();
process.exit(0);
