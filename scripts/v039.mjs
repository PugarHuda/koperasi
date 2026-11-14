// node scripts/v039.mjs [credit] [dividend] [lend]   contract 0.3.9 on the showcase co-op and its sister
//   credit:   reads the sister co-op's federation credit score (get_coop_credit)
//   dividend: the members recognise a third co-op built from this repo (koperasi-mw7zrvx4, keys in .keys) as a sister,
//             name its DAO as its treasury, and vote a 50% federation dividend: half of each sister loan's interest is
//             split among the OTHER sisters' treasuries
//   lend:     the members vote a 1 USDC loan for 1 day at 500 bps to the sister (the tx shows coop_credit_cap); the
//             sister's DAO repays 1.05 USDC by its own vote; the interest's dividend goes to the third co-op's DAO
// Results are saved in the deployment files (`v039`); `npm run verify` reads them back.
import fs from "node:fs";
import path from "node:path";
import { DEPLOYMENT, LOCAL_DEPLOYMENT, ROOT, account, callRaw, decide, fnCall, landed, propose, txUrl, view, vote } from "./lib.mjs";

const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const sis = JSON.parse(fs.readFileSync(LOCAL_DEPLOYMENT, "utf8"));
const K = dep.contract, D = dep.dao, S = sis.contract, SD = sis.dao;
// a third co-op deployed from this repo (web/coops.html lists it); its keys are in .keys
const T = "koperasi-mw7zrvx4.testnet";
const voters = ["kop-alice-mw4i3w8f.testnet", "kop-bob-mw4i3w8f.testnet", dep.steward].map(account);
const sv = [`kop-bob-${sis.tag}.testnet`, sis.steward].map(account);
const want = process.argv.slice(2);
const run = (p) => !want.length || want.includes(p);
// re-read both files right before writing: another process may have written them
const saved = (patch) => {
  for (const f of [DEPLOYMENT, path.join(ROOT, "web/deployment.json")]) {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    d.v039 = { ...d.v039, ...patch };
    fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
  }
};
const logs = (r) => r.receipts_outcome.flatMap((o) => o.outcome.logs);
const events = (r, re) => logs(r).filter((x) => re.test(x)).map((x) => JSON.parse(x.slice(11)));
const usdcId = (await view(K, "get_info")).usdc_id;
const usdc = (id) => view(usdcId, "ft_balance_of", { account_id: id });

/** Vote proposal `id` of `dao` with each voter until it leaves InProgress; the last vote's tx (it executed the proposal). */
async function voteThrough(dao, id, vs) {
  let last = null;
  for (const v of vs) {
    if ((await view(dao, "get_proposal", { id })).status !== "InProgress") break;
    const r = await vote(v, dao, id);
    if (r !== landed) last = r;
  }
  const p = await view(dao, "get_proposal", { id });
  if (p.status !== "Approved") throw new Error(`${dao} #${id} ended ${p.status}`);
  return last;
}

if (run("credit")) {
  const c = await view(K, "get_coop_credit", { coop: S });
  const [risk] = await view(K, "get_risk_fund");
  const cap = (BigInt(risk) * 5000n / 10000n) * BigInt(c.score) / 100n;
  console.log(`${S}: federation credit ${JSON.stringify(c)}; risk fund ${risk}, so at most ${cap} (half x ${c.score}/100)`);
  if (c.score !== 100) console.log(`note: expected 100, read ${c.score}`);
  saved({ credit: { coop: S, ...c, risk_fund: risk, cap: String(cap) } });
}

if (run("dividend")) {
  const out = { third: T };
  const tdao = (await view(T, "get_info")).dao_id;
  out.third_dao = tdao;
  const sisters = await view(K, "get_sister_coops");
  if (!sisters.includes(T)) {
    const coops = [...sisters, T];
    const { id } = await decide(voters[0], voters, D, `Recognise ${T} (a co-op built from the same code, its own DAO ${tdao}) as a sister co-op, alongside ${sisters.join(", ")}`,
      fnCall(K, "set_sister_coops", { coops }, { tgas: 30 }));
    out.sisters_proposal = id;
    console.log(`${D} #${id}: sister co-ops ${JSON.stringify(await view(K, "get_sister_coops"))}`);
  }
  out.sisters = await view(K, "get_sister_coops");
  if ((await view(K, "get_coop_treasury", { coop: T })) !== tdao) {
    const { id } = await decide(voters[0], voters, D, `${T}'s federation dividend and referral shares are paid to its treasury, ${tdao}`,
      fnCall(K, "set_coop_treasury", { coop: T, treasury: tdao }, { tgas: 30 }));
    out.treasury_proposal = id;
    console.log(`${D} #${id}: treasury of ${T} = ${await view(K, "get_coop_treasury", { coop: T })}`);
  }
  // the third DAO must be registered on the USDC contract or the dividend transfer fails (it would go to the DAO instead)
  if (!(await view(usdcId, "storage_balance_of", { account_id: tdao }))) {
    const { min } = await view(usdcId, "storage_balance_bounds");
    const r = await callRaw(account(dep.steward), usdcId, "storage_deposit", { account_id: tdao, registration_only: true }, { deposit: BigInt(min), tgas: 30 });
    out.storage_tx = r.transaction.hash;
    console.log(`registered ${tdao} on ${usdcId}: ${txUrl(r.transaction.hash)}`);
  }
  const bps = 5000;
  if ((await view(K, "get_federation_dividend")) !== bps) {
    const { id } = await decide(voters[0], voters, D, `Federation dividend: ${bps / 100}% of each sister loan's interest is split equally among the treasuries of the other sister co-ops (not the borrower); the rest to this DAO`,
      fnCall(K, "set_federation_dividend", { bps }, { tgas: 30 }));
    out.dividend_proposal = id;
  }
  out.bps = await view(K, "get_federation_dividend");
  out.rule = `${out.bps / 100}% of each sister loan's interest, split equally among the treasuries of the sister co-ops other than the borrower (at most 5); the rest to ${D}`;
  console.log(`${D}: federation dividend ${out.bps} bps; sisters ${JSON.stringify(out.sisters)}`);
  saved({ dividend: { ...(JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8")).v039?.dividend), ...out } });
}

if (run("lend")) {
  const terms = { coop: S, paid_to: SD, amount: "1000000", days: 1, interest_bps: 500 };
  const pid = await propose(voters[0], D, `Lend ${S} ${Number(terms.amount) / 1e6} USDC for ${terms.days} day at ${terms.interest_bps} bps, paid to its DAO ${SD}; capped by its federation credit score`,
    fnCall(K, "lend_to_sister", terms, { tgas: 100 }));
  const v = await voteThrough(D, pid, voters);
  const cap = v ? events(v, /"event":"coop_credit_cap"/) : [];
  const l = (await view(K, "get_sister_loans")).at(-1);
  console.log(`${D} #${pid}: loan #${l.id} ${l.status}: ${txUrl(v?.transaction.hash)}\n${JSON.stringify(cap)}`);
  saved({ lend: { ...terms, proposal: pid, vote_tx: v?.transaction.hash, voter: v?.transaction.signer_id, id: l.id, status: l.status, credit_cap: cap[0]?.data } });

  const [, due, paid] = (await view(K, "get_sister_interest")).find(([x]) => x === l.id);
  const amount = String(BigInt(l.amount) - BigInt(l.repaid) + BigInt(due) - BigInt(paid));
  const short = BigInt(amount) - BigInt(await usdc(SD));
  let topup = null;
  if (short > 0n) {
    const have = BigInt(await usdc(dep.steward));
    if (have < short) throw new Error(`the steward holds ${have}, the sister DAO needs ${short} more`);
    const t = await callRaw(account(dep.steward), usdcId, "ft_transfer", { receiver_id: SD, amount: String(short), memo: `top-up for sister loan #${l.id} interest` },
      { deposit: 1n, tgas: 30 });
    topup = { from: dep.steward, amount: String(short), tx: t.transaction.hash,
      note: "from the steward's USDC (the agent's market earnings): the sister co-op had no income of its own to pay the interest from" };
    console.log(`steward topped up ${SD} by ${short}: ${txUrl(t.transaction.hash)}`);
  }
  const tdao = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8")).v039?.dividend?.third_dao;
  const before = { dao: await usdc(D), third: tdao ? await usdc(tdao) : null };
  const rid = await propose(sv[0], SD, `Repay loan #${l.id} from ${K}: ${Number(amount) / 1e6} USDC (principal into its risk fund, interest to its treasury and the federation dividend)`,
    fnCall(usdcId, "ft_transfer_call", { receiver_id: K, amount, msg: `sister_repay:${l.id}` }, { deposit: "1", tgas: 150 }));
  const r = await voteThrough(SD, rid, sv);
  const ev = r ? events(r, /"event":"(sister_interest|sister_repaid|federation_dividend\w*)"/) : [];
  const after = { dao: await usdc(D), third: tdao ? await usdc(tdao) : null };
  const interest = (await view(K, "get_sister_interest")).find(([x]) => x === l.id);
  const dividend = await view(K, "get_federation_dividend_paid", { loan_id: l.id });
  const now = (await view(K, "get_sister_loans")).find((x) => x.id === l.id);
  const why = dividend.length ? null : "no other sister co-op has a treasury set: the whole interest goes to the DAO (the rule)";
  console.log(`${SD} #${rid}: ${txUrl(r?.transaction.hash)}; loan ${now.status}; interest ${JSON.stringify(interest)}; dividend ${JSON.stringify(dividend)}${why ? ` (${why})` : ""}
${D} ${before.dao} -> ${after.dao}; ${tdao} ${before.third} -> ${after.third}\n${ev.map((e) => JSON.stringify(e)).join("\n")}`);
  saved({ repay: { dao: SD, proposal: rid, voter: r?.transaction.signer_id, vote_tx: r?.transaction.hash, loan: l.id, amount, topup, status: now.status,
    interest: { due: interest[1], paid: interest[2] }, dividend, dividend_note: why, balances_before: before, balances_after: after, events: ev } });
}
