// node scripts/commons.mjs [--term <days>] [--pledge] [--court]
// What members owe each other, on the showcase co-op (contract 0.2.4, contract/src/commons.rs):
//   --term 90   the members vote the steward's term (set_steward_term)
//   --pledge    alice pledges a review; bob calls it in and says it was kept
//   --court     a demo job the buyer disputed and the market then paid (recorded by the agent, as `npm run demo` does:
//               Agent Market has no testnet, so its "demo-" receipts carry no inference proof); bob takes the buyer's
//               case to the co-op court; (0.2.8) bob and the steward each file evidence; the drawn jurors rule; an upheld
//               case refunds the buyer from the treasury.
//   --appeal <case> approve|reject   (0.2.7) the claimant of a dismissed case appeals to every member; the members vote
//               the refund proposal the contract filed; anyone settles the appeal from the DAO's decision
//   --routes    (0.2.7) bob routes his payouts to Base, alice to Arbitrum, each to their own Chain Signatures address
//               (derived from their NEAR account: no new wallet)
//   --mint      (0.2.7) alice, bob and the steward mint their work records as tokens
//   --passport  (0.2.8) carol, who did paid tasks in another co-op (koperasi-mw80aczw), mints her record there; the
//               members vote that co-op a sister; the contract reads her token there and stamps her passport here,
//               one more trust source for payouts on trust
//   --agenda    (0.2.9) alice and bob put items on this year's annual meeting agenda (then: scripts/rat.mjs)
//   --dues      (0.2.9) every member pays the mandatory dues the members voted (two periods each)
//   --passport-back  (0.2.8) the other way: the sister co-op's members vote the showcase a sister; its contract reads
//               carol's record here (9 paid tasks) and stamps her passport there, so the recognition is mutual
import fs from "node:fs";
import { daoAddress } from "./chainsig.mjs";
import { DEPLOYMENT, NEAR, account, callRaw, decide, fnCall, txUrl, view, vote } from "./lib.mjs";

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
  const p = await callRaw(account(A), dep.contract, "pledge", { what: "Review one pull request to the co-op's agent or contract within a week", units: 2 }, { deposit: NEAR / 100n, tgas: 30 });
  const id = value(p);
  say(`alice pledged #${id}`, p);
  const r = await callRaw(account(B), dep.contract, "redeem_pledge", { id }, { deposit: NEAR / 100n, tgas: 30 });
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
  // 0.2.8: both sides are heard before the jurors rule
  say("bob filed evidence", await callRaw(account(B), dep.contract, "add_evidence", { id,
    what: `The brief asked for 10 sources; the delivered report (deliverable sha256 ${"0".repeat(8)}…) names 5. Buyer's dispute on the market job page.` }, { deposit: NEAR / 100n, tgas: 30 }));
  say("the steward filed evidence", await callRaw(account(S), dep.contract, "add_evidence", { id,
    what: "The market's own arbiter ruled for the agent (receipt status Paid); the report covers the brief's three questions." }, { deposit: NEAR / 100n, tgas: 30 }));
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

if (arg("--appeal")) {
  const id = Number(arg("--appeal"));
  const verdict = process.argv[process.argv.indexOf("--appeal") + 2];
  const c = (await view(dep.contract, "get_cases", { from: id, limit: 1 }))[0];
  const a = await callRaw(account(c.claimant), dep.contract, "appeal_case", { id }, { deposit: NEAR, tgas: 100 });
  say(`${c.claimant} appealed case #${id} to the members`, a);
  const appeal = await view(dep.contract, "get_appeal", { id });
  console.log(`the contract filed DAO proposal #${appeal.proposal}; the members vote it`);
  for (const m of [A, B, S, "kop-guest-984702.testnet", "vouched-mwa7jwhw.kop-publisher-mw5tkpfo.testnet"]) {
    if ((await view(dep.dao, "get_proposal", { id: appeal.proposal })).status !== "InProgress") break;
    say(`${m}: ${verdict === "approve" ? "refund" : "keep the jury's ruling"}`, await vote(account(m), dep.dao, appeal.proposal, verdict === "approve" ? "VoteApprove" : "VoteReject"));
  }
  const p = await view(dep.dao, "get_proposal", { id: appeal.proposal });
  say(`proposal #${appeal.proposal} ${p.status}; anyone settles the appeal`, await callRaw(account(S), dep.contract, "settle_appeal", { id }, { tgas: 300 }));
  console.log(`appeal of case #${id}:`, JSON.stringify(await view(dep.contract, "get_appeal", { id })));
}

if (process.argv.includes("--routes")) {
  for (const [who, chain] of [[B, "base"], [A, "arb"]]) {
    const address = await daoAddress(who);
    say(`${who} routes payouts to ${chain} ${address}`, await callRaw(account(who), dep.contract, "set_payout_route", { chain, address }, { tgas: 30 }));
  }
  console.log("routes:", JSON.stringify(await view(dep.contract, "get_payout_routes")));
}

if (process.argv.includes("--mint")) {
  for (const who of [A, B, S]) {
    say(`${who} minted their work record`, await callRaw(account(who), dep.contract, "mint_work_record", {}, { deposit: NEAR / 100n, tgas: 30 }));
  }
  console.log("tokens:", (await view(dep.contract, "nft_tokens", {})).map((t) => `${t.token_id}: ${t.metadata.description.slice(0, 90)}…`).join("\n"));
}

if (process.argv.includes("--passport")) {
  const SISTER = "koperasi-mw80aczw.testnet", CAROL = "kop-carol-mw80aczw.testnet";
  if (!(await view(SISTER, "nft_token", { token_id: CAROL }))) say("carol minted her work record at the sister co-op",
    await callRaw(account(CAROL), SISTER, "mint_work_record", {}, { deposit: NEAR / 100n, tgas: 30 }));
  if (!(await view(dep.contract, "get_sister_coops")).includes(SISTER)) {
    const { id } = await decide(account(A), [A, B, S].map(account), dep.dao,
      `Recognise ${SISTER} as a sister co-op: work records there in good standing count as one trust source here`,
      fnCall(dep.contract, "set_sister_coops", { coops: [SISTER] }, { tgas: 30 }));
    console.log(`proposal #${id} approved: set_sister_coops([${SISTER}])`);
  }
  const before = await view(dep.contract, "get_trust_sources", { account_id: CAROL });
  const r = await callRaw(account(B), dep.contract, "stamp_passport", { account_id: CAROL, coop: SISTER }, { deposit: NEAR / 100n, tgas: 60 });
  say(`bob asked the contract to read carol's record at ${SISTER}: stamped ${value(r)}`, r);
  console.log(`carol's trust sources here: ${before} → ${await view(dep.contract, "get_trust_sources", { account_id: CAROL })};`,
    JSON.stringify(await view(dep.contract, "get_passport", { account_id: CAROL })));
}

if (process.argv.includes("--passport-back")) {
  const sis = JSON.parse(fs.readFileSync(new URL("../deployment.testnet.local.json", import.meta.url), "utf8"));
  const WHO = "kop-carol-mw4i2iwk.testnet", SB = "kop-bob-mw80aczw.testnet", SS = "kop-steward-mw80aczw.testnet";
  if (!(await view(dep.contract, "nft_token", { token_id: WHO }))) throw new Error(`${WHO} has no work-record token here`);
  if (!(await view(sis.contract, "get_sister_coops")).includes(dep.contract)) {
    const { id } = await decide(account(SB), [SB, SS].map(account), sis.dao,
      `Recognise ${dep.contract} as a sister co-op: work records there in good standing count as one trust source here`,
      fnCall(sis.contract, "set_sister_coops", { coops: [dep.contract] }, { tgas: 30 }));
    console.log(`${sis.dao} proposal #${id} approved: set_sister_coops([${dep.contract}])`);
  }
  const r = await callRaw(account(SB), sis.contract, "stamp_passport", { account_id: WHO, coop: dep.contract }, { deposit: NEAR / 100n, tgas: 60 });
  say(`${sis.contract} read ${WHO}'s record here and stamped it: ${value(r)}`, r);
  console.log(`trust sources there: ${await view(sis.contract, "get_trust_sources", { account_id: WHO })};`,
    JSON.stringify(await view(sis.contract, "get_passport", { account_id: WHO })));
}

if (process.argv.includes("--agenda")) {
  const year = new Date().getUTCFullYear();
  for (const [who, item] of [[A, "Should every member pay small monthly dues, so the treasury has income that does not depend on the agent's jobs?"],
    [B, "Why does the audit still show 7.60 USDC owed, and can anyone be held to it?"]]) {
    say(`${who.split("-")[1]} put on the ${year} agenda: ${item}`, await callRaw(account(who), dep.contract, "propose_agenda", { year, item }, { deposit: NEAR / 100n, tgas: 30 }));
  }
}

if (process.argv.includes("--dues")) {
  const d = await view(dep.contract, "get_dues");
  if (!d || BigInt(d.amount) === 0n) throw new Error("the members voted no dues yet");
  const members = (await view(dep.contract, "get_members", { from: 0, limit: 100 })).map(([a]) => a);
  for (const m of members) {
    say(`${m.split(".")[0]} paid two periods of dues`, await callRaw(account(m), dep.contract, "pay_dues", {}, { deposit: 2n * BigInt(d.amount), tgas: 30 }));
    console.log("   ", JSON.stringify(await view(dep.contract, "get_dues_status", { account_id: m })));
  }
}

