// node scripts/trade.mjs [job id]   work passed between the federation's co-ops (federation resolution 3), its money leg
//
// The sister co-op's agent did a job the showcase brought (`KOP_DEPLOYMENT=deployment.testnet.local.json
// KOP_REFERRED_BY=koperasi-mw4i2iwk.testnet node --env-file=.env scripts/job.mjs 1`): its by-laws checked in the enclave,
// the work done on a TEE-verified model, and its receipt's proof names the co-op that brought it. Then, here: the demo
// buyer pays the sister's steward the job's net (the stand-in market never pays; the sister runs on usdc.fakes.testnet),
// the steward deposits it as the sister's earnings, and the sister's members vote 30% of it to the showcase's treasury,
// as resolution 3 says. Saved as `federation.trade`; `npm run verify` reads it back.
import fs from "node:fs";
import path from "node:path";
import { ROOT, DEPLOYMENT, account, all, callRaw, decide, txUrl, view } from "./lib.mjs";

const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const sis = JSON.parse(fs.readFileSync(path.join(ROOT, "deployment.testnet.local.json"), "utf8"));
const info = await view(sis.contract, "get_info");
const T = info.usdc_id, BUYER = "kop-bob-mw4i3w8f.testnet", VOTERS = ["kop-bob-mw80aczw.testnet", "kop-steward-mw80aczw.testnet"];
const say = (what, out) => console.log(`${what}${out?.transaction ? `: ${txUrl(out.transaction.hash)}` : ""}`);
const usd = (x) => Number(x) / 1e6;

const receipts = await all(sis.contract, "get_receipts");
const proofOf = async (r) => JSON.parse((await view(sis.contract, "get_proof", { job_id: r.job_id })) ?? "{}");
let job = process.argv[2] ? receipts.find((r) => r.job_id === process.argv[2]) : null;
const done = new Set((dep.federation.trades ?? [dep.federation.trade]).filter(Boolean).map((x) => x.job));
for (const r of [...receipts].reverse()) {
  if (job) break;
  if (r.status === "Paid" && !done.has(r.job_id) && (await proofOf(r)).referred_by === dep.contract) job = r;
}
if (!job) throw new Error("no paid job of the sister co-op, not yet settled, names the showcase as the co-op that brought it");
const proof = await proofOf(job);
const net = BigInt(job.price) * 95n / 100n, share = net * 30n / 100n;
if (BigInt(await view(T, "ft_balance_of", { account_id: BUYER })) < net) {
  say(`${BUYER} minted test ${T}`, await callRaw(account(BUYER), T, "mint", { account_id: BUYER, amount: String(net) }, { tgas: 30 }));
}
const paid = await callRaw(account(BUYER), T, "ft_transfer", { receiver_id: info.steward, amount: String(net), memo: job.job_id }, { deposit: 1n, tgas: 30 });
say(`the demo buyer paid the sister's steward ${usd(net)} ${T} for ${job.job_id}`, paid);
const earned = await callRaw(account(info.steward), T, "ft_transfer_call", { receiver_id: sis.contract, amount: String(net), msg: "earnings" }, { deposit: 1n, tgas: 150 });
say("the sister's steward deposited it as the sister's earnings (its treasury)", earned);
await new Promise((ok) => setTimeout(ok, 4000));
const before = BigInt(await view(T, "ft_balance_of", { account_id: dep.dao }));
const { id } = await decide(account(VOTERS[0]), VOTERS.map(account), sis.dao,
  `Federation resolution 3: 30% of what job ${job.job_id} earned (${usd(net)} USDC) to ${dep.dao}, the co-op that brought it`,
  { Transfer: { token_id: T, receiver_id: dep.dao, amount: String(share), msg: null } });
await new Promise((ok) => setTimeout(ok, 3000));
const after = BigInt(await view(T, "ft_balance_of", { account_id: dep.dao }));
console.log(`sister #${id} approved: the showcase's treasury ${usd(before)} → ${usd(after)} ${T}`);
const trade = { resolution: 3, coop: sis.contract, job: job.job_id, referred_by: proof.referred_by, gate: proof.gate?.tx, model: proof.model,
  token: T, net: String(net), share: String(share), paid: paid.transaction.hash, deposited: earned.transaction.hash, proposal: id, dao: sis.dao };
for (const f of [DEPLOYMENT, path.join(ROOT, "web/deployment.json")]) {
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  // a list: each job passed between the co-ops (the first was passed by hand, later ones by the agent itself)
  const trades = [...(d.federation.trades ?? (d.federation.trade ? [d.federation.trade] : [])).filter((x) => x.job !== trade.job), trade];
  d.federation = { ...d.federation, trades };
  delete d.federation.trade;
  fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
}
