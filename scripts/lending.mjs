// node scripts/lending.mjs [funds] [loans]   contract 0.3.0 on the showcase co-op (contract/src/lending.rs), by vote
//   funds:  two fund accounts (education, social) are opened and registered on USDC; the members vote them 5% and 2.5%
//           of every profit share, out of the reserve; then a 2 USDC profit share pays them on its own
//   loans:  the members vote a loan fund of 1 NEAR (loans up to 0.5 NEAR, 30 days, 2% flat); alice stands surety for
//           bob and guest; bob borrows 0.3 NEAR (the contract files and approves the DAO Transfer) and repays 0.306;
//           guest borrows 0.2 NEAR and keeps the loan open
// The result is saved in the deployment files (`lending`); `npm run verify` reads every step back.
import fs from "node:fs";
import path from "node:path";
import { DEPLOYMENT, NEAR, ROOT, account, callRaw, decide, faucetAccount, fnCall, txUrl, view } from "./lib.mjs";

const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const K = dep.contract, D = dep.dao, USDC = dep.usdc;
const A = "kop-alice-mw4i3w8f.testnet", B = "kop-bob-mw4i3w8f.testnet", G = "kop-guest-984702.testnet", S = dep.steward;
const voters = [A, B, S].map(account);
const want = process.argv.slice(2);
const run = (part) => !want.length || want.includes(part);
const say = (what, out) => console.log(`${what}${out?.transaction ? `: ${txUrl(out.transaction.hash)}` : ""}`);
const saved = (patch) => {
  for (const f of [DEPLOYMENT, path.join(ROOT, "web/deployment.json")]) {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    d.lending = { ...d.lending, ...patch };
    fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
  }
};

if (run("funds")) {
  const tag = Date.now().toString(36);
  const funds = [];
  for (const [name, bps] of [["education", 500], ["social", 250]]) {
    const id = `kop-${name}-${tag}.testnet`;
    const a = await faucetAccount(id);
    say(`opened the ${name} fund's account ${id}`);
    const min = BigInt((await view(USDC, "storage_balance_bounds")).min);
    say(`${id} registered on USDC`, await callRaw(a, USDC, "storage_deposit", { account_id: id, registration_only: true }, { deposit: min, tgas: 30 }));
    funds.push({ name, bps, to: id });
  }
  const set = await decide(account(A), voters, D, "Funds from every profit share, out of the reserve (Law 25/1992 art. 45): education 5%, social 2.5%",
    fnCall(K, "set_share_funds", { funds }, { tgas: 30 }));
  console.log(`proposal #${set.id} approved: set_share_funds`);
  const before = await Promise.all(funds.map((f) => view(USDC, "ft_balance_of", { account_id: f.to })));
  const share = await decide(account(A), voters, D, "Profit share of 2 USDC from the treasury (the first with the education and social funds)",
    fnCall(USDC, "ft_transfer_call", { receiver_id: K, amount: "2000000", msg: "share" }, { deposit: "1", tgas: 200 }));
  console.log(`proposal #${share.id} approved: profit share of 2 USDC`);
  await new Promise((ok) => setTimeout(ok, 5000));
  const after = await Promise.all(funds.map((f) => view(USDC, "ft_balance_of", { account_id: f.to })));
  funds.forEach((f, i) => console.log(`${f.name} fund ${f.to}: ${Number(before[i]) / 1e6} → ${Number(after[i]) / 1e6} USDC`));
  saved({ funds: { set: set.id, share: share.id, funds: funds.map((f, i) => ({ ...f, received: after[i] })) } });
}

if (run("loans")) {
  const rule = { max_loan: String(NEAR / 2n), rate_bps: 200, term_days: 30 };
  const set = await decide(account(A), voters, D, "Savings and loans: a 1 NEAR loan fund; loans up to 0.5 NEAR, 30 days, 2% flat, each with a guarantor",
    fnCall(K, "set_loan_rule", { rule, add_to_fund: String(NEAR) }, { tgas: 30 }));
  console.log(`proposal #${set.id} approved: set_loan_rule`);
  for (const who of [B, G]) {
    if (!(await view(K, "get_guarantors", { account_id: who })).includes(A)) {
      say(`alice stands surety for ${who.split("-")[1]}`, await callRaw(account(A), K, "guarantee", { account_id: who }, { deposit: NEAR / 100n, tgas: 30 }));
    }
  }
  const loans = [];
  for (const [who, amount, repay] of /** @type {[string, bigint, boolean][]} */ ([[B, 3n * NEAR / 10n, true], [G, 2n * NEAR / 10n, false]])) {
    const r = await callRaw(account(who), K, "request_loan", { amount: String(amount) }, { tgas: 250 });
    say(`${who.split("-")[1]} borrowed ${Number(amount / 10n ** 21n) / 1000} NEAR`, r);
    await new Promise((ok) => setTimeout(ok, 4000));
    const loan = await view(K, "get_loan", { account_id: who });
    const p = await view(D, "get_proposal", { id: loan.proposal });
    console.log(`   the contract filed and approved DAO proposal #${loan.proposal}: ${p.status}`);
    let repaid = null;
    if (repay) {
      const owed = BigInt(loan.principal) + BigInt(loan.interest);
      const x = await callRaw(account(who), K, "repay_loan", {}, { deposit: owed, tgas: 30 });
      say(`${who.split("-")[1]} repaid ${Number(owed / 10n ** 21n) / 1000} NEAR into the treasury`, x);
      repaid = x.transaction.hash;
    }
    loans.push({ who, near: Number(amount / 10n ** 21n) / 1000, proposal: loan.proposal, borrowed: r.transaction.hash, repaid });
  }
  console.log("fund now:", JSON.stringify(await view(K, "get_loan_rule")));
  saved({ loans: { set: set.id, guarantor: A, loans } });
}
