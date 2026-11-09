// Join the co-op from the page with a testnet wallet: pay the deposit, ask the members (a DAO proposal from your own
// wallet), sync once they vote you in. Members can then vote on open proposals and claim their profit share.
import { NearConnector } from "https://esm.sh/@hot-labs/near-connect@0.12.0";
import { dep, view, all, query, RPC_URLS, explorer, txUrl, $, esc, usdc, nearAmt } from "./near.js";
import { affordable, nearUnits, oneLine, payPath, splitShare, taskCheck, trustSources, usdcExact, usdcUnits, walletError } from "./share.js";

// what each member would receive from a share of `amount`, by the contract's own rule
const preview = (amount, s) => {
  const { shares, reserve } = splitShare(amount, s.info.share_rule, s.roster);
  return [...shares.filter((x) => x.share > 0n).map((x) => `${x.account}: ${usdcExact(x.share)} USDC`), `reserve back to the DAO: ${usdcExact(reserve)} USDC`];
};
// a FunctionCall that sends the co-op's USDC to the contract as a profit share
const shareCall = (p) => kindOf(p) === "FunctionCall" && p.kind.FunctionCall.receiver_id === dep.usdc
  && p.kind.FunctionCall.actions.length === 1 && p.kind.FunctionCall.actions[0].method_name === "ft_transfer_call"
  && (() => { const a = JSON.parse(argsOf(p.kind.FunctionCall.actions[0].args) ?? "{}"); return a.receiver_id === dep.contract && a.msg === "share" && typeof a.amount === "string" && /^\d{1,30}$/.test(a.amount) ? BigInt(a.amount) : null; })();

const connector = new NearConnector({ network: dep.network, providers: { [dep.network]: RPC_URLS } });
const box = $("joinapp");
let me = "";
let busy = false;
let note = "";
/** A validation message, shown in place: no re-render, so nothing the member is typing is lost. */
function say(html) {
  note = html;
  let line = box.querySelector(".note-line");
  if (!line) { line = document.createElement("p"); line.className = "note-line"; box.append(line); }
  line.innerHTML = html;
}

/** Thrown before the wallet opens: nothing was signed or sent. */
const notSent = (msg) => Object.assign(new Error(msg), { notSent: true });

async function send(receiverId, methodName, args, { deposit = 0n, tgas = 100 } = {}) {
  // the chain's own numbers first: a call the account cannot pay for is never signed
  const lack = affordable(await query({ request_type: "view_account", account_id: me }), deposit, tgas);
  if (lack) throw notSent(lack);
  const wallet = await connector.wallet();
  const out = await wallet.signAndSendTransaction({
    receiverId,
    actions: [{ type: "FunctionCall", params: { methodName, args, gas: (BigInt(tgas) * 10n ** 12n).toString(), deposit: deposit.toString() } }],
  });
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
const yocto = (y) => (BigInt(y || 0) > 0n ? `, attaches ${nearAmt(y)} NEAR` : "");
const argsOf = (b64) => {
  try { return JSON.stringify(JSON.parse(atob(b64)), null, 1); } catch { return null; }
};
// a proposal whose args we cannot show in full is not voted on from here
const opaque = (p) => kindOf(p) === "FunctionCall" && p.kind.FunctionCall.actions.some((a) => argsOf(a.args) === null)
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
  if (shared) return `Profit share: send ${usdc(shared)} USDC from the treasury to the co-op contract, split by its rule.\nIf approved now:\n  ${preview(shared, s).join("\n  ")}`;
  if (k === "AddMemberToRole") return `Add ${p.kind.AddMemberToRole.member_id} to role ${oneLine(p.kind.AddMemberToRole.role)}`;
  if (k === "RemoveMemberFromRole") return `Remove ${p.kind.RemoveMemberFromRole.member_id} from role ${oneLine(p.kind.RemoveMemberFromRole.role)}`;
  if (k === "AddBounty") {
    const b = p.kind.AddBounty.bounty;
    // the terms first, from the proposal's own fields; the proposer's task text last, on one line and cut, so it
    // cannot pose as another line of what the proposal does
    const task = String(b.description).replace(/\s+/g, " ").slice(0, 120);
    return `Open a paid task: ${pays(b.token, b.amount)} × ${b.times} = up to ${pays(b.token, BigInt(b.amount) * BigInt(b.times))}, `
      + `${Number(BigInt(b.max_deadline) / DAY_NS)} days to deliver once taken\nTask text (proposer's words): “${task}”`;
  }
  if (k === "BountyDone") return `Pay task #${p.kind.BountyDone.bounty_id} to ${p.kind.BountyDone.receiver_id} from the treasury`;
  if (k === "Transfer") return `Transfer ${pays(oneLine(p.kind.Transfer.token_id), p.kind.Transfer.amount)} to ${p.kind.Transfer.receiver_id}`;
  if (k === "FunctionCall") {
    const f = p.kind.FunctionCall;
    return f.actions.map((a) => `Call ${f.receiver_id} ${oneLine(a.method_name)}${yocto(a.deposit)}\n${argsOf(a.args) ?? "(binary args: inspect in the DAO)"}`).join("\n\n");
  }
  return `${k} (open the DAO to inspect)`;
};

// proposals are anyone's on-chain data: one malformed proposal must not take the panel down for every member
const safeDescribe = (p, s) => {
  try { return describe(p, s); } catch { return `${kindOf(p)} (malformed: inspect it in the DAO)`; }
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
  return { onNetwork, info, member, pending, policy, inRole: group.includes(me), needed, members: group.length, request, leave, proposals, claimable, usdcReady, usdcStorage, pool, staked, waiting, bounties, myClaims, roster, treasury,
    board, tasks, records: Object.fromEntries(recs) };
}

// each button runs one transaction, then the panel re-reads the chain. The stages a member sees:
// checking with the chain → waiting for your signature → confirmed (link) | failed on-chain (reason, link) |
// cancelled in the wallet | network did not answer (check before retrying). One at a time: the panel is busy meanwhile.
async function act(label, fn, check) {
  if (busy) return;
  busy = true;
  box.querySelectorAll("button, input, select").forEach((el) => { el.disabled = true; });
  say(`${label}: checking with the chain first…`);
  try {
    const problem = check ? await check() : null;
    if (problem) throw notSent(problem);
    say(`${label}: waiting for your signature in the wallet. Once signed, NEAR confirms it in about 2 seconds.`);
    const hash = await fn();
    note = `<span class="ok">${label}: confirmed on-chain.</span>${hash ? ` <a href="${esc(txUrl(hash))}">See the transaction</a>.` : ""}`;
  } catch (e) {
    const link = e?.hash ? ` <a href="${esc(txUrl(e.hash))}">See the failed transaction</a>.` : "";
    if (e?.notSent) note = `<span class="err">${label}: not sent. ${esc(e.message)}</span>`;
    else {
      const { kind, text } = walletError(e);
      note = kind === "rejected" ? `${label}: ${esc(text)}`
        : `<span class="err">${label} ${kind === "network" ? "status unknown" : e?.hash ? "failed on-chain" : "failed"}: ${esc(text)}</span>${link}`;
    }
  }
  busy = false;
  await new Promise((r) => setTimeout(r, 1500));
  await render();
}

const TASK_FEE = 10n ** 22n; // 0.01 NEAR, kept for the task's storage (TASK_FEE in contract/src/tasks.rs)
const workLink = (d) => (/^https:\/\/\S+$/.test(d) ? `<a href="${esc(d)}" rel="noopener">${esc(d)}</a>` : esc(d));
function tasksPanel(s) {
  const r = s.board.rule;
  let html = `<h3 class="jh">Tasks with earned trust</h3>`;
  if (!r) return `${html}<p class="small">The members have not voted a trust rule yet, so no task can be posted.</p>`;
  const sources = (a) => trustSources(s.records[a]?.refs ?? [], s.tasks);
  const mine = sources(me);
  html += `<p class="small">Your record: ${s.records[me]?.done ?? 0} finished, trusted by ${mine} different source${mine === 1 ? "" : "s"}${
    mine >= r.trusted_after ? `, so tasks up to ${nearAmt(r.auto_max)} NEAR pay you from the DAO treasury when the poster accepts` : ""}.
    The contract may pay ${nearAmt(s.board.budget)} NEAR more.</p>`;
  const li = (t, action) => `<li><span><strong>#${t.id}</strong> ${esc(t.description)}<span class="claim">Pays ${nearAmt(t.amount)} NEAR, posted by ${esc(t.poster)}${
    t.deliverable ? `; delivered: ${workLink(t.deliverable)}` : ""}</span></span>${action}</li>`;
  const items = s.tasks.flatMap((t) => {
    if (t.status === "Open" && t.poster !== me) return [li(t, `<button type="button" class="btn small" data-ttake="${t.id}">Take this task</button>`)];
    if (t.status === "Claimed" && t.contributor === me) return [li(t, `<span class="task-done"><input id="w-tw-${t.id}" type="text" maxlength="500" placeholder="Link to your work" aria-label="Link to your work for task #${t.id}">
      <button type="button" class="btn small" data-tsubmit="${t.id}">Deliver</button><button type="button" class="btn ghost small" data-tgiveup="${t.id}">Give up</button></span>`)];
    if (t.status === "Submitted" && t.poster === me) {
      const how = payPath(t.amount, r, sources(t.contributor)) === "trust" ? "pays at once if you are within your daily limit" : "then one other member approves";
      return [li(t, `<button type="button" class="btn small" data-taccept="${t.id}">Accept the work (${how})</button>`)];
    }
    if (t.status === "NeedsApproval" && s.member && t.poster !== me && t.contributor !== me) {
      return [li(t, `<button type="button" class="btn small" data-tapprove="${t.id}">Approve paying ${esc(t.contributor)}</button>`)];
    }
    return [];
  });
  html += items.length ? `<ul class="props tasks">${items.join("")}</ul>` : `<p class="small">Nothing for you to do on the board right now.</p>`;
  if (s.member) {
    html += `<div class="stake-row"><label>Task <input id="w-task-desc" type="text" maxlength="500" autocomplete="off" aria-label="Task description"></label>
      <label>Pays <input id="w-task-amt" type="text" inputmode="decimal" autocomplete="off" aria-label="NEAR to pay" placeholder="0.05"> NEAR</label>
      <button type="button" class="btn" id="w-task-post">Post (0.01 NEAR storage)</button></div>
      <p class="small">Up to ${nearAmt(r.one_vote_max)} NEAR. Larger tasks are DAO bounties, voted by all members.</p>`;
  }
  return html;
}

const step = (state, title, body) => `<li class="${state}"><b>${title}</b>${body ? `<div>${body}</div>` : ""}</li>`;

async function render() {
  if (!me) {
    box.innerHTML = `<p>Connect a NEAR <strong>testnet</strong> wallet (Meteor, Intear, Nightly…) to join this co-op from here.
      New to testnet? Meteor creates a free testnet account with faucet NEAR.</p>
      <button type="button" class="btn" id="w-connect">Connect a testnet wallet</button>`;
    $("w-connect").onclick = () => connector.connect().catch(() => {});
    return;
  }
  let s;
  try { s = await load(); } catch (e) {
    box.innerHTML = `<p class="err">Could not read the co-op: ${esc(e.message)}. Reload to try again.</p>`;
    return;
  }
  if (!s.onNetwork) {
    box.innerHTML = `<div class="who-bar"><span>Signed in as <strong>${esc(me)}</strong></span>
      <button type="button" class="linkish" id="w-out">Disconnect</button></div>
      <p class="err" id="w-network">This account does not exist on NEAR ${esc(dep.network)}, where this co-op runs. If your wallet is
        set to the other network, switch it to ${esc(dep.network)} (in Meteor: the network menu at the top) and connect again.
        A new implicit account exists only once it has received some NEAR.</p>
      <button type="button" class="btn" id="w-switch">Disconnect and connect a ${esc(dep.network)} account</button>`;
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

  let html = `<div class="who-bar"><span>Signed in as <strong>${esc(me)}</strong></span>
    <button type="button" class="linkish" id="w-out">Disconnect</button></div>`;

  if (!s.member) {
    html += `<ol class="jsteps">
      ${step(joined ? "done" : "now", `Pay the join deposit: ${nearAmt(deposit)} NEAR`, joined
        ? "Paid. You get it back if the members remove you, or if you cancel before they vote you in."
        : `<button type="button" class="btn" id="w-join">Pay ${nearAmt(deposit)} NEAR</button>`)}
      ${step(asked ? "done" : joined ? "now" : "todo", "Ask the members to vote you in", asked
        ? (req ? `Your request is <a href="${explorer(dep.dao)}">proposal #${req.id}</a>.` : "The members added you.")
        : joined ? `Creates a DAO proposal from your wallet. Bond ${nearAmt(bond)} NEAR, returned when the members decide.
            <button type="button" class="btn" id="w-ask">Create my proposal</button>` : "")}
      ${step(s.inRole ? "done" : asked ? "now" : "todo", "The members vote", s.inRole
        ? "Approved. You hold the member role in the DAO."
        : req ? `${req.status === "InProgress" ? `${approvals} of ${s.needed} approvals so far. Members have 7 days.` : `Proposal ended: ${esc(req.status)}.`}` : "")}
      ${step(s.inRole ? "now" : "todo", "Sync your membership", s.inRole
        ? `The contract reads the DAO's decision on-chain. <button type="button" class="btn" id="w-sync">Sync my membership</button>` : "")}
    </ol>`;
    if (s.pending && !s.inRole) html += `<p class="small"><button type="button" class="linkish" id="w-cancel">Cancel and take my ${nearAmt(deposit)} NEAR back</button></p>`;
  } else {
    const open = s.proposals.filter((p) => p.status === "InProgress").reverse();
    html += `<div class="me-card">
        <div><span>Your vote</span><strong>1 of ${s.members}</strong></div>
        <div><span>Contribution points</span><strong>${s.member.points}</strong></div>
        <div><span>Share to claim</span><strong>${usdc(s.claimable)} USDC</strong></div>
      </div>
      ${BigInt(s.claimable) > 0n ? (s.usdcReady
        ? `<button type="button" class="btn" id="w-claim">Claim ${usdc(s.claimable)} USDC</button>`
        : `<p class="small">To receive USDC, register your account with the token first (a one-time ${(Number(s.usdcStorage) / 1e24).toLocaleString("en", { maximumFractionDigits: 6 })} NEAR storage deposit).</p>
           <button type="button" class="btn" id="w-usdc">Register for USDC</button>`) : ""}
      ${s.pool ? `<h3 class="jh">Savings: your stake for the agent's inference</h3>
      <p class="small">The members chose <a href="${explorer(s.pool)}">${esc(s.pool)}</a>. Your stake there is your savings: it weighs your
        profit share, and its rewards are what pay for inference. The NEAR stays yours; unstake from the pool any time.</p>
      <div class="me-card two">
        <div><span>Staked in the pool now</span><strong>${nearAmt(s.staked)} NEAR</strong></div>
        <div><span>Counted as savings</span><strong>${nearAmt(s.member.savings)} NEAR</strong></div>
      </div>
      ${s.waiting ? `<p class="small">${nearAmt(s.waiting[0])} NEAR waits to count: a stake increase counts as savings after 7 days
        in the pool, from ${new Date(Number(BigInt(s.waiting[1]) / 1_000_000n)).toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
        (sync again then). A decrease counts at once.</p>` : `<p class="small">A stake increase counts as savings after 7 days in the pool; a decrease counts at once.</p>`}
      <div class="stake-row"><label>Stake <input id="w-amt" type="number" min="1" step="1" value="1" inputmode="numeric"> NEAR</label>
        <button type="button" class="btn" id="w-stake">Stake</button>
        <button type="button" class="btn ghost" id="w-sync-sav"${s.staked === s.member.savings || (s.waiting?.[0] === s.staked && BigInt(s.waiting[1]) > BigInt(Date.now()) * 1_000_000n) ? " disabled" : ""}>Count my stake as savings</button></div>` : ""}
      <h3 class="jh">Members' meeting: propose a profit share</h3>
      ${s.treasury > 0n
        ? `<p class="small">The treasury holds ${usdc(s.treasury)} USDC. Choose how much to share; everyone sees each member's part before voting.</p>
           <div class="stake-row"><label>Share <input id="w-share-amt" type="text" inputmode="decimal" autocomplete="off" placeholder="${usdc(s.treasury)}" aria-label="USDC to share"> USDC</label>
           <button type="button" class="btn" id="w-share">Propose this share</button></div>
           <pre class="does" id="w-share-preview" aria-live="polite">Type an amount to see each member's part.</pre>`
        : `<p class="small">The treasury holds 0.00 USDC of ${esc(dep.usdc.slice(0, 12))}…, so there is nothing to share yet.</p>`}
      <h3 class="jh">Tasks the co-op pays for</h3>
      ${s.bounties.length ? `<ul class="props tasks">${s.bounties.map((b) => {
        const mine = s.myClaims.find((c) => c.bounty_id === b.id);
        const days = Number(BigInt(b.max_deadline) / DAY_NS);
        return `<li><span><strong>#${b.id}</strong> ${esc(b.description)}<span class="claim">Pays ${esc(pays(b.token, b.amount))}; ${b.times} left; ${days} days to deliver once taken.</span></span>${mine
          ? `<span class="task-done"><input id="w-work-${b.id}" type="text" maxlength="300" placeholder="Link to your work (PR, file…)" aria-label="Link to your work for task #${b.id}">
             <button type="button" class="btn small" data-done="${b.id}">Ask to be paid</button>
             <button type="button" class="btn ghost small" data-giveup="${b.id}">Give up</button></span>`
          : `<button type="button" class="btn small" data-claim="${b.id}" data-days="${days}">Take this task (${nearAmt(s.policy.bounty_bond)} NEAR bond)</button>`}</li>`;
      }).join("")}</ul>${s.usdcReady ? "" : `<p class="small">Payouts are in USDC: register for USDC first.</p>`}`
        : `<p class="small">No open tasks right now.</p>`}
      <h3 class="jh">Open proposals</h3>
      ${open.length ? `<ul class="props">${open.map((p) => {
        const mine = p.votes[me];
        const hidden = opaque(p);
        return `<li><span><strong>#${p.id}</strong> <pre class="does">${esc(safeDescribe(p, s))}</pre>${p.description
          ? `<span class="claim">Proposer says: “${esc(p.description.slice(0, 200))}”</span>` : ""}</span>${mine ? `<em>you voted ${esc(mine.toLowerCase())}</em>`
          : hidden ? `<a class="small-link" href="${explorer(dep.dao)}">Inspect in the DAO to vote</a>`
          : `<span class="vote-btns"><button type="button" class="btn small" data-vote="VoteApprove" data-id="${p.id}">Approve</button>
             <button type="button" class="btn ghost small" data-vote="VoteReject" data-id="${p.id}">Reject</button></span>`}</li>`;
      }).join("")}</ul>` : `<p class="small">Nothing to vote on right now.</p>`}
      <h3 class="jh">Leave the co-op</h3>
      ${!s.inRole
        ? `<p class="small">The members removed you from the DAO role. Close your membership to get your ${nearAmt(s.member.join_deposit)} NEAR
             join deposit back; a profit share already credited stays yours to claim.</p>
           <button type="button" class="btn" id="w-leave-sync">Close my membership and take the deposit back</button>`
        : s.leave?.status === "InProgress"
          ? `<p class="small">Your request to leave is <a href="${explorer(dep.dao)}">proposal #${s.leave.id}</a>:
               ${Object.values(s.leave.votes).filter((v) => v === "Approve").length} of ${s.needed} approvals so far.</p>`
          : `<p class="small">Asks the members to remove you from the DAO role (bond ${nearAmt(bond)} NEAR, returned when they decide).
               Once they approve, come back here to take your ${nearAmt(s.member.join_deposit)} NEAR join deposit back.
               A profit share already credited stays yours to claim.</p>
             <button type="button" class="btn ghost" id="w-leave">Ask to leave</button>`}`;
  }
  html += tasksPanel(s);
  if (note) html += `<p class="note-line">${note}</p>`;
  box.innerHTML = html;

  $("w-out").onclick = () => connector.disconnect().catch(() => {});
  const on = (id, label, fn, check) => { const b = $(id); if (b) b.onclick = () => act(label, fn, check); };
  on("w-join", "Join deposit", () => send(dep.contract, "join", {}, { deposit, tgas: 30 }), async () =>
    ((await view(dep.contract, "get_member", { account_id: me })) || (await view(dep.contract, "is_pending", { account_id: me }))
      ? "You already joined: the panel will refresh." : null));
  on("w-ask", "Membership proposal", () => send(dep.dao, "add_proposal", {
    proposal: { description: `Accept ${me} as a member (asked from the Koperasi page)`, kind: { AddMemberToRole: { member_id: me, role: "member" } } },
  }, { deposit: bond, tgas: 50 }));
  on("w-sync", "Sync membership", () => send(dep.contract, "sync_member", { account_id: me }, { tgas: 60 }));
  on("w-cancel", "Cancel", () => send(dep.contract, "cancel_join", {}, { tgas: 30 }));
  on("w-leave", "Request to leave", () => send(dep.dao, "add_proposal", {
    proposal: { description: `Remove ${me} from the members: they asked to leave (from the Koperasi page)`, kind: { RemoveMemberFromRole: { member_id: me, role: "member" } } },
  }, { deposit: bond, tgas: 50 }));
  on("w-leave-sync", "Leave", () => send(dep.contract, "sync_member", { account_id: me }, { tgas: 60 }));
  on("w-usdc", "USDC registration", () => send(dep.usdc, "storage_deposit", { account_id: me, registration_only: true }, { deposit: s.usdcStorage, tgas: 30 }));
  // read the amount on click: act() re-renders the panel (and this input) before the transaction runs
  const stake = $("w-stake");
  if (stake) stake.onclick = () => {
    const raw = $("w-amt").value;
    const n = Number(raw);
    if (!(Number.isInteger(n) && n >= 1 && n <= 1000)) {
      say(`<span class="err">Stake: enter a whole number of NEAR, 1 to 1000 (got "${esc(raw)}").</span>`);
      return;
    }
    act(`Stake ${n} NEAR`, () => send(s.pool, "deposit_and_stake", {}, { deposit: BigInt(n) * 10n ** 24n, tgas: 100 }));
  };
  on("w-sync-sav", "Savings sync", () => send(dep.contract, "sync_savings", { account_id: me }, { tgas: 40 }));
  on("w-claim", "Claim", () => send(dep.contract, "claim_share", {}, { tgas: 60 }), async () =>
    (BigInt(await view(dep.contract, "get_claimable", { account_id: me })) > 0n ? null : "Nothing to claim any more: it was claimed already."));
  const shareIn = $("w-share-amt");
  if (shareIn) {
    // the amount is read on click (act() re-renders the panel), and checked against the treasury before the wallet opens
    const check = () => {
      const units = usdcUnits(shareIn.value);
      if (units === null) return { err: "a positive USDC amount, at most 6 decimals" };
      if (units > s.treasury) return { err: `at most the ${usdc(s.treasury)} USDC the treasury holds` };
      return { units };
    };
    shareIn.oninput = () => {
      const c = check();
      $("w-share-preview").textContent = c.err ? `Enter ${c.err}.` : `If the members approve:\n${preview(c.units, s).join("\n")}`;
    };
    $("w-share").onclick = () => {
      const c = check();
      if (c.err) { say(`<span class="err">Profit share: enter ${esc(c.err)}.</span>`); return; }
      act(`Propose a ${usdc(c.units)} USDC profit share`, () => send(dep.dao, "add_proposal", { proposal: {
        description: `Profit share of ${usdc(c.units)} USDC (proposed from the Koperasi page)`,
        kind: { FunctionCall: { receiver_id: dep.usdc, actions: [{ method_name: "ft_transfer_call",
          args: btoa(JSON.stringify({ receiver_id: dep.contract, amount: c.units.toString(), msg: "share" })),
          deposit: "1", gas: (150n * 10n ** 12n).toString() }] } },
      } }, { deposit: bond, tgas: 50 }));
    };
  }
  box.querySelectorAll("[data-claim]").forEach((b) => {
    b.onclick = () => act(`Take task #${b.dataset.claim}`, () => send(dep.dao, "bounty_claim",
      { id: Number(b.dataset.claim), deadline: String(BigInt(b.dataset.days) * DAY_NS) },
      { deposit: BigInt(s.policy.bounty_bond), tgas: 50 }));
  });
  box.querySelectorAll("[data-giveup]").forEach((b) => {
    b.onclick = () => act(`Give up task #${b.dataset.giveup}`, () => send(dep.dao, "bounty_giveup", { id: Number(b.dataset.giveup) }, { tgas: 50 }));
  });
  box.querySelectorAll("[data-done]").forEach((b) => {
    b.onclick = () => {
      const id = Number(b.dataset.done);
      const work = $(`w-work-${id}`).value.trim(); // read before act() re-renders the panel
      if (work.length < 4) { say(`<span class="err">Task #${id}: link to the work you delivered first.</span>`); return; }
      // Sputnik v2's bounty_done cannot succeed (no deposit, then ERR_MIN_BOND): file BountyDone as a proposal instead
      act(`Ask to be paid for task #${id}`, () => send(dep.dao, "add_proposal",
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
    return taskCheck(action, t, me, { members, budget: board.budget });
  };
  const task = (attr, label, method, extra = () => ({}), tgas = 30, action = null) => box.querySelectorAll(`[data-${attr}]`).forEach((b) => {
    b.onclick = () => {
      const id = Number(b.dataset[attr]);
      const args = extra(id); // read inputs before act() re-renders the panel
      if (args) act(`${label} task #${id}`, () => send(dep.contract, method, { id, ...args }, { tgas }), action ? () => fresh(id, action) : undefined);
    };
  });
  task("ttake", "Take", "claim_task", undefined, 30, "claim");
  task("tgiveup", "Give up", "give_up_task");
  task("taccept", "Accept", "accept_task", undefined, 200, "accept");
  task("tapprove", "Approve", "approve_task", undefined, 300, "approve");
  task("tsubmit", "Deliver", "submit_task", (id) => {
    const work = $(`w-tw-${id}`).value.trim();
    if (!work) { say(`<span class="err">Task #${id}: link to the work you delivered first.</span>`); return null; }
    return { deliverable: work };
  }, 30, "submit");
  const post = $("w-task-post");
  if (post) post.onclick = () => {
    const desc = $("w-task-desc").value.trim();
    const amt = nearUnits($("w-task-amt").value);
    const max = BigInt(s.board.rule.one_vote_max);
    if (!desc) { say(`<span class="err">Task: describe the task first.</span>`); return; }
    if (amt === null || amt > max) { say(`<span class="err">Task: pay a positive NEAR amount, at most ${nearAmt(max)} NEAR and 6 decimals.</span>`); return; }
    act(`Post a ${nearAmt(amt)} NEAR task`, () => send(dep.contract, "post_task", { description: desc, amount: amt.toString() }, { deposit: TASK_FEE, tgas: 30 }));
  };
  box.querySelectorAll("[data-vote]").forEach((b) => {
    let p;
    b.onclick = () => act(b.dataset.vote === "VoteApprove" ? "Approve" : "Reject",
      () => send(dep.dao, "act_proposal", { id: p.id, action: b.dataset.vote, proposal: p.kind }, { tgas: 200 }),
      async () => {
        p = await view(dep.dao, "get_proposal", { id: Number(b.dataset.id) });
        if (p.status !== "InProgress") return `Proposal #${p.id} already ended: ${p.status}.`;
        return p.votes[me] ? `You already voted on proposal #${p.id}.` : null;
      });
  });
}

// a new event on-chain (live.js) refreshes the panel, unless a transaction is in progress
window.addEventListener("koperasi:events", () => { if (me && !busy) render(); });
connector.on("wallet:signIn", (e) => { me = e?.accounts?.[0]?.accountId ?? ""; note = ""; render(); });
connector.on("wallet:signOut", () => { me = ""; note = ""; render(); });
// ponytail: ?as=<account> previews the panel for any account, on localhost only (to test each state without a wallet)
const previewAs = location.hostname === "localhost" && new URLSearchParams(location.search).get("as");
connector.getConnectedWallet().then((w) => { me = w?.accounts?.[0]?.accountId ?? ""; }).catch(() => {})
  .finally(() => { if (previewAs) me = previewAs; render(); });
