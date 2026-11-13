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
//!   that is split by each member's credit score: work done, pledges kept, juries served, guarantors.
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
        let scores: Vec<(AccountId, u128)> = self.members.keys().map(|a| (a.clone(), self.get_credit(a.clone()).0 as u128)).collect();
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
    pub fn get_credit(&self, account_id: AccountId) -> (u32, U128) {
        let done = self.get_record(account_id.clone()).map_or(0, |r| r.done);
        let s = crate::commons::standing_of(&account_id);
        let g = self.get_guarantors(account_id.clone()).iter().filter(|x| self.in_good_standing(x)).count() as u32;
        let score = (done + s.pledges_honored + s.juries_served + 2 * g).min(10);
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
        Event::LoanLate { account_id }.emit();
    }

    pub fn get_loan(&self, account_id: AccountId) -> Option<Loan> {
        load(&loan_key(&account_id))
    }
}
