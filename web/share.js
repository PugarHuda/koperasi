// The contract's profit-share split (Koperasi::distribute in contract/src/lib.rs), in the browser, so members see what
// each of them would receive before they vote. Same integer maths: savings weighed in milli-NEAR, floor division,
// rounding and unused pools stay in the DAO as reserve. Checked against the contract's own test in tests/unit.
const BPS = 10_000n;
const SAVINGS_UNIT = 10n ** 21n;

/**
 * @param {bigint} amount USDC units (6 decimals) the DAO would send
 * @param {{ reserve_bps: number, savings_bps: number, points_bps: number }} rule
 * @param {Array<[string, { savings: string, points: number }]>} members as get_members returns them
 * @returns {{ shares: Array<{ account: string, share: bigint }>, reserve: bigint }}
 */
export function splitShare(amount, rule, members) {
  const savingsPool = (amount * BigInt(rule.savings_bps)) / BPS;
  const pointsPool = (amount * BigInt(rule.points_bps)) / BPS;
  const weight = members.map(([, m]) => BigInt(m.savings) / SAVINGS_UNIT);
  const totalSavings = weight.reduce((a, b) => a + b, 0n);
  const totalPoints = members.reduce((a, [, m]) => a + BigInt(m.points), 0n);
  let paid = 0n;
  const shares = members.map(([account, m], i) => {
    let share = 0n;
    if (totalSavings > 0n) share += (savingsPool * weight[i]) / totalSavings;
    if (totalPoints > 0n) share += (pointsPool * BigInt(m.points)) / totalPoints;
    paid += share;
    return { account, share };
  });
  return { shares, reserve: amount - paid };
}

/** "12.5" → 12500000n (USDC has 6 decimals); null for anything that is not a positive amount with ≤ 6 decimals. */
export const usdcUnits = (text) => {
  const t = String(text).trim();
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  const units = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
  return units > 0n ? units : null;
};

/** 1333333n → "1.333333", 4000000n → "4.00": exact USDC (6 decimals), at least 2 shown. */
export const usdcExact = (units) => {
  const u = BigInt(units);
  const frac = (u % 1_000_000n).toString().padStart(6, "0").replace(/0{1,4}$/, "");
  return `${u / 1_000_000n}.${frac}`;
};

/** "0.05" → yoctoNEAR; null for anything that is not a positive amount with ≤ 6 decimals. */
export const nearUnits = (text) => {
  const t = String(text).trim();
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  const units = BigInt(whole) * 10n ** 24n + BigInt(frac.padEnd(24, "0"));
  return units > 0n ? units : null;
};

/**
 * Different sources that trust a contributor (`sources` in contract/src/tasks.rs): each task's poster, and the DAO for
 * every voted bounty. Two members posting only to each other's friend add one source each.
 * @param {string[]} refs "task:<id>" | "dao-proposal:<id>" @param {{ id: number, poster: string }[]} tasks
 */
export const trustSources = (refs, tasks) =>
  new Set(refs.map((r) => (r.startsWith("task:") ? tasks.find((t) => t.id === Number(r.slice(5)))?.poster ?? r : "dao"))).size;

/**
 * How a delivered task gets paid (Koperasi::accept_task in contract/src/tasks.rs): "trust" pays when the poster accepts
 * (if the poster is still within their daily limit, which only the contract knows), "member" waits for one other member.
 * @param {string} amount yoctoNEAR @param {{ auto_max: string, trusted_after: number }} rule @param {number} sources
 */
export const payPath = (amount, rule, sources) => (BigInt(amount) <= BigInt(rule.auto_max) && sources >= rule.trusted_after ? "trust" : "member");

// ---------- events, indexer, wallet errors, checks before signing (pure, unit-tested in tests/unit) ----------

/** Every NEP-297 event the contract emits (contract/src/events.rs), by its snake_case wire name. */
export const EVENTS = ["join_requested", "join_cancelled", "member_added", "member_left", "config_set", "points_awarded",
  "savings_set", "savings_pending", "staking_pool_set", "share_rule_set", "usdc_set", "ledger_started", "agent_set", "steward_set",
  "steward_bonded", "steward_slashed", "steward_slashed_overdue", "paused", "unpaused", "upgraded", "receipt_recorded", "receipt_updated",
  "earnings_deposited", "share_distributed", "reserve_floor_set", "share_refused", "forward_failed", "share_claimed", "claim_rolled_back", "trust_rule_set",
  "task_budget_set", "task_posted", "task_claimed", "task_given_up", "task_submitted", "task_accepted", "veto_window_set", "task_held", "task_vetoed", "task_approved",
  "task_cancelled", "payout_filed", "task_paid", "task_unpaid", "record_credited",
  "pledge_made", "pledge_redeemed", "pledge_settled", "case_opened", "case_voted", "case_closed", "refund_filed", "case_appealed", "appeal_settled", "payout_route_set", "evidence_filed", "sister_coops_set", "passport_stamped", "agent_saves_set", "agent_saved", "reputation_share_set", "reputation_dividend", "refund_from_risk_fund", "risk_refund_failed", "agent_config_set", "agents_set", "share_funds_set", "fund_paid", "guaranteed", "guarantee_withdrawn", "guarantee_called", "guarantee_cleared", "loan_rule_set", "loan_requested", "loan_filed", "loan_repaid", "loan_late", "dues_set", "dues_paid", "agenda_proposed", "annual_meeting_held", "agent_struck", "agent_reinstated", "steward_term_set", "steward_term_ended"];
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

/**
 * The co-op's events in a transaction's outcome (RPC `EXPERIMENTAL_tx_status`): only logs written by `contract`, only
 * `EVENT_JSON` of standard "koperasi" with a known event, a semver version and object `data`. Anything else is dropped.
 * @returns {{ event: string, data: Record<string, any> }[]}
 */
export function parseEvents(outcome, contract) {
  const receipts = Array.isArray(outcome?.receipts_outcome) ? outcome.receipts_outcome : [];
  return receipts.filter((r) => r?.outcome?.executor_id === contract).flatMap((r) => r.outcome.logs ?? [])
    .filter((l) => typeof l === "string" && l.startsWith("EVENT_JSON:"))
    .flatMap((l) => { try { return [JSON.parse(l.slice(11))]; } catch { return []; } })
    .filter((e) => isObj(e) && e.standard === "koperasi" && /^\d+\.\d+\.\d+$/.test(e.version) && EVENTS.includes(e.event)
      && (isObj(e.data) || (Array.isArray(e.data) && isObj(e.data[0]))))
    .map((e) => ({ event: e.event, data: Array.isArray(e.data) ? e.data[0] : e.data }));
}

const short = (a) => (typeof a === "string" ? a.replace(/\.testnet$|\.near$/, "") : "?");
const nearOf = (y) => { try { return `${Number(BigInt(y) / 10n ** 21n) / 1000} NEAR`; } catch { return "? NEAR"; } };
const usdcOf = (u) => { try { return `${usdcExact(BigInt(u))} USDC`; } catch { return "? USDC"; } };
/** One plain sentence per event, for the live feed. */
export function describeEvent({ event: e, data: d }) {
  const s = {
    join_requested: () => `${short(d.account_id)} paid the join deposit and waits for the vote`,
    join_cancelled: () => `${short(d.account_id)} withdrew a join request`,
    member_added: () => `${short(d.account_id)} became a member`,
    member_left: () => `${short(d.account_id)} left the co-op and took the ${nearOf(d.refunded)} deposit back`,
    config_set: () => `The members voted by-laws v${d.version}`,
    points_awarded: () => `${short(d.account_id)} was awarded ${d.points} contribution points`,
    savings_set: () => `Savings of ${short(d.account_id)} now count ${nearOf(d.savings)}`,
    savings_pending: () => `${short(d.account_id)} staked ${nearOf(d.savings)}; it counts as savings after 7 days`,
    share_distributed: () => `The members shared ${usdcOf(d.amount)} among ${d.members} members`,
    share_claimed: () => `${short(d.account_id)} claimed ${usdcOf(d.amount)}`,
    share_refused: () => `A profit share of ${usdcOf(d.amount)} went back: it would have left the treasury under its ${usdcOf(d.floor)} floor`,
    reserve_floor_set: () => `The members set the treasury's floor to ${usdcOf(d.amount)}`,
    steward_slashed_overdue: () => `The audit stayed red past the grace period: the steward's ${nearOf(d.amount)} bond went to the DAO`,
    paused: () => `The agent was paused by ${short(d.by)}`,
    unpaused: () => "The members restarted the agent",
    upgraded: () => "The members upgraded the contract's code",
    receipt_recorded: () => `The agent recorded job ${String(d.job_id).slice(0, 12)}`,
    task_posted: () => `${short(d.poster)} posted task #${d.id} for ${nearOf(d.amount)}`,
    task_claimed: () => `${short(d.contributor)} took task #${d.id}`,
    task_submitted: () => `Task #${d.id} was delivered`,
    task_accepted: () => `Task #${d.id} was accepted${d.on_trust ? ", paid on earned trust" : ", waiting for one other member"}`,
    veto_window_set: () => `The members voted a ${d.minutes}-minute veto window on payouts on trust`,
    task_held: () => `Task #${d.id} accepted on trust: held for a member's veto`,
    task_vetoed: () => `${short(d.by)} vetoed task #${d.id}: it needs one member's approval`,
    task_approved: () => `${short(d.approver)} approved paying task #${d.id}`,
    payout_filed: () => `The contract filed DAO proposal #${d.proposal_id} to pay task #${d.id}`,
    task_paid: () => `The treasury paid ${short(d.contributor)} ${nearOf(d.amount)} for task #${d.id}`,
    task_unpaid: () => `Task #${d.id} was not paid (${d.status})`,
    record_credited: () => `The record of ${short(d.account_id)} grew (${d.source})`,
    pledge_made: () => `${short(d.issuer)} pledged to the co-op: ${String(d.what).slice(0, 60)} (${d.units}×)`,
    pledge_redeemed: () => `${short(d.holder)} called in pledge #${d.id}`,
    pledge_settled: () => `A pledge by ${short(d.issuer)} was ${d.honored ? "kept" : "not kept"}`,
    case_opened: () => `Court case #${d.id}: a buyer's dispute of job ${String(d.job_id).slice(0, 20)}; ${Array.isArray(d.jurors) ? d.jurors.length : "?"} jurors drawn`,
    case_voted: () => `A juror ${d.uphold ? "upheld" : "rejected"} case #${d.id}`,
    case_closed: () => `Court case #${d.id} was ${d.upheld ? "upheld: the buyer is refunded" : "not upheld"}`,
    refund_filed: () => `The contract filed DAO proposal #${d.proposal_id} to refund court case #${d.id}`,
    case_appealed: () => `${short(d.claimant)} appealed court case #${d.id} to the members: DAO proposal #${d.proposal_id}`,
    appeal_settled: () => `The members ${d.upheld ? "overturned the jury: the buyer of case #" + d.id + " is refunded" : "kept the jury's ruling on case #" + d.id}`,
    payout_route_set: () => `${short(d.account_id)} wants payouts on ${d.chain === "near" ? "NEAR" : { base: "Base", arb: "Arbitrum", eth: "Ethereum" }[d.chain] ?? "?"}`,
    agent_saves_set: () => `The members set the agent to save ${d.bps / 100}% of what it earns into the risk fund`,
    agent_saved: () => `The agent saved ${usdcOf(d.amount)} of its earnings into the risk fund`,
    reputation_share_set: () => `The members set ${d.bps / 100}% of every profit share to be split by credit score`,
    reputation_dividend: () => `A reputation dividend of ${usdcOf(d.amount)} was credited to members by credit score`,
    refund_from_risk_fund: () => `Court case #${d.id}: the buyer was refunded ${usdcOf(d.amount)} from the risk fund at once`,
    risk_refund_failed: () => `Court case #${d.id}: the refund from the risk fund bounced; ${usdcOf(d.amount)} went back to the fund`,
    agent_config_set: () => `The members voted ${short(d.account_id)} its own by-laws v${d.version}`,
    agents_set: () => `The members voted ${d.agents?.length ?? 0} further agent(s), each with the jobs it takes`,
    share_funds_set: () => `The members set ${d.funds} fund(s) paid from every profit share's reserve`,
    fund_paid: () => `The ${d.name} fund got ${usdcOf(d.amount)} from a profit share`,
    guaranteed: () => `${short(d.guarantor)} stands surety for ${short(d.account_id)}`,
    guarantee_withdrawn: () => `${short(d.guarantor)} no longer stands surety for ${short(d.account_id)}`,
    guarantee_called: () => `${short(d.account_id)} fell out of good standing: ${short(d.guarantor)}, who stood surety, answers for it`,
    guarantee_cleared: () => `The members cleared ${short(d.account_id)}'s surety marks`,
    loan_rule_set: () => `The members set loans: up to ${Number(BigInt(d.max_loan) / 10n ** 21n) / 1000} NEAR, ${d.rate_bps / 100}% flat, ${d.term_days} days`,
    loan_requested: () => `${short(d.account_id)} borrowed ${Number(BigInt(d.amount) / 10n ** 21n) / 1000} NEAR from the loan fund`,
    loan_filed: () => `The contract filed the loan to ${short(d.account_id)} as DAO proposal #${d.proposal_id}`,
    loan_repaid: () => `${short(d.account_id)} repaid ${Number(BigInt(d.amount) / 10n ** 21n) / 1000} NEAR into the treasury`,
    loan_late: () => `${short(d.account_id)}'s loan is late: they and their guarantors lose good standing`,
    dues_set: () => (BigInt(d.amount) === 0n ? "The members voted no mandatory dues" : `The members set mandatory dues: ${Number(BigInt(d.amount) / 10n ** 21n) / 1000} NEAR every ${d.every_days} days`),
    dues_paid: () => `${short(d.account_id)} paid ${d.periods} period(s) of dues into the treasury`,
    agenda_proposed: () => `${short(d.by)} put an item on the ${d.year} annual meeting's agenda`,
    annual_meeting_held: () => `The members approved the ${d.year} accountability report (sha256 ${String(d.report_sha256).slice(0, 12)}…)`,
    agent_struck: () => `Court case #${d.case} was upheld against the agent: ${d.strikes} strike(s) in 90 days${d.suspended ? ", the agent is suspended" : ""}`,
    agent_reinstated: () => "The members reinstated the agent",
    evidence_filed: () => `${short(d.by)} filed evidence in court case #${d.id}`,
    sister_coops_set: () => `The members now recognise work records from ${d.coops?.length ?? 0} sister co-op(s)`,
    passport_stamped: () => d.kept ? `${short(d.account_id)}'s work at ${short(d.coop)} (${d.done} done, in good standing) now counts here` : `${short(d.account_id)}'s record at ${short(d.coop)} no longer holds: its stamp is removed`,
    steward_term_set: () => `The members set the steward's term to ${d.days} days`,
    steward_term_ended: () => `The steward's term ended; the members appoint the next one`,
  }[e];
  return s ? s() : e.replace(/_/g, " ");
}

/**
 * The NearBlocks v3 answer for `/accounts/<id>/txns`, checked: transactions with a base58 hash and a signer.
 * @returns {{ hash: string, signer: string, ts: number }[]}
 */
export function txList(json) {
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows.filter((t) => typeof t?.transaction_hash === "string" && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(t.transaction_hash)
    && typeof t.signer_account_id === "string" && /^\d{1,19}$/.test(String(t.block_timestamp ?? "")))
    .map((t) => ({ hash: t.transaction_hash, signer: t.signer_account_id, ts: Number(BigInt(t.block_timestamp) / 1_000_000n) }));
}

/**
 * What went wrong with a transaction, for a person: they cancelled in the wallet (nothing sent), the contract refused
 * (its own sentence), or the network did not answer (the transaction may still land: check before retrying).
 * @returns {{ kind: "rejected"|"failed"|"network", text: string }}
 */
export function walletError(e) {
  const msg = String(e?.message ?? e ?? "");
  const why = msg.replace(/^[\s\S]*?Smart contract panicked: /, "").replace(/^panicked at '?|'?, src[\s\S]*$/g, "");
  if (why !== msg) return { kind: "failed", text: why };
  if (/reject|cancel|denied|declined|closed|abort/i.test(msg)) return { kind: "rejected", text: "You cancelled it in your wallet. Nothing was sent." };
  if (/fetch|network|timed? ?out|rate limit|429|50[234]/i.test(msg)) {
    return { kind: "network", text: "The network did not answer. The transaction may still land: check your account on the explorer before trying again." };
  }
  return { kind: "failed", text: msg };
}

/**
 * Can the account pay `deposit` plus the most this call may burn (`tgas` at 0.1 NEAR per 1000 Tgas), on top of what its
 * storage locks (1 NEAR per 100 kB)? Null when it can, else the sentence to show.
 * @param {{ amount: string, storage_usage: number }} acct RPC view_account
 */
export function affordable(acct, deposit, tgas) {
  const free = BigInt(acct.amount) - BigInt(acct.storage_usage) * 10n ** 19n;
  const need = BigInt(deposit) + BigInt(tgas) * 10n ** 20n;
  return free >= need ? null : `Your account has ${nearOf(free > 0n ? free : 0n)} free; this needs about ${nearOf(need)} with gas.`;
}

/**
 * The contract's own checks (accept_task etc. in contract/src/tasks.rs), run on the chain's current state before the
 * wallet opens, so a transaction that would fail is never signed. Null when it should pass, else the reason.
 * @param {"claim"|"submit"|"accept"|"approve"|"veto"|"release"} action
 * @param {{ status: string, poster: string, contributor?: string|null, amount: string }|undefined} t
 * @param {string} me @param {{ members?: string[], budget?: string, due?: number|null, now?: number }} [ctx] due/now in ms
 */
export function taskCheck(action, t, me, { members = [], budget = "0", due = null, now = Date.now() } = {}) {
  if (!t) return "This task does not exist.";
  const need = { claim: "Open", submit: "Claimed", accept: "Submitted", approve: "NeedsApproval", veto: "Held", release: "Held" }[action];
  if (t.status !== need) return `This task is ${t.status} now, not ${need}: someone acted first.`;
  if (action === "claim" && t.poster === me) return "You posted this task, so you cannot take it.";
  if (action === "submit" && t.contributor !== me) return "This task is not yours.";
  if (action === "accept" && t.poster !== me) return "Only the poster accepts the work.";
  if (action === "accept" && !members.includes(me)) return "You are no longer a member, so you cannot accept it.";
  if (action === "approve" && (t.poster === me || t.contributor === me)) return "The poster and the contributor cannot approve.";
  if (action === "approve" && !members.includes(me)) return "Only a member of the DAO approves.";
  if (action === "approve" && BigInt(t.amount) > BigInt(budget)) return "The task budget is too low: the members must raise it first.";
  if (action === "veto" && t.contributor === me) return "The contributor cannot veto their own payout.";
  if (action === "veto" && !members.includes(me)) return "Only members veto.";
  if (action === "release" && due !== null && now < due) return "The veto window is still open.";
  if (action === "release" && BigInt(t.amount) > BigInt(budget)) return "The task budget is too low: the members must raise it first.";
  return null;
}

// ---------- proposals are anyone's data (security S14–S16) ----------

/** A proposer's plain string on one short line, so it cannot pose as another line of what a proposal does. */
export const oneLine = (s) => String(s).replace(/\s+/g, " ").slice(0, 64);

/**
 * What a vote-only call to the co-op's own contract does, in one sentence (null for anything else; the raw args are
 * still shown under it). Amounts in yoctoNEAR are written in NEAR; values come from the args, cut to one line.
 * @param {string} method @param {any} a
 */
export function plainCall(method, a) {
  const near = (y) => `${Number(BigInt(y) / 10n ** 21n) / 1000} NEAR`;
  const v = (x) => oneLine(x);
  try {
    switch (method) {
      case "set_task_budget": return `The contract may pay ${near(a.amount)} for tasks from the treasury (replaces the current budget).`;
      case "set_veto_window": return Number(a.minutes) === 0 ? "Payouts on trust are paid at once: no veto window." : `Payouts on trust wait ${v(a.minutes)} minutes, during which any other member can veto them.`;
      case "set_trust": return `Trust rule: up to ${near(a.rule.auto_max)} paid with no vote to a contributor trusted by ${v(a.rule.trusted_after)}+ members; one member approves up to ${near(a.rule.one_vote_max)}; each poster pays at most ${near(a.rule.poster_daily_auto)} a day this way; ${v(a.rule.points)} points a task.`;
      case "set_config": return `New by-laws v${v(a.version)} for the agent (hash ${v(a.hash).slice(0, 12)}…, ${v(a.uri)}), ${v(a.points)} points to ${a.contributor ? v(a.contributor) : "nobody"}.`;
      case "upgrade": return `Replace the contract's code with the published code ${v(a.code_hash).slice(0, 12)}…: check it was built from the source.`;
      case "set_steward": return a.steward ? `Appoint ${v(a.steward)} as steward (they then post a bond).` : "Remove the steward.";
      case "set_steward_term": return `The steward serves ${v(a.days)} days from appointment.`;
      case "slash_steward": return "Slash the steward's bond into the treasury.";
      case "pause": return "Stop the agent from taking jobs.";
      case "unpause": return "Let the agent take jobs again.";
      case "award_points": return `Give ${v(a.account_id)} ${v(a.points)} contribution points: “${v(a.reason)}”.`;
      case "set_share_rule": return `Profit shares: ${a.rule.reserve_bps / 100}% reserve, ${a.rule.savings_bps / 100}% by savings, ${a.rule.points_bps / 100}% by points.`;
      case "set_usdc": return `Move the co-op to the USDC contract ${v(a.usdc_id)}.`;
      case "set_agent": return `Hand the agent's role to ${v(a.agent_id)}.`;
      case "set_staking_pool": return a.pool ? `Members' savings are staked with ${v(a.pool)}.` : "No staking pool.";
      case "set_reserve_floor": return `Keep at least ${Number(a.amount) / 1e6} USDC in the treasury before any share.`;
      default: return null;
    }
  } catch {
    return null; // malformed args: the raw args below say what they are
  }
}

// ---------- invitations: a member shares ?invite=<their account>; the newcomer's proposal names them ----------

const ACCOUNT = /^(?=.{2,64}$)[a-z0-9]+([-_][a-z0-9]+)*(\.[a-z0-9]+([-_][a-z0-9]+)*)*$/;
/** The inviter in a page URL's query, if it is a NEAR account id. */
export const inviteParam = (search) => {
  const v = new URLSearchParams(search).get("invite");
  return v && ACCOUNT.test(v) ? v : null;
};
/** The membership proposal's description, naming the inviter (not oneself). */
export const joinText = (me, by) => `Accept ${me} as a member (asked from the Koperasi page)${by && by !== me ? ` (invited by ${by})` : ""}`;
/**
 * "Invited by X" is the newcomer's own words. It is shown only when X is a member, and it counts as vouching only
 * once X has voted to approve the proposal on-chain.
 */
export function inviteOf(p, members) {
  // only a membership proposal in this page's exact words: free text on any other proposal never shows as vouched
  const add = p?.kind?.AddMemberToRole;
  if (!add || add.role !== "member") return null;
  const text = String(p.description ?? "");
  const signed = SIGNED.exec(text);
  const plain = signed ? text.slice(0, signed.index) : text;
  const by = /\(invited by ([a-z0-9._-]{2,64})\)$/.exec(plain)?.[1];
  if (!by || !members.includes(by) || plain !== joinText(add.member_id, by)) return null;
  return { by, vouched: p.votes?.[by] === "Approve", signed: signed ? { pk: signed[1], sig: signed[2], nonce: signed[3] } : null };
}

// ---------- signed vouches (NEP-413): a member signs "I vouch for X" with their wallet; anyone checks it here ----------

const B64 = "[A-Za-z0-9+/]+={0,2}";
/** The signed vouch a membership proposal carries after the page's own words. */
const SIGNED = new RegExp(String.raw` \[nep413 (ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}) (${B64}) (${B64})\]$`);
/** What the inviter signs. Names both accounts and the DAO, so it cannot be reused for anyone or anywhere else. */
export const vouchText = (by, member, dao) => `I, ${by}, vouch for ${member} joining the Koperasi co-op ${dao}.`;
/** The suffix a newcomer's membership proposal carries. */
export const vouchSuffix = ({ pk, sig, nonce }) => ` [nep413 ${pk} ${sig} ${nonce}]`;
/** A signed vouch from the page URL, if it is for `me` and well formed. */
export function vouchParam(search, me) {
  const q = new URLSearchParams(search);
  const v = { pk: q.get("pk") ?? "", sig: q.get("sig") ?? "", nonce: q.get("n") ?? "" };
  return q.get("for") === me && SIGNED.test(vouchSuffix(v)) ? v : null;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("not base58");
    n = n * 58n + BigInt(i);
  }
  const out = [];
  for (; n > 0n; n >>= 8n) out.unshift(Number(n & 255n));
  for (const c of s) { if (c !== "1") break; out.unshift(0); }
  return new Uint8Array(out);
}
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** NEP-413: sha256 of borsh(tag 2^31+413, { message, nonce[32], recipient, callbackUrl: None }). */
export async function nep413Hash(message, nonce, recipient) {
  const enc = new TextEncoder();
  const str = (t) => { const b = enc.encode(t); const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, b.length, true); return [len, b]; };
  const tag = new Uint8Array(4);
  new DataView(tag.buffer).setUint32(0, 2 ** 31 + 413, true);
  const parts = [tag, ...str(message), nonce, ...str(recipient), new Uint8Array([0])];
  const all = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  parts.reduce((o, x) => (all.set(x, o), o + x.length), 0);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", all));
}

/** Whether `sig` is an ed25519 signature by `pk` of the vouch `by` → `member` for `dao` (recipient: the DAO). */
export async function checkVouch({ by, member, dao, pk, sig, nonce }) {
  try {
    const n = b64(nonce);
    if (n.length !== 32 || !pk.startsWith("ed25519:")) return false;
    const key = await crypto.subtle.importKey("raw", b58decode(pk.slice(8)), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, b64(sig), await nep413Hash(vouchText(by, member, dao), n, dao));
  } catch {
    return false;
  }
}

/** The by-laws path a DAO vote set, if it is a relative path on this site (never another host or a parent dir). */
export const byLawsPath = (uri) => /^(?!\/)(?!.*(\/\/|\.\.))[\w./-]+$/.test(String(uri));

/**
 * The vote that set these by-laws: the newest *approved* proposal calling `set_config` on this contract with this hash.
 * Anyone can file a proposal, so an open, rejected or foreign one never counts; unreadable args never match.
 */
export function configVote(props, contract, hash) {
  return [...props].reverse().find((p) => p?.status === "Approved" && p.kind?.FunctionCall?.receiver_id === contract
    && p.kind.FunctionCall.actions?.some((x) => {
      if (x?.method_name !== "set_config") return false;
      try { return JSON.parse(atob(x.args)).hash === hash; } catch { return false; }
    }));
}
