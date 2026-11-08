//! Tasks the co-op pays for, with earned trust. The members vote a NEAR budget and a trust rule; a member posts a
//! task, anyone takes it, and when the poster accepts the work the payout is decided by size and track record:
//!   - up to `auto_max`, to a contributor with `trusted_after` finished tasks: paid at once from the budget;
//!   - up to `one_vote_max`: paid once one other member (not the poster, not the contributor) approves;
//!   - larger: not posted here at all; it is a normal DAO proposal (a Sputnik bounty) and `credit_dao_bounty`
//!     adds it to the contributor's record once the members approved it.
//!
//! Every point of a record names the task or DAO proposal it came from. Custody and the budget stay with the DAO:
//! only a vote funds the budget, sets the rule, cancels any task or takes the budget back.
//!
//! State lives under its own storage keys (not struct fields), so the upgrade needs no state migration.

use crate::*;
use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};

const KEY_TRUST: &[u8] = b"trust";
const KEY_BUDGET: &[u8] = b"task_budget";
const KEY_TASK_COUNT: &[u8] = b"task_count";
const KEY_CONTRIBUTORS: &[u8] = b"contributors";
/// Kept by the contract for the task's storage; also what makes spamming the board cost something.
pub const TASK_FEE: NearToken = NearToken::from_millinear(10);
const MAX_TEXT: usize = 500;

#[ext_contract(ext_dao_proposals)]
#[allow(dead_code)]
trait SputnikProposals {
    fn get_proposal(&self, id: u64) -> Value;
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct TrustRule {
    /// yoctoNEAR: payouts up to this need no vote once the contributor is trusted.
    pub auto_max: U128,
    /// yoctoNEAR: payouts up to this need one other member; larger tasks are DAO proposals.
    pub one_vote_max: U128,
    /// finished tasks (here or DAO bounties) before a contributor is trusted.
    pub trusted_after: u32,
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
    /// yoctoNEAR the members voted for tasks and not yet paid out
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

/// One more point on `who`'s record, from `source`.
fn credit(who: &AccountId, source: String, earned: u128) {
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

    /// The members add NEAR to the task budget (a FunctionCall proposal with a deposit).
    #[payable]
    pub fn fund_tasks(&mut self) {
        self.assert_dao();
        write_u128(KEY_BUDGET, budget() + env::attached_deposit().as_yoctonear());
    }

    /// The members take unspent budget back to the DAO.
    pub fn return_budget(&mut self, amount: U128) -> Promise {
        self.assert_dao();
        require!(amount.0 > 0 && amount.0 <= budget(), "more than the budget");
        write_u128(KEY_BUDGET, budget() - amount.0);
        Promise::new(self.dao_id.clone()).transfer(NearToken::from_yoctonear(amount.0))
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

    /// The poster accepts the work: paid at once if small and the contributor is trusted, else it waits for one
    /// other member's approval. Returns true when it paid.
    pub fn accept_task(&mut self, id: u32) -> bool {
        let mut t = task(id);
        require!(t.status == TaskStatus::Submitted, "nothing submitted");
        require!(t.poster == env::predecessor_account_id(), "only the poster accepts");
        // a poster the members removed cannot spend the budget; their open tasks are the DAO's to cancel
        require!(self.members.contains_key(&t.poster), "the poster is no longer a member");
        let rule: TrustRule = load(KEY_TRUST).unwrap_or_else(|| env::panic_str("no trust rule"));
        let who = t.contributor.clone().unwrap();
        let done = load::<Record>(&record_key(&who)).map_or(0, |r| r.done);
        if t.amount.0 <= rule.auto_max.0 && done >= rule.trusted_after {
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
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK.saturating_mul(2)).on_approve_policy(id, who))
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
            !matches!(t.status, Paying | Paid | Cancelled)
        } else {
            who == t.poster && matches!(t.status, Open | Claimed)
        };
        require!(ok, "cannot cancel this task");
        t.status = Cancelled;
        save(&task_key(id), &t);
    }

    fn pay(&mut self, t: &mut Task, approver: Option<AccountId>) {
        require!(t.amount.0 <= budget(), "the task budget is too low: the members must fund it");
        write_u128(KEY_BUDGET, budget() - t.amount.0);
        t.status = TaskStatus::Paying;
        t.approved_by = approver;
        save(&task_key(t.id), t);
        let _ = Promise::new(t.contributor.clone().unwrap())
            .transfer(NearToken::from_yoctonear(t.amount.0))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_task_paid(t.id));
    }

    #[private]
    pub fn on_task_paid(&mut self, id: u32, #[callback_result] r: Result<(), PromiseError>) {
        let mut t = task(id);
        if r.is_ok() {
            t.status = TaskStatus::Paid;
            t.paid_at = Some(U64(env::block_timestamp()));
            credit(t.contributor.as_ref().unwrap(), format!("task:{id}"), t.amount.0);
        } else {
            // the transfer bounced (e.g. the account does not exist): money back in the budget, accept again
            write_u128(KEY_BUDGET, budget() + t.amount.0);
            t.status = TaskStatus::Submitted;
            t.approved_by = None;
            log!("task #{}: payout failed, back to submitted", id);
        }
        save(&task_key(id), &t);
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
        credit(&receiver, format!("dao-proposal:{proposal_id}"), 0);
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

    /// Everyone with a record, with it.
    // ponytail: one list, fine for a co-op's contributors; page it if it grows past a few hundred.
    pub fn get_contributors(&self) -> Vec<(AccountId, Record)> {
        let all: Vec<AccountId> = load(KEY_CONTRIBUTORS).unwrap_or_default();
        all.into_iter().filter_map(|a| load(&record_key(&a)).map(|r| (a, r))).collect()
    }
}
