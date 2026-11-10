// node scripts/commons.mjs [--term <days>] [--pledge] [--court]
// What members owe each other, on the showcase co-op (contract 0.2.4, contract/src/commons.rs):
//   --term 90   the members vote the steward's term (set_steward_term)
//   --pledge    alice pledges a review; bob calls it in and says it was kept
//   --court     a demo job the buyer disputed and the market then paid (recorded by the agent, as `npm run demo` does:
//               Agent Market has no testnet, so its "demo-" receipts carry no inference proof); bob takes the buyer's
//               case to the co-op court; the drawn jurors rule; an upheld case refunds the buyer from the treasury.
import fs from "node:fs";
import { DEPLOYMENT, NEAR, account, callRaw, decide, fnCall, txUrl, view } from "./lib.mjs";

const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const arg = (n) => { const i = process.argv.indexOf(n); return i < 0 ? null : process.argv[i + 1]; };
const A = "kop-alice-mw4i3w8f.testnet", B = "kop-bob-mw4i3w8f.testnet", S = "kop-steward-mw4i2iwk.testnet";
const BUYER = "kop-publisher-mw5tkpfo.testnet";
const say = (what, out) => console.log(`${what}${out?.transaction ? `: ${txUrl(out.transaction.hash)}` : ""}`);
const value = (out) => JSON.parse(Buffer.from(out.status.SuccessValue, "base64").toString());

if (arg("--term")) {
  const days = Number(arg("--term"));
  const { id } = await decide(account(A), [A, B, S].map(account), dep.dao,
    `Steward term: ${days} days from appointment; once it runs out anyone ends it and the members appoint again`,
    fnCall(dep.contract, "set_steward_term", { days }, { tgas: 30 }));
  console.log(`proposal #${id} approved: set_steward_term(${days});`, JSON.stringify(await view(dep.contract, "get_steward_term")));
}

if (process.argv.includes("--pledge")) {
  const p = await callRaw(account(A), dep.contract, "pledge", { what: "Review one pull request to the co-op's agent or contract within a week", units: 2 }, { tgas: 30 });
  const id = value(p);
  say(`alice pledged #${id}`, p);
  const r = await callRaw(account(B), dep.contract, "redeem_pledge", { id }, { tgas: 30 });
  const claim = value(r);
  say(`bob called in one unit (claim #${claim})`, r);
  say("bob: kept", await callRaw(account(B), dep.contract, "settle_pledge", { claim, honored: true }, { tgas: 30 }));
  console.log("alice's standing:", JSON.stringify(await view(dep.contract, "get_standing", { account_id: A })));
}

if (process.argv.includes("--court")) {
  const agent = account(dep.agent);
  const job = `demo-court-${Date.now().toString(36)}`;
  const info = await view(dep.contract, "get_info");
  say(`agent recorded ${job} (1 USDC)`, await callRaw(agent, dep.contract, "record_receipt", { job_id: job, price: "1000000", inference_cost: "0",
    config_hash: info.config.hash, deliverable_hash: "0".repeat(64), proof: null }, { tgas: 30 }));
  say("market: the buyer disputed it", await callRaw(agent, dep.contract, "update_receipt", { job_id: job, status: "Disputed" }, { tgas: 30 }));
  say("market: ruled for the agent (paid)", await callRaw(agent, dep.contract, "update_receipt", { job_id: job, status: "Paid" }, { tgas: 30 }));
  // the buyer must hold a USDC storage registration for the refund to land (NEP-145)
  if (!(await view(dep.usdc, "storage_balance_of", { account_id: BUYER }))) {
    const min = BigInt((await view(dep.usdc, "storage_balance_bounds")).min);
    say("buyer registered on USDC", await callRaw(account(BUYER), dep.usdc, "storage_deposit", { account_id: BUYER, registration_only: true }, { deposit: min, tgas: 30 }));
  }
  const before = BigInt(await view(dep.usdc, "ft_balance_of", { account_id: BUYER }));
  const o = await callRaw(account(B), dep.contract, "open_case", { job_id: job, refund_to: BUYER, amount: "500000",
    reason: "The buyer disputed the report on Agent Market: half the sources were missing. The market paid the agent anyway; refund half." }, { deposit: NEAR / 2n, tgas: 30 });
  const id = value(o);
  say(`bob took the buyer's case to court: case #${id}`, o);
  const c = (await view(dep.contract, "get_cases", { from: id, limit: 1 }))[0];
  console.log("jurors drawn:", c.jurors.join(", "));
  for (const j of c.jurors) {
    if ((await view(dep.contract, "get_cases", { from: id, limit: 1 }))[0].status !== "Open") break;
    say(`${j} upholds`, await callRaw(account(j), dep.contract, "rule_case", { id, uphold: true }, { tgas: 300 }));
  }
  await new Promise((ok) => setTimeout(ok, 4000));
  const done = (await view(dep.contract, "get_cases", { from: id, limit: 1 }))[0];
  const after = BigInt(await view(dep.usdc, "ft_balance_of", { account_id: BUYER }));
  console.log(`case #${id}: ${done.status}, refund proposal #${done.refund_proposal}; buyer USDC ${Number(before) / 1e6} → ${Number(after) / 1e6}`);
}
