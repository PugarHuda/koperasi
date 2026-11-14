// Join the co-op from the page with a testnet wallet: pay the deposit, ask the members (a DAO proposal from your own
// wallet), sync once they vote you in. Members can then vote on open proposals and claim their profit share.
import { NearConnector } from "./vendor/near-connect-0.12.0.mjs";
import { SEPOLIA, eth, plainPayment, rawHash, rawTx, toHex, transfer, txFromText, txsFromText, txHash, txText } from "./eth.js";
import { dep, view, all, query, forget, RPC_URLS, explorer, txUrl, $, esc, usdc, nearAmt } from "./near.js";
import { t } from "./lang.js";
import { affordable, checkVouch, inviteOf, inviteParam, joinText, vouchParam, vouchSuffix, vouchText, nearUnits, oneLine, payPath, plainCall, splitShare, taskCheck, trustSources, usdcExact, usdcUnits, walletError } from "./share.js";

// what each member would receive from a share of `amount`, by the contract's own rule
const preview = (amount, s) => {
  const { shares, reserve } = splitShare(amount, s.info.share_rule, s.roster);
  return [...shares.filter((x) => x.share > 0n).map((x) => `${x.account}: ${usdcExact(x.share)} USDC`), t(`reserve back to the DAO: ${usdcExact(reserve)} USDC`, `cadangan kembali ke DAO: ${usdcExact(reserve)} USDC`)];
};
// a FunctionCall that sends the co-op's USDC to the contract as a profit share
const shareCall = (p) => kindOf(p) === "FunctionCall" && p.kind.FunctionCall.receiver_id === dep.usdc
  && p.kind.FunctionCall.actions.length === 1 && p.kind.FunctionCall.actions[0].method_name === "ft_transfer_call"
  && (() => { const a = JSON.parse(argsOf(p.kind.FunctionCall.actions[0].args) ?? "{}"); return a.receiver_id === dep.contract && a.msg === "share" && typeof a.amount === "string" && /^\d{1,30}$/.test(a.amount) ? BigInt(a.amount) : null; })();

const connector = new NearConnector({ network: dep.network, providers: { [dep.network]: RPC_URLS } });
const box = $("joinapp");
let me = "";
// ?invite=<member>: who shared the link, named in the newcomer's membership proposal
const invitedBy = inviteParam(location.search);
let busy = false;
let note = "";
/** A validation message, shown in place: no re-render, so nothing the member is typing is lost. */
function say(html) {
  note = html;
  let line = box.querySelector(".note-line");
  if (!line) { line = document.createElement("p"); line.className = "note-line"; box.append(line); }
  line.innerHTML = html;
  told();
}
/** The dashboard (dashboard.js) shows who is signed in and the last transaction's state outside this panel. */
const told = () => window.dispatchEvent(new CustomEvent("koperasi:wallet", { detail: { me, note } }));
/** The account signed in (or previewed with ?as=), "" when none. */
export const account = () => me;

/** Thrown before the wallet opens: nothing was signed or sent. */
const notSent = (msg) => Object.assign(new Error(msg), { notSent: true });

// gasless (NEP-366): wallets that sign delegate actions send co-op calls through the co-op's relayer (api/relay.mjs),
// which pays the gas. Only calls with no deposit: under NEP-366 the relayer would pay a deposit, so the relayer refuses
// those and they go from the member's wallet. Off when the relayer is off (e.g. on localhost).
const relay = fetch("/api/relay", { signal: AbortSignal.timeout(8_000) }).then((r) => r.ok && r.json()).then((j) => !!j?.on, () => false);
let gasless = false;
/** The last transaction's outcome: a vote that completed an Ethereum signature carries the MPC network's answer. */
let lastOut = null;
/** HTML added to a confirmation, built from escaped values only. */
let extra = "";

async function send(receiverId, methodName, args, { deposit = 0n, tgas = 100 } = {}) {
  const wallet = await connector.wallet();
  const action = { type: "FunctionCall", params: { methodName, args, gas: (BigInt(tgas) * 10n ** 12n).toString(), deposit: deposit.toString() } };
  gasless = BigInt(deposit) === 0n && [dep.contract, dep.dao].includes(receiverId) && !!wallet.manifest?.features?.signDelegateActions && await relay;
  // the chain's own numbers first: a call the account cannot pay for is never signed
  const lack = affordable(await query({ request_type: "view_account", account_id: me }), deposit, gasless ? 0 : tgas);
  if (lack) throw notSent(lack);
  let out;
  if (gasless) {
    const { signedDelegateActions: [signedDelegate] } = await wallet.signDelegateActions({ delegateActions: [{ receiverId, actions: [action] }] });
    const r = await fetch("/api/relay", { method: "POST", signal: AbortSignal.timeout(90_000), headers: { "content-type": "application/json" }, body: JSON.stringify({ signedDelegate }) });
    const body = await r.json().catch(() => ({}));
    if (r.status === 429 || r.status === 503) gasless = false; // relayer busy or off: the member pays the gas instead
    else if (!r.ok) throw Object.assign(new Error(`the co-op's relayer: ${body.error ?? r.status}`), { hash: body.hash });
    else out = body.outcome;
  }
  out ??= await wallet.signAndSendTransaction({ receiverId, actions: [action] });
  lastOut = out;
  const failure = out?.status?.Failure ?? out?.receipts_outcome?.find((r) => r.outcome.status.Failure)?.outcome.status.Failure;
  if (failure) {
    const s = JSON.stringify(failure);
    throw Object.assign(new Error(s.match(/"panic_msg":"([^"]+)"/)?.[1] ?? s.match(/ExecutionError":"([^"]+)"/)?.[1] ?? s.slice(0, 160)),
      { hash: out?.transaction?.hash ?? out?.transaction_outcome?.id });
  }
  return out?.transaction?.hash ?? out?.transaction_outcome?.id;
}

const kindOf = (p) => (typeof p.kind === "string" ? p.kind : Object.keys(p.kind)[0]);
// what a proposal really does, built from its kind; the proposer's description is shown apart, as their claim
const yocto = (y) => (BigInt(y || 0) > 0n ? t(`, attaches ${nearAmt(y)} NEAR`, `, melampirkan ${nearAmt(y)} NEAR`) : "");
const argsOf = (b64) => {
  try { return JSON.stringify(JSON.parse(atob(b64)), null, 1); } catch { return null; }
};
// a proposal whose args we cannot show in full is not voted on from here
export const opaque = (p) => kindOf(p) === "FunctionCall" && p.kind.FunctionCall.actions.some((a) => argsOf(a.args) === null)
  || !["AddMemberToRole", "RemoveMemberFromRole", "Transfer", "FunctionCall", "AddBounty", "BountyDone"].includes(kindOf(p))
  || (kindOf(p) === "AddBounty" && !validToken(p.kind.AddBounty.bounty.token));
// a NEAR account id (or "" for NEAR itself); anything else is not voted on from here
const validToken = (t) => t === "" || /^(?=.{2,64}$)[a-z0-9]+([-_][a-z0-9]+)*(\.[a-z0-9]+([-_][a-z0-9]+)*)*$/.test(String(t));
// only the co-op's own USDC contract is called USDC; any other token shows its raw contract id, flagged
const pays = (token, amount) => (!token ? `${nearAmt(amount)} NEAR`
  : token === dep.usdc ? `${usdc(amount)} USDC` : `${amount} base units of UNKNOWN token ${token}`);
const DAY_NS = 86_400_000_000_000n;
const describe = (p, s) => {
  const k = kindOf(p);
  const shared = s && shareCall(p);
  if (shared) return `${t(`Profit share: send ${usdc(shared)} USDC from the treasury to the co-op contract, split by its rule.\nIf approved now:`,
    `Sisa hasil usaha (SHU): kirim ${usdc(shared)} USDC dari kas ke kontrak koperasi, dibagi menurut aturannya.\nJika disetujui sekarang:`)}\n  ${preview(shared, s).join("\n  ")}`;
  if (k === "AddMemberToRole") return t(`Add ${oneLine(p.kind.AddMemberToRole.member_id)} to role ${oneLine(p.kind.AddMemberToRole.role)}`,
    `Tambahkan ${oneLine(p.kind.AddMemberToRole.member_id)} ke peran ${oneLine(p.kind.AddMemberToRole.role)}`);
  if (k === "RemoveMemberFromRole") return t(`Remove ${oneLine(p.kind.RemoveMemberFromRole.member_id)} from role ${oneLine(p.kind.RemoveMemberFromRole.role)}`,
    `Keluarkan ${oneLine(p.kind.RemoveMemberFromRole.member_id)} dari peran ${oneLine(p.kind.RemoveMemberFromRole.role)}`);
  if (k === "AddBounty") {
    const b = p.kind.AddBounty.bounty;
    // the terms first, from the proposal's own fields; the proposer's task text last, on one line and cut, so it
    // cannot pose as another line of what the proposal does
    const task = String(b.description).replace(/\s+/g, " ").slice(0, 120);
    return `Open a paid task: ${pays(b.token, b.amount)} × ${b.times} = up to ${pays(b.token, BigInt(b.amount) * BigInt(b.times))}, `
      + `${Number(BigInt(b.max_deadline) / DAY_NS)} days to deliver once taken\nTask text (proposer's words): “${task}”`;
  }
  if (k === "BountyDone") return t(`Pay task #${p.kind.BountyDone.bounty_id} to ${oneLine(p.kind.BountyDone.receiver_id)} from the treasury`,
    `Bayar tugas #${p.kind.BountyDone.bounty_id} kepada ${oneLine(p.kind.BountyDone.receiver_id)} dari kas`);
  if (k === "Transfer") return t(`Transfer ${pays(oneLine(p.kind.Transfer.token_id), p.kind.Transfer.amount)} to ${oneLine(p.kind.Transfer.receiver_id)}`,
    `Kirim ${pays(oneLine(p.kind.Transfer.token_id), p.kind.Transfer.amount)} kepada ${oneLine(p.kind.Transfer.receiver_id)}`);
  const batch = ethBatch(p);
  if (batch) return batch.ok
    ? `Pay ${batch.ts.length} Sepolia ETH payments from the co-op's Ethereum address, each signed by NEAR's MPC network for the DAO:\n`
      + batch.ts.map((t) => `${ethAmt(t.value)} ETH to ${t.to} (nonce ${t.nonce}, fee at most ${ethAmt(t.gas * t.maxFeePerGas)} ETH)`).join("\n")
      + "\nChecked here: each hash to sign is the transaction's at the same place."
    : "Sign several hashes with the co-op's Ethereum address.\nWARNING: they do not all match the plain Sepolia payments in the description. Do not approve.";
  const pay = ethPayment(p);
  if (pay) return pay.ok
    ? `Pay ${ethAmt(pay.t.value)} Sepolia ETH from the co-op's Ethereum address to ${pay.t.to} (Sepolia, nonce ${pay.t.nonce}, fee at most ${ethAmt(pay.t.gas * pay.t.maxFeePerGas)} ETH): NEAR's MPC network signs it for the DAO.
Checked here: the hash to sign, ${pay.asked.slice(0, 16)}…, is this transaction's.`
    : pay.matches
      ? `Sign a transaction from the co-op's Ethereum address that is not a plain Sepolia payment (chain ${pay.t.chainId}, fee up to ${ethAmt(pay.t.gas * pay.t.maxFeePerGas)} ETH).
WARNING: do not approve unless the members agreed to exactly this.`
      : `Sign ${pay.asked} with the co-op's Ethereum address.
WARNING: the transaction in the description does not make this hash. Do not approve: you would sign something else.`;
  if (k === "FunctionCall") {
    const f = p.kind.FunctionCall;
    // for the co-op's own contract, a sentence first; the raw call stays under it, so the sentence can be checked
    const said = (a) => (f.receiver_id === dep.contract && argsOf(a.args) !== null ? plainCall(a.method_name, JSON.parse(atob(a.args))) : null);
    return f.actions.map((a) => `${said(a) ? `${said(a)}\n` : ""}Call ${f.receiver_id} ${oneLine(a.method_name)}${yocto(a.deposit)}\n${argsOf(a.args) ?? "(binary args: inspect in the DAO)"}`).join("\n\n");
  }
  return t(`${k} (open the DAO to inspect)`, `${k} (buka DAO untuk memeriksanya)`);
};

// a proposal that asks NEAR's MPC network to sign for the co-op's Ethereum address (trezu/testnet/kop-pay-ethereum.json)
const SIGNER = dep.chainSignatures?.signer ?? "v1.signer-prod.testnet";
const ethAmt = (wei) => (Number(BigInt(wei) / 10n ** 12n) / 1e6).toString();
function ethPayment(p) {
  if (kindOf(p) !== "FunctionCall" || p.kind.FunctionCall.receiver_id !== SIGNER) return null;
  const a = p.kind.FunctionCall.actions;
  if (a.length !== 1 || a[0].method_name !== "sign") return null;
  let asked;
  try { asked = JSON.parse(atob(a[0].args)).request.payload_v2.Ecdsa; } catch { return null; }
  if (!/^[0-9a-f]{64}$/.test(String(asked))) return null;
  const t = txFromText(p.description);
  // the hash must be this transaction's, and the transaction a plain Sepolia payment (no other chain, no outsized fee)
  const matches = !!t && toHex(txHash(t)) === asked;
  return { asked, t, matches, ok: matches && plainPayment(t) };
}

/**
 * A batch of payments from the co-op's Ethereum address signed in one vote (scripts/chainsig.mjs --batch): every sign
 * action must ask for the hash of the transaction at the same place in the description, each a plain Sepolia payment.
 */
function ethBatch(p) {
  if (kindOf(p) !== "FunctionCall" || p.kind.FunctionCall.receiver_id !== SIGNER) return null;
  const a = p.kind.FunctionCall.actions;
  if (a.length < 2 || a.some((x) => x.method_name !== "sign")) return null;
  const ts = txsFromText(p.description);
  const asked = a.map((x) => { try { return JSON.parse(atob(x.args)).request.payload_v2.Ecdsa; } catch { return null; } });
  const ok = ts.length === a.length && ts.every((t, i) => t && toHex(txHash(t)) === asked[i] && plainPayment(t));
  return { ts, ok };
}

// proposals are anyone's on-chain data: one malformed proposal must not take the panel down for every member
export const safeDescribe = (p, s) => {
  try { return describe(p, s); } catch { return t(`${kindOf(p)} (malformed: inspect it in the DAO)`, `${kindOf(p)} (rusak: periksa di DAO)`); }
};

async function load() {
  // tasks with earned trust are read in the same round: open to anyone signed in, members also post and approve
  const [info, member, pending, policy, last, board, tasks, recs] = await Promise.all([
    view(dep.contract, "get_info"),
    view(dep.contract, "get_member", { account_id: me }),
    view(dep.contract, "is_pending", { account_id: me }),
    view(dep.dao, "get_policy"),
    view(dep.dao, "get_last_proposal_id"),
    view(dep.contract, "get_board"),
    all(dep.contract, "get_tasks"),
    view(dep.contract, "get_contributors"),
  ]);
  const proposals = await view(dep.dao, "get_proposals", { from_index: Math.max(0, last - 50), limit: 50 });
  // held payouts on trust: when each may be released (ms), so the panel offers the veto or the release
  const dues = Object.fromEntries(await Promise.all(tasks.filter((t) => t.status === "Held")
    .map(async (t) => [t.id, Number(BigInt((await view(dep.contract, "get_task_due", { id: t.id })) ?? 0) / 1_000_000n)])));
  const group = policy.roles.find((r) => r.name === "member")?.kind?.Group ?? [];
  const [num, den] = policy.default_vote_policy?.threshold ?? [1, 2];
  const needed = Math.floor((group.length * num) / den) + 1;
  const request = [...proposals].reverse().find((p) => kindOf(p) === "AddMemberToRole" && p.kind.AddMemberToRole.member_id === me);
  const leave = [...proposals].reverse().find((p) => kindOf(p) === "RemoveMemberFromRole" && p.kind.RemoveMemberFromRole.member_id === me);
  const onNetwork = await query({ request_type: "view_account", account_id: me })
    .then(() => true, (e) => (/does not exist|UNKNOWN_ACCOUNT/i.test(String(e?.message)) ? false : true));
  const claimable = member ? await view(dep.contract, "get_claimable", { account_id: me }) : "0";
  const pool = member ? await view(dep.contract, "get_staking_pool") : null;
  const staked = pool ? await view(pool, "get_account_staked_balance", { account_id: me }).catch(() => "0") : "0";
  // [yoctoNEAR, counts from (ns)]: a stake increase that waits 7 days before it counts (S12)
  const waiting = pool ? await view(dep.contract, "get_pending_savings", { account_id: me }).catch(() => null) : null;
  const usdcReady = member ? await view(dep.usdc, "storage_balance_of", { account_id: me }).catch(() => null) : null;
  // what the token itself asks for a registration (NEP-145), not a guess
  const usdcStorage = member && !usdcReady ? BigInt((await view(dep.usdc, "storage_balance_bounds")).min) : 0n;
  // every member: the share preview splits among all of them
  const roster = member ? await all(dep.contract, "get_members") : [];
  const treasury = member ? BigInt(await view(dep.usdc, "ft_balance_of", { account_id: dep.dao }).catch(() => "0")) : 0n;
  const nb = member ? await view(dep.dao, "get_last_bounty_id") : 0;
  const bounties = nb ? (await view(dep.dao, "get_bounties", { from_index: 0, limit: nb })).filter((b) => b.times > 0) : [];
  const myClaims = member ? await view(dep.dao, "get_bounty_claims", { account_id: me }).catch(() => []) : [];
  // pledges, the court and standing (contract 0.2.4): null on older code
  const [pledges, pclaims, cases, standing, receipts] = await Promise.all([all(dep.contract, "get_pledges"), all(dep.contract, "get_pledge_claims"),
    all(dep.contract, "get_cases"), view(dep.contract, "get_standing", { account_id: me }), member ? all(dep.contract, "get_receipts") : []]
    .map((x) => Promise.resolve(x).catch(() => null)));
  // contract 0.2.7: appeals of dismissed cases, the members' payout routes, the work-record token (null on older code)
  const appeals = Object.fromEntries(await Promise.all((cases ?? []).filter((c) => c.status === "Dismissed")
    .map(async (c) => [c.id, await view(dep.contract, "get_appeal", { id: c.id }).catch(() => null)])));
  const [routes, token] = await Promise.all([view(dep.contract, "get_payout_routes"), view(dep.contract, "nft_token", { token_id: me })]
    .map((x) => x.catch(() => undefined)));
  // contract 0.2.9: the dues the members voted and where this member stands on them (null on older code or no dues)
  const duesStatus = member ? await view(dep.contract, "get_dues_status", { account_id: me }).catch(() => null) : null;
  // contract 0.3.0: the loan rule and fund, this member's loan and guarantors (null on older code)
  const [loanRule, loan, guarantors] = await Promise.all([view(dep.contract, "get_loan_rule"), view(dep.contract, "get_loan", { account_id: me }),
    view(dep.contract, "get_guarantors", { account_id: me })].map((x) => x.catch(() => null)));
  return { loanRule, loan, guarantors, duesStatus, appeals, routes, token, onNetwork, info, member, pending, policy, inRole: group.includes(me), needed, members: group.length, group, request, leave, proposals, claimable, usdcReady, usdcStorage, pool, staked, waiting, bounties, myClaims, roster, treasury,
    board, tasks, dues, records: Object.fromEntries(recs), pledges, pclaims, cases, standing, receipts };
}

// each button runs one transaction, then the panel re-reads the chain. The stages a member sees:
// checking with the chain → waiting for your signature → confirmed (link) | failed on-chain (reason, link) |
// cancelled in the wallet | network did not answer (check before retrying). One at a time: the panel is busy meanwhile.
async function act(label, fn, check) {
  if (busy) return;
  busy = true;
  extra = "";
  box.querySelectorAll("button, input, select").forEach((el) => { el.disabled = true; });
  say(t(`${label}: checking with the chain first…`, `${label}: memeriksa ke chain dulu…`));
  try {
    const problem = check ? await check() : null;
    if (problem) throw notSent(problem);
    say(t(`${label}: waiting for your signature in the wallet. Once signed, NEAR confirms it in about 2 seconds.`,
      `${label}: menunggu tanda tangan Anda di dompet. Setelah ditandatangani, NEAR mengonfirmasinya dalam sekitar 2 detik.`));
    const hash = await fn();
    note = `<span class="ok">${label}: ${t("confirmed on-chain", "terkonfirmasi on-chain")}${gasless ? t(", gas paid by the co-op's relayer", ", biaya gas dibayar relayer koperasi") : ""}.</span>${
      hash ? ` <a href="${esc(txUrl(hash))}">${t("See the transaction", "Lihat transaksinya")}</a>.` : ""}${extra}`;
  } catch (e) {
    const link = e?.hash ? ` <a href="${esc(txUrl(e.hash))}">${t("See the failed transaction", "Lihat transaksi yang gagal")}</a>.` : "";
    if (e?.notSent) note = `<span class="err">${label}: ${t("not sent.", "tidak dikirim.")} ${esc(e.message)}</span>`;
    else {
      const { kind, text: en } = walletError(e);
      // share.js's two fixed sentences in Indonesian; a contract's own reason stays as the chain said it
      const text = kind === "rejected" ? t(en, "Anda membatalkannya di dompet. Tidak ada yang dikirim.")
        : kind === "network" ? t(en, "Jaringan tidak menjawab. Transaksinya mungkin tetap masuk: periksa akun Anda di explorer sebelum mencoba lagi.") : en;
      note = kind === "rejected" ? `${label}: ${esc(text)}`
        : `<span class="err">${label} ${kind === "network" ? t("status unknown", "status tidak diketahui") : e?.hash ? t("failed on-chain", "gagal on-chain") : t("failed", "gagal")}: ${esc(text)}</span>${link}`;
    }
  }
  busy = false;
  await new Promise((r) => setTimeout(r, 1500));
  forget(); // the member's own transaction changed what the views say
  await render();
}

const TASK_FEE = 10n ** 22n; // 0.01 NEAR, kept for the task's storage (TASK_FEE in contract/src/tasks.rs)
const PLEDGE_FEE = 10n ** 22n; // 0.01 NEAR, kept for a pledge's or a claim's storage (PLEDGE_FEE in contract/src/commons.rs)
const workLink = (d) => (/^https:\/\/\S+$/.test(d) ? `<a href="${esc(d)}" rel="noopener">${esc(d)}</a>` : esc(d));
function tasksPanel(s) {
  const r = s.board.rule;
  let html = `<h3 class="jh">${t("Tasks with earned trust", "Tugas dengan kepercayaan yang diraih")}</h3>`;
  if (!r) return `${html}<p class="small">${t("The members have not voted a trust rule yet, so no task can be posted.", "Anggota belum memilih aturan kepercayaan, jadi belum ada tugas yang bisa dipasang.")}</p>`;
  const sources = (a) => trustSources(s.records[a]?.refs ?? [], s.tasks);
  const mine = sources(me);
  const done = s.records[me]?.done ?? 0;
  html += `<p class="small">${t(`Your record: ${done} finished, trusted by ${mine} different source${mine === 1 ? "" : "s"}`,
    `Catatan Anda: ${done} selesai, dipercaya oleh ${mine} sumber berbeda`)}${
    mine >= r.trusted_after ? t(`, so tasks up to ${nearAmt(r.auto_max)} NEAR pay you from the DAO treasury when the poster accepts`,
      `, jadi tugas sampai ${nearAmt(r.auto_max)} NEAR dibayar dari kas DAO begitu pemasangnya menerima`) : ""}.
    ${t(`The contract may pay ${nearAmt(s.board.budget)} NEAR more.`, `Kontrak masih boleh membayar ${nearAmt(s.board.budget)} NEAR lagi.`)}</p>`;
  const li = (k, action) => `<li><span><strong>#${k.id}</strong> ${esc(k.description)}<span class="claim">${t(`Pays ${nearAmt(k.amount)} NEAR, posted by`, `Bayaran ${nearAmt(k.amount)} NEAR, dipasang oleh`)} ${esc(k.poster)}${
    k.deliverable ? `; ${t("delivered", "diserahkan")}: ${workLink(k.deliverable)}` : ""}</span></span>${action}</li>`;
  const items = s.tasks.flatMap((k) => {
    if (k.status === "Open" && k.poster !== me) return [li(k, `<button type="button" class="btn small" data-ttake="${k.id}">${t("Take this task", "Ambil tugas ini")}</button>`)];
    if (k.status === "Claimed" && k.contributor === me) return [li(k, `<span class="task-done"><input id="w-tw-${k.id}" type="text" maxlength="500" placeholder="${t("Link to your work", "Tautan ke hasil kerja Anda")}" aria-label="${t("Link to your work for task", "Tautan ke hasil kerja Anda untuk tugas")} #${k.id}">
      <button type="button" class="btn small" data-tsubmit="${k.id}">${t("Deliver", "Serahkan")}</button><button type="button" class="btn ghost small" data-tgiveup="${k.id}">${t("Give up", "Mundur")}</button></span>`)];
    if (k.status === "Submitted" && k.poster === me) {
      const how = payPath(k.amount, r, sources(k.contributor)) === "trust"
        ? t("pays at once if you are within your daily limit", "langsung dibayar jika masih dalam batas harian Anda")
        : t("then one other member approves", "lalu satu anggota lain menyetujui");
      return [li(k, `<button type="button" class="btn small" data-taccept="${k.id}">${t("Accept the work", "Terima hasil kerjanya")} (${how})</button>`)];
    }
    if (k.status === "Held") {
      const due = s.dues?.[k.id];
      const open = due && Date.now() < due;
      return [li(k, `${open ? `<span class="small">${t("held until", "ditahan sampai")} ${new Date(due).toLocaleTimeString()}</span>` : ""}${
        s.member && k.contributor !== me ? `<button type="button" class="btn ghost small" data-tveto="${k.id}">${t("Veto: needs one member", "Veto: cukup satu anggota")}</button>` : ""}${
        open ? "" : `<button type="button" class="btn small" data-trelease="${k.id}">${t("Release the payout", "Cairkan bayarannya")}</button>`}`)];
    }
    if (k.status === "NeedsApproval" && s.member && k.poster !== me && k.contributor !== me) {
      return [li(k, `<button type="button" class="btn small" data-tapprove="${k.id}">${t("Approve paying", "Setujui pembayaran kepada")} ${esc(k.contributor)}</button>`)];
    }
    return [];
  });
  html += items.length ? `<ul class="props tasks">${items.join("")}</ul>` : `<p class="small">${t("Nothing for you to do on the board right now.", "Belum ada yang perlu Anda kerjakan di papan tugas.")}</p>`;
  if (s.member) {
    html += `<div class="stake-row"><label>${t("Task", "Tugas")} <input id="w-task-desc" type="text" maxlength="500" autocomplete="off" aria-label="${t("Task description", "Uraian tugas")}"></label>
      <label>${t("Pays", "Bayaran")} <input id="w-task-amt" type="text" inputmode="decimal" autocomplete="off" aria-label="${t("NEAR to pay", "NEAR yang dibayar")}" placeholder="0.05"> NEAR</label>
      <button type="button" class="btn" id="w-task-post">${t("Post (0.01 NEAR storage)", "Pasang (0.01 NEAR penyimpanan)")}</button></div>
      <p class="small">${t(`Up to ${nearAmt(r.one_vote_max)} NEAR. Larger tasks are DAO bounties, voted by all members.`,
        `Sampai ${nearAmt(r.one_vote_max)} NEAR. Tugas yang lebih besar menjadi bounty DAO, dipilih oleh semua anggota.`)}</p>`;
  }
  return html;
}

// pledges and the co-op court (contract/src/commons.rs): members only; the contract re-checks every rule
const COURT_BOND = 5n * 10n ** 23n; // 0.5 NEAR (COURT_BOND)
const APPEAL_BOND = 10n ** 24n; // 1 NEAR (APPEAL_BOND)
const DAY_MS = 86_400_000;
const nsMs = (ns) => Number(BigInt(ns) / 1_000_000n);
/**
 * What needs this member now, in one list at the top of the panel: proposals they have not voted on, court cases where
 * they are a juror and have not ruled, pledges they called in and must confirm, dues coming due. With the browser's
 * permission, a notification when something new appears (remembered per account in this browser only).
 */
export function inboxItems(s, now = Date.now()) {
  const items = [];
  for (const p of s.proposals) {
    if (p.status === "InProgress" && !p.votes?.[me]) {
      items.push({ key: `p${p.id}`, text: `${t(`Vote on DAO proposal #${p.id}`, `Berikan suara pada usulan DAO #${p.id}`)}: ${oneLine(p.description).slice(0, 90)}` });
    }
  }
  for (const c of s.cases ?? []) {
    if (c.status === "Open" && c.jurors.includes(me) && !c.votes.some(([j]) => j === me)) {
      const by = new Date(nsMs(c.opened) + 3 * DAY_MS).toLocaleDateString();
      items.push({ key: `c${c.id}`, text: t(`You are a juror on court case #${c.id}: rule by ${by}`, `Anda juri dalam perkara #${c.id}: putuskan paling lambat ${by}`) });
    }
  }
  for (const c of s.pclaims ?? []) {
    if (c.holder === me && c.status === "Open") {
      items.push({ key: `k${c.id}`, text: t(`Say whether pledge #${c.pledge}, which you called in, was kept`, `Nyatakan apakah janji #${c.pledge} yang Anda tagih sudah ditepati`) });
    }
  }
  if (s.duesStatus) {
    const [until, ok] = s.duesStatus;
    const left = nsMs(until) - now;
    const day = new Date(nsMs(until)).toLocaleDateString();
    if (!ok) items.push({ key: "dues-late", text: t("Your dues are more than 7 days late: you are out of good standing until you pay",
      "Simpanan wajib Anda terlambat lebih dari 7 hari: status Anda tidak baik sampai Anda membayar") });
    else if (left < 7 * DAY_MS) items.push({ key: `dues${until}`, text: t(`Your dues fall due on ${day}`, `Simpanan wajib Anda jatuh tempo pada ${day}`) });
  }
  return items;
}

function inboxPanel(s) {
  const items = inboxItems(s);
  let seen = [];
  try { seen = JSON.parse(localStorage.getItem(`kop-seen:${me}`) ?? "[]"); } catch { /* private mode */ }
  const fresh = items.filter((i) => !seen.includes(i.key));
  if (fresh.length && typeof Notification !== "undefined" && Notification.permission === "granted") {
    try { new Notification(t("Koperasi: something needs you", "Koperasi: ada yang menunggu Anda"), { body: fresh.map((i) => i.text).join("\n").slice(0, 300) }); } catch { /* not allowed here */ }
  }
  try { localStorage.setItem(`kop-seen:${me}`, JSON.stringify(items.map((i) => i.key))); } catch { /* private mode */ }
  const ask = typeof Notification !== "undefined" && Notification.permission === "default"
    ? ` <button type="button" class="linkish" id="w-notify">${t("Tell me in this browser when something new needs me", "Beri tahu saya di browser ini jika ada hal baru untuk saya")}</button>` : "";
  return `<div class="inbox" id="w-inbox"><h3 class="jh">${t("Needs you", "Menunggu Anda")}${items.length ? ` (${items.length})` : ""}</h3>${items.length
    ? `<ul>${items.map((i) => `<li>${fresh.includes(i) ? `<strong>${t("new", "baru")}</strong> ` : ""}${esc(i.text)}</li>`).join("")}</ul>`
    : `<p class="small">${t("Nothing waits for you: no vote, no jury, no pledge to confirm, no dues due this week.",
      "Tidak ada yang menunggu Anda: tidak ada pemungutan suara, tugas juri, janji untuk dikonfirmasi, atau simpanan wajib yang jatuh tempo minggu ini.")}</p>`}<p class="small">${ask}
      ${t("Outside this page", "Di luar halaman ini")}: <a href="/api/inbox?who=${encodeURIComponent(me)}">${t("your feed", "feed Anda")}</a> ${t("(RSS, read from the chain; any feed-to-email or feed-to-Telegram service delivers it).",
        "(RSS, dibaca dari chain; layanan feed-ke-email atau feed-ke-Telegram apa pun bisa mengantarkannya).")}</p></div>`;
}

function commonsPanel(s) {
  if (!s.member || !s.pledges || !s.pclaims || !s.cases) return "";
  const [st, good] = s.standing ?? [{}, true];
  let html = `<h3 class="jh">${t("Pledges and the co-op court", "Janji dan pengadilan koperasi")}</h3>
    <p class="small">${t(`Your standing: ${st.pledges_honored ?? 0} pledge(s) kept, ${st.pledges_broken ?? 0} broken, ${st.juries_served ?? 0} jury rulings,
      ${st.juries_missed ?? 0} missed`, `Status Anda: ${st.pledges_honored ?? 0} janji ditepati, ${st.pledges_broken ?? 0} diingkari, ${st.juries_served ?? 0} putusan juri,
      ${st.juries_missed ?? 0} terlewat`)}${st.slashed ? t(`, slashed ${st.slashed} time(s)`, `, didenda ${st.slashed} kali`) : ""}: <strong>${good ? t("good", "baik") : t("not good", "tidak baik")}</strong>${
      good ? "" : t(" (you are not drawn as a juror)", " (Anda tidak diundi sebagai juri)")}.</p>`;
  const items = [];
  for (const p of s.pledges) {
    if (p.issuer !== me && p.called < p.units) items.push(`<li><span><strong>${t("Pledge", "Janji")} #${p.id}</strong> ${esc(p.what)}<span class="claim">${t("by", "oleh")} ${esc(p.issuer)}, ${t(`${p.units - p.called} of ${p.units} left`, `sisa ${p.units - p.called} dari ${p.units}`)}</span></span>
      <button type="button" class="btn small" data-predeem="${p.id}">${t("Call one in", "Tagih satu")}</button></li>`);
  }
  for (const c of s.pclaims) {
    if (c.holder !== me || c.status !== "Open") continue;
    const p = s.pledges.find((x) => x.id === c.pledge);
    const late = Date.now() >= nsMs(c.ts) + 14 * DAY_MS;
    items.push(`<li><span><strong>${t("You called in", "Anda menagih")}</strong> ${esc(p?.what ?? `${t("pledge", "janji")} #${c.pledge}`)}<span class="claim">${t("from", "dari")} ${esc(p?.issuer ?? "?")}: ${t("was it kept?", "sudah ditepati?")}</span></span>
      <span class="task-done"><button type="button" class="btn small" data-pkept="${c.id}">${t("Kept", "Ditepati")}</button>${late ? `<button type="button" class="btn ghost small" data-pbroken="${c.id}">${t("Not kept (14 days passed)", "Tidak ditepati (sudah 14 hari)")}</button>` : ""}</span></li>`);
  }
  // appeal to the members (0.2.7): the claimant of a dismissed case a juror ruled on, within 7 days after the jury's 3
  for (const c of s.cases) {
    const a = s.appeals?.[c.id];
    const head = `<span><strong>Case #${c.id}</strong> job ${esc(c.job_id)}: refund ${usdc(c.amount)} USDC to ${esc(c.refund_to)}<span class="claim">dismissed by the jury (${c.votes.length} ruled)`;
    if (c.status === "Dismissed" && a === null && c.claimant === me && c.votes.length && Date.now() < nsMs(c.opened) + 10 * DAY_MS) {
      items.push(`<li>${head}; you may appeal to every member until ${new Date(nsMs(c.opened) + 10 * DAY_MS).toLocaleDateString()}</span></span>
        <button type="button" class="btn small" data-cappeal="${c.id}">Appeal to the members (1 NEAR bond)</button></li>`);
    }
    if (a?.status === "Open" && a.proposal !== null) {
      const p = s.proposals.find((x) => x.id === a.proposal);
      const decided = p && p.status !== "InProgress";
      items.push(`<li>${head}; on appeal: the members vote DAO proposal #${a.proposal}${decided ? ` (${esc(p.status)})` : " below"}</span></span>${
        decided ? `<button type="button" class="btn small" data-csettle="${c.id}">Settle the appeal</button>` : ""}</li>`);
    }
  }
  for (const c of s.cases) {
    if (c.status !== "Open") continue;
    const over = Date.now() >= nsMs(c.opened) + 3 * DAY_MS;
    const mine = c.jurors.includes(me) && !c.votes.some(([j]) => j === me);
    const head = `<span><strong>Case #${c.id}</strong> job ${esc(c.job_id)}: refund ${usdc(c.amount)} USDC to ${esc(c.refund_to)}<span class="claim">“${esc(c.reason)}”, brought by ${esc(c.claimant)}; jurors ${c.jurors.map(esc).join(", ")}; ${c.votes.length} ruled</span></span>`;
    // contract 0.2.8: both sides are heard, the claimant and the steward who answers for the agent's work
    if (!over && (c.claimant === me || s.info?.steward === me)) {
      items.push(`<li>${head}<span class="stake-row"><label>Evidence <input type="text" maxlength="280" autocomplete="off" data-cevid-in="${c.id}" aria-label="Evidence for case #${c.id}: a link or a hash and what it shows"></label>
        <button type="button" class="btn ghost small" data-cevid="${c.id}">File (0.01 NEAR)</button></span></li>`);
    }
    if (over) items.push(`<li>${head}<button type="button" class="btn small" data-cclose="${c.id}">Close (3 days passed)</button></li>`);
    else if (mine) items.push(`<li>${head}<span class="task-done"><button type="button" class="btn small" data-crule="${c.id}" data-up="1">Uphold: refund</button><button type="button" class="btn ghost small" data-crule="${c.id}" data-up="0">Reject</button></span></li>`);
  }
  html += items.length ? `<ul class="props tasks">${items.join("")}</ul>` : `<p class="small">${t("Nothing for you to do here right now.", "Belum ada yang perlu Anda lakukan di sini.")}</p>`;
  html += `<div class="stake-row"><label>${t("I pledge", "Saya berjanji")} <input id="w-pl-what" type="text" maxlength="280" autocomplete="off" aria-label="${t("What you promise the co-op", "Apa yang Anda janjikan kepada koperasi")}" placeholder="${t("review one pull request", "memeriksa satu pull request")}"></label>
    <label>${t("times", "kali")} <input id="w-pl-units" type="number" min="1" max="20" value="1" aria-label="${t("How many times", "Berapa kali")}"></label>
    <button type="button" class="btn" id="w-pl-post">${t("Pledge", "Berjanji")}</button></div>
    <p class="small">${t("Another member calls it in and says if you kept it. Kept and broken pledges are your standing, not profit-share points.",
      "Anggota lain menagihnya dan menyatakan apakah Anda menepatinya. Janji yang ditepati dan diingkari menjadi status Anda, bukan poin SHU.")}</p>`;
  // contract 0.3.0: stand surety for another account, and the savings-and-loan fund
  if (s.loanRule !== null && s.loanRule !== undefined) {
    html += `<h3 class="jh">${t("Surety and loans", "Tanggung renteng dan pinjaman")}</h3>
      <p class="small">${t("Your guarantors", "Penjamin Anda")}: ${s.guarantors?.length ? s.guarantors.map(esc).join(", ") : t("none yet (a loan needs one)", "belum ada (pinjaman perlu satu penjamin)")}.
        ${t("If an account you stand surety for falls out of good standing, so do you, until the members clear it.",
          "Jika akun yang Anda jamin kehilangan status baik, Anda juga, sampai anggota memulihkannya.")}</p>
      <div class="stake-row"><label>${t("Stand surety for", "Jadi penjamin untuk")} <input id="w-g-who" type="text" autocomplete="off" aria-label="${t("The account you stand surety for", "Akun yang Anda jamin")}"></label>
        <button type="button" class="btn ghost" id="w-g-go">${t("Stand surety (0.01 NEAR)", "Jadi penjamin (0.01 NEAR)")}</button></div>`;
    if (s.loanRule) {
      const [r, fund] = s.loanRule;
      const open = s.loan && s.loan.status !== "Repaid";
      html += open
        // exact amounts: the contract takes nothing less than principal plus interest
        ? `<p class="small">${t(`Your loan: ${nearAmt(s.loan.principal)} NEAR plus`, `Pinjaman Anda: ${nearAmt(s.loan.principal)} NEAR ditambah`)} ${(Number(BigInt(s.loan.interest) / 10n ** 18n) / 1e6).toLocaleString("en", { maximumFractionDigits: 6 })} ${t("NEAR interest, due", "NEAR bunga, jatuh tempo")} ${new Date(nsMs(s.loan.due)).toLocaleDateString()}${s.loan.status === "Late" ? ` (<strong>${t("late", "terlambat")}</strong>)` : ""}.</p>
           <button type="button" class="btn" id="w-l-repay">${t("Repay", "Lunasi")} ${(Number((BigInt(s.loan.principal) + BigInt(s.loan.interest)) / 10n ** 18n) / 1e6).toLocaleString("en", { maximumFractionDigits: 6 })} NEAR</button>`
        : `<div class="stake-row"><label>${t("Borrow", "Pinjam")} <input id="w-l-amt" type="number" min="0.01" step="0.01" aria-label="${t("NEAR to borrow", "NEAR yang dipinjam")}"> NEAR</label>
             <button type="button" class="btn" id="w-l-go">${t("Borrow", "Pinjam")}</button></div>
           <p class="small">${t(`Up to ${nearAmt(r.max_loan)} NEAR for ${esc(r.term_days)} days at ${r.rate_bps / 100}% flat; the fund can lend ${nearAmt(fund)} NEAR now.
             The contract files the payment as a DAO proposal and approves it with its role; repaying sends it all to the treasury.`,
             `Sampai ${nearAmt(r.max_loan)} NEAR selama ${esc(r.term_days)} hari dengan bunga tetap ${r.rate_bps / 100}%; dana bisa meminjamkan ${nearAmt(fund)} NEAR sekarang.
             Kontrak mengajukan pencairannya sebagai usulan DAO dan menyetujuinya dengan perannya; pelunasan dikirim seluruhnya ke kas.`)}</p>`;
    }
  }
  const paid = (s.receipts ?? []).filter((r) => r.status === "Paid");
  if (good && paid.length) {
    html += `<details class="court"><summary>Take a buyer's dispute to the co-op court (0.5 NEAR bond)</summary>
      <div class="stake-row"><label>Job <select id="w-c-job">${paid.map((r) => `<option value="${esc(r.job_id)}">${esc(r.job_id)} (${usdc(r.price)} USDC)</option>`).join("")}</select></label>
      <label>Refund to <input id="w-c-to" type="text" autocomplete="off" aria-label="The buyer's NEAR account"></label>
      <label>USDC <input id="w-c-amt" type="text" inputmode="decimal" autocomplete="off" aria-label="USDC to refund"></label></div>
      <div class="stake-row"><label>Why <input id="w-c-why" type="text" maxlength="280" autocomplete="off" aria-label="Why the buyer should be refunded"></label>
      <button type="button" class="btn" id="w-c-open">Open the case</button></div>
      <p class="small">Only a job the buyer disputed on Agent Market and the market then paid to the agent. Three members in good standing are drawn at random;
      two must uphold. Upheld: your bond comes back and the contract refunds the buyer from the treasury. Not upheld: the bond goes to the DAO,
      and within 7 days you may appeal to every member (1 NEAR bond): the refund becomes a DAO proposal, one member one vote.</p></details>`;
  }
  return html;
}

function armCommons() {
  const one = (attr, label, method, args, tgas = 30) => box.querySelectorAll(`[data-${attr}]`).forEach((b) => {
    b.onclick = () => act(`${label} #${b.dataset[attr]}`, () => send(dep.contract, method, args(b), { tgas }));
  });
  box.querySelectorAll("[data-predeem]").forEach((b) => {
    b.onclick = () => act(t(`Call in pledge #${b.dataset.predeem}`, `Tagih janji #${b.dataset.predeem}`), () => send(dep.contract, "redeem_pledge", { id: Number(b.dataset.predeem) }, { deposit: PLEDGE_FEE, tgas: 30 }));
  });
  one("pkept", t("Kept: pledge claim", "Ditepati: tagihan janji"), "settle_pledge", (b) => ({ claim: Number(b.dataset.pkept), honored: true }));
  one("pbroken", t("Not kept: pledge claim", "Tidak ditepati: tagihan janji"), "settle_pledge", (b) => ({ claim: Number(b.dataset.pbroken), honored: false }));
  // the deciding ruling files and approves the refund in the same transaction
  one("crule", "Rule on case", "rule_case", (b) => ({ id: Number(b.dataset.crule), uphold: b.dataset.up === "1" }), 300);
  one("cclose", "Close case", "close_case", (b) => ({ id: Number(b.dataset.cclose) }), 300);
  one("csettle", "Settle the appeal of case", "settle_appeal", (b) => ({ id: Number(b.dataset.csettle) }), 300);
  box.querySelectorAll("[data-cevid]").forEach((b) => {
    b.onclick = () => {
      const what = box.querySelector(`[data-cevid-in="${b.dataset.cevid}"]`)?.value.trim() ?? "";
      if (!what) { say(`<span class="err">Evidence: a link or a hash, and what it shows (up to 280 characters).</span>`); return; }
      act(`Evidence in case #${b.dataset.cevid}`, () => send(dep.contract, "add_evidence", { id: Number(b.dataset.cevid), what }, { deposit: PLEDGE_FEE, tgas: 30 }));
    };
  });
  box.querySelectorAll("[data-cappeal]").forEach((b) => {
    b.onclick = () => act(`Appeal case #${b.dataset.cappeal} to the members`, () => send(dep.contract, "appeal_case", { id: Number(b.dataset.cappeal) }, { deposit: APPEAL_BOND, tgas: 100 }));
  });
  const post = $("w-pl-post");
  if (post) post.onclick = () => {
    const what = $("w-pl-what").value.trim();
    const units = Number($("w-pl-units").value);
    if (!what || !(units >= 1 && units <= 20)) { say(`<span class="err">${t("Pledge: say what you promise, 1 to 20 times.", "Janji: tulis apa yang Anda janjikan, 1 sampai 20 kali.")}</span>`); return; }
    act(t("Pledge", "Janji"), () => send(dep.contract, "pledge", { what, units }, { deposit: PLEDGE_FEE, tgas: 30 }));
  };
  const open = $("w-c-open");
  if (open) open.onclick = () => {
    const amt = usdcUnits($("w-c-amt").value);
    const to = $("w-c-to").value.trim();
    const why = $("w-c-why").value.trim();
    if (!amt || !to || !why) { say(`<span class="err">Case: the buyer's account, the USDC to refund and why.</span>`); return; }
    act("Open a court case", () => send(dep.contract, "open_case", { job_id: $("w-c-job").value, refund_to: to, amount: amt.toString(), reason: why },
      { deposit: COURT_BOND, tgas: 30 }));
  };
}

// beyond the co-op (contract 0.2.7, contract/src/reach.rs): where your payouts land, your work record as a token, and
// payments from the co-op's Ethereum address, which NEAR's MPC network signs only by the members' vote
const CHAINS = { near: "NEAR (your account)", base: "Base", arb: "Arbitrum", eth: "Ethereum" };
function reachPanel(s) {
  let html = "";
  if (s.member && s.routes !== undefined) {
    const mine = s.routes.find(([a]) => a === me);
    html += `<h3 class="jh">${t("Where your payouts land", "Ke mana bayaran Anda dikirim")}</h3>
      <p class="small">${t("Now", "Sekarang")}: <strong>${mine ? `${CHAINS[mine[1]] ?? esc(mine[1])}, ${esc(mine[2])}` : CHAINS.near}</strong>. ${t(`The agent's NEAR Intents wallet pays profit
      shares by these routes; its policy lists exactly the members' routes, and only a members' vote changes it.`, `Dompet NEAR Intents milik agen membayar SHU
      lewat rute ini; kebijakannya memuat persis rute para anggota, dan hanya suara anggota yang bisa mengubahnya.`)}</p>
      <div class="stake-row"><label>Chain <select id="w-route-chain">${Object.entries(CHAINS).map(([k, v]) => `<option value="${k}"${(mine?.[1] ?? "near") === k ? " selected" : ""}>${v}</option>`).join("")}</select></label>
      <label>${t("Address", "Alamat")} <input id="w-route-addr" type="text" autocomplete="off" spellcheck="false" placeholder="0x…" aria-label="${t("Your address on that chain", "Alamat Anda di chain itu")}" value="${esc(mine?.[2] ?? "")}"></label>
      <button type="button" class="btn" id="w-route">${t("Save my route", "Simpan rute saya")}</button></div>`;
  }
  if (s.token !== undefined && (s.member || s.records[me] || s.standing?.[0]?.juries_served)) {
    html += `<h3 class="jh">${t("Your work record, as a token", "Catatan kerja Anda, sebagai token")}</h3>`;
    html += s.token
      ? `<p class="small">${t(`Minted: any NEAR wallet or explorer that reads NFTs (NEP-171) shows it, read live from the contract; it cannot be transferred.
          <a href="/cert.html?who=${encodeURIComponent(me)}">See it</a>.`, `Sudah dicetak: dompet atau explorer NEAR apa pun yang membaca NFT (NEP-171) menampilkannya, dibaca langsung dari kontrak; tidak bisa dipindahtangankan.
          <a href="/cert.html?who=${encodeURIComponent(me)}">Lihat</a>.`)}</p>`
      : `<p class="small">${t("Take your record (tasks, pledges kept, juries) beyond this co-op: a token in your wallet, read live from the contract, never transferable.",
        "Bawa catatan Anda (tugas, janji yang ditepati, tugas juri) ke luar koperasi ini: token di dompet Anda, dibaca langsung dari kontrak, tidak pernah bisa dipindahtangankan.")}</p>
          <button type="button" class="btn" id="w-mint">${t("Mint my work record (0.01 NEAR storage)", "Cetak catatan kerja saya (0.01 NEAR penyimpanan)")}</button>`;
  }
  if (s.member && dep.chainSignatures?.address) {
    html += `<details class="court"><summary>Pay from the co-op's Ethereum address (members vote, NEAR signs)</summary>
      <p class="small">${esc(dep.chainSignatures.address)} on Sepolia has no private key: NEAR's MPC network signs for it only when the DAO calls it, by a vote.
      This files that vote, in the same form as the Trezu template <code>kop-pay-ethereum</code>; the vote that passes it sends the payment.</p>
      <div class="stake-row"><label>To <input id="w-eth-to" type="text" autocomplete="off" spellcheck="false" placeholder="0x…" aria-label="Ethereum address to pay"></label>
      <label>ETH <input id="w-eth-amt" type="text" inputmode="decimal" autocomplete="off" placeholder="0.001" aria-label="Sepolia ETH to pay"></label>
      <button type="button" class="btn" id="w-eth">Propose the payment</button></div></details>`;
  }
  return html;
}

function armReach(s) {
  const route = $("w-route");
  if (route) route.onclick = () => {
    const chain = $("w-route-chain").value;
    const address = $("w-route-addr").value.trim().toLowerCase();
    if (chain !== "near" && !/^0x[0-9a-f]{40}$/.test(address)) { say(`<span class="err">Route: an address of 0x and 40 hex digits.</span>`); return; }
    act(`Payouts on ${CHAINS[chain]}`, () => send(dep.contract, "set_payout_route", { chain, address: chain === "near" ? null : address }, { tgas: 30 }));
  };
  const mint = $("w-mint");
  if (mint) mint.onclick = () => act(t("Mint your work record", "Cetak catatan kerja Anda"), () => send(dep.contract, "mint_work_record", {}, { deposit: PLEDGE_FEE, tgas: 30 }));
  const pay = $("w-eth");
  if (pay) pay.onclick = () => {
    const to = $("w-eth-to").value.trim().toLowerCase();
    const amt = $("w-eth-amt").value.trim();
    if (!/^0x[0-9a-f]{40}$/.test(to) || !/^\d{1,3}(\.\d{1,6})?$/.test(amt) || !(Number(amt) > 0)) {
      say(`<span class="err">Ethereum payment: an address of 0x and 40 hex digits, and a positive ETH amount (at most 6 decimals).</span>`); return;
    }
    const [w, f = ""] = amt.split(".");
    const wei = (BigInt(w) * 10n ** 6n + BigInt(f.padEnd(6, "0"))) * 10n ** 12n;
    act(`Propose paying ${amt} Sepolia ETH`, async () => {
      // nonce and gas from Sepolia now; the members vote on the transaction itself, its fields in the description
      const t = await transfer(dep.chainSignatures.address, to, wei);
      const payload = toHex(txHash(t));
      return send(dep.dao, "add_proposal", { proposal: {
        description: `[trezu-tmpl:kop-pay-ethereum] Pay from the co-op's Ethereum address (NEAR Chain Signatures): sign ${payload} for tx ${txText(t)}`,
        kind: { FunctionCall: { receiver_id: SIGNER, actions: [{ method_name: "sign",
          args: btoa(JSON.stringify({ request: { payload_v2: { Ecdsa: payload }, path: dep.chainSignatures.path ?? "ethereum-1", domain_id: 0 } })),
          deposit: "1", gas: (100n * 10n ** 12n).toString() }] } },
      } }, { deposit: BigInt(s.policy.proposal_bond), tgas: 50 });
    });
  };
}

/** After a vote that passed an Ethereum payment: the MPC network's signature is in that vote's outcome; send it. */
async function sendSigned(p) {
  const pay = ethPayment(p);
  if (!pay?.ok) return "";
  const sig = (lastOut?.receipts_outcome ?? []).map((r) => r.outcome.status?.SuccessValue).filter(Boolean)
    .map((v) => { try { return JSON.parse(atob(v)); } catch { return null; } }).find((j) => j?.big_r);
  if (!sig) return "";
  const raw = rawTx(pay.t, sig);
  const hash = rawHash(raw);
  try {
    await eth("eth_sendRawTransaction", [raw]);
    return ` Your vote completed the signature: the payment was sent to Sepolia, <a href="${SEPOLIA.explorer}${hash}">${hash.slice(0, 12)}…</a>.`;
  } catch (e) {
    return ` Your vote completed the signature, but Sepolia refused the payment (${esc(e.message)}).`;
  }
}

const whoBar = () => `<div class="who-bar"><span>${t("Signed in as", "Masuk sebagai")} <strong>${esc(me)}</strong></span>
    <button type="button" class="linkish" id="w-out">${t("Disconnect", "Putuskan")}</button></div>`;
const step = (state, title, body) => `<li class="${state}"><b>${title}</b>${body ? `<div>${body}</div>` : ""}</li>`;

async function render() {
  told();
  await paint();
  told();
}

async function paint() {
  if (!me) {
    box.innerHTML = t(`<p>Connect a NEAR <strong>testnet</strong> wallet (Meteor, Intear, Nightly…) to join this co-op from here.
      New to testnet? Meteor creates a free testnet account with faucet NEAR.</p>
      <button type="button" class="btn" id="w-connect">Connect a testnet wallet</button>`,
    `<p>Hubungkan dompet NEAR <strong>testnet</strong> (Meteor, Intear, Nightly…) untuk bergabung dengan koperasi ini dari sini.
      Baru mengenal testnet? Meteor membuatkan akun testnet gratis berisi NEAR dari faucet.</p>
      <button type="button" class="btn" id="w-connect">Hubungkan dompet testnet</button>`);
    $("w-connect").onclick = () => connector.connect().catch(() => {});
    return;
  }
  let s;
  try { s = await load(); } catch (e) {
    box.innerHTML = `<p class="err">${t("Could not read the co-op", "Gagal membaca data koperasi")}: ${esc(e.message)}. ${t("Reload to try again.", "Muat ulang untuk mencoba lagi.")}</p>`;
    return;
  }
  if (!s.onNetwork) {
    const net = esc(dep.network);
    box.innerHTML = `${whoBar()}
      <p class="err" id="w-network">${t(`This account does not exist on NEAR ${net}, where this co-op runs. If your wallet is
        set to the other network, switch it to ${net} (in Meteor: the network menu at the top) and connect again.
        A new implicit account exists only once it has received some NEAR.`, `Akun ini tidak ada di NEAR ${net}, tempat koperasi ini berjalan. Jika dompet Anda
        diatur ke jaringan lain, ganti ke ${net} (di Meteor: menu jaringan di bagian atas) lalu hubungkan lagi.
        Akun implisit baru baru ada setelah menerima sedikit NEAR.`)}</p>
      <button type="button" class="btn" id="w-switch">${t(`Disconnect and connect a ${net} account`, `Putuskan dan hubungkan akun ${net}`)}</button>`;
    $("w-out").onclick = () => connector.disconnect().catch(() => {});
    $("w-switch").onclick = () => connector.disconnect().catch(() => {}).then(() => connector.connect()).catch(() => {});
    return;
  }
  const deposit = BigInt(s.info.join_deposit);
  const bond = BigInt(s.policy.proposal_bond);
  const joined = s.pending || !!s.member;
  const asked = !!s.request || s.inRole;
  const req = s.request;
  const approvals = req ? Object.values(req.votes).filter((v) => v === "Approve").length : 0;

  let html = whoBar();

  if (!s.member) {
    if (invitedBy && invitedBy !== me) html += `<p class="small">${t("Invited by", "Diundang oleh")} <strong>${esc(invitedBy)}</strong>${vouchParam(location.search, me)
      ? t(", who signed a vouch for your account with their wallet (NEP-413). Your request carries it, so every member can check it in their browser",
        ", yang menandatangani jaminan untuk akun Anda dengan dompetnya (NEP-413). Permohonan Anda membawanya, jadi setiap anggota bisa memeriksanya di browser mereka")
      : t(". Your request to the members names them", ". Permohonan Anda kepada anggota menyebut namanya")}${
      t(", and it shows as vouched once they vote for you.", ", dan tampil sebagai dijamin setelah ia memilih Anda.")}</p>`;
    html += `<ol class="jsteps">
      ${step(joined ? "done" : "now", t(`Pay the join deposit: ${nearAmt(deposit)} NEAR`, `Bayar simpanan pokok: ${nearAmt(deposit)} NEAR`), joined
        ? t("Paid. You get it back if the members remove you, or if you cancel before they vote you in.",
          "Sudah dibayar. Uang ini kembali jika anggota mengeluarkan Anda, atau jika Anda membatalkan sebelum mereka menerima Anda.")
        : `<button type="button" class="btn" id="w-join">${t("Pay", "Bayar")} ${nearAmt(deposit)} NEAR</button>`)}
      ${step(asked ? "done" : joined ? "now" : "todo", t("Ask the members to vote you in", "Minta anggota menerima Anda"), asked
        ? (req ? t(`Your request is <a href="${explorer(dep.dao)}">proposal #${req.id}</a>.`, `Permohonan Anda adalah <a href="${explorer(dep.dao)}">usulan #${req.id}</a>.`)
          : t("The members added you.", "Anggota sudah menambahkan Anda."))
        : joined ? `${t(`Creates a DAO proposal from your wallet. Bond ${nearAmt(bond)} NEAR, returned when the members decide.`,
          `Membuat usulan DAO dari dompet Anda. Jaminan ${nearAmt(bond)} NEAR, dikembalikan setelah anggota memutuskan.`)}
            <button type="button" class="btn" id="w-ask">${t("Create my proposal", "Buat usulan saya")}</button>` : "")}
      ${step(s.inRole ? "done" : asked ? "now" : "todo", t("The members vote", "Anggota memberikan suara"), s.inRole
        ? t("Approved. You hold the member role in the DAO.", "Disetujui. Anda memegang peran anggota di DAO.")
        : req ? `${req.status === "InProgress" ? t(`${approvals} of ${s.needed} approvals so far. Members have 7 days.`, `${approvals} dari ${s.needed} persetujuan sejauh ini. Anggota punya waktu 7 hari.`)
          : `${t("Proposal ended", "Usulan berakhir")}: ${esc(req.status)}.`}` : "")}
      ${step(s.inRole ? "now" : "todo", t("Sync your membership", "Sinkronkan keanggotaan Anda"), s.inRole
        ? `${t("The contract reads the DAO's decision on-chain.", "Kontrak membaca keputusan DAO di on-chain.")} <button type="button" class="btn" id="w-sync">${t("Sync my membership", "Sinkronkan keanggotaan saya")}</button>` : "")}
    </ol>`;
    if (s.pending && !s.inRole) html += `<p class="small"><button type="button" class="linkish" id="w-cancel">${t(`Cancel and take my ${nearAmt(deposit)} NEAR back`, `Batalkan dan ambil kembali ${nearAmt(deposit)} NEAR saya`)}</button></p>`;
  } else {
    const open = s.proposals.filter((p) => p.status === "InProgress").reverse();
    html += inboxPanel(s);
    html += `<div class="me-card">
        <div><span>${t("Your vote", "Suara Anda")}</span><strong>${t(`1 of ${s.members}`, `1 dari ${s.members}`)}</strong></div>
        <div><span>${t("Contribution points", "Poin kontribusi")}</span><strong>${s.member.points}</strong></div>
        <div><span>${t("Share to claim", "SHU yang bisa diambil")}</span><strong>${usdc(s.claimable)} USDC</strong></div>
      </div>
      ${BigInt(s.claimable) > 0n ? (s.usdcReady
        ? `<button type="button" class="btn" id="w-claim">${t("Claim", "Ambil")} ${usdc(s.claimable)} USDC</button>`
        : `<p class="small">${t("To receive USDC, register your account with the token first (a one-time", "Untuk menerima USDC, daftarkan akun Anda ke token dulu (sekali saja, simpanan penyimpanan")} ${(Number(s.usdcStorage) / 1e24).toLocaleString("en", { maximumFractionDigits: 6 })} ${t("NEAR storage deposit).", "NEAR).")}</p>
           <button type="button" class="btn" id="w-usdc">${t("Register for USDC", "Daftar untuk USDC")}</button>`) : ""}
      ${s.pool ? `<h3 class="jh">${t("Savings: your stake for the agent's inference", "Simpanan sukarela: stake Anda untuk inferensi agen")}</h3>
      <p class="small">${t("The members chose", "Anggota memilih")} <a href="${explorer(s.pool)}">${esc(s.pool)}</a>. ${t(`Your stake there is your savings: it weighs your
        profit share, and its rewards are what pay for inference. The NEAR stays yours; unstake from the pool any time.`, `Stake Anda di sana adalah simpanan Anda: ia menentukan bobot
        SHU Anda, dan imbalannya membayar inferensi. NEAR-nya tetap milik Anda; tarik dari pool kapan saja.`)}</p>
      <div class="me-card two">
        <div><span>${t("Staked in the pool now", "Di-stake di pool sekarang")}</span><strong>${nearAmt(s.staked)} NEAR</strong></div>
        <div><span>${t("Counted as savings", "Dihitung sebagai simpanan")}</span><strong>${nearAmt(s.member.savings)} NEAR</strong></div>
      </div>
      ${s.waiting ? `<p class="small">${nearAmt(s.waiting[0])} ${t(`NEAR waits to count: a stake increase counts as savings after 7 days
        in the pool, from`, `NEAR menunggu dihitung: kenaikan stake dihitung sebagai simpanan setelah 7 hari
        di pool, mulai`)} ${new Date(Number(BigInt(s.waiting[1]) / 1_000_000n)).toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
        ${t(`(sync again then). The co-op's keeper reads it twice a day meanwhile: a gap of more than a day between readings
        starts the wait again. A decrease counts at once.`, `(sinkronkan lagi saat itu). Sementara itu penjaga koperasi membacanya dua kali sehari: jeda lebih dari sehari
        antarpembacaan memulai penantian dari awal. Penurunan langsung dihitung.`)}</p>`
    : `<p class="small">${t("A stake increase counts as savings after 7 days in the pool, read at least once a day (the co-op's keeper does it); a decrease counts at once.",
      "Kenaikan stake dihitung sebagai simpanan setelah 7 hari di pool, dibaca minimal sekali sehari (oleh penjaga koperasi); penurunan langsung dihitung.")}</p>`}
      <div class="stake-row"><label>${t("Stake", "Stake")} <input id="w-amt" type="number" min="1" step="1" value="1" inputmode="numeric"> NEAR</label>
        <button type="button" class="btn" id="w-stake">${t("Stake", "Stake")}</button>
        <button type="button" class="btn ghost" id="w-sync-sav"${s.staked === s.member.savings || (s.waiting?.[0] === s.staked && BigInt(s.waiting[1]) > BigInt(Date.now()) * 1_000_000n) ? " disabled" : ""}>${t("Count my stake as savings", "Hitung stake saya sebagai simpanan")}</button></div>` : ""}
      <h3 class="jh">${t("Invite someone", "Undang seseorang")}</h3>
      <p class="small">${t(`Share this link. Their membership proposal names you, and it shows as vouched once you vote for them.
        Know their account? Sign a vouch for it with your wallet (NEP-413, no transaction, no gas): the link then carries
        your signature, their request carries it to the members, and anyone can check it against your keys on-chain.`, `Bagikan tautan ini. Usulan keanggotaan mereka menyebut nama Anda, dan tampil sebagai dijamin setelah Anda memilih mereka.
        Tahu akun mereka? Tanda tangani jaminan untuknya dengan dompet Anda (NEP-413, tanpa transaksi, tanpa gas): tautannya lalu membawa
        tanda tangan Anda, permohonan mereka membawanya ke anggota, dan siapa pun bisa memeriksanya terhadap kunci Anda di on-chain.`)}</p>
      <div class="stake-row"><input id="w-vouch-for" type="text" autocomplete="off" placeholder="their-account.testnet" aria-label="${t("Account to vouch for", "Akun yang Anda jamin")}">
        <button type="button" class="btn ghost" id="w-vouch">${t("Sign a vouch", "Tanda tangani jaminan")}</button></div>
      <div class="stake-row"><input id="w-invite" type="text" readonly value="${esc(`${location.origin}/?invite=${me}#joinapp`)}" aria-label="${t("Your invite link", "Tautan undangan Anda")}">
        <button type="button" class="btn ghost" id="w-invite-copy">${t("Copy", "Salin")}</button></div>
      <h3 class="jh">${t("Members' meeting: propose a profit share", "Rapat anggota: usulkan pembagian SHU")}</h3>
      ${s.treasury > 0n
        ? `<p class="small">${t(`The treasury holds ${usdc(s.treasury)} USDC. Choose how much to share; everyone sees each member's part before voting.`,
          `Kas berisi ${usdc(s.treasury)} USDC. Pilih berapa yang dibagi; semua melihat bagian setiap anggota sebelum memberikan suara.`)}</p>
           <div class="stake-row"><label>${t("Share", "Bagikan")} <input id="w-share-amt" type="text" inputmode="decimal" autocomplete="off" placeholder="${usdc(s.treasury)}" aria-label="${t("USDC to share", "USDC yang dibagi")}"> USDC</label>
           <button type="button" class="btn" id="w-share">${t("Propose this share", "Usulkan pembagian ini")}</button></div>
           <pre class="does" id="w-share-preview" aria-live="polite">${t("Type an amount to see each member's part.", "Ketik jumlahnya untuk melihat bagian setiap anggota.")}</pre>`
        : `<p class="small">${t(`The treasury holds 0.00 USDC of ${esc(dep.usdc.slice(0, 12))}…, so there is nothing to share yet.`,
          `Kas berisi 0.00 USDC dari ${esc(dep.usdc.slice(0, 12))}…, jadi belum ada yang bisa dibagi.`)}</p>`}
      <h3 class="jh">${t("Tasks the co-op pays for", "Tugas yang dibayar koperasi")}</h3>
      ${s.bounties.length ? `<ul class="props tasks">${s.bounties.map((b) => {
        const mine = s.myClaims.find((c) => c.bounty_id === b.id);
        const days = Number(BigInt(b.max_deadline) / DAY_NS);
        return `<li><span><strong>#${b.id}</strong> ${esc(b.description)}<span class="claim">${t("Pays", "Bayaran")} ${esc(pays(b.token, b.amount))}; ${
          t(`${b.times} left; ${days} days to deliver once taken.`, `sisa ${b.times}; ${days} hari untuk menyerahkan setelah diambil.`)}</span></span>${mine
          ? `<span class="task-done"><input id="w-work-${b.id}" type="text" maxlength="300" placeholder="${t("Link to your work (PR, file…)", "Tautan ke hasil kerja Anda (PR, berkas…)")}" aria-label="${t("Link to your work for task", "Tautan ke hasil kerja Anda untuk tugas")} #${b.id}">
             <button type="button" class="btn small" data-done="${b.id}">${t("Ask to be paid", "Minta dibayar")}</button>
             <button type="button" class="btn ghost small" data-giveup="${b.id}">${t("Give up", "Mundur")}</button></span>`
          : `<button type="button" class="btn small" data-claim="${b.id}" data-days="${days}">${t(`Take this task (${nearAmt(s.policy.bounty_bond)} NEAR bond)`, `Ambil tugas ini (jaminan ${nearAmt(s.policy.bounty_bond)} NEAR)`)}</button>`}</li>`;
      }).join("")}</ul>${s.usdcReady ? "" : `<p class="small">${t("Payouts are in USDC: register for USDC first.", "Bayaran dalam USDC: daftar untuk USDC dulu.")}</p>`}`
        : `<p class="small">${t("No open tasks right now.", "Belum ada tugas terbuka.")}</p>`}
      <h3 class="jh">${t("Open proposals", "Usulan yang terbuka")}</h3>
      ${open.length ? `<ul class="props">${open.map((p) => {
        const mine = p.votes[me];
        const hidden = opaque(p);
        return `<li><span><strong>#${p.id}</strong> <pre class="does">${esc(safeDescribe(p, s))}</pre>${p.description
          ? `<span class="claim">${t("Proposer says", "Kata pengusul")}: “${esc(p.description.slice(0, 200))}”</span>` : ""}${(() => {
            const inv = inviteOf(p, s.group);
            const by = inv ? esc(inv.by) : "";
            return inv ? `<span class="claim">${inv.vouched ? t(`Vouched: ${by} invited them and voted to approve.`, `Dijamin: ${by} mengundangnya dan memilih setuju.`)
              : t(`Says ${by} invited them; ${by} has not approved yet.`, `Mengaku diundang ${by}; ${by} belum menyetujui.`)}</span>${inv.signed
              ? `<span class="claim" data-vouch="${esc(JSON.stringify({ by: inv.by, member: p.kind.AddMemberToRole.member_id, ...inv.signed }))}">${t(`Checking ${by}'s signed vouch…`, `Memeriksa jaminan bertanda tangan dari ${by}…`)}</span>` : ""}` : "";
          })()}</span>${mine ? `<em>${mine === "Approve" ? t("you voted approve", "Anda memilih setuju") : mine === "Reject" ? t("you voted reject", "Anda memilih tolak") : `${t("you voted", "Anda memilih")} ${esc(mine.toLowerCase())}`}</em>`
          : hidden ? `<a class="small-link" href="${explorer(dep.dao)}">${t("Inspect in the DAO to vote", "Periksa di DAO untuk memilih")}</a>`
          : `<span class="vote-btns"><button type="button" class="btn small" data-vote="VoteApprove" data-id="${p.id}">${t("Approve", "Setuju")}</button>
             <button type="button" class="btn ghost small" data-vote="VoteReject" data-id="${p.id}">${t("Reject", "Tolak")}</button></span>`}</li>`;
      }).join("")}</ul>` : `<p class="small">${t("Nothing to vote on right now.", "Belum ada yang perlu dipilih.")}</p>`}
      <h3 class="jh">${t("Leave the co-op", "Keluar dari koperasi")}</h3>
      ${!s.inRole
        ? `<p class="small">${t(`The members removed you from the DAO role. Close your membership to get your ${nearAmt(s.member.join_deposit)} NEAR
             join deposit back; a profit share already credited stays yours to claim.`, `Anggota telah mengeluarkan Anda dari peran DAO. Tutup keanggotaan Anda untuk mengambil kembali simpanan pokok
             ${nearAmt(s.member.join_deposit)} NEAR; SHU yang sudah dikreditkan tetap milik Anda untuk diambil.`)}</p>
           <button type="button" class="btn" id="w-leave-sync">${t("Close my membership and take the deposit back", "Tutup keanggotaan saya dan ambil kembali simpanannya")}</button>`
        : s.leave?.status === "InProgress"
          ? `<p class="small">${t(`Your request to leave is <a href="${explorer(dep.dao)}">proposal #${s.leave.id}</a>:`, `Permohonan keluar Anda adalah <a href="${explorer(dep.dao)}">usulan #${s.leave.id}</a>:`)}
               ${t(`${Object.values(s.leave.votes).filter((v) => v === "Approve").length} of ${s.needed} approvals so far.`, `${Object.values(s.leave.votes).filter((v) => v === "Approve").length} dari ${s.needed} persetujuan sejauh ini.`)}</p>`
          : `<p class="small">${t(`Asks the members to remove you from the DAO role (bond ${nearAmt(bond)} NEAR, returned when they decide).
               Once they approve, come back here to take your ${nearAmt(s.member.join_deposit)} NEAR join deposit back.
               A profit share already credited stays yours to claim.`, `Meminta anggota mengeluarkan Anda dari peran DAO (jaminan ${nearAmt(bond)} NEAR, dikembalikan setelah mereka memutuskan).
               Setelah mereka setuju, kembali ke sini untuk mengambil simpanan pokok ${nearAmt(s.member.join_deposit)} NEAR Anda.
               SHU yang sudah dikreditkan tetap milik Anda untuk diambil.`)}</p>
             <button type="button" class="btn ghost" id="w-leave">${t("Ask to leave", "Minta keluar")}</button>`}`;
  }
  html += tasksPanel(s);
  html += commonsPanel(s);
  html += reachPanel(s);
  if (note) html += `<p class="note-line">${note}</p>`;
  box.innerHTML = html;

  $("w-out").onclick = () => connector.disconnect().catch(() => {});
  armCommons();
  armReach(s);
  const copy = $("w-invite-copy");
  if (copy) copy.onclick = () => navigator.clipboard.writeText($("w-invite").value).then(() => { copy.textContent = t("Copied", "Tersalin"); }, () => $("w-invite").select());
  const vouch = $("w-vouch");
  if (vouch) vouch.onclick = async () => {
    const who = $("w-vouch-for").value.trim();
    if (!/^(?=.{2,64}$)[a-z0-9]+([-_][a-z0-9]+)*(\.[a-z0-9]+([-_][a-z0-9]+)*)*$/.test(who) || who === me) { $("w-vouch-for").focus(); return; }
    try {
      const nonce = crypto.getRandomValues(new Uint8Array(32));
      const w = await connector.wallet();
      if (!w.signMessage) throw new Error("this wallet cannot sign messages (NEP-413); share the plain link");
      const r = await w.signMessage({ message: vouchText(me, who, dep.dao), recipient: dep.dao, nonce });
      const sig = typeof r.signature === "string" ? r.signature : btoa(String.fromCharCode(...new Uint8Array(r.signature)));
      const v = { pk: String(r.publicKey), sig, nonce: btoa(String.fromCharCode(...nonce)) };
      if (!(await checkVouch({ by: me, member: who, dao: dep.dao, ...v }))) throw new Error("the wallet's signature does not verify");
      $("w-invite").value = `${location.origin}/?${new URLSearchParams({ invite: me, for: who, pk: v.pk, sig: v.sig, n: v.nonce })}#joinapp`;
      vouch.textContent = t("Signed: copy the link", "Ditandatangani: salin tautannya");
    } catch (e) {
      vouch.textContent = `${t("Not signed", "Tidak ditandatangani")}: ${e.message ?? e}`.slice(0, 80);
    }
  };
  // a signed vouch on an open request: the signature, and that the key is a full-access key of the inviter, today
  box.querySelectorAll("[data-vouch]").forEach(async (el) => {
    const v = JSON.parse(el.getAttribute("data-vouch"));
    const sigOk = await checkVouch({ ...v, dao: dep.dao });
    const key = sigOk ? await query({ request_type: "view_access_key", account_id: v.by, public_key: v.pk }).catch(() => null) : null;
    el.textContent = sigOk && key?.permission === "FullAccess"
      ? t(`Signed vouch: ${v.by} signed "I vouch for ${v.member}" with a full-access key of their account. Verified in your browser (NEP-413).`,
        `Jaminan bertanda tangan: ${v.by} menandatangani "I vouch for ${v.member}" dengan kunci akses penuh akunnya. Diperiksa di browser Anda (NEP-413).`)
      : t(`A signed vouch is attached, but it does not verify against ${v.by}'s keys: treat the request as unvouched.`,
        `Ada jaminan bertanda tangan, tetapi tidak cocok dengan kunci ${v.by}: anggap permohonan ini tanpa jaminan.`);
  });
  const on =(id, label, fn, check) => { const b = $(id); if (b) b.onclick = () => act(label, fn, check); };
  on("w-join", t("Join deposit", "Simpanan pokok"), () => send(dep.contract, "join", {}, { deposit, tgas: 30 }), async () =>
    ((await view(dep.contract, "get_member", { account_id: me })) || (await view(dep.contract, "is_pending", { account_id: me }))
      ? t("You already joined: the panel will refresh.", "Anda sudah bergabung: panel akan dimuat ulang.") : null));
  on("w-ask", t("Membership proposal", "Usulan keanggotaan"), () => send(dep.dao, "add_proposal", {
    proposal: { description: joinText(me, invitedBy) + (invitedBy && vouchParam(location.search, me) ? vouchSuffix(vouchParam(location.search, me)) : ""),
      kind: { AddMemberToRole: { member_id: me, role: "member" } } },
  }, { deposit: bond, tgas: 50 }));
  on("w-sync", t("Sync membership", "Sinkron keanggotaan"), () => send(dep.contract, "sync_member", { account_id: me }, { tgas: 60 }));
  on("w-cancel", t("Cancel", "Batal"), () => send(dep.contract, "cancel_join", {}, { tgas: 30 }));
  on("w-leave", t("Request to leave", "Permohonan keluar"), () => send(dep.dao, "add_proposal", {
    proposal: { description: `Remove ${me} from the members: they asked to leave (from the Koperasi page)`, kind: { RemoveMemberFromRole: { member_id: me, role: "member" } } },
  }, { deposit: bond, tgas: 50 }));
  on("w-leave-sync", t("Leave", "Keluar"), () => send(dep.contract, "sync_member", { account_id: me }, { tgas: 60 }));
  on("w-usdc", t("USDC registration", "Pendaftaran USDC"), () => send(dep.usdc, "storage_deposit", { account_id: me, registration_only: true }, { deposit: s.usdcStorage, tgas: 30 }));
  // read the amount on click: act() re-renders the panel (and this input) before the transaction runs
  const stake = $("w-stake");
  if (stake) stake.onclick = () => {
    const raw = $("w-amt").value;
    const n = Number(raw);
    if (!(Number.isInteger(n) && n >= 1 && n <= 1000)) {
      say(`<span class="err">${t("Stake: enter a whole number of NEAR, 1 to 1000", "Stake: masukkan bilangan bulat NEAR, 1 sampai 1000")} (${t("got", "tertulis")} "${esc(raw)}").</span>`);
      return;
    }
    act(`Stake ${n} NEAR`, () => send(s.pool, "deposit_and_stake", {}, { deposit: BigInt(n) * 10n ** 24n, tgas: 100 }));
  };
  const gGo = $("w-g-go");
  if (gGo) gGo.onclick = () => {
    const who = $("w-g-who").value.trim();
    if (!/^[a-z0-9._-]{2,64}$/.test(who)) { say(`<span class="err">${t("Surety: a NEAR account id.", "Penjamin: isi id akun NEAR.")}</span>`); return; }
    act(t(`Stand surety for ${who}`, `Menjamin ${who}`), () => send(dep.contract, "guarantee", { account_id: who }, { deposit: PLEDGE_FEE, tgas: 30 }));
  };
  const lGo = $("w-l-go");
  if (lGo) lGo.onclick = () => {
    const n = Number($("w-l-amt").value);
    if (!(n > 0)) { say(`<span class="err">${t("Borrow: an amount of NEAR.", "Pinjam: isi jumlah NEAR.")}</span>`); return; }
    act(t(`Borrow ${n} NEAR`, `Pinjam ${n} NEAR`), () => send(dep.contract, "request_loan", { amount: (BigInt(Math.round(n * 1000)) * 10n ** 21n).toString() }, { tgas: 200 }));
  };
  const lRepay = $("w-l-repay");
  if (lRepay) lRepay.onclick = () => act(t("Repay the loan", "Pelunasan pinjaman"), () => send(dep.contract, "repay_loan", {},
    { deposit: BigInt(s.loan.principal) + BigInt(s.loan.interest), tgas: 30 }));
  const notify = $("w-notify");
  if (notify) notify.onclick = () => Notification.requestPermission().then(() => render());
  on("w-sync-sav", t("Savings sync", "Sinkron simpanan"), () => send(dep.contract, "sync_savings", { account_id: me }, { tgas: 40 }));
  on("w-claim", t("Claim", "Ambil SHU"), () => send(dep.contract, "claim_share", {}, { tgas: 60 }), async () =>
    (BigInt(await view(dep.contract, "get_claimable", { account_id: me })) > 0n ? null
      : t("Nothing to claim any more: it was claimed already.", "Tidak ada lagi yang bisa diambil: sudah diambil sebelumnya.")));
  const shareIn = $("w-share-amt");
  if (shareIn) {
    // the amount is read on click (act() re-renders the panel), and checked against the treasury before the wallet opens
    const check = () => {
      const units = usdcUnits(shareIn.value);
      if (units === null) return { err: t("a positive USDC amount, at most 6 decimals", "jumlah USDC positif, paling banyak 6 desimal") };
      if (units > s.treasury) return { err: t(`at most the ${usdc(s.treasury)} USDC the treasury holds`, `paling banyak ${usdc(s.treasury)} USDC yang ada di kas`) };
      return { units };
    };
    shareIn.oninput = () => {
      const c = check();
      $("w-share-preview").textContent = c.err ? `${t("Enter", "Masukkan")} ${c.err}.` : `${t("If the members approve:", "Jika anggota menyetujui:")}\n${preview(c.units, s).join("\n")}`;
    };
    $("w-share").onclick = () => {
      const c = check();
      if (c.err) { say(`<span class="err">${t("Profit share: enter", "SHU: masukkan")} ${esc(c.err)}.</span>`); return; }
      act(t(`Propose a ${usdc(c.units)} USDC profit share`, `Usulan SHU ${usdc(c.units)} USDC`), () => send(dep.dao, "add_proposal", { proposal: {
        description: `Profit share of ${usdc(c.units)} USDC (proposed from the Koperasi page)`,
        kind: { FunctionCall: { receiver_id: dep.usdc, actions: [{ method_name: "ft_transfer_call",
          args: btoa(JSON.stringify({ receiver_id: dep.contract, amount: c.units.toString(), msg: "share" })),
          deposit: "1", gas: (150n * 10n ** 12n).toString() }] } },
      } }, { deposit: bond, tgas: 50 }));
    };
  }
  box.querySelectorAll("[data-claim]").forEach((b) => {
    b.onclick = () => act(t(`Take task #${b.dataset.claim}`, `Ambil tugas #${b.dataset.claim}`), () => send(dep.dao, "bounty_claim",
      { id: Number(b.dataset.claim), deadline: String(BigInt(b.dataset.days) * DAY_NS) },
      { deposit: BigInt(s.policy.bounty_bond), tgas: 50 }));
  });
  box.querySelectorAll("[data-giveup]").forEach((b) => {
    b.onclick = () => act(t(`Give up task #${b.dataset.giveup}`, `Mundur dari tugas #${b.dataset.giveup}`), () => send(dep.dao, "bounty_giveup", { id: Number(b.dataset.giveup) }, { tgas: 50 }));
  });
  box.querySelectorAll("[data-done]").forEach((b) => {
    b.onclick = () => {
      const id = Number(b.dataset.done);
      const work = $(`w-work-${id}`).value.trim(); // read before act() re-renders the panel
      if (work.length < 4) { say(`<span class="err">${t(`Task #${id}: link to the work you delivered first.`, `Tugas #${id}: isi dulu tautan ke hasil kerja Anda.`)}</span>`); return; }
      // Sputnik v2's bounty_done cannot succeed (no deposit, then ERR_MIN_BOND): file BountyDone as a proposal instead
      act(t(`Ask to be paid for task #${id}`, `Minta dibayar untuk tugas #${id}`), () => send(dep.dao, "add_proposal",
        { proposal: { description: `Task #${id} done: ${work}`, kind: { BountyDone: { bounty_id: id, receiver_id: me } } } },
        { deposit: BigInt(s.policy.proposal_bond), tgas: 50 }));
    };
  });
  // accept and approve may file and approve the payout proposal in the DAO: up to ~130 Tgas of cross-contract calls
  // each task action is checked against the task's state on-chain now, by the contract's own rules (share.js: taskCheck)
  const fresh = async (id, action) => {
    const [[t], member, board, policy] = await Promise.all([view(dep.contract, "get_tasks", { from: id, limit: 1 }),
      view(dep.contract, "get_member", { account_id: me }), view(dep.contract, "get_board"), view(dep.dao, "get_policy")]);
    const members = action === "approve" ? (policy.roles.find((x) => x.name === "member")?.kind?.Group ?? []) : member ? [me] : [];
    const due = action === "release" ? await view(dep.contract, "get_task_due", { id }).then((d) => (d ? Number(BigInt(d) / 1_000_000n) : null)) : null;
    return taskCheck(action, t, me, { members, budget: board.budget, due });
  };
  const task = (attr, label, method, extra = () => ({}), tgas = 30, action = null) => box.querySelectorAll(`[data-${attr}]`).forEach((b) => {
    b.onclick = () => {
      const id = Number(b.dataset[attr]);
      const args = extra(id); // read inputs before act() re-renders the panel
      if (args) act(`${label} ${t("task", "tugas")} #${id}`, () => send(dep.contract, method, { id, ...args }, { tgas }), action ? () => fresh(id, action) : undefined);
    };
  });
  task("ttake", t("Take", "Ambil"), "claim_task", undefined, 30, "claim");
  task("tgiveup", t("Give up", "Mundur dari"), "give_up_task");
  task("taccept", t("Accept", "Terima"), "accept_task", undefined, 200, "accept");
  task("tapprove", t("Approve", "Setujui"), "approve_task", undefined, 300, "approve");
  task("tveto", "Veto", "veto_task", undefined, 30, "veto");
  task("trelease", t("Release", "Cairkan"), "release_task", undefined, 200, "release");
  task("tsubmit", t("Deliver", "Serahkan"), "submit_task", (id) => {
    const work = $(`w-tw-${id}`).value.trim();
    if (!work) { say(`<span class="err">${t(`Task #${id}: link to the work you delivered first.`, `Tugas #${id}: isi dulu tautan ke hasil kerja Anda.`)}</span>`); return null; }
    return { deliverable: work };
  }, 30, "submit");
  const post = $("w-task-post");
  if (post) post.onclick = () => {
    const desc = $("w-task-desc").value.trim();
    const amt = nearUnits($("w-task-amt").value);
    const max = BigInt(s.board.rule.one_vote_max);
    if (!desc) { say(`<span class="err">${t("Task: describe the task first.", "Tugas: uraikan tugasnya dulu.")}</span>`); return; }
    if (amt === null || amt > max) {
      say(`<span class="err">${t(`Task: pay a positive NEAR amount, at most ${nearAmt(max)} NEAR and 6 decimals.`, `Tugas: bayaran NEAR positif, paling banyak ${nearAmt(max)} NEAR dan 6 desimal.`)}</span>`); return;
    }
    act(t(`Post a ${nearAmt(amt)} NEAR task`, `Pasang tugas ${nearAmt(amt)} NEAR`), () => send(dep.contract, "post_task", { description: desc, amount: amt.toString() }, { deposit: TASK_FEE, tgas: 30 }));
  };
  box.querySelectorAll("[data-vote]").forEach((b) => { b.onclick = () => vote(Number(b.dataset.id), b.dataset.vote); });
}

/** Vote on a DAO proposal from this wallet ("VoteApprove" or "VoteReject"); also used by the dashboard's proposals view. */
export function vote(id, action) {
  let p;
  return act(action === "VoteApprove" ? t("Approve", "Setuju") : t("Reject", "Tolak"),
    async () => {
      const hash = await send(dep.dao, "act_proposal", { id: p.id, action, proposal: p.kind }, { tgas: 200 });
      if (action === "VoteApprove") extra = await sendSigned(p);
      return hash;
    },
    async () => {
      p = await view(dep.dao, "get_proposal", { id });
      if (p.status !== "InProgress") return t(`Proposal #${p.id} already ended: ${p.status}.`, `Usulan #${p.id} sudah berakhir: ${p.status}.`);
      return p.votes[me] ? t(`You already voted on proposal #${p.id}.`, `Anda sudah memilih pada usulan #${p.id}.`) : null;
    });
}

// a new event on-chain (live.js) refreshes the panel, unless a transaction is in progress
window.addEventListener("koperasi:events", () => { forget(); if (me && !busy) render(); });
// the language switch (lang.js): re-render in the new language; mid-transaction, act() re-renders when it ends
window.addEventListener("koperasi:lang", () => { if (!busy) render(); });
connector.on("wallet:signIn", (e) => { me = e?.accounts?.[0]?.accountId ?? ""; note = ""; render(); });
connector.on("wallet:signOut", () => { me = ""; note = ""; render(); });
// ponytail: ?as=<account> previews the panel for any account, on localhost only (to test each state without a wallet)
const previewAs = location.hostname === "localhost" && new URLSearchParams(location.search).get("as");
connector.getConnectedWallet().then((w) => { me = w?.accounts?.[0]?.accountId ?? ""; }).catch(() => {})
  .finally(() => { if (previewAs) me = previewAs; render(); });
