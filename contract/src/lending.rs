//! What an Indonesian co-op does besides sharing profit (Law 25/1992): funds set aside from the surplus, members standing
//! surety for each other, and a savings-and-loan fund.
//!
//! - **Funds from the surplus** (art. 45: education and social funds): the members vote up to three funds, each a share
//!   of every profit share in basis points and the account it is paid to (`set_share_funds`). They come out of the
//!   reserve part of the rule, never out of the members' part; a transfer that fails goes to the DAO instead.
//! - **Standing surety** (*tanggung renteng*): a member in good standing guarantees another account (`guarantee`, up to
//!   three guarantors each). When the guaranteed account falls out of good standing (a broken pledge, a missed jury, a
//!   slash, a late loan), each guarantor is marked too and loses good standing until the members clear it by vote.
//! - **Savings and loans**: the members vote a loan fund in NEAR, the largest loan, a flat rate and a term
//!   (`set_loan_rule`). A member in good standing with at least one guarantor borrows once at a time (`request_loan`):
//!   the contract files the payment as a DAO Transfer from the treasury and approves it with its `tasks` role, as it does
//!   for a court refund. Repaying (`repay_loan`, principal plus the flat interest) sends it all to the treasury and the
//!   principal back to the fund, so the fund revolves. A loan unpaid 7 days after its term can be called late by anyone:
//!   the borrower, and so their guarantors, lose good standing.
//!
//! - **More than one agent** (0.3.1): besides the agent the co-op was founded with, the members vote further agents and
//!   the job tags each one takes (`set_agents`). Any of them records receipts under the same by-laws and court; a receipt
//!   names the agent that did the job, and only that agent updates it. Each agent's runtime takes only its voted tags.
//!
//! - **A risk fund** (0.3.2): a fund whose account is the contract itself is kept here, in USDC, and the members may
//!   vote that a share of every earnings deposit stays in it too (`set_agent_saves`: the agent saves for its own
//!   mistakes). A court case upheld against the agent's job is refunded from it at once when it holds enough; otherwise
//!   the contract files the refund as a DAO proposal, as before.
//! - **Credit from the record** (0.3.2): a loan is at most the voted largest loan times the borrower's score out of 10:
//!   finished tasks and bounties, pledges kept, juries served, and two points for each guarantor in good standing.
//! - **A reputation dividend** (0.3.2): the members may vote a share of every profit share (out of the reserve part)
//!   that is split among members in good standing by their record: work done, pledges kept, juries served.
//! - **An agent's own by-laws** (0.3.2): the members can vote a further agent its own by-laws (`set_agent_config`); its
//!   receipts must then carry that hash, and the OutLayer gate checks that file.
//!
//! State lives under its own storage keys, so the upgrade needs no state migration.

use crate::tasks::{ext_dao_proposals, load, save, DAY_NS, GAS_ACT, GAS_PROPOSE, PAYOUT_BOND};
use crate::*;

const KEY_FUNDS: &[u8] = b"share_funds";
const KEY_LOAN_RULE: &[u8] = b"loan_rule";
const KEY_LOAN_FUND: &[u8] = b"loan_fund";
const KEY_AGENTS: &[u8] = b"more_agents";
const KEY_RISK: &[u8] = b"risk_fund";
const KEY_AGENT_SAVES: &[u8] = b"agent_saves_bps";
const KEY_REPUTATION: &[u8] = b"reputation_bps";
pub(crate) const GAS_RISK_REFUND: Gas = Gas::from_tgas(10);

pub(crate) fn risk_fund() -> u128 {
    load::<U128>(KEY_RISK).map_or(0, |x| x.0)
}
pub(crate) fn add_risk(x: u128) {
    save(KEY_RISK, &U128(risk_fund() + x));
}
pub(crate) fn take_risk(x: u128) {
    save(KEY_RISK, &U128(risk_fund() - x));
}
pub(crate) fn agent_saves_bps() -> u16 {
    load::<u16>(KEY_AGENT_SAVES).unwrap_or(0)
}
fn agent_config_key(a: &AccountId) -> Vec<u8> {
    format!("agent_config:{a}").into_bytes()
}
/// A further agent's own by-laws, if the members voted it some.
pub(crate) fn agent_config(a: &AccountId) -> Option<Config> {
    load(&agent_config_key(a))
}
const MAX_AGENTS: usize = 5;

/// A further agent the members voted, and the job tags it takes.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct AgentSkill {
    pub account: AccountId,
    pub tags: Vec<String>,
}

pub(crate) fn more_agents() -> Vec<AgentSkill> {
    load(KEY_AGENTS).unwrap_or_default()
}
pub(crate) fn receipt_agent_key(job: &str) -> Vec<u8> {
    format!("receipt_agent:{job}").into_bytes()
}
const MAX_FUNDS: usize = 3;
const MAX_GUARANTORS: usize = 3;
const LATE_GRACE_DAYS: u64 = 7;
const GAS_LOAN_FILED: Gas = Gas::from_tgas(80);
const GAS_FUND_PAID: Gas = Gas::from_tgas(10);

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct ShareFund {
    pub name: String,
    pub bps: u16,
    pub to: AccountId,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct LoanRule {
    /// yoctoNEAR: the largest single loan.
    pub max_loan: U128,
    /// Flat interest on the principal, in basis points.
    pub rate_bps: u16,
    pub term_days: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub enum LoanStatus {
    Open,
    Repaid,
    Late,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Loan {
    pub principal: U128,
    pub interest: U128,
    pub due: U64,
    pub proposal: Option<u64>,
    pub status: LoanStatus,
}

fn guarantors_key(a: &AccountId) -> Vec<u8> {
    format!("guarantors:{a}").into_bytes()
}
fn failed_key(a: &AccountId) -> Vec<u8> {
    format!("guarantee_failed:{a}").into_bytes()
}
fn loan_key(a: &AccountId) -> Vec<u8> {
    format!("loan:{a}").into_bytes()
}

pub(crate) fn guarantee_failures(a: &AccountId) -> u32 {
    load::<u32>(&failed_key(a)).unwrap_or(0)
}

/// `a` just fell out of good standing: each of its guarantors answers for it (once per fall).
pub(crate) fn guarantors_answer(a: &AccountId) {
    for g in load::<Vec<AccountId>>(&guarantors_key(a)).unwrap_or_default() {
        save(&failed_key(&g), &(guarantee_failures(&g) + 1));
        Event::GuaranteeCalled { account_id: a.clone(), guarantor: g }.emit();
    }
}

fn loan_fund() -> u128 {
    load::<U128>(KEY_LOAN_FUND).map_or(0, |x| x.0)
}

impl Koperasi {
    /// The reputation dividend of a profit share of `amount`, out of `reserve` at most, credited to the members by
    /// credit score. Returns what is left of the reserve.
    pub(crate) fn pay_reputation(&mut self, amount: u128, reserve: u128) -> u128 {
        let bps = load::<u16>(KEY_REPUTATION).unwrap_or(0) as u128;
        let pool = (amount * bps / 10_000).min(reserve);
        if pool == 0 {
            return reserve;
        }
        // Only members in good standing, and only the record: work done, pledges kept, juries served. Guarantors are
        // left out here (two members can stand surety for each other at no cost). 0.3.3: the weight is the work added
        // since the last dividend plus half the last weight, so it never saturates and recent work counts most.
        let scores = self.reputation_weights(true);
        let total: u128 = scores.iter().map(|(_, s)| s).sum();
        if total == 0 {
            return reserve;
        }
        let mut paid = 0;
        for (a, s) in scores {
            let x = pool * s / total;
            if x > 0 {
                let c = self.claimable.get(&a).copied().unwrap_or(0);
                self.claimable.insert(a.clone(), c + x);
                paid += x;
            }
        }
        crate::bump(crate::KEY_OWED_SHARES, paid, false);
        Event::ReputationDividend { amount: U128(paid) }.emit();
        reserve - paid
    }

    /// Good standing, all of it: the record (pledges, juries, slashes), dues, and no guarantee called against them.
    pub(crate) fn in_good_standing(&self, a: &AccountId) -> bool {
        crate::commons::standing_of(a).good() && self.dues_ok(a) && guarantee_failures(a) == 0
    }

    /// The funds' parts of a profit share of `amount`, out of `reserve` at most. Returns what is left of the reserve.
    pub(crate) fn pay_funds(&mut self, amount: u128, reserve: u128) -> u128 {
        let mut left = reserve;
        for f in load::<Vec<ShareFund>>(KEY_FUNDS).unwrap_or_default() {
            let x = (amount * f.bps as u128 / 10_000).min(left);
            if x == 0 {
                continue;
            }
            left -= x;
            Event::FundPaid { name: f.name.clone(), to: f.to.clone(), amount: U128(x) }.emit();
            if f.to == env::current_account_id() {
                add_risk(x); // the risk fund is kept here, for court refunds
                continue;
            }
            let _ = ext_ft::ext(self.usdc_id.clone())
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(Gas::from_tgas(15))
                .ft_transfer(f.to.clone(), U128(x), Some(format!("Koperasi {} fund", f.name)))
                .then(Self::ext(env::current_account_id()).with_static_gas(GAS_FUND_PAID).on_fund_paid(U128(x)));
        }
        left
    }
}

#[near]
impl Koperasi {
    // ---------- the reputation dividend ----------

    /// DAO only: the share of every profit share (bps, out of the reserve part) split by credit score.
    pub fn set_reputation_share(&mut self, bps: u16) {
        self.assert_dao();
        require!(bps as u32 <= self.share_rule.reserve_bps as u32, "it comes out of the reserve: at most its bps");
        save(KEY_REPUTATION, &bps);
        Event::ReputationShareSet { bps }.emit();
    }

    pub fn get_reputation_share(&self) -> u16 {
        load(KEY_REPUTATION).unwrap_or(0)
    }

    // ---------- the risk fund ----------

    /// DAO only: the share of every earnings deposit (bps, at most 20%) that stays in the risk fund.
    pub fn set_agent_saves(&mut self, bps: u16) {
        self.assert_dao();
        require!(bps <= 2_000, "at most 20%");
        save(KEY_AGENT_SAVES, &bps);
        Event::AgentSavesSet { bps }.emit();
    }

    /// (USDC in the risk fund, bps of each earnings deposit it keeps).
    pub fn get_risk_fund(&self) -> (U128, u16) {
        (U128(risk_fund()), agent_saves_bps())
    }

    /// Callback of a refund paid from the risk fund: if it failed, the amount goes back to the fund (the members then
    /// refund the buyer by a proposal).
    #[private]
    pub fn on_risk_refund(&mut self, id: u32, amount: U128, #[callback_result] r: Result<(), PromiseError>) {
        if r.is_err() {
            add_risk(amount.0);
            Event::RiskRefundFailed { id, amount }.emit();
        }
    }

    // ---------- an agent's own by-laws ----------

    /// DAO only: a further agent's own by-laws (version, sha256, file next to the page).
    pub fn set_agent_config(&mut self, account_id: AccountId, version: u32, hash: String, uri: String) {
        self.assert_dao();
        require!(more_agents().iter().any(|a| a.account == account_id), "not a further agent the members voted");
        require!(hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()), "hash: sha256 hex");
        require!(!uri.is_empty() && uri.len() <= 200, "uri");
        save(&agent_config_key(&account_id), &Config { version, hash: hash.clone(), uri, contributor: None, activated_at: U64(env::block_timestamp()) });
        Event::AgentConfigSet { account_id, version, hash }.emit();
    }

    /// A further agent's own by-laws (None: it runs the co-op's).
    pub fn get_agent_config(&self, account_id: AccountId) -> Option<Config> {
        agent_config(&account_id)
    }

    // ---------- credit from the record ----------

    /// (score out of 10, the largest loan it allows now): finished tasks and bounties, pledges kept, juries served,
    /// and 2 for each guarantor in good standing.
    /// 0.3.3: work stamped into the passport from sister co-ops counts too; a loan late at a sister co-op makes it 0.
    pub fn get_credit(&self, account_id: AccountId) -> (u32, U128) {
        if crate::solidarity::late_elsewhere(&account_id).is_some() {
            return (0, U128(0));
        }
        let done = self.get_record(account_id.clone()).map_or(0, |r| r.done);
        let s = crate::commons::standing_of(&account_id);
        let g = self.get_guarantors(account_id.clone()).iter().filter(|x| self.in_good_standing(x)).count() as u32;
        let sisters = self.get_sister_coops();
        // only stamps read in the last 30 days: anyone can stamp again (stamp_passport) to bring one up to date
        let fresh = env::block_timestamp().saturating_sub(30 * DAY_NS);
        let away: u32 = self.get_passport(account_id.clone()).iter().filter(|p| sisters.contains(&p.coop) && p.at.0 >= fresh).map(|p| p.done).sum();
        let score = (done + s.pledges_honored + s.juries_served + 2 * g + away).min(10);
        let max = load::<LoanRule>(KEY_LOAN_RULE).map_or(0, |r| r.max_loan.0);
        (score, U128(max * score as u128 / 10))
    }

    // ---------- more than one agent ----------

    /// DAO only: further agents (at most 5, not the founding agent) and the job tags each takes (1 to 8, lowercase).
    pub fn set_agents(&mut self, agents: Vec<AgentSkill>) {
        self.assert_dao();
        require!(agents.len() <= MAX_AGENTS, "at most 5 further agents");
        for a in &agents {
            require!(a.account != self.agent_id, "the founding agent is already the agent");
            require!(!a.tags.is_empty() && a.tags.len() <= 8 && a.tags.iter().all(|t| !t.is_empty() && t.len() <= 32 && *t == t.to_lowercase()),
                "tags: 1 to 8, lowercase, up to 32 characters");
        }
        Event::AgentsSet { agents: agents.iter().map(|a| a.account.clone()).collect() }.emit();
        save(KEY_AGENTS, &agents);
    }

    /// The founding agent (empty tags: every tag the by-laws allow) and the further agents with their tags.
    pub fn get_agents(&self) -> Vec<AgentSkill> {
        let mut all = vec![AgentSkill { account: self.agent_id.clone(), tags: vec![] }];
        all.extend(more_agents());
        all
    }

    /// The agent that recorded a receipt (the founding agent when none is named).
    pub fn get_receipt_agent(&self, job_id: String) -> AccountId {
        env::storage_read(&receipt_agent_key(&job_id)).and_then(|b| String::from_utf8(b).ok()).and_then(|s| s.parse().ok())
            .unwrap_or_else(|| self.agent_id.clone())
    }

    // ---------- funds from the surplus ----------

    /// DAO only: up to 3 funds paid from every profit share's reserve part; together at most the rule's reserve.
    pub fn set_share_funds(&mut self, funds: Vec<ShareFund>) {
        self.assert_dao();
        require!(funds.len() <= MAX_FUNDS, "at most 3 funds");
        require!(funds.iter().all(|f| !f.name.trim().is_empty() && f.name.len() <= 40), "fund name: 1 to 40 characters");
        let total: u32 = funds.iter().map(|f| f.bps as u32).sum();
        require!(total <= self.share_rule.reserve_bps as u32, "the funds come out of the reserve: at most its bps");
        Event::ShareFundsSet { funds: funds.len() as u32 }.emit();
        save(KEY_FUNDS, &funds);
    }

    pub fn get_share_funds(&self) -> Vec<ShareFund> {
        load(KEY_FUNDS).unwrap_or_default()
    }

    /// Callback of a fund's payment: if it failed, the amount goes to the DAO with the next flush.
    #[private]
    pub fn on_fund_paid(&mut self, amount: U128, #[callback_result] r: Result<(), PromiseError>) {
        if r.is_err() {
            self.unforwarded += amount.0;
            Event::ForwardFailed { amount }.emit();
        }
    }

    // ---------- standing surety ----------

    /// A member in good standing guarantees `account_id` (attach 0.01 NEAR for storage); at most 3 guarantors each.
    #[payable]
    pub fn guarantee(&mut self, account_id: AccountId) {
        let g = env::predecessor_account_id();
        require!(self.members.contains_key(&g), "only a member");
        require!(self.in_good_standing(&g), "only a member in good standing");
        require!(g != account_id, "not for yourself");
        require!(env::attached_deposit() >= crate::commons::PLEDGE_FEE, "attach 0.01 NEAR for the guarantee's storage");
        let mut all: Vec<AccountId> = load(&guarantors_key(&account_id)).unwrap_or_default();
        require!(!all.contains(&g), "you already guarantee this account");
        require!(all.len() < MAX_GUARANTORS, "at most 3 guarantors");
        all.push(g.clone());
        save(&guarantors_key(&account_id), &all);
        Event::Guaranteed { account_id, guarantor: g }.emit();
    }

    /// A guarantor withdraws, unless the account has a loan open.
    pub fn withdraw_guarantee(&mut self, account_id: AccountId) {
        let g = env::predecessor_account_id();
        require!(self.get_loan(account_id.clone()).is_none_or(|l| l.status != LoanStatus::Open), "the account has a loan open");
        let mut all: Vec<AccountId> = load(&guarantors_key(&account_id)).unwrap_or_default();
        require!(all.contains(&g), "you do not guarantee this account");
        all.retain(|x| *x != g);
        save(&guarantors_key(&account_id), &all);
        Event::GuaranteeWithdrawn { account_id, guarantor: g }.emit();
    }

    pub fn get_guarantors(&self, account_id: AccountId) -> Vec<AccountId> {
        load(&guarantors_key(&account_id)).unwrap_or_default()
    }

    /// How many times a guarantee this account gave was called (0: no mark).
    pub fn get_guarantee_failures(&self, account_id: AccountId) -> u32 {
        guarantee_failures(&account_id)
    }

    /// DAO only: the members clear a guarantor's marks (they reviewed what happened).
    pub fn clear_guarantee_failures(&mut self, account_id: AccountId) {
        self.assert_dao();
        save(&failed_key(&account_id), &0u32);
        Event::GuaranteeCleared { account_id }.emit();
    }

    // ---------- savings and loans ----------

    /// DAO only: the loan rule, and `add_to_fund` yoctoNEAR more the contract may lend from the treasury.
    pub fn set_loan_rule(&mut self, rule: LoanRule, add_to_fund: U128) {
        self.assert_dao();
        require!(rule.rate_bps <= 5_000 && (1..=365).contains(&rule.term_days), "rate at most 50%, term 1 to 365 days");
        require!(crate::solidarity::within_federation(rule.rate_bps, rule.term_days), "above the federation's loan ceiling");
        save(KEY_LOAN_RULE, &rule);
        save(KEY_LOAN_FUND, &U128(loan_fund() + add_to_fund.0));
        Event::LoanRuleSet { max_loan: rule.max_loan, rate_bps: rule.rate_bps, term_days: rule.term_days, fund: U128(loan_fund()) }.emit();
    }

    /// (rule, what the fund can still lend).
    pub fn get_loan_rule(&self) -> Option<(LoanRule, U128)> {
        load::<LoanRule>(KEY_LOAN_RULE).map(|r| (r, U128(loan_fund())))
    }

    /// A member in good standing, with a guarantor in good standing, borrows `amount` yoctoNEAR (one loan at a time).
    pub fn request_loan(&mut self, amount: U128) -> Promise {
        let who = env::predecessor_account_id();
        require!(self.members.contains_key(&who), "only a member");
        require!(self.in_good_standing(&who), "only a member in good standing");
        let rule: LoanRule = load(KEY_LOAN_RULE).unwrap_or_else(|| env::panic_str("the members voted no loans"));
        require!(amount.0 > 0 && amount.0 <= rule.max_loan.0, "at most the largest loan the members voted");
        require!(crate::solidarity::within_federation(rule.rate_bps, rule.term_days), "the loan rule is above the federation's ceiling: the members must lower it");
        require!(crate::solidarity::late_elsewhere(&who).is_none(), "a loan of yours is late at a sister co-op");
        // 0.3.2: and at most what the borrower's record allows (score out of 10 of the largest loan)
        require!(amount.0 <= self.get_credit(who.clone()).1 .0, "more than your record allows: finish tasks, keep pledges, find guarantors");
        require!(amount.0 <= loan_fund(), "the loan fund is too low: the members must add to it");
        require!(self.get_loan(who.clone()).is_none_or(|l| l.status == LoanStatus::Repaid), "repay your loan first");
        let gs = self.get_guarantors(who.clone());
        require!(gs.iter().any(|g| self.in_good_standing(g)), "a loan needs a guarantor in good standing");
        save(KEY_LOAN_FUND, &U128(loan_fund() - amount.0));
        let interest = amount.0 * rule.rate_bps as u128 / 10_000;
        let due = env::block_timestamp() + rule.term_days as u64 * DAY_NS;
        save(&loan_key(&who), &Loan { principal: amount, interest: U128(interest), due: U64(due), proposal: None, status: LoanStatus::Open });
        Event::LoanRequested { account_id: who.clone(), amount, due: U64(due) }.emit();
        let kind = near_sdk::serde_json::json!({ "Transfer": { "token_id": "", "receiver_id": who, "amount": amount, "msg": null } });
        let description = format!("Koperasi loan: {} NEAR to {who}, {} days at {} bps flat, guaranteed by {}",
            amount.0 as f64 / 1e24, rule.term_days, rule.rate_bps, gs.iter().map(|g| g.as_str()).collect::<Vec<_>>().join(", "));
        ext_dao_proposals::ext(self.dao_id.clone())
            .with_attached_deposit(PAYOUT_BOND)
            .with_static_gas(GAS_PROPOSE)
            .add_proposal(near_sdk::serde_json::json!({ "description": description, "kind": kind.clone() }))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_LOAN_FILED).on_loan_filed(who, kind))
    }

    /// Callback: the DAO filed the loan; the contract approves it with its `tasks` role (the rule already decided).
    /// Nothing filed: the loan is undone and the fund restored.
    #[private]
    pub fn on_loan_filed(&mut self, account_id: AccountId, kind: Value, #[callback_result] pid: Result<u64, PromiseError>) -> PromiseOrValue<()> {
        let mut l: Loan = load(&loan_key(&account_id)).unwrap();
        let Ok(pid) = pid else {
            save(KEY_LOAN_FUND, &U128(loan_fund() + l.principal.0));
            env::storage_remove(&loan_key(&account_id));
            return PromiseOrValue::Value(());
        };
        l.proposal = Some(pid);
        save(&loan_key(&account_id), &l);
        Event::LoanFiled { account_id, proposal_id: pid }.emit();
        PromiseOrValue::Promise(ext_dao_proposals::ext(self.dao_id.clone()).with_static_gas(GAS_ACT).act_proposal(pid, "VoteApprove".into(), kind, None))
    }

    /// The borrower repays: attach principal plus interest; it all goes to the treasury, and the principal back to the
    /// loan fund. A late loan repaid is settled too (the marks stay until the members clear them).
    #[payable]
    pub fn repay_loan(&mut self) {
        let who = env::predecessor_account_id();
        let mut l: Loan = load(&loan_key(&who)).unwrap_or_else(|| env::panic_str("no loan"));
        require!(l.status != LoanStatus::Repaid, "already repaid");
        if l.status == LoanStatus::Late {
            crate::solidarity::tell_sisters(&who, false); // 0.3.3: settled, the sister co-ops lift their note
        }
        let owed = l.principal.0 + l.interest.0;
        let paid = env::attached_deposit().as_yoctonear();
        require!(paid >= owed, "attach the principal plus the interest");
        l.status = LoanStatus::Repaid;
        save(&loan_key(&who), &l);
        save(KEY_LOAN_FUND, &U128(loan_fund() + l.principal.0));
        let _ = Promise::new(self.dao_id.clone()).transfer(NearToken::from_yoctonear(owed));
        if paid > owed {
            let _ = Promise::new(who.clone()).transfer(NearToken::from_yoctonear(paid - owed));
        }
        Event::LoanRepaid { account_id: who, amount: U128(owed) }.emit();
    }

    /// Anyone, 7 days after a loan's term: the borrower is marked (and so their guarantors).
    pub fn call_loan_late(&mut self, account_id: AccountId) {
        let mut l: Loan = load(&loan_key(&account_id)).unwrap_or_else(|| env::panic_str("no loan"));
        require!(l.status == LoanStatus::Open, "not an open loan");
        require!(env::block_timestamp() > l.due.0 + LATE_GRACE_DAYS * DAY_NS, "not late yet");
        l.status = LoanStatus::Late;
        save(&loan_key(&account_id), &l);
        crate::commons::mark(&account_id, |s| s.slashed += 1);
        crate::solidarity::tell_sisters(&account_id, true); // 0.3.3: told to every sister co-op
        Event::LoanLate { account_id }.emit();
    }

    pub fn get_loan(&self, account_id: AccountId) -> Option<Loan> {
        load(&loan_key(&account_id))
    }
}

// ---------- 0.3.6: loans to sister co-ops from the risk fund ----------
//
// The members (DAO only) lend a sister co-op USDC from the risk fund (`lend_to_sister`): at most half of it, one loan
// open per co-op, and never to a co-op a sister co-op notes late (0.3.10: a late loan repaid here only lowers its score,
// see `lend_to_sister`). Interest since 0.3.7 (below).
// The borrower (or anyone) repays with ft_transfer_call msg "sister_repay:<id>", into the risk fund. A loan unpaid after
// its due date can be called late by anyone (`mark_sister_late`): recorded here and told to every sister co-op.

const KEY_SISTER_LOANS: &[u8] = b"sister_loans";
const KEY_SISTER_LOAN_COUNT: &[u8] = b"sister_loan_count";
/// Loans kept: when there are more, the oldest settled one (repaid or failed) is dropped.
pub const MAX_SISTER_LOANS: usize = 100;
/// The most of the risk fund one loan may take, in bps.
const SISTER_CAP_BPS: u128 = 5_000;
const GAS_SISTER_LENT: Gas = Gas::from_tgas(10);
pub const SISTER_REPAY_PREFIX: &str = "sister_repay:";

fn sister_late_key(coop: &AccountId) -> Vec<u8> {
    format!("sister_late:{coop}").into_bytes()
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum SisterLoanStatus {
    Open,
    Repaid,
    Late,
    /// the transfer failed: the amount went back to the risk fund
    Failed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct SisterLoan {
    pub id: u32,
    pub coop: AccountId,
    /// where the money went: the sister's treasury (its DAO) the members named, never its contract (which cannot spend it)
    pub paid_to: AccountId,
    pub amount: U128,
    pub repaid: U128,
    pub lent_at: U64,
    pub due: U64,
    pub status: SisterLoanStatus,
    pub was_late: bool,
}

fn sister_loans() -> Vec<SisterLoan> {
    load(KEY_SISTER_LOANS).unwrap_or_default()
}

/// How many loans to `coop` went late (kept for good: the record of this co-op's own lending).
pub(crate) fn sister_late_count(coop: &AccountId) -> u32 {
    load(&sister_late_key(coop)).unwrap_or(0)
}

impl Koperasi {
    /// `ft_on_transfer` with msg "sister_repay:<id>": repay a sister loan into the risk fund. Returns what is not used
    /// (all of it for a bad id, a settled or failed loan; the excess over what is still owed).
    pub(crate) fn sister_repay(&mut self, id: &str, amount: u128) -> u128 {
        let Ok(id) = id.parse::<u32>() else { return amount };
        let mut all = sister_loans();
        let Some(l) = all.iter_mut().find(|l| l.id == id) else { return amount };
        if !matches!(l.status, SisterLoanStatus::Open | SisterLoanStatus::Late) {
            return amount;
        }
        // 0.3.7: the principal first, back into the risk fund; then the interest, to the DAO treasury (the surplus)
        let left = l.amount.0 - l.repaid.0;
        let take = amount.min(left);
        l.repaid.0 += take;
        add_risk(take);
        let (due, paid) = sister_interest(id);
        let interest = (amount - take).min(due - paid);
        if interest > 0 {
            save(&sister_interest_key(id), &(U128(due), U128(paid + interest)));
            // 0.3.9: the federation dividend's part to the other sister co-ops' treasuries; the rest to the DAO as before
            let coop = l.coop.clone();
            let rest = self.pay_federation_dividend(id, &coop, interest);
            if rest > 0 {
                self.forward_to_dao(rest);
            }
            Event::SisterInterest { id, coop: l.coop.clone(), amount: U128(interest) }.emit();
        }
        let outstanding = left - take + due - paid - interest;
        if outstanding == 0 {
            if l.status == SisterLoanStatus::Late {
                crate::solidarity::tell_sisters(&l.coop, false); // settled: the sister co-ops lift their note
            }
            l.status = SisterLoanStatus::Repaid;
        }
        Event::SisterRepaid { id, coop: l.coop.clone(), amount: U128(take), outstanding: U128(outstanding) }.emit();
        save(KEY_SISTER_LOANS, &all);
        amount - take - interest
    }
}

#[near]
impl Koperasi {
    /// DAO only: lend sister co-op `coop` `amount` USDC from the risk fund for `days` (1 to 365). At most half the risk
    /// fund x its federation credit score / 100 (score 0: refused); refused while it is in arrears: a loan to it is open,
    /// or a sister co-op's late note on it still stands. 0.3.10 (after the hackathon deadline), graduated sanctions (Ostrom's
    /// principle 5): a co-op whose loan here went late and was repaid may borrow again, less (-40 per late in the score).
    /// 0.3.7: `interest_bps` (0 to 2000, none = 0) is simple interest for the term, due on top of the amount.
    pub fn lend_to_sister(&mut self, coop: AccountId, paid_to: AccountId, amount: U128, days: u32, interest_bps: Option<u16>) -> Promise {
        self.assert_dao();
        let bps = interest_bps.unwrap_or(0);
        require!(bps <= MAX_SISTER_INTEREST_BPS, "interest at most 2000 bps");
        require!(!self.paused, "koperasi is paused");
        require!(self.get_sister_coops().contains(&coop), "not a sister co-op the members recognise");
        require!((1..=365).contains(&days), "term 1 to 365 days");
        // the sister's contract cannot spend or return USDC: the loan goes to the treasury the members name (its DAO)
        require!(paid_to != coop && paid_to != env::current_account_id(), "pay the sister's treasury (its DAO), not a contract");
        require!(amount.0 > 0 && amount.0 <= risk_fund() * SISTER_CAP_BPS / 10_000, "at most half the risk fund");
        let (score, cap) = self.assert_credit_cap(&coop, amount.0); // 0.3.9
        // 0.3.10 graduated sanctions: lateness repaid here only lowers the score (and so the cap); arrears still refuse
        require!(crate::solidarity::late_elsewhere(&coop).is_none(), "a sister co-op noted this co-op late");
        let mut all = sister_loans();
        require!(!all.iter().any(|l| l.coop == coop && matches!(l.status, SisterLoanStatus::Open | SisterLoanStatus::Late)),
            "a loan to this co-op is still open");
        let id: u32 = load(KEY_SISTER_LOAN_COUNT).unwrap_or(0);
        save(KEY_SISTER_LOAN_COUNT, &(id + 1));
        let due_interest = amount.0 * bps as u128 / 10_000;
        if due_interest > 0 {
            save(&sister_interest_key(id), &(U128(due_interest), U128(0)));
        }
        env::storage_remove(&suggestion_key(&coop)); // the agent's suggestion for this co-op is settled
        let now = env::block_timestamp();
        let due = U64(now + days as u64 * DAY_NS);
        all.push(SisterLoan { id, coop: coop.clone(), paid_to: paid_to.clone(), amount, repaid: U128(0), lent_at: U64(now), due, status: SisterLoanStatus::Open, was_late: false });
        if all.len() > MAX_SISTER_LOANS {
            if let Some(i) = all.iter().position(|l| matches!(l.status, SisterLoanStatus::Repaid | SisterLoanStatus::Failed)) {
                env::storage_remove(&sister_interest_key(all[i].id));
                env::storage_remove(&dividend_key(all[i].id));
                all.remove(i);
            }
        }
        save(KEY_SISTER_LOANS, &all);
        take_risk(amount.0);
        crate::bump(crate::KEY_IN_FLIGHT, amount.0, false);
        Event::CoopCreditCap { coop: coop.clone(), score, cap: U128(cap) }.emit();
        Event::SisterLoan { id, coop: coop.clone(), paid_to: paid_to.clone(), amount, due }.emit();
        ext_ft::ext(self.usdc_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(crate::GAS_FT_TRANSFER)
            .ft_transfer(paid_to, amount, Some(format!("Koperasi sister loan #{id}: repay with ft_transfer_call msg {SISTER_REPAY_PREFIX}{id}")))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_SISTER_LENT).on_sister_lent(id, amount))
    }

    /// Callback of `lend_to_sister`: a failed transfer puts the amount back in the risk fund and the loan is void.
    #[private]
    pub fn on_sister_lent(&mut self, id: u32, amount: U128, #[callback_result] r: Result<(), PromiseError>) {
        crate::bump(crate::KEY_IN_FLIGHT, amount.0, true);
        if r.is_ok() {
            return;
        }
        let mut all = sister_loans();
        if let Some(l) = all.iter_mut().find(|l| l.id == id) {
            l.status = SisterLoanStatus::Failed;
            env::storage_remove(&sister_interest_key(id)); // nothing lent, nothing due
            Event::SisterLoanFailed { id, coop: l.coop.clone(), amount }.emit();
        }
        add_risk(amount.0);
        save(KEY_SISTER_LOANS, &all);
    }

    /// Anyone, after its due date: an unpaid sister loan is late; recorded here and told to every sister co-op.
    pub fn mark_sister_late(&mut self, id: u32) {
        let mut all = sister_loans();
        let l = all.iter_mut().find(|l| l.id == id).unwrap_or_else(|| env::panic_str("no such sister loan"));
        require!(l.status == SisterLoanStatus::Open, "not an open loan");
        require!(env::block_timestamp() > l.due.0, "not due yet");
        l.status = SisterLoanStatus::Late;
        l.was_late = true;
        save(&sister_late_key(&l.coop), &(sister_late_count(&l.coop) + 1));
        crate::solidarity::tell_sisters(&l.coop, true);
        let (due, paid) = sister_interest(id);
        Event::SisterLate { id, coop: l.coop.clone(), outstanding: U128(l.amount.0 - l.repaid.0 + due - paid) }.emit();
        save(KEY_SISTER_LOANS, &all);
    }

    /// Loans to sister co-ops still kept (every open or late one; the last settled ones), oldest first.
    pub fn get_sister_loans(&self) -> Vec<SisterLoan> {
        sister_loans()
    }

    /// How many loans to `coop` went late here (each takes 40 off its federation credit score, so off its cap).
    pub fn get_sister_late(&self, coop: AccountId) -> u32 {
        sister_late_count(&coop)
    }
}

// ---------- 0.3.7: interest on loans to sister co-ops; the agent asks for one ----------
//
// The members may lend a sister co-op at simple interest for the term (`interest_bps`, at most 20%). Repayment covers
// the principal first, back into the risk fund, then the interest, forwarded to the DAO treasury: the surplus the next
// profit share splits (the same transfer, with the same rollback, as the agent's earnings). The loan is Repaid only once
// both are paid. Kept under `sister_interest:<id>`, so `SisterLoan` keeps its layout.
//
// The founding agent may ask the members to lend a sister co-op (`agent_suggest_sister_loan`), directly or by its
// signature: the contract files a DAO proposal that calls `lend_to_sister` with those terms, the caller attaching the
// bond. The members still decide by vote. One suggestion open per sister co-op: until a loan to it is made, or 7 days.

const MAX_SISTER_INTEREST_BPS: u16 = 2_000;
/// The agent's loan suggestions signed so far: only ever goes up (its own nonce, apart from by-laws and referrals).
const KEY_AGENT_LOAN_NONCE: &[u8] = b"agent_loan_nonce";
/// A suggestion stays open this long (Sputnik's default proposal period), or until a loan to that co-op is made.
pub const SUGGESTION_OPEN_DAYS: u64 = 7;
const MAX_LOAN_REASON: usize = 280;
const GAS_LOAN_SUGGESTED: Gas = Gas::from_tgas(10);
/// Gas the DAO gives `lend_to_sister` when the proposal is executed (its transfer and callback included).
const GAS_LEND_ACTION: &str = "50000000000000";

fn sister_interest_key(id: u32) -> Vec<u8> {
    format!("sister_interest:{id}").into_bytes()
}
fn suggestion_key(coop: &AccountId) -> Vec<u8> {
    format!("loan_suggestion:{coop}").into_bytes()
}

/// (interest due, interest paid) on sister loan `id`; (0, 0) for a loan without interest.
pub(crate) fn sister_interest(id: u32) -> (u128, u128) {
    load::<(U128, U128)>(&sister_interest_key(id)).map_or((0, 0), |(d, p)| (d.0, p.0))
}

/// What the agent signs to ask the members for a loan to a sister co-op (bound to this contract and to the nonce).
pub fn agent_loan_message(contract: &AccountId, nonce: u32, coop: &AccountId, paid_to: &AccountId, amount: u128, days: u32, interest_bps: u16, reason: &str) -> String {
    format!("koperasi-agent-loan/1 {contract} #{nonce} {coop} {paid_to} {amount} {days} {interest_bps}
{reason}")
}

/// A loan the agent asked the members for; `proposal` is the DAO proposal once filed.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct LoanSuggestion {
    pub coop: AccountId,
    pub paid_to: AccountId,
    pub amount: U128,
    pub days: u32,
    pub interest_bps: u16,
    pub reason: String,
    /// who attached the bond (refunded if the DAO files nothing)
    pub by: AccountId,
    pub proposal: Option<u64>,
    pub at: U64,
}

#[near]
impl Koperasi {
    /// The founding agent asks the members to lend sister co-op `coop` (paid to its treasury `paid_to`) `amount` USDC
    /// from the risk fund for `days` at `interest_bps`: directly, or anyone submitting its ed25519 signature (base64) of
    /// `get_loan_suggestion_message(...)`. Attach the DAO proposal bond (0.1 NEAR). Files a DAO proposal calling
    /// `lend_to_sister`; the members vote.
    #[payable]
    pub fn agent_suggest_sister_loan(&mut self, coop: AccountId, paid_to: AccountId, amount: U128, days: u32, interest_bps: u16,
        reason: String, signature: Option<String>) -> Promise {
        require!(!self.paused, "koperasi is paused");
        require!(!crate::meeting::agent_suspended(), "the agent is suspended");
        crate::solidarity::assert_tee_ok(&self.agent_id);
        let nonce: u32 = load(KEY_AGENT_LOAN_NONCE).unwrap_or(0);
        crate::meeting::assert_agent_or_signed(&self.agent_id, signature.as_deref(),
            || agent_loan_message(&env::current_account_id(), nonce, &coop, &paid_to, amount.0, days, interest_bps, &reason));
        save(KEY_AGENT_LOAN_NONCE, &(nonce + 1)); // a signature counts once
        require!(!reason.trim().is_empty() && reason.len() <= MAX_LOAN_REASON, "reason: 1 to 280 characters");
        // the terms `lend_to_sister` checks again when the members' vote executes it
        require!(self.get_sister_coops().contains(&coop), "not a sister co-op the members recognise");
        require!(paid_to != coop && paid_to != env::current_account_id(), "pay the sister's treasury (its DAO), not a contract");
        require!((1..=365).contains(&days), "term 1 to 365 days");
        require!(interest_bps <= MAX_SISTER_INTEREST_BPS, "interest at most 2000 bps");
        require!(amount.0 > 0 && amount.0 <= risk_fund() * SISTER_CAP_BPS / 10_000, "at most half the risk fund");
        self.assert_credit_cap(&coop, amount.0); // 0.3.9
        require!(crate::solidarity::late_elsewhere(&coop).is_none(), "a sister co-op noted this co-op late"); // 0.3.10
        require!(!sister_loans().iter().any(|l| l.coop == coop && matches!(l.status, SisterLoanStatus::Open | SisterLoanStatus::Late)),
            "a loan to this co-op is still open");
        let now = env::block_timestamp();
        require!(load::<LoanSuggestion>(&suggestion_key(&coop)).is_none_or(|s| now >= s.at.0 + SUGGESTION_OPEN_DAYS * DAY_NS),
            "a suggestion for this co-op is still open");
        require!(env::attached_deposit() == PAYOUT_BOND, "attach the DAO proposal bond: 0.1 NEAR");
        let by = env::predecessor_account_id();
        save(&suggestion_key(&coop), &LoanSuggestion { coop: coop.clone(), paid_to: paid_to.clone(), amount, days, interest_bps,
            reason: reason.clone(), by: by.clone(), proposal: None, at: U64(now) });
        let args = near_sdk::serde_json::json!({ "coop": coop, "paid_to": paid_to, "amount": amount, "days": days,
            "interest_bps": interest_bps }).to_string();
        let kind = near_sdk::serde_json::json!({ "FunctionCall": { "receiver_id": env::current_account_id(), "actions": [{
            "method_name": "lend_to_sister", "args": near_sdk::base64::Engine::encode(&near_sdk::base64::engine::general_purpose::STANDARD, args),
            "deposit": "0", "gas": GAS_LEND_ACTION }] } });
        let description = format!("Loan to sister co-op {coop}: {} USDC to {paid_to} for {days} days at {interest_bps} bps, asked by the co-op's agent: {reason}",
            amount.0 as f64 / 1e6);
        ext_dao_proposals::ext(self.dao_id.clone())
            .with_attached_deposit(PAYOUT_BOND)
            .with_static_gas(GAS_PROPOSE)
            .add_proposal(near_sdk::serde_json::json!({ "description": description, "kind": kind }))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_LOAN_SUGGESTED).on_loan_suggested(coop, amount, by))
    }

    /// Callback: the DAO filed the suggestion (its proposal id kept). Nothing filed: the suggestion is forgotten and the
    /// bond goes back to whoever attached it.
    #[private]
    pub fn on_loan_suggested(&mut self, coop: AccountId, amount: U128, by: AccountId, #[callback_result] pid: Result<u64, PromiseError>) {
        let s = load::<LoanSuggestion>(&suggestion_key(&coop));
        match pid {
            Ok(id) => {
                if let Some(mut s) = s {
                    s.proposal = Some(id);
                    save(&suggestion_key(&coop), &s);
                }
                Event::LoanSuggested { coop, amount, proposal: id }.emit();
            }
            Err(_) => {
                if s.is_some_and(|s| s.proposal.is_none()) {
                    env::storage_remove(&suggestion_key(&coop));
                }
                let _ = Promise::new(by).transfer(PAYOUT_BOND);
            }
        }
    }

    /// The exact text the agent signs for its next `agent_suggest_sister_loan`.
    pub fn get_loan_suggestion_message(&self, coop: AccountId, paid_to: AccountId, amount: U128, days: u32, interest_bps: u16, reason: String) -> String {
        agent_loan_message(&env::current_account_id(), load(KEY_AGENT_LOAN_NONCE).unwrap_or(0), &coop, &paid_to, amount.0, days, interest_bps, &reason)
    }

    /// The agent's last loan suggestion for `coop` (open while younger than 7 days and no loan to it was made since).
    pub fn get_loan_suggestion(&self, coop: AccountId) -> Option<LoanSuggestion> {
        load(&suggestion_key(&coop))
    }

    /// (loan id, interest due, interest paid) for every sister loan still kept.
    pub fn get_sister_interest(&self) -> Vec<(u32, U128, U128)> {
        sister_loans().iter().map(|l| { let (d, p) = sister_interest(l.id); (l.id, U128(d), U128(p)) }).collect()
    }
}

// ---------- 0.3.9: binding federation credit; the federation dividend ----------
//
// A sister co-op's credit score, the rule web/coops.html shows: 100, -40 for each loan to it that went late (this
// co-op's count, plus each sister's "late elsewhere" note), -10 for each open loan to it past due, +5 for each loan repaid
// on time; between 0 and 100. `lend_to_sister` and the agent's suggestion lend at most half the risk fund x score/100.
// 0.3.10 (after the hackathon deadline): the score decides past lateness (graduated sanctions); only current arrears (an
// open loan, a standing late note from a sister co-op) still refuse.
//
// The federation dividend: the members vote a share (`set_federation_dividend`, bps) of each sister loan's interest
// that is split equally among the treasuries (`set_coop_treasury`) of the other sister co-ops; the rest goes to the DAO
// as before. A failed transfer goes to the DAO's unforwarded balance (`flush_to_dao`): never sent twice.

const KEY_FED_DIVIDEND: &[u8] = b"federation_dividend_bps";
// each part is one ft_transfer (10 Tgas) and its callback (5 Tgas), all inside the repayment's ft_on_transfer: five fit in
// the gas a repayment attaches (100 Tgas+), so too many sisters can never make a repayment run out of gas and revert
const MAX_DIVIDEND_RECIPIENTS: usize = 5;
const GAS_DIVIDEND_PAID: Gas = Gas::from_tgas(5);

fn dividend_key(id: u32) -> Vec<u8> {
    format!("federation_dividend:{id}").into_bytes()
}

/// A sister co-op's federation credit, as this co-op's contract sees it.
#[near(serializers = [json])]
pub struct CoopCredit {
    pub score: u32,
    /// loans to it called late here, plus the sister co-ops noting it late
    pub late: u32,
    pub open_past_due: u32,
    /// loans to it still kept here, repaid and never late
    pub repaid_on_time: u32,
}

/// What a sister loan's interest paid one treasury, all payments together; `failed` went to the DAO instead.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct DividendPaid {
    pub to: AccountId,
    pub amount: U128,
    pub failed: U128,
}

impl Koperasi {
    /// Refuses `amount` over half the risk fund x the co-op's score / 100. Returns (score, cap).
    fn assert_credit_cap(&self, coop: &AccountId, amount: u128) -> (u32, u128) {
        let score = self.get_coop_credit(coop.clone()).score;
        require!(score > 0, "federation credit score 0/100: this co-op cannot borrow");
        let cap = risk_fund() * SISTER_CAP_BPS / 10_000 * score as u128 / 100;
        require!(amount <= cap, format!("federation credit score {score}/100: at most {cap} (half the risk fund x score/100)"));
        (score, cap)
    }

    /// The federation dividend of `interest` paid on sister loan `id` by `borrower`: sent to the other sister co-ops'
    /// treasuries in equal parts. Returns what is left for the DAO.
    fn pay_federation_dividend(&mut self, id: u32, borrower: &AccountId, interest: u128) -> u128 {
        let bps = load::<u16>(KEY_FED_DIVIDEND).unwrap_or(0) as u128;
        if bps == 0 {
            return interest;
        }
        let to: Vec<AccountId> = self.get_sister_coops().iter().filter(|c| *c != borrower)
            .filter_map(|c| self.get_coop_treasury(c.clone())).take(MAX_DIVIDEND_RECIPIENTS).collect();
        if to.is_empty() {
            return interest;
        }
        let each = interest * bps / 10_000 / to.len() as u128;
        if each == 0 {
            return interest;
        }
        let mut paid: Vec<DividendPaid> = load(&dividend_key(id)).unwrap_or_default();
        for t in &to {
            match paid.iter_mut().find(|p| p.to == *t) {
                Some(p) => p.amount.0 += each,
                None => paid.push(DividendPaid { to: t.clone(), amount: U128(each), failed: U128(0) }),
            }
            crate::bump(crate::KEY_IN_FLIGHT, each, false);
            Event::FederationDividend { loan_id: id, to: t.clone(), amount: U128(each) }.emit();
            let _ = ext_ft::ext(self.usdc_id.clone())
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(crate::GAS_FT_TRANSFER)
                .ft_transfer(t.clone(), U128(each), Some(format!("Koperasi federation dividend, sister loan #{id}")))
                .then(Self::ext(env::current_account_id()).with_static_gas(GAS_DIVIDEND_PAID).on_federation_dividend(id, t.clone(), U128(each)));
        }
        save(&dividend_key(id), &paid);
        interest - each * to.len() as u128
    }
}

#[near]
impl Koperasi {
    /// A sister co-op's federation credit score (no record: 100) and what it is made of.
    pub fn get_coop_credit(&self, coop: AccountId) -> CoopCredit {
        let now = env::block_timestamp();
        let loans = sister_loans();
        let mine = loans.iter().filter(|l| l.coop == coop);
        let open_past_due = mine.clone().filter(|l| l.status == SisterLoanStatus::Open && l.due.0 < now).count() as u32;
        // ponytail: only loans still kept (the last 100) count as repaid on time; the late count is kept for good
        let repaid_on_time = mine.filter(|l| l.status == SisterLoanStatus::Repaid && !l.was_late).count() as u32;
        let late = sister_late_count(&coop) + self.get_late_elsewhere(coop).len() as u32;
        let score = (100 - 40 * late as i64 - 10 * open_past_due as i64 + 5 * repaid_on_time as i64).clamp(0, 100) as u32;
        CoopCredit { score, late, open_past_due, repaid_on_time }
    }

    /// DAO only: the share (bps, at most 10000) of each sister loan's interest split among the other sister co-ops'
    /// treasuries (0: all of it to the DAO, as before).
    pub fn set_federation_dividend(&mut self, bps: u16) {
        self.assert_dao();
        require!(bps <= 10_000, "at most 10000 bps");
        save(KEY_FED_DIVIDEND, &bps);
        Event::FederationDividendSet { bps }.emit();
    }

    pub fn get_federation_dividend(&self) -> u16 {
        load(KEY_FED_DIVIDEND).unwrap_or(0)
    }

    /// What sister loan `loan_id`'s interest paid each treasury as federation dividend (kept while the loan is kept).
    pub fn get_federation_dividend_paid(&self, loan_id: u32) -> Vec<DividendPaid> {
        load(&dividend_key(loan_id)).unwrap_or_default()
    }

    /// Callback of a federation dividend's transfer: failed, the amount goes to the DAO's unforwarded balance.
    #[private]
    pub fn on_federation_dividend(&mut self, loan_id: u32, to: AccountId, amount: U128, #[callback_result] r: Result<(), PromiseError>) {
        crate::bump(crate::KEY_IN_FLIGHT, amount.0, true);
        if r.is_err() {
            self.unforwarded += amount.0;
            let mut paid: Vec<DividendPaid> = load(&dividend_key(loan_id)).unwrap_or_default();
            if let Some(p) = paid.iter_mut().find(|p| p.to == to) {
                p.failed.0 += amount.0;
                save(&dividend_key(loan_id), &paid);
            }
            Event::FederationDividendFailed { loan_id, to, amount }.emit();
        }
    }
}
