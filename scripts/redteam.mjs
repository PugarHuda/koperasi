// node scripts/redteam.mjs   attacks on the live showcase co-op that must be refused, sent as real transactions
//
// Each line is something an outsider, a member, the steward or the agent's own key might try: vote themselves points,
// rewrite the by-laws, take the treasury's rule, sell a work record, stamp a passport by hand. Every one is sent to
// testnet and must fail on-chain with the contract's (or the DAO's) own refusal. The transactions and refusals are saved
// in the deployment files; `npm run verify` reads each one back and checks it failed with that refusal.
import fs from "node:fs";
import path from "node:path";
import { DEPLOYMENT, ROOT, account, callRaw, txUrl, view } from "./lib.mjs";

const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const C = dep.contract;
const ALICE = "kop-alice-mw4i3w8f.testnet";
const BOB = "kop-bob-mw4i3w8f.testnet";
const OUTSIDER = "kop-carol-mw4i2iwk.testnet"; // never a member of the showcase co-op (a contributor: 9 paid tasks)
const NO_WORK = "kop-flow-mw8r2327.testnet"; // no record, standing or membership here
const AGENT = dep.agent;
const FEE = 10n ** 22n; // 0.01 NEAR, where a method charges for storage
const rule = { reserve_bps: 0, savings_bps: 0, points_bps: 10000 };

/** [who tries it, as whom, on which contract, method, args, deposit] */
const ATTACKS = [
  ["an outsider rewrites the agent's by-laws", OUTSIDER, C, "set_config", { version: 99, hash: "00".repeat(32), uri: "evil.yaml", contributor: null, points: 0 }],
  ["a member votes themselves profit-share points", ALICE, C, "award_points", { account_id: ALICE, points: 1000000, reason: "me" }],
  ["a member swaps the contract's code without a vote", ALICE, C, "upgrade", { code_hash: "11111111111111111111111111111111" }],
  ["a member gives all profit to contribution points", BOB, C, "set_share_rule", { rule }],
  ["a member drops the trust rule to pay friends with no vote", BOB, C, "set_trust", { rule: { auto_max: "1000000000000000000000000", one_vote_max: "1000000000000000000000000", trusted_after: 0, poster_daily_auto: "1000000000000000000000000", points: 0 } }],
  // the agent's key may call only record_receipt and update_receipt (a function-call key): inside those, the contract
  ["the agent records a job done under by-laws nobody voted", AGENT, C, "record_receipt", { job_id: "rt-unvoted", price: "4000000", inference_cost: "0", config_hash: "00".repeat(32), deliverable_hash: "00", proof: null }],
  ["the agent records the same job twice to count its pay again", AGENT, C, "record_receipt", { job_id: "demo-97ffe708-f54c-4a2b-86a1-d812abab08d4", price: "4000000", inference_cost: "0", config_hash: dep.configHash, deliverable_hash: "00", proof: null }],
  ["a member writes a receipt as if they were the agent", ALICE, C, "update_receipt", { job_id: "demo-97ffe708-f54c-4a2b-86a1-d812abab08d4", status: "Paid" }],
  ["a member pauses the co-op", ALICE, C, "pause", {}],
  ["a member sells their work record to an outsider", ALICE, C, "nft_transfer", { receiver_id: OUTSIDER, token_id: ALICE, approval_id: null, memo: null }, 1n],
  ["an account with no work here mints a work record", NO_WORK, C, "mint_work_record", {}, FEE],
  ["an outsider routes the co-op's payouts to their address", OUTSIDER, C, "set_payout_route", { chain: "eth", address: `0x${"ab".repeat(20)}` }],
  ["a member sets a payout route to a malformed address", BOB, C, "set_payout_route", { chain: "eth", address: "0xABC" }],
  ["an outsider takes a job to the co-op court", OUTSIDER, C, "open_case", { job_id: "demo-97ffe708-f54c-4a2b-86a1-d812abab08d4", refund_to: OUTSIDER, amount: "1", reason: "give me money" }, 5n * 10n ** 23n],
  ["a member appeals a case the jury already upheld", ALICE, C, "appeal_case", { id: 0 }, 10n ** 24n],
  ["a member recognises a sister co-op without a vote", ALICE, C, "set_sister_coops", { coops: [OUTSIDER] }],
  ["an outsider stamps a passport from a co-op nobody voted for", OUTSIDER, C, "stamp_passport", { account_id: OUTSIDER, coop: OUTSIDER }, FEE],
  ["an outsider files evidence in a court case", OUTSIDER, C, "add_evidence", { id: 0, what: "trust me" }, FEE],
  ["an outsider votes on the members' wallet policy in the DAO", OUTSIDER, dep.dao, "act_proposal", { id: 80, action: "VoteApprove", proposal: (await view(dep.dao, "get_proposal", { id: 80 })).kind }],
];

const results = [];
for (const [what, who, contract, method, args, deposit = 0n] of ATTACKS) {
  let tx = null, error = null;
  try {
    const r = await callRaw(account(who), contract, method, args, { deposit, tgas: 50 });
    tx = r.transaction.hash; // it went through: that is a finding, not a pass
  } catch (e) {
    tx = e.transactionResult?.transaction?.hash ?? null;
    error = e.message.replace(/^Smart contract panicked: /, "").slice(0, 200);
  }
  console.log(`${error ? "refused" : "ACCEPTED"}  ${what}: ${error ?? ""}\n          ${tx ? txUrl(tx) : "(no transaction: refused before it reached the chain)"}`);
  results.push({ what, by: who, contract, method, tx, error, at: new Date().toISOString() });
}
const accepted = results.filter((r) => !r.error);
for (const f of [DEPLOYMENT, path.join(ROOT, "web/deployment.json")]) {
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  fs.writeFileSync(f, JSON.stringify({ ...d, redteam: results.filter((r) => r.tx) }, null, 2) + "\n");
}
if (accepted.length) throw new Error(`${accepted.length} attack(s) went through: ${accepted.map((r) => r.what).join("; ")}`);
console.log(`\nall ${results.length} refused on-chain`);
