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
  "steward_bonded", "steward_slashed", "paused", "unpaused", "upgraded", "receipt_recorded", "receipt_updated",
  "earnings_deposited", "share_distributed", "forward_failed", "share_claimed", "claim_rolled_back", "trust_rule_set",
  "task_budget_set", "task_posted", "task_claimed", "task_given_up", "task_submitted", "task_accepted", "task_approved",
  "task_cancelled", "payout_filed", "task_paid", "task_unpaid", "record_credited"];
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
    paused: () => `The agent was paused by ${short(d.by)}`,
    unpaused: () => "The members restarted the agent",
    upgraded: () => "The members upgraded the contract's code",
    receipt_recorded: () => `The agent recorded job ${String(d.job_id).slice(0, 12)}`,
    task_posted: () => `${short(d.poster)} posted task #${d.id} for ${nearOf(d.amount)}`,
    task_claimed: () => `${short(d.contributor)} took task #${d.id}`,
    task_submitted: () => `Task #${d.id} was delivered`,
    task_accepted: () => `Task #${d.id} was accepted${d.on_trust ? ", paid on earned trust" : ", waiting for one other member"}`,
    task_approved: () => `${short(d.approver)} approved paying task #${d.id}`,
    payout_filed: () => `The contract filed DAO proposal #${d.proposal_id} to pay task #${d.id}`,
    task_paid: () => `The treasury paid ${short(d.contributor)} ${nearOf(d.amount)} for task #${d.id}`,
    task_unpaid: () => `Task #${d.id} was not paid (${d.status})`,
    record_credited: () => `The record of ${short(d.account_id)} grew (${d.source})`,
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
 * @param {"claim"|"submit"|"accept"|"approve"} action
 * @param {{ status: string, poster: string, contributor?: string|null, amount: string }|undefined} t
 * @param {string} me @param {{ members?: string[], budget?: string }} [ctx]
 */
export function taskCheck(action, t, me, { members = [], budget = "0" } = {}) {
  if (!t) return "This task does not exist.";
  const need = { claim: "Open", submit: "Claimed", accept: "Submitted", approve: "NeedsApproval" }[action];
  if (t.status !== need) return `This task is ${t.status} now, not ${need}: someone acted first.`;
  if (action === "claim" && t.poster === me) return "You posted this task, so you cannot take it.";
  if (action === "submit" && t.contributor !== me) return "This task is not yours.";
  if (action === "accept" && t.poster !== me) return "Only the poster accepts the work.";
  if (action === "accept" && !members.includes(me)) return "You are no longer a member, so you cannot accept it.";
  if (action === "approve" && (t.poster === me || t.contributor === me)) return "The poster and the contributor cannot approve.";
  if (action === "approve" && !members.includes(me)) return "Only a member of the DAO approves.";
  if (action === "approve" && BigInt(t.amount) > BigInt(budget)) return "The task budget is too low: the members must raise it first.";
  return null;
}

// ---------- proposals are anyone's data (security S14–S16) ----------

/** A proposer's plain string on one short line, so it cannot pose as another line of what a proposal does. */
export const oneLine = (s) => String(s).replace(/\s+/g, " ").slice(0, 64);

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
