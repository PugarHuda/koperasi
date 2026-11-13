// node --env-file=.env scripts/job.mjs   one job for the showcase co-op's agent, from a demo buyer
//
// Agent Market has no testnet, so a local stand-in (agent/mock-market.mjs) plays the buyer and the market; everything
// else is what the agent does on the real market: it bids, checks its by-laws inside an Intel TDX enclave on-chain
// (OutLayer, agent/gate.mjs) before it starts, does the work on NEAR AI Cloud after checking the model's TEE (with
// NEARAI_API_KEY; without it, a draft that says no model wrote it), and records a "demo-" receipt that names the gate's
// transaction. `npm run verify` reads the gate back.
import fs from "node:fs";
import { startMockMarket } from "../agent/mock-market.mjs";
import { runOnce } from "../agent/runtime.mjs";
import { DEPLOYMENT, sleep, view } from "./lib.mjs";

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
mock.addJob(JOBS[Number(process.argv[2] ?? JOBS.length - 1)]);
const before = (await view(dep.contract, "get_info")).receipts;
await runOnce({ dep });
await sleep(2500); // the stand-in accepts the bid after 1.5 s
await runOnce({ dep });
await sleep(2500);
await runOnce({ dep }); // mirrors the buyer's acceptance into the receipt
const after = await view(dep.contract, "get_receipts", { from: before, limit: 10 });
for (const r of after) console.log(r.job_id, r.status, "proof:", await view(dep.contract, "get_proof", { job_id: r.job_id }));
mock.server.close();
process.exit(0);
