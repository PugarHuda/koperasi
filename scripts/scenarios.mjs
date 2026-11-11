// node scripts/scenarios.mjs [gas] [tasks] [pledges] [court] [earnings] [dao]   (no argument: all, in this order)
// Fills the showcase co-op with real cases in every state the page shows, one transaction at a time (keys in .keys/;
// testnet demo accounts). Each line prints the call and its tx link.
//   tasks:    one left open, one taken, one handed back and delivered by someone else, one cancelled, one waiting for a
//             member (contributor not trusted yet), one above the no-vote limit approved by one member, one held in
//             the veto window;
//   pledges:  one partly called in with a claim still open, one never called in, one kept;
//   court:    two cases the jurors dismissed (one unanimous, one split), so the claimants' bonds go to the treasury;
//   receipts: jobs submitted, disputed and refunded by the market (Agent Market has no testnet: "demo-" receipts carry
//             no inference proof); the court's two paid jobs are passed on by the steward, so the audit stays square;
//   DAO:      a profit share members claim, a proposal the members reject, and one still open for votes.
// Not covered: a broken pledge (the issuer has 14 days) and a case closed for lack of rulings (the jurors have 3 days).
import fs from "node:fs";
import { DEPLOYMENT, NEAR, account, callRaw, decide, fnCall, propose, txUrl, view, vote } from "./lib.mjs";

const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const K = dep.contract, D = dep.dao, USDC = dep.usdc;
const A = "kop-alice-mw4i3w8f.testnet", B = "kop-bob-mw4i3w8f.testnet", C = "kop-carol-mw4i2iwk.testnet",
  S = "kop-steward-mw4i2iwk.testnet", G = "kop-guest-984702.testnet", V = "vouched-mwa7jwhw.kop-publisher-mw5tkpfo.testnet",
  P = "kop-publisher-mw5tkpfo.testnet";
const short = (a) => a.split(/[-.]/)[1] === "mwa7jwhw" ? "vouched" : a.split("-")[1] ?? a;
const tx = async (who, contract, method, args = {}, opts = {}) => {
  const out = await callRaw(account(who), contract, method, args, { tgas: 60, ...opts });
  console.log(`${short(who)} ${method} ${JSON.stringify(args).slice(0, 90)}: ${out?.transaction ? txUrl(out.transaction.hash) : "landed"}`);
  return out;
};
const want = process.argv.slice(2);
const run = (part) => !want.length || want.includes(part);
const near = (n) => String(BigInt(Math.round(n * 1000)) * (NEAR / 1000n));
const task = async (id) => (await view(K, "get_tasks", { from: id, limit: 1 }))[0];
const post = async (who, amount, description) => {
  await tx(who, K, "post_task", { description, amount: near(amount) }, { deposit: NEAR / 100n });
  return (await view(K, "get_board")).tasks - 1;
};

// gas money for the members who act most
if (run("gas")) for (const [who, n] of [[C, 2n], [V, 2n], [G, 1n], [S, 1n]]) {
  await account(P).transfer({ receiverId: who, amount: n * NEAR });
  console.log(`publisher sent ${n} NEAR to ${short(who)}`);
}

// ---------- tasks ----------
if (run("tasks")) {
  const open = await post(A, 0.05, "Write a one-page member guide in Bahasa Indonesia for people new to wallets");

  const taken = await post(A, 0.08, "Record a two-minute screen walkthrough of the member panel");
  await tx(B, K, "claim_task", { id: taken });

  const handed = await post(S, 0.05, "Add the veto window to the quick start in Bahasa Indonesia (docs/MULAI.md)");
  await tx(C, K, "claim_task", { id: handed });
  await tx(C, K, "give_up_task", { id: handed });
  await tx(G, K, "claim_task", { id: handed });
  await tx(G, K, "submit_task", { id: handed, deliverable: "https://github.com/PugarHuda/koperasi/blob/main/docs/MULAI.md" });

  const cancelled = await post(A, 0.04, "Design a logo for the co-op");
  await tx(A, K, "cancel_task", { id: cancelled });

  // guest has no paid task yet, so the payout waits for one member however small it is
  const untrusted = await post(A, 0.05, "Check every link on the live page and list the broken ones");
  await tx(G, K, "claim_task", { id: untrusted });
  await tx(G, K, "submit_task", { id: untrusted, deliverable: "All 41 links on https://koperasi-kohl.vercel.app answer 200; GitHub links wait for the repo to go public on 13 Nov" });
  await tx(A, K, "accept_task", { id: untrusted }, { tgas: 200 });

  // carol is trusted, but 0.2 NEAR is above the no-vote limit: one member approves
  const big = await post(B, 0.2, "Translate RULES.md into Bahasa Indonesia");
  await tx(C, K, "claim_task", { id: big });
  await tx(C, K, "submit_task", { id: big, deliverable: "https://github.com/PugarHuda/koperasi/blob/main/RULES.md" });
  await tx(B, K, "accept_task", { id: big }, { tgas: 200 });
  await tx(S, K, "approve_task", { id: big }, { tgas: 300 });

  // small and trusted: paid on trust, held for the members' veto window first
  const held = await post(A, 0.03, "Proofread the submission text (docs/submission.md)");
  await tx(C, K, "claim_task", { id: held });
  await tx(C, K, "submit_task", { id: held, deliverable: "https://github.com/PugarHuda/koperasi/blob/main/docs/submission.md" });
  await tx(A, K, "accept_task", { id: held }, { tgas: 200 });

  await new Promise((ok) => setTimeout(ok, 5000));
  for (const id of [open, taken, handed, cancelled, untrusted, big, held]) {
    const t = await task(id);
    console.log(`   task #${id}: ${t.status}${t.contributor ? ` (${short(t.contributor)})` : ""}`);
  }
}

// ---------- pledges ----------
if (run("pledges")) {
  const value = (out) => JSON.parse(Buffer.from(out.status.SuccessValue, "base64").toString());
  const p1 = value(await tx(B, K, "pledge", { what: "Translate one document of the co-op into Bahasa Indonesia", units: 3 }));
  await tx(A, K, "redeem_pledge", { id: p1 });
  const c2 = value(await tx(S, K, "redeem_pledge", { id: p1 }));
  await tx(S, K, "settle_pledge", { claim: c2, honored: true });

  await tx(G, K, "pledge", { what: "Host a 30-minute onboarding call for a new member", units: 2 });

  const p3 = value(await tx(V, K, "pledge", { what: "Test the page on a phone and report what breaks", units: 1 }));
  const c3 = value(await tx(B, K, "redeem_pledge", { id: p3 }));
  await tx(B, K, "settle_pledge", { claim: c3, honored: true });
}

// ---------- receipts and the court ----------
if (run("court")) {
  const agent = dep.agent;
  const hash = (await view(K, "get_info")).config.hash;
  const job = (tag) => `demo-${tag}-${Date.now().toString(36)}`;
  const record = async (id, price) => tx(agent, K, "record_receipt", { job_id: id, price, inference_cost: "0", config_hash: hash, deliverable_hash: "0".repeat(64), proof: null });
  const status = (id, s) => tx(agent, K, "update_receipt", { job_id: id, status: s });

  await record(job("submitted"), "300000"); // waiting for the buyer
  const disputed = job("disputed"); await record(disputed, "250000"); await status(disputed, "Disputed");
  const refunded = job("refunded"); await record(refunded, "200000"); await status(refunded, "Disputed"); await status(refunded, "Refunded");

  const cases = [];
  for (const [claimant, rulings, reason] of [
    [A, [false, false], "The buyer says the summary missed a section, but the brief never asked for it. Refund in full."],
    [B, [true, false, false], "The buyer disputed the translation's tone. The market paid the agent; refund half."],
  ]) {
    const id = job("court"); await record(id, "100000"); await status(id, "Disputed"); await status(id, "Paid");
    const amount = claimant === A ? "100000" : "50000";
    await tx(claimant, K, "open_case", { job_id: id, refund_to: P, amount, reason }, { deposit: NEAR / 2n, tgas: 30 });
    const c = (await view(K, "get_cases", { from: 0, limit: 50 })).at(-1);
    console.log(`   case #${c.id}: jurors ${c.jurors.map(short).join(", ")}`);
    for (const [k, uphold] of rulings.entries()) {
      if ((await view(K, "get_cases", { from: c.id, limit: 1 }))[0].status !== "Open") break;
      await tx(c.jurors[k], K, "rule_case", { id: c.id, uphold }, { tgas: 300 });
    }
    cases.push(c.id);
  }
  for (const id of cases) console.log(`   case #${id}: ${(await view(K, "get_cases", { from: id, limit: 1 }))[0].status}`);
}

if (run("earnings")) {

  // the steward passes on the two paid jobs' earnings (net of the market's 5%), so nothing becomes overdue
  const owed = BigInt((await view(K, "get_audit")).owed) - 7_600_000n;
  if (owed > 0n) {
    if (BigInt(await view(USDC, "ft_balance_of", { account_id: S })) < owed) await tx(P, USDC, "ft_transfer", { receiver_id: S, amount: String(owed) }, { deposit: 1n, tgas: 30 });
    await tx(S, USDC, "ft_transfer_call", { receiver_id: K, amount: String(owed), msg: "earnings" }, { deposit: 1n, tgas: 150 });
  }
  console.log("   audit:", JSON.stringify(await view(K, "get_audit")), "overdue:", await view(K, "get_overdue"));
}

// ---------- the DAO ----------
if (run("dao")) {
  const voters = [A, B, S].map(account);
  const { id } = await decide(account(A), voters, D, "Profit share of 2 USDC from the treasury",
    fnCall(USDC, "ft_transfer_call", { receiver_id: K, amount: "2000000", msg: "share" }, { deposit: "1", tgas: 200 }));
  console.log(`   proposal #${id}: profit share approved`);
  for (const m of [A, B, G]) {
    if (!(await view(USDC, "storage_balance_of", { account_id: m }))) {
      await tx(m, USDC, "storage_deposit", { account_id: m, registration_only: true }, { deposit: NEAR / 100n, tgas: 30 });
    }
    await tx(m, K, "claim_share", {});
  }

  const no = await propose(account(B), D, "Set the veto window to 0 minutes: pay small tasks on trust at once", fnCall(K, "set_veto_window", { minutes: 0 }, { tgas: 30 }));
  for (const m of [A, S, G]) await vote(account(m), D, no, "VoteReject");
  console.log(`   proposal #${no}: ${(await view(D, "get_proposal", { id: no })).status}`);

  const open = await propose(account(A), D, "Raise the task budget to 1.5 NEAR for the translation work in December", fnCall(K, "set_task_budget", { amount: near(1.5) }, { tgas: 30 }));
  await new Promise((ok) => setTimeout(ok, 3000)); // the RPC that answers next may not have the proposal yet
  await vote(account(A), D, open);
  console.log(`   proposal #${open}: ${(await view(D, "get_proposal", { id: open })).status}, waiting for the members`);
}
