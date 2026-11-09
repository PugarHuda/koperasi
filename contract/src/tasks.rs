//! Tasks the co-op pays for, with earned trust. The members vote a NEAR budget and a trust rule; a member posts a
//! task, anyone takes it, and when the poster accepts the work the payout is decided by size and track record:
//!   - up to `auto_max`, to a contributor trusted by `trusted_after` *different* sources (task posters, or the DAO
//!     for a voted bounty), within the poster's `poster_daily_auto`: paid with no vote;
//!   - up to `one_vote_max` (or when the above does not hold): paid once one other member approves;
//!   - larger: not posted here at all; it is a normal DAO proposal (a Sputnik bounty) and `credit_dao_bounty`
//!     adds it to the contributor's record once the members approved it.
//!
//! The money stays in the DAO's treasury until a payout: this contract holds the Sputnik role `tasks`, which may only
//! add and approve `transfer` proposals. A payout is a Transfer proposal from the treasury that the contract files and
//! approves itself, so every payout is a DAO proposal anyone can read, and the role is visible in the DAO policy.
//! The members vote how much the contract may pay out in total (`set_task_budget`), the rule, and can cancel any task.
//! A finished task by a member also earns contribution points in proportion to its pay, so it raises their profit share;
//! the points can grow only as fast as the treasury pays out under the members' budget.
//!
//! State lives under its own storage keys (not struct fields), so the upgrade needs no state migration.

use crate::*;
use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};

// v2: the v1 rule (stored under "trust") had no poster cap or points; the members vote a v2 rule after the upgrade
const KEY_TRUST: &[u8] = b"trust_v2";
const KEY_BUDGET: &[u8] = b"task_budget";
const KEY_TASK_COUNT: &[u8] = b"task_count";
const KEY_CONTRIBUTORS: &[u8] = b"contributors";
/// Kept by the contract for the task's storage; also what makes spamming the board cost something.
pub const TASK_FEE: NearToken = NearToken::from_millinear(10);
const MAX_TEXT: usize = 500;
/// The DAO role that lets this contract file and approve `transfer` proposals, and nothing else.
pub const TASKS_ROLE: &str = "tasks";
// ponytail: the DAO's proposal bond (0.1 NEAR on Koperasi DAOs), fronted from the contract's balance and returned by
// Sputnik when the payout is approved; read it from the policy if a DAO ever votes a different bond.
pub const PAYOUT_BOND: NearToken = NearToken::from_millinear(100);
const DAY_NS: u64 = 86_400_000_000_000;
/// The contract's own payout chain ends in a few blocks; a flag older than this means a callback failed (e.g. gas).
const STUCK_NS: u64 = 3_600_000_000_000;
const GAS_PROPOSE: Gas = Gas::from_tgas(15);
const GAS_ACT: Gas = Gas::from_tgas(50);
const GAS_PROPOSED: Gas = Gas::from_tgas(100);
const GAS_VOTED: Gas = Gas::from_tgas(30);
const GAS_CHECKED: Gas = Gas::from_tgas(15);

#[ext_contract(ext_dao_proposals)]
#[allow(dead_code)]
trait SputnikProposals {
    fn get_proposal(&self, id: u64) -> Value;
    fn add_proposal(&mut self, proposal: Value) -> u64;
    fn act_proposal(&mut self, id: u64, action: String, proposal: Value, memo: Option<String>);
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct TrustRule {
    /// yoctoNEAR: payouts up to this need no vote once the contributor is trusted.
    pub auto_max: U128,
    /// yoctoNEAR: payouts up to this need one other member; larger tasks are DAO proposals.
    pub one_vote_max: U128,
    /// different sources (task posters; the DAO for voted bounties) on a record before a contributor is trusted.
    pub trusted_after: u32,
    /// yoctoNEAR one poster may pay out with no vote per UTC day; more waits for one other member.
    pub poster_daily_auto: U128,
    /// contribution points a member earns for a task paying `one_vote_max` (smaller tasks earn in proportion, floored)
    /// or for a DAO bounty; they weigh the profit share.
    pub points: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum TaskStatus {
    Open,
    Claimed,
    Submitted,
    NeedsApproval,
    Paying,
    Paid,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Task {
    pub id: u32,
    pub poster: AccountId,
    pub description: String,
    /// yoctoNEAR
    pub amount: U128,
    pub contributor: Option<AccountId>,
    pub deliverable: Option<String>,
    /// the member who approved a payout that needed one vote; None when it was paid on trust.
    pub approved_by: Option<AccountId>,
    pub status: TaskStatus,
    pub created: U64,
    pub paid_at: Option<U64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct Record {
    /// finished tasks and DAO bounties
    pub done: u32,
    /// yoctoNEAR paid for tasks here (DAO bounties are paid by the DAO, in their own token)
    pub earned: U128,
    /// where each point came from: "task:<id>" or "dao-proposal:<id>"
    pub refs: Vec<String>,
}

#[near(serializers = [json])]
pub struct Board {
    pub rule: Option<TrustRule>,
    /// yoctoNEAR the members let this contract pay from the treasury, not yet paid out
    pub budget: U128,
    pub tasks: u32,
}

fn load<T: BorshDeserialize>(key: &[u8]) -> Option<T> {
    env::storage_read(key).map(|b| T::try_from_slice(&b).unwrap_or_else(|_| env::panic_str("bad task state")))
}
fn save<T: BorshSerialize>(key: &[u8], v: &T) {
    env::storage_write(key, &borsh::to_vec(v).unwrap());
}
fn task_key(id: u32) -> Vec<u8> {
    format!("task:{id}").into_bytes()
}
fn record_key(a: &AccountId) -> Vec<u8> {
    format!("record:{a}").into_bytes()
}
fn budget() -> u128 {
    read_u128(KEY_BUDGET).unwrap_or(0)
}
fn task(id: u32) -> Task {
    load(&task_key(id)).unwrap_or_else(|| env::panic_str("no such task"))
}
fn text(s: &str, what: &str) {
    require!(!s.trim().is_empty() && s.len() <= MAX_TEXT, format!("{what}: 1 to {MAX_TEXT} characters"));
}
fn payout_key(id: u32) -> Vec<u8> {
    format!("payout:{id}").into_bytes()
}
/// Set while the contract's own file → vote → check chain runs, so `settle_task` cannot read the proposal in between.
fn inflight_key(id: u32) -> Vec<u8> {
    format!("inflight:{id}").into_bytes()
}
/// What the transfer returned, written by `on_payout_voted` before it reads the proposal: [1] moved, [0] bounced.
fn moved_key(id: u32) -> Vec<u8> {
    format!("moved:{id}").into_bytes()
}
/// The contract's own chain broke (a callback failed): its flag is older than an hour. Flags written before this rule
/// hold one byte and read as time 0, so they count as stuck.
fn stuck(id: u32) -> bool {
    env::storage_read(&inflight_key(id))
        .is_some_and(|v| env::block_timestamp().saturating_sub(v.try_into().map_or(0, u64::from_le_bytes)) > STUCK_NS)
}
fn payout_kind(t: &Task) -> Value {
    near_sdk::serde_json::json!({ "Transfer": {
        "token_id": "", "receiver_id": t.contributor.as_ref().unwrap(), "amount": t.amount, "msg": null } })
}

/// Different sources on a record: each task's poster, and the DAO (all members) for every voted bounty. Two friends
/// posting tasks to each other give one source each, so trust needs work for more than one member.
// ponytail: reads every task on the record; keep a poster set per record if records grow long
fn sources(r: &Record) -> u32 {
    let mut s: Vec<String> = r.refs.iter()
        .map(|x| x.strip_prefix("task:").map_or("dao".into(), |id| task(id.parse().unwrap()).poster.to_string()))
        .collect();
    s.sort();
    s.dedup();
    s.len() as u32
}

#[near]
impl Koperasi {
    // ---------- members' vote (DAO only) ----------

    pub fn set_trust(&mut self, rule: TrustRule) {
        self.assert_dao();
        require!(rule.auto_max.0 <= rule.one_vote_max.0, "auto_max must not exceed one_vote_max");
        require!(rule.trusted_after >= 1, "trusted_after must be at least 1: trust is earned");
        save(KEY_TRUST, &rule);
    }

    /// How much this contract may still pay from the DAO's treasury for tasks, in yoctoNEAR (replaces what is left).
    pub fn set_task_budget(&mut self, amount: U128) {
        self.assert_dao();
        write_u128(KEY_BUDGET, amount.0);
    }

    // ---------- the task's life ----------

    /// A member posts a task. Attach `TASK_FEE` (0.01 NEAR) for its storage.
    #[payable]
    pub fn post_task(&mut self, description: String, amount: U128) -> u32 {
        let poster = env::predecessor_account_id();
        require!(self.members.contains_key(&poster), "only members post tasks");
        require!(env::attached_deposit() >= TASK_FEE, "attach 0.01 NEAR for the task's storage");
        let rule: TrustRule = load(KEY_TRUST).unwrap_or_else(|| env::panic_str("the members have not set a trust rule"));
        require!(amount.0 > 0, "amount must be positive");
        require!(amount.0 <= rule.one_vote_max.0, "larger than one_vote_max: make it a DAO bounty proposal");
        text(&description, "description");
        let id = read_u128(KEY_TASK_COUNT).unwrap_or(0) as u32;
        write_u128(KEY_TASK_COUNT, id as u128 + 1);
        save(&task_key(id), &Task {
            id,
            poster,
            description,
            amount,
            contributor: None,
            deliverable: None,
            approved_by: None,
            status: TaskStatus::Open,
            created: U64(env::block_timestamp()),
            paid_at: None,
        });
        log!("task #{} posted", id);
        id
    }

    pub fn claim_task(&mut self, id: u32) {
        let who = env::predecessor_account_id();
        let mut t = task(id);
        require!(t.status == TaskStatus::Open, "task is not open");
        require!(who != t.poster, "the poster cannot take their own task");
        t.contributor = Some(who);
        t.status = TaskStatus::Claimed;
        save(&task_key(id), &t);
    }

    /// The contributor hands the task back.
    pub fn give_up_task(&mut self, id: u32) {
        let mut t = task(id);
        require!(t.status == TaskStatus::Claimed, "task is not claimed");
        require!(t.contributor.as_ref() == Some(&env::predecessor_account_id()), "not your task");
        t.contributor = None;
        t.status = TaskStatus::Open;
        save(&task_key(id), &t);
    }

    /// `deliverable`: a link or hash of the work.
    pub fn submit_task(&mut self, id: u32, deliverable: String) {
        let mut t = task(id);
        require!(t.status == TaskStatus::Claimed, "task is not claimed");
        require!(t.contributor.as_ref() == Some(&env::predecessor_account_id()), "not your task");
        text(&deliverable, "deliverable");
        t.deliverable = Some(deliverable);
        t.status = TaskStatus::Submitted;
        save(&task_key(id), &t);
    }

    /// The poster accepts the work: paid with no vote if small, the contributor is trusted and the poster is within
    /// their daily limit; else it waits for one other member's approval. Returns true when the payout started.
    pub fn accept_task(&mut self, id: u32) -> bool {
        let mut t = task(id);
        require!(t.status == TaskStatus::Submitted, "nothing submitted");
        require!(t.poster == env::predecessor_account_id(), "only the poster accepts");
        // a poster the members removed cannot spend the budget; their open tasks are the DAO's to cancel
        require!(self.members.contains_key(&t.poster), "the poster is no longer a member");
        let rule: TrustRule = load(KEY_TRUST).unwrap_or_else(|| env::panic_str("no trust rule"));
        let who = t.contributor.clone().unwrap();
        let trusted = load::<Record>(&record_key(&who)).map_or(0, |r| sources(&r)) >= rule.trusted_after;
        let today = format!("auto:{}:{}", t.poster, env::block_timestamp() / DAY_NS);
        let spent = read_u128(today.as_bytes()).unwrap_or(0) + t.amount.0;
        if t.amount.0 <= rule.auto_max.0 && trusted && spent <= rule.poster_daily_auto.0 {
            // ponytail: a payout that later fails still counts toward the poster's day; errs on the safe side
            write_u128(today.as_bytes(), spent);
            self.pay(&mut t, None);
            true
        } else {
            t.status = TaskStatus::NeedsApproval;
            save(&task_key(id), &t);
            false
        }
    }

    /// One other member approves a payout; membership is read from the DAO policy at that moment.
    pub fn approve_task(&mut self, id: u32) -> Promise {
        let who = env::predecessor_account_id();
        let t = task(id);
        require!(t.status == TaskStatus::NeedsApproval, "task is not waiting for approval");
        require!(who != t.poster && Some(&who) != t.contributor.as_ref(), "the poster and the contributor cannot approve");
        ext_dao::ext(self.dao_id.clone())
            .with_static_gas(GAS_VIEW)
            .get_policy()
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_PROPOSE.saturating_add(GAS_PROPOSED).saturating_add(GAS_CALLBACK)).on_approve_policy(id, who))
    }

    #[private]
    pub fn on_approve_policy(&mut self, id: u32, approver: AccountId, #[callback_result] policy: Result<Value, PromiseError>) {
        let policy = policy.unwrap_or_else(|_| env::panic_str("could not read DAO policy"));
        require!(role_has(&policy, MEMBER_ROLE, &approver), "only a member of the DAO approves");
        let mut t = task(id);
        require!(t.status == TaskStatus::NeedsApproval, "task is not waiting for approval");
        self.pay(&mut t, Some(approver));
    }

    /// The poster cancels a task nobody delivered yet; the DAO can cancel any task not paid.
    pub fn cancel_task(&mut self, id: u32) {
        let who = env::predecessor_account_id();
        let mut t = task(id);
        use TaskStatus::*;
        let ok = if who == self.dao_id {
            !matches!(t.status, Paid | Cancelled) && (t.status != Paying || stuck(id))
        } else {
            who == t.poster && matches!(t.status, Open | Claimed)
        };
        require!(ok, "cannot cancel this task");
        if t.status == Paying {
            // the members decided a stuck payout did not happen: the money stays in the budget
            return self.unpay(t, Cancelled);
        }
        t.status = Cancelled;
        save(&task_key(id), &t);
    }

    /// The payout is a Transfer proposal from the DAO's treasury, filed and approved by this contract's `tasks` role.
    fn pay(&mut self, t: &mut Task, approver: Option<AccountId>) {
        require!(t.amount.0 <= budget(), "the task budget is too low: the members must raise it");
        write_u128(KEY_BUDGET, budget() - t.amount.0);
        t.status = TaskStatus::Paying;
        let tier = approver.as_ref().map_or("earned trust, no vote".to_string(), |a| format!("approved by {a}"));
        t.approved_by = approver;
        save(&task_key(t.id), t);
        env::storage_write(&inflight_key(t.id), &env::block_timestamp().to_le_bytes());
        let description = format!("Koperasi task #{}: pay {} for \"{}\" ({tier})", t.id, t.contributor.as_ref().unwrap(), t.description);
        let _ = ext_dao_proposals::ext(self.dao_id.clone())
            .with_attached_deposit(PAYOUT_BOND)
            .with_static_gas(GAS_PROPOSE)
            .add_proposal(near_sdk::serde_json::json!({ "description": description, "kind": payout_kind(t) }))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_PROPOSED).on_payout_proposed(t.id));
    }

    #[private]
    pub fn on_payout_proposed(&mut self, id: u32, #[callback_result] pid: Result<u64, PromiseError>) -> PromiseOrValue<()> {
        let t = task(id);
        let Ok(pid) = pid else {
            // nothing was filed (and the bond came back): the poster can accept again
            self.unpay(t, TaskStatus::Submitted);
            return PromiseOrValue::Value(());
        };
        write_u128(&payout_key(id), pid as u128);
        PromiseOrValue::Promise(
            ext_dao_proposals::ext(self.dao_id.clone()).with_static_gas(GAS_ACT)
                .act_proposal(pid, "VoteApprove".into(), payout_kind(&t), None)
                .then(Self::ext(env::current_account_id()).with_static_gas(GAS_VOTED).on_payout_voted(id, pid)),
        )
    }

    /// Sputnik's `act_proposal` returns the transfer's own promise once the vote passes, and marks nothing when the
    /// transfer bounces (the proposal stays Approved). So the money moved only if that result succeeded.
    #[private]
    pub fn on_payout_voted(&mut self, id: u32, pid: u64) -> Promise {
        // only success or failure matters; TooLong(_) means it succeeded with a value we do not read
        let moved = !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed));
        env::storage_write(&moved_key(id), &[moved as u8]);
        ext_dao_proposals::ext(self.dao_id.clone())
            .with_static_gas(GAS_VIEW)
            .get_proposal(pid)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CHECKED).on_payout_checked(id, moved))
    }

    /// Anyone: re-read a payout's DAO proposal (e.g. one the members approved or rejected by hand) and settle the task.
    /// If a callback of the contract's own chain failed, the task is unstuck an hour later:
    /// - no proposal on record (one may have been filed): Cancelled, never filed again by the contract; the members
    ///   can still vote that proposal, or pay with a bounty;
    /// - the transfer's result on record (stuck or not): settled from the proposal with that result;
    /// - the result never read: only the members (the DAO) can settle it, as paid, or cancel it with `cancel_task`.
    // ponytail: a payout the members approved by hand is taken as moved; their own vote transaction shows the transfer
    pub fn settle_task(&mut self, id: u32) -> PromiseOrValue<()> {
        let t = task(id);
        require!(t.status == TaskStatus::Paying, "no payout in flight");
        let open = env::storage_read(&inflight_key(id)).is_some();
        require!(!open || stuck(id), "the contract is still settling this payout");
        let Some(pid) = read_u128(&payout_key(id)) else {
            self.unpay(t, TaskStatus::Cancelled);
            return PromiseOrValue::Value(());
        };
        // the transfer's result once on record decides; with nothing on record the members approved it by hand
        let moved = match env::storage_read(&moved_key(id)) {
            Some(v) => v == [1],
            None if open => {
                require!(env::predecessor_account_id() == self.dao_id,
                    "the transfer's result was never read: the members settle or cancel this payout by vote");
                true
            }
            _ => true,
        };
        PromiseOrValue::Promise(ext_dao_proposals::ext(self.dao_id.clone())
            .with_static_gas(GAS_VIEW)
            .get_proposal(pid as u64)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CHECKED).on_payout_checked(id, moved)))
    }

    /// Paid only when the DAO's Transfer proposal is Approved and its transfer went through.
    #[private]
    pub fn on_payout_checked(&mut self, id: u32, moved: bool, #[callback_result] p: Result<Value, PromiseError>) {
        let mut t = task(id);
        require!(t.status == TaskStatus::Paying, "no payout in flight");
        // the transfer's result stays on record until the task settles: a later settle_task must still see a bounce
        env::storage_remove(&inflight_key(id));
        let status = p.ok().and_then(|p| p["status"].as_str().map(String::from)).unwrap_or_default();
        match status.as_str() {
            "Approved" if moved => {
                t.status = TaskStatus::Paid;
                t.paid_at = Some(U64(env::block_timestamp()));
                save(&task_key(id), &t);
                env::storage_remove(&moved_key(id));
                let points = load::<TrustRule>(KEY_TRUST)
                    // at most `points`, even if the members lowered one_vote_max after the task was posted
                    .map_or(0, |r| (r.points as u128 * t.amount.0 / r.one_vote_max.0.max(1)).min(r.points as u128) as u64);
                self.credit(t.contributor.as_ref().unwrap(), format!("task:{id}"), t.amount.0, points);
            }
            // still open (e.g. the role is missing from the policy) or unreadable: the members can vote it by hand,
            // then anyone calls settle_task
            "InProgress" | "" => log!("task #{}: payout proposal not approved yet", id),
            // rejected, removed, expired, failed, or approved but the transfer bounced: the members or the chain said no,
            // so the contract must not file and approve it again on its own; only a new task (or a DAO bounty) pays it
            _ => self.unpay(t, TaskStatus::Cancelled),
        }
    }

    /// The payout did not happen: the money stays in the treasury and in the budget.
    fn unpay(&mut self, mut t: Task, status: TaskStatus) {
        env::storage_remove(&inflight_key(t.id));
        env::storage_remove(&moved_key(t.id));
        write_u128(KEY_BUDGET, budget() + t.amount.0);
        if status == TaskStatus::Submitted {
            env::storage_remove(&payout_key(t.id));
        }
        t.status = status;
        t.approved_by = None;
        log!("task #{}: not paid, now {:?}", t.id, status);
        save(&task_key(t.id), &t);
    }

    /// One more point on `who`'s record, from `source`; a member also earns `points` contribution points.
    fn credit(&mut self, who: &AccountId, source: String, earned: u128, points: u64) {
        let mut r: Record = load(&record_key(who)).unwrap_or_else(|| {
            let mut all: Vec<AccountId> = load(KEY_CONTRIBUTORS).unwrap_or_default();
            all.push(who.clone());
            save(KEY_CONTRIBUTORS, &all);
            Record::default()
        });
        r.done += 1;
        r.earned = U128(r.earned.0 + earned);
        log!("trust: +1 for {} from {}", who, source);
        r.refs.push(source);
        save(&record_key(who), &r);
        if points > 0 && self.members.contains_key(who) {
            self.add_points(who, points);
            log!("+{} contribution points for {}", points, who);
        }
    }

    /// Anyone: count an approved Sputnik `BountyDone` proposal (a large task the members voted) on its receiver's record.
    pub fn credit_dao_bounty(&mut self, proposal_id: u64) -> Promise {
        require!(env::storage_read(format!("credited:{proposal_id}").as_bytes()).is_none(), "already counted");
        ext_dao_proposals::ext(self.dao_id.clone())
            .with_static_gas(GAS_VIEW)
            .get_proposal(proposal_id)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_dao_proposal(proposal_id))
    }

    #[private]
    pub fn on_dao_proposal(&mut self, proposal_id: u64, #[callback_result] p: Result<Value, PromiseError>) {
        let p = p.unwrap_or_else(|_| env::panic_str("could not read the proposal"));
        require!(p["status"] == "Approved", "the members have not approved this proposal");
        let receiver: AccountId = p["kind"]["BountyDone"]["receiver_id"]
            .as_str()
            .and_then(|s| s.parse().ok())
            .unwrap_or_else(|| env::panic_str("not a bounty payout"));
        let key = format!("credited:{proposal_id}");
        require!(env::storage_read(key.as_bytes()).is_none(), "already counted");
        env::storage_write(key.as_bytes(), &[1]);
        let points = load::<TrustRule>(KEY_TRUST).map_or(0, |r| r.points);
        self.credit(&receiver, format!("dao-proposal:{proposal_id}"), 0, points);
    }

    // ---------- views ----------

    pub fn get_board(&self) -> Board {
        Board { rule: load(KEY_TRUST), budget: U128(budget()), tasks: read_u128(KEY_TASK_COUNT).unwrap_or(0) as u32 }
    }

    pub fn get_tasks(&self, from: Option<u32>, limit: Option<u32>) -> Vec<Task> {
        let n = read_u128(KEY_TASK_COUNT).unwrap_or(0) as u32;
        let from = from.unwrap_or(0);
        (from..n.min(from.saturating_add(limit.unwrap_or(50)))).map(task).collect()
    }

    pub fn get_record(&self, account_id: AccountId) -> Option<Record> {
        load(&record_key(&account_id))
    }

    /// How many different sources trust this account (what `trusted_after` counts).
    pub fn get_trust_sources(&self, account_id: AccountId) -> u32 {
        load::<Record>(&record_key(&account_id)).map_or(0, |r| sources(&r))
    }

    /// The DAO proposal that paid (or is paying) a task.
    pub fn get_payout_proposal(&self, id: u32) -> Option<u64> {
        read_u128(&payout_key(id)).map(|p| p as u64)
    }

    /// Everyone with a record, with it.
    // ponytail: one list, fine for a co-op's contributors; page it if it grows past a few hundred.
    pub fn get_contributors(&self) -> Vec<(AccountId, Record)> {
        let all: Vec<AccountId> = load(KEY_CONTRIBUTORS).unwrap_or_default();
        all.into_iter().filter_map(|a| load(&record_key(&a)).map(|r| (a, r))).collect()
    }
}
