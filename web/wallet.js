// Join the co-op from the page with a testnet wallet: pay the deposit, ask the members (a DAO proposal from your own
// wallet), sync once they vote you in. Members can then vote on open proposals and claim their profit share.
import { NearConnector } from "https://esm.sh/@hot-labs/near-connect@0.12.0";
import { dep, view, RPC_URLS, explorer, txUrl, $, esc, usdc, nearAmt } from "./near.js";

const connector = new NearConnector({ network: dep.network, providers: { [dep.network]: RPC_URLS } });
const box = $("joinapp");
let me = "";
let busy = false;
let note = "";

async function send(receiverId, methodName, args, { deposit = 0n, tgas = 100 } = {}) {
  const wallet = await connector.wallet();
  const out = await wallet.signAndSendTransaction({
    receiverId,
    actions: [{ type: "FunctionCall", params: { methodName, args, gas: (BigInt(tgas) * 10n ** 12n).toString(), deposit: deposit.toString() } }],
  });
  const failure = out?.status?.Failure ?? out?.receipts_outcome?.find((r) => r.outcome.status.Failure)?.outcome.status.Failure;
  if (failure) {
    const s = JSON.stringify(failure);
    throw new Error(s.match(/"panic_msg":"([^"]+)"/)?.[1] ?? s.match(/ExecutionError":"([^"]+)"/)?.[1] ?? s.slice(0, 160));
  }
  return out?.transaction?.hash ?? out?.transaction_outcome?.id;
}

const kindOf = (p) => (typeof p.kind === "string" ? p.kind : Object.keys(p.kind)[0]);
// what a proposal really does, built from its kind; the proposer's description is shown apart, as their claim
const yocto = (y) => (BigInt(y || 0) > 0n ? `, attaches ${nearAmt(y)} NEAR` : "");
const argsOf = (b64) => {
  try { return JSON.stringify(JSON.parse(atob(b64))); } catch { return "(binary args)"; }
};
const describe = (p) => {
  const k = kindOf(p);
  if (k === "AddMemberToRole") return `Add ${p.kind.AddMemberToRole.member_id} to role ${p.kind.AddMemberToRole.role}`;
  if (k === "RemoveMemberFromRole") return `Remove ${p.kind.RemoveMemberFromRole.member_id} from role ${p.kind.RemoveMemberFromRole.role}`;
  if (k === "Transfer") return `Transfer ${p.kind.Transfer.amount} of ${p.kind.Transfer.token_id || "NEAR"} to ${p.kind.Transfer.receiver_id}`;
  if (k === "FunctionCall") {
    const f = p.kind.FunctionCall;
    return f.actions.map((a) => `Call ${f.receiver_id} ${a.method_name} ${argsOf(a.args).slice(0, 160)}${yocto(a.deposit)}`).join("; ");
  }
  return `${k} (open the DAO to inspect)`;
};

async function load() {
  const [info, member, pending, policy, last] = await Promise.all([
    view(dep.contract, "get_info"),
    view(dep.contract, "get_member", { account_id: me }),
    view(dep.contract, "is_pending", { account_id: me }),
    view(dep.dao, "get_policy"),
    view(dep.dao, "get_last_proposal_id"),
  ]);
  const proposals = await view(dep.dao, "get_proposals", { from_index: Math.max(0, last - 50), limit: 50 });
  const group = policy.roles.find((r) => r.name === "member")?.kind?.Group ?? [];
  const [num, den] = policy.default_vote_policy?.threshold ?? [1, 2];
  const needed = Math.floor((group.length * num) / den) + 1;
  const request = [...proposals].reverse().find((p) => kindOf(p) === "AddMemberToRole" && p.kind.AddMemberToRole.member_id === me);
  const claimable = member ? await view(dep.contract, "get_claimable", { account_id: me }) : "0";
  const usdcReady = member ? await view(dep.usdc, "storage_balance_of", { account_id: me }).catch(() => null) : null;
  return { info, member, pending, policy, inRole: group.includes(me), needed, members: group.length, request, proposals, claimable, usdcReady };
}

// each button runs one transaction, then the panel re-reads the chain
async function act(label, fn) {
  if (busy) return;
  busy = true;
  note = `${label}: confirm in your wallet…`;
  await render();
  try {
    const hash = await fn();
    note = `${label}: done.${hash ? ` <a href="${esc(txUrl(hash))}">See the transaction</a>.` : ""}`;
  } catch (e) {
    note = `<span class="err">${label} failed: ${esc(e.message ?? e)}</span>`;
  }
  busy = false;
  await new Promise((r) => setTimeout(r, 1500));
  await render();
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
        : `<p class="small">To receive USDC, register your account with the token first (a one-time 0.0125 NEAR storage deposit).</p>
           <button type="button" class="btn" id="w-usdc">Register for USDC</button>`) : ""}
      <h3 class="jh">Open proposals</h3>
      ${open.length ? `<ul class="props">${open.map((p) => {
        const mine = p.votes[me];
        return `<li><span><strong>#${p.id}</strong> <code class="does">${esc(describe(p))}</code>${p.description
          ? `<span class="claim">Proposer says: “${esc(p.description.slice(0, 200))}”</span>` : ""}</span>${mine ? `<em>you voted ${esc(mine.toLowerCase())}</em>`
          : `<span class="vote-btns"><button type="button" class="btn small" data-vote="VoteApprove" data-id="${p.id}">Approve</button>
             <button type="button" class="btn ghost small" data-vote="VoteReject" data-id="${p.id}">Reject</button></span>`}</li>`;
      }).join("")}</ul>` : `<p class="small">Nothing to vote on right now.</p>`}`;
  }
  if (note) html += `<p class="note-line">${note}</p>`;
  box.innerHTML = html;

  $("w-out").onclick = () => connector.disconnect().catch(() => {});
  const on = (id, label, fn) => { const b = $(id); if (b) b.onclick = () => act(label, fn); };
  on("w-join", "Join deposit", () => send(dep.contract, "join", {}, { deposit, tgas: 30 }));
  on("w-ask", "Membership proposal", () => send(dep.dao, "add_proposal", {
    proposal: { description: `Accept ${me} as a member (asked from the Koperasi page)`, kind: { AddMemberToRole: { member_id: me, role: "member" } } },
  }, { deposit: bond, tgas: 50 }));
  on("w-sync", "Sync membership", () => send(dep.contract, "sync_member", { account_id: me }, { tgas: 60 }));
  on("w-cancel", "Cancel", () => send(dep.contract, "cancel_join", {}, { tgas: 30 }));
  on("w-usdc", "USDC registration", () => send(dep.usdc, "storage_deposit", { account_id: me }, { deposit: 12_500_000_000_000_000_000_000n, tgas: 30 }));
  on("w-claim", "Claim", () => send(dep.contract, "claim_share", {}, { tgas: 60 }));
  box.querySelectorAll("[data-vote]").forEach((b) => {
    b.onclick = () => act(b.dataset.vote === "VoteApprove" ? "Approve" : "Reject", async () => {
      const p = await view(dep.dao, "get_proposal", { id: Number(b.dataset.id) });
      return send(dep.dao, "act_proposal", { id: p.id, action: b.dataset.vote, proposal: p.kind }, { tgas: 200 });
    });
  });
}

connector.on("wallet:signIn", (e) => { me = e?.accounts?.[0]?.accountId ?? ""; note = ""; render(); });
connector.on("wallet:signOut", () => { me = ""; note = ""; render(); });
// ponytail: ?as=<account> previews the panel for any account, on localhost only (to test each state without a wallet)
const preview = location.hostname === "localhost" && new URLSearchParams(location.search).get("as");
connector.getConnectedWallet().then((w) => { me = w?.accounts?.[0]?.accountId ?? ""; }).catch(() => {})
  .finally(() => { if (preview) me = preview; render(); });
