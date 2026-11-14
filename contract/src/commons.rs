//! What the members owe each other besides money.
//!
//! - **Pledges** (commitment vouchers, after Grassroots Economics' Sarafu pools in Kenya): a member promises a service
//!   ("review one pull request") a few times; another member calls one in; the *holder*, not the issuer, says whether it
//!   was kept, or (after 14 days) that it was broken. Pledges are reputation only (standing), never profit-share points:
//!   two members could otherwise mint points by confirming each other's pledges.
//! - **The co-op court** (after Kleros' agent court): when a buyer disputed a job on the Agent Market (the agent mirrors
//!   that status) and the market ruled for the agent (Paid, final), a member can take the buyer's case to the co-op
//!   with a bond. Three other members in good standing are drawn at random; two of the three must uphold. Upheld: the
//!   bond comes back and the contract files and approves (as role `tasks`) a USDC refund from the treasury, at most the
//!   job's price. One open case per job, at most two cases and one refund per job, and each member takes a given job
//!   to court once: a bogus case (wrong receiver, token amount) cannot block the real one, and a lost case costs a bond. Not upheld: the bond goes to the DAO, unless no juror ruled at all. Jurors earn points only when the jury reached a verdict; jurors who let the
//!   deadline pass are marked. The market names buyers by its own ids, not NEAR accounts, so the contract cannot
//!   check that `refund_to` is the buyer: the jurors do, from the market's job page (trust assumptions in the README).
//!   Both sides are heard: while the case is open the claimant and the steward (who runs the agent and answers for its
//!   work) each file up to three pieces of evidence (`add_evidence`: a link or a hash with a line on what it shows), read
//!   by the jurors and kept with the case for an appeal.
//! - **Standing** (after Hats Protocol): each account's kept and broken pledges, juries served and missed, and slashes,
//!   all written by the contract. Anyone not in good standing is not drawn as a juror.
//! - **The steward's term** (also after Hats): the members vote how many days a steward serves; once it runs out anyone
//!   ends it, and the bond goes back or to the DAO exactly as when the members replace a steward.
//!
//! State lives under its own storage keys, so the upgrade needs no state migration.

use crate::tasks::{ext_dao_proposals, load, save, DAY_NS, GAS_ACT, GAS_PROPOSE, PAYOUT_BOND};
use crate::*;

const KEY_PLEDGES: &[u8] = b"pledge_count";
const KEY_CLAIMS: &[u8] = b"pledge_claim_count";
const KEY_CASES: &[u8] = b"case_count";
const KEY_STEWARD_TERM: &[u8] = b"steward_term_days";
const MAX_WHAT: usize = 280;
/// Pieces of evidence each side may file in one case.
const MAX_EVIDENCE: usize = 3;
const MAX_UNITS: u32 = 20;
/// Storage for a pledge or a claim, paid by whoever makes it (as `TASK_FEE` for a task): otherwise one member could fill
/// the contract's storage for free and leave it unable to write state or refund deposits.
pub const PLEDGE_FEE: NearToken = NearToken::from_millinear(10);
/// The issuer has this long to keep a called-in pledge before the holder may report it broken.
const PLEDGE_DUE_NS: u64 = 14 * DAY_NS;
/// Points for a juror who rules (cases need a market dispute and a bond, so they cannot be minted at will).
pub const JUROR_POINTS: u64 = 5;
pub const JURORS: usize = 3;
pub const COURT_BOND: NearToken = NearToken::from_millinear(500);
const COURT_DAYS_NS: u64 = 3 * DAY_NS;
/// An appeal costs twice the court bond: the whole membership is asked, not three jurors.
pub const APPEAL_BOND: NearToken = NearToken::from_near(1);
/// After the jury's 3 days, the claimant has this long to appeal a dismissed case.
const APPEAL_DAYS_NS: u64 = 7 * DAY_NS;
const GAS_FILED: Gas = Gas::from_tgas(80);
/// 0.3.7: whether jurors are drawn in proportion to their reputation weight (DAO-set; off by default).
const KEY_JURY_BY_REPUTATION: &[u8] = b"jury_by_reputation";
/// Weight given in a reputation draw to an eligible member whose reputation weight is 0, so nobody is excluded: a
/// tenth of a member with one counted contribution and a neutral court record (weight 100).
pub const JURY_WEIGHT_FLOOR: u128 = 10;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Pledge {
    pub id: u32,
    pub issuer: AccountId,
    pub what: String,
    pub units: u32,
    pub called: u32,
    pub ts: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum ClaimStatus {
    Open,
    Honored,
    Broken,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct PledgeClaim {
    pub id: u32,
    pub pledge: u32,
    pub holder: AccountId,
    pub status: ClaimStatus,
    pub ts: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum CaseStatus {
    Open,
    Upheld,
    Dismissed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Case {
    pub id: u32,
    pub job_id: String,
    pub claimant: AccountId,
    pub refund_to: AccountId,
    /// USDC (6 decimals), at most the job's price.
    pub amount: U128,
    pub reason: String,
    pub jurors: Vec<AccountId>,
    pub votes: Vec<(AccountId, bool)>,
    pub opened: U64,
    pub status: CaseStatus,
    pub refund_proposal: Option<u64>,
}

/// A dismissed case taken to the members' meeting (its own key: `Case` stays as it was stored).
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Appeal {
    pub case: u32,
    /// The DAO proposal the members vote: the refund itself.
    pub proposal: Option<u64>,
    /// Open while the members vote; Upheld (refunded) or Dismissed (the jury's ruling stands) once settled.
    pub status: CaseStatus,
    pub opened: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct Standing {
    pub pledges_honored: u32,
    pub pledges_broken: u32,
    pub juries_served: u32,
    pub juries_missed: u32,
    pub slashed: u32,
}

impl Standing {
    pub fn good(&self) -> bool {
        self.slashed == 0 && self.pledges_broken == 0 && self.juries_missed == 0
    }
}

fn count(key: &[u8]) -> u32 {
    load::<u32>(key).unwrap_or(0)
}
fn next(key: &[u8]) -> u32 {
    let n = count(key);
    save(key, &(n + 1));
    n
}
fn pledge_key(id: u32) -> Vec<u8> {
    format!("pledge:{id}").into_bytes()
}
fn claim_key(id: u32) -> Vec<u8> {
    format!("pclaim:{id}").into_bytes()
}
fn case_key(id: u32) -> Vec<u8> {
    format!("case:{id}").into_bytes()
}
/// How many cases were ever opened.
pub(crate) fn cases_count() -> u32 {
    count(KEY_CASES)
}

/// Tests only: store a case as if the court had ruled it.
#[cfg(test)]
pub(crate) fn put_case(c: &Case) {
    save(&case_key(c.id), c);
    if count(KEY_CASES) <= c.id {
        save(KEY_CASES, &(c.id + 1));
    }
}
fn appeal_key(id: u32) -> Vec<u8> {
    format!("appeal:{id}").into_bytes()
}
/// [0] a case (or an appeal) for this job is open, [1] the court refunded it. Removed when a case is not upheld.
fn job_case_key(job: &str) -> Vec<u8> {
    format!("job_case:{job}").into_bytes()
}
/// How many cases this job had: at most `MAX_CASES_PER_JOB`.
fn job_tries_key(job: &str) -> Vec<u8> {
    format!("job_tries:{job}").into_bytes()
}
const MAX_CASES_PER_JOB: u8 = 2;
/// This member already took this job to court.
fn case_by_key(job: &str, claimant: &AccountId) -> Vec<u8> {
    format!("case_by:{job}:{claimant}").into_bytes()
}
/// Written by `update_receipt` when the agent mirrors the market's Disputed status; stays after the market's verdict.
pub(crate) fn disputed_key(job: &str) -> Vec<u8> {
    format!("disputed:{job}").into_bytes()
}
fn standing_key(a: &AccountId) -> Vec<u8> {
    format!("standing:{a}").into_bytes()
}
fn case(id: u32) -> Case {
    load(&case_key(id)).unwrap_or_else(|| env::panic_str("no such case"))
}
pub(crate) fn mark(a: &AccountId, f: impl FnOnce(&mut Standing)) {
    let mut s: Standing = load(&standing_key(a)).unwrap_or_default();
    let was = s.good();
    f(&mut s);
    save(&standing_key(a), &s);
    // 0.3.0: whoever guaranteed `a` answers for its fall (tanggung renteng)
    if was && !s.good() {
        crate::lending::guarantors_answer(a);
    }
}
pub(crate) fn standing_of(a: &AccountId) -> Standing {
    standing(a)
}
fn standing(a: &AccountId) -> Standing {
    load(&standing_key(a)).unwrap_or_default()
}
fn refund_kind(usdc: &AccountId, c: &Case) -> Value {
    near_sdk::serde_json::json!({ "Transfer": {
        "token_id": usdc, "receiver_id": c.refund_to, "amount": c.amount, "msg": null } })
}

#[near]
impl Koperasi {
    fn assert_member(&self) -> AccountId {
        let who = env::predecessor_account_id();
        require!(self.members.contains_key(&who), "only a member");
        who
    }

    // ---------- pledges ----------

    /// A member promises a service to the co-op, `units` times (1 to 20). Attach `PLEDGE_FEE` (0.01 NEAR) for its storage.
    #[payable]
    pub fn pledge(&mut self, what: String, units: u32) -> u32 {
        let issuer = self.assert_member();
        require!(env::attached_deposit() >= PLEDGE_FEE, "attach 0.01 NEAR for the pledge's storage");
        require!(!what.trim().is_empty() && what.len() <= MAX_WHAT, "what: 1 to 280 characters");
        require!((1..=MAX_UNITS).contains(&units), "units: 1 to 20");
        let id = next(KEY_PLEDGES);
        Event::PledgeMade { id, issuer: issuer.clone(), what: what.clone(), units }.emit();
        save(&pledge_key(id), &Pledge { id, issuer, what, units, called: 0, ts: U64(env::block_timestamp()) });
        id
    }

    /// Another member calls in one unit of a pledge. Attach `PLEDGE_FEE` (0.01 NEAR) for the claim's storage.
    #[payable]
    pub fn redeem_pledge(&mut self, id: u32) -> u32 {
        let holder = self.assert_member();
        require!(env::attached_deposit() >= PLEDGE_FEE, "attach 0.01 NEAR for the claim's storage");
        let mut p: Pledge = load(&pledge_key(id)).unwrap_or_else(|| env::panic_str("no such pledge"));
        require!(p.issuer != holder, "you cannot call in your own pledge");
        require!(p.called < p.units, "every unit of this pledge was called in");
        p.called += 1;
        save(&pledge_key(id), &p);
        let claim = next(KEY_CLAIMS);
        Event::PledgeRedeemed { id, claim, holder: holder.clone() }.emit();
        save(&claim_key(claim), &PledgeClaim { id: claim, pledge: id, holder, status: ClaimStatus::Open, ts: U64(env::block_timestamp()) });
        claim
    }

    /// The holder says the pledge was kept (any time), or broken (only once the issuer had 14 days).
    pub fn settle_pledge(&mut self, claim: u32, honored: bool) {
        let mut c: PledgeClaim = load(&claim_key(claim)).unwrap_or_else(|| env::panic_str("no such claim"));
        require!(env::predecessor_account_id() == c.holder, "only the member who called it in");
        require!(c.status == ClaimStatus::Open, "already settled");
        require!(honored || env::block_timestamp() >= c.ts.0 + PLEDGE_DUE_NS, "the issuer has 14 days to keep it");
        let issuer = load::<Pledge>(&pledge_key(c.pledge)).unwrap().issuer;
        c.status = if honored { ClaimStatus::Honored } else { ClaimStatus::Broken };
        save(&claim_key(claim), &c);
        if honored {
            mark(&issuer, |s| s.pledges_honored += 1);
        } else {
            mark(&issuer, |s| s.pledges_broken += 1);
        }
        Event::PledgeSettled { claim, issuer, honored }.emit();
    }

    pub fn get_pledges(&self, from: Option<u32>, limit: Option<u32>) -> Vec<Pledge> {
        let from = from.unwrap_or(0);
        (from..count(KEY_PLEDGES).min(from.saturating_add(limit.unwrap_or(50)))).filter_map(|i| load(&pledge_key(i))).collect()
    }

    pub fn get_pledge_claims(&self, from: Option<u32>, limit: Option<u32>) -> Vec<PledgeClaim> {
        let from = from.unwrap_or(0);
        (from..count(KEY_CLAIMS).min(from.saturating_add(limit.unwrap_or(50)))).filter_map(|i| load(&claim_key(i))).collect()
    }

    // ---------- standing ----------

    /// Kept and broken pledges, juries served and missed, slashes; `good` = none broken, missed or slashed.
    pub fn get_standing(&self, account_id: AccountId) -> (Standing, bool) {
        let s = standing(&account_id);
        // 0.2.9: a member behind on the dues the members voted is out of good standing too; 0.3.0: and a called guarantee
        let good = self.in_good_standing(&account_id);
        (s, good)
    }

    // ---------- the co-op court ----------

    /// A member in good standing, with a 0.5 NEAR bond: take a buyer's dispute of a job to the co-op and ask for
    /// `amount` USDC (at most its price) back to `refund_to`. Only a job the buyer disputed on the market and the market
    /// then paid to the agent (final: a paid receipt never changes, so the market cannot refund it as well). Three members in good standing are drawn at random (not the claimant, the refund's receiver or
    /// the steward); they rule within 3 days.
    #[payable]
    pub fn open_case(&mut self, job_id: String, refund_to: AccountId, amount: U128, reason: String) -> u32 {
        let claimant = self.assert_member();
        require!(self.in_good_standing(&claimant), "only a member in good standing");
        require!(env::attached_deposit() >= COURT_BOND, "attach the 0.5 NEAR court bond");
        require!(!reason.trim().is_empty() && reason.len() <= MAX_WHAT, "reason: 1 to 280 characters");
        let i = *self.receipt_index.get(&job_id).unwrap_or_else(|| env::panic_str("no receipt for this job"));
        let r = self.receipts.get(i).unwrap();
        require!(env::storage_read(&disputed_key(&job_id)).is_some(), "only a job the buyer disputed on the market");
        require!(r.status == ReceiptStatus::Paid, "only once the market ruled for the agent (paid)");
        require!(amount.0 > 0 && amount.0 <= r.price.0, "the refund is at most the job's price");
        match env::storage_read(&job_case_key(&job_id)).as_deref() {
            Some([1]) => env::panic_str("the court already refunded this job"),
            Some(_) => env::panic_str("a case for this job is open"),
            None => {}
        }
        require!(env::storage_read(&case_by_key(&job_id, &claimant)).is_none(), "you already took this job to court");
        let tries = env::storage_read(&job_tries_key(&job_id)).map_or(0, |b| b[0]);
        require!(tries < MAX_CASES_PER_JOB, "this job had its two cases");
        env::storage_write(&job_tries_key(&job_id), &[tries + 1]);
        let mut pool: Vec<AccountId> = self.members.keys()
            .filter(|m| **m != claimant && **m != refund_to && Some(*m) != self.steward.as_ref() && self.in_good_standing(m))
            .cloned()
            .collect();
        require!(pool.len() >= JURORS, "fewer than 3 members can sit on a jury");
        // ponytail: the block's random seed; a validator could bias it, a commit-reveal draw would not let them
        let seed = env::random_seed();
        let mut jurors = Vec::with_capacity(JURORS);
        if load::<bool>(KEY_JURY_BY_REPUTATION).unwrap_or(false) {
            // 0.3.7: drawn in proportion to reputation weight (at least the floor), without replacement
            let rep: std::collections::HashMap<AccountId, u128> = self.reputation_weights(false).into_iter().collect();
            // the square root flattens the weights: a heavier record draws more often, but no one member's weight can capture the jury
        let mut w: Vec<u128> = pool.iter().map(|m| isqrt(rep.get(m).copied().unwrap_or(0).max(JURY_WEIGHT_FLOOR))).collect();
            for k in 0..JURORS {
                let mut x = u64::from_le_bytes(seed[8 * k..8 * k + 8].try_into().unwrap()) as u128 % w.iter().sum::<u128>();
                let i = w.iter().position(|v| if x < *v { true } else { x -= *v; false }).unwrap();
                jurors.push(pool.swap_remove(i));
                w.swap_remove(i);
            }
        } else {
            for k in 0..JURORS {
                let x = u32::from_le_bytes(seed[4 * k..4 * k + 4].try_into().unwrap()) as usize % pool.len();
                jurors.push(pool.swap_remove(x));
            }
        }
        let id = next(KEY_CASES);
        env::storage_write(&job_case_key(&job_id), &[0]);
        env::storage_write(&case_by_key(&job_id, &claimant), &[1]);
        Event::CaseOpened { id, job_id: job_id.clone(), claimant: claimant.clone(), refund_to: refund_to.clone(), amount, jurors: jurors.clone() }.emit();
        save(&case_key(id), &Case {
            id, job_id, claimant, refund_to, amount, reason, jurors, votes: vec![],
            opened: U64(env::block_timestamp()), status: CaseStatus::Open, refund_proposal: None,
        });
        id
    }

    /// The claimant or the steward, while the case is open: a piece of evidence (a link or a hash and what it shows),
    /// at most 3 each. Attach `PLEDGE_FEE` (0.01 NEAR) for its storage.
    #[payable]
    pub fn add_evidence(&mut self, id: u32, what: String) {
        let c = case(id);
        let who = env::predecessor_account_id();
        require!(c.status == CaseStatus::Open, "the case is closed");
        require!(who == c.claimant || Some(&who) == self.steward.as_ref(), "only the claimant or the steward");
        require!(env::attached_deposit() >= PLEDGE_FEE, "attach 0.01 NEAR for the evidence's storage");
        require!(!what.trim().is_empty() && what.len() <= MAX_WHAT, "evidence: 1 to 280 characters");
        let key = format!("evidence:{id}").into_bytes();
        let mut all: Vec<(AccountId, String, U64)> = load(&key).unwrap_or_default();
        require!(all.iter().filter(|(a, _, _)| *a == who).count() < MAX_EVIDENCE, "at most 3 pieces of evidence each");
        all.push((who.clone(), what, U64(env::block_timestamp())));
        save(&key, &all);
        Event::EvidenceFiled { id, by: who }.emit();
    }

    /// What each side filed in a case: (who, what, when).
    pub fn get_evidence(&self, id: u32) -> Vec<(AccountId, String, U64)> {
        load(&format!("evidence:{id}").into_bytes()).unwrap_or_default()
    }

    /// A juror rules once; two matching rulings close the case.
    pub fn rule_case(&mut self, id: u32, uphold: bool) {
        let mut c = case(id);
        let who = env::predecessor_account_id();
        require!(c.status == CaseStatus::Open, "the case is closed");
        require!(env::block_timestamp() < c.opened.0 + COURT_DAYS_NS, "the 3 days are over: anyone can close the case");
        require!(c.jurors.contains(&who), "only a juror drawn for this case");
        require!(c.votes.iter().all(|(j, _)| *j != who), "you already ruled");
        c.votes.push((who.clone(), uphold));
        Event::CaseVoted { id, juror: who, uphold }.emit();
        if c.votes.iter().filter(|(_, v)| *v == uphold).count() * 2 > JURORS {
            self.close(c, uphold);
        } else {
            save(&case_key(id), &c);
        }
    }

    /// Anyone, after 3 days: two matching rulings were never cast, so the case is dismissed (only two upholds refund).
    pub fn close_case(&mut self, id: u32) {
        let c = case(id);
        require!(c.status == CaseStatus::Open, "the case is closed");
        require!(env::block_timestamp() >= c.opened.0 + COURT_DAYS_NS, "the jurors have 3 days");
        self.close(c, false);
    }

    fn close(&mut self, mut c: Case, upheld: bool) {
        c.status = if upheld { CaseStatus::Upheld } else { CaseStatus::Dismissed };
        let missed: Vec<AccountId> = c.jurors.iter().filter(|j| c.votes.iter().all(|(v, _)| v != *j)).cloned().collect();
        // two matching rulings: a verdict. Its jurors earn points; a juror who let 3 days pass is marked
        let late = env::block_timestamp() >= c.opened.0 + COURT_DAYS_NS;
        let verdict = c.votes.iter().filter(|(_, v)| *v == upheld).count() * 2 > JURORS;
        for (j, _) in &c.votes {
            mark(j, |s| s.juries_served += 1);
            if verdict && self.members.contains_key(j) {
                self.add_points(j, JUROR_POINTS);
            }
        }
        if late {
            for j in &missed {
                mark(j, |s| s.juries_missed += 1);
            }
        }
        Event::CaseClosed { id: c.id, upheld, missed: if late { missed } else { vec![] } }.emit();
        save(&case_key(c.id), &c);
        if upheld {
            env::storage_write(&job_case_key(&c.job_id), &[1]);
        } else {
            env::storage_remove(&job_case_key(&c.job_id));
        }
        if upheld && crate::lending::risk_fund() >= c.amount.0 {
            // 0.3.2: the risk fund holds enough: the buyer is refunded at once, no proposal needed
            crate::meeting::strike(c.id);
            let _ = Promise::new(c.claimant.clone()).transfer(COURT_BOND);
            crate::lending::take_risk(c.amount.0);
            Event::RefundFromRiskFund { id: c.id, amount: c.amount }.emit();
            let _ = ext_ft::ext(self.usdc_id.clone())
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(Gas::from_tgas(15))
                .ft_transfer(c.refund_to.clone(), c.amount, Some(format!("Koperasi court case #{}: refund from the risk fund", c.id)))
                .then(Self::ext(env::current_account_id()).with_static_gas(crate::lending::GAS_RISK_REFUND).on_risk_refund(c.id, c.amount));
        } else if upheld {
            crate::meeting::strike(c.id); // a case upheld against the agent's job
            let _ = Promise::new(c.claimant.clone()).transfer(COURT_BOND);
            let description = format!("Koperasi court case #{}: refund {} USDC (6 decimals: {}) to {} for job {}, upheld by the jury",
                c.id, c.amount.0 as f64 / 1e6, c.amount.0, c.refund_to, c.job_id);
            let _ = ext_dao_proposals::ext(self.dao_id.clone())
                .with_attached_deposit(PAYOUT_BOND)
                .with_static_gas(GAS_PROPOSE)
                .add_proposal(near_sdk::serde_json::json!({ "description": description, "kind": refund_kind(&self.usdc_id, &c) }))
                .then(Self::ext(env::current_account_id()).with_static_gas(GAS_FILED).on_refund_filed(c.id));
        } else if c.votes.is_empty() {
            let _ = Promise::new(c.claimant.clone()).transfer(COURT_BOND);
        } else {
            let _ = Promise::new(self.dao_id.clone()).transfer(COURT_BOND);
        }
    }

    /// Callback: the DAO filed the refund; the contract approves it with its `tasks` role (the jury already decided).
    /// If filing failed, the members can still pay it by hand: the case stays Upheld with no proposal.
    #[private]
    pub fn on_refund_filed(&mut self, id: u32, #[callback_result] pid: Result<u64, PromiseError>) -> PromiseOrValue<()> {
        let mut c = case(id);
        let Ok(pid) = pid else {
            log!("case #{}: the refund proposal was not filed; the members can pay it by vote", id);
            return PromiseOrValue::Value(());
        };
        c.refund_proposal = Some(pid);
        save(&case_key(id), &c);
        Event::RefundFiled { id, proposal_id: pid }.emit();
        PromiseOrValue::Promise(ext_dao_proposals::ext(self.dao_id.clone()).with_static_gas(GAS_ACT)
            .act_proposal(pid, "VoteApprove".into(), refund_kind(&self.usdc_id, &c), None))
    }

    // ---------- appeal to the assembly ----------

    /// The claimant of a dismissed case, with a 1 NEAR bond, within 7 days after the jury's 3 days: take it to every
    /// member. A co-op of a handful of members has no second, larger jury to draw (the first one, the claimant, the
    /// receiver and the steward are already out), so the appeal goes where a koperasi's last word is, the members'
    /// meeting: the contract files the refund as a DAO proposal and does not vote on it; one member, one vote decides.
    /// Only a case a juror ruled on (a case nobody ruled on already gave the bond back and leaves the second case open).
    #[payable]
    pub fn appeal_case(&mut self, id: u32) -> Promise {
        let c = case(id);
        require!(env::predecessor_account_id() == c.claimant, "only the member who opened the case");
        require!(c.status == CaseStatus::Dismissed, "only a dismissed case");
        require!(!c.votes.is_empty(), "no juror ruled: open the job's second case instead");
        require!(env::attached_deposit() >= APPEAL_BOND, "attach the 1 NEAR appeal bond");
        require!(env::block_timestamp() < c.opened.0 + COURT_DAYS_NS + APPEAL_DAYS_NS, "the 7 days to appeal are over");
        require!(load::<Appeal>(&appeal_key(id)).is_none(), "this case was appealed");
        require!(env::storage_read(&job_case_key(&c.job_id)).is_none(), "another case or appeal for this job is open, or it was refunded");
        env::storage_write(&job_case_key(&c.job_id), &[0]);
        save(&appeal_key(id), &Appeal { case: id, proposal: None, status: CaseStatus::Open, opened: U64(env::block_timestamp()) });
        let description = format!("Koperasi court case #{} on appeal to the members: refund {} USDC (6 decimals: {}) to {} for job {}. \
            The jury dismissed it; {} appeals. Approve to refund, reject to keep the jury's ruling. Reason: {}",
            id, c.amount.0 as f64 / 1e6, c.amount.0, c.refund_to, c.job_id, c.claimant, c.reason);
        ext_dao_proposals::ext(self.dao_id.clone())
            .with_attached_deposit(PAYOUT_BOND)
            .with_static_gas(GAS_PROPOSE)
            .add_proposal(near_sdk::serde_json::json!({ "description": description, "kind": refund_kind(&self.usdc_id, &c) }))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_FILED).on_appeal_filed(id))
    }

    /// Callback: the appeal's proposal is on the DAO, for the members to vote. If it could not be filed, the appeal is
    /// withdrawn and the bond goes back.
    #[private]
    pub fn on_appeal_filed(&mut self, id: u32, #[callback_result] pid: Result<u64, PromiseError>) {
        let mut a: Appeal = load(&appeal_key(id)).unwrap();
        let c = case(id);
        match pid {
            Ok(pid) => {
                a.proposal = Some(pid);
                save(&appeal_key(id), &a);
                Event::CaseAppealed { id, proposal_id: pid, claimant: c.claimant }.emit();
            }
            Err(_) => {
                env::storage_remove(&appeal_key(id));
                env::storage_remove(&job_case_key(&c.job_id));
                let _ = Promise::new(c.claimant).transfer(APPEAL_BOND);
                log!("case #{}: the appeal could not be filed; bond returned", id);
            }
        }
    }

    /// Anyone, once the members voted: read the appeal's DAO proposal and settle it. Approved (the DAO paid the refund):
    /// the bond goes back. Rejected, removed or expired: the jury's ruling stands and the bond goes to the DAO.
    pub fn settle_appeal(&mut self, id: u32) -> Promise {
        let a: Appeal = load(&appeal_key(id)).unwrap_or_else(|| env::panic_str("this case was not appealed"));
        require!(a.status == CaseStatus::Open, "the appeal is settled");
        let pid = a.proposal.unwrap_or_else(|| env::panic_str("the appeal's proposal is not filed yet"));
        ext_dao_proposals::ext(self.dao_id.clone())
            .with_static_gas(GAS_FILED)
            .get_proposal(pid)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_FILED).on_appeal_read(id))
    }

    /// Callback of `settle_appeal`.
    // ponytail: an Approved transfer that bounced (Sputnik leaves it Approved) counts as refunded, as settle_task
    // takes a payout the members approved by hand; the claimant would then ask the members to pay it again
    #[private]
    pub fn on_appeal_read(&mut self, id: u32, #[callback_result] p: Result<Value, PromiseError>) {
        let mut a: Appeal = load(&appeal_key(id)).unwrap();
        require!(a.status == CaseStatus::Open, "the appeal is settled");
        let status = p.ok().and_then(|p| p["status"].as_str().map(String::from)).unwrap_or_default();
        let c = case(id);
        let upheld = match status.as_str() {
            "Approved" => true,
            "Rejected" | "Removed" | "Expired" | "Failed" | "Moved" => false,
            _ => env::panic_str("the members have not decided the appeal yet"),
        };
        a.status = if upheld { CaseStatus::Upheld } else { CaseStatus::Dismissed };
        save(&appeal_key(id), &a);
        if upheld {
            crate::meeting::strike(c.id); // upheld by the members on appeal
            env::storage_write(&job_case_key(&c.job_id), &[1]);
            let _ = Promise::new(c.claimant.clone()).transfer(APPEAL_BOND);
        } else {
            env::storage_remove(&job_case_key(&c.job_id));
            let _ = Promise::new(self.dao_id.clone()).transfer(APPEAL_BOND);
        }
        Event::AppealSettled { id, upheld }.emit();
    }

    /// The appeal of a case, if there was one.
    /// DAO only: draw jurors in proportion to their reputation weight (`true`) or uniformly (`false`, the default).
    pub fn set_jury_by_reputation(&mut self, on: bool) {
        self.assert_dao();
        save(KEY_JURY_BY_REPUTATION, &on);
        Event::JuryModeSet { by_reputation: on }.emit();
    }

    pub fn get_jury_by_reputation(&self) -> bool {
        load(KEY_JURY_BY_REPUTATION).unwrap_or(false)
    }

    pub fn get_appeal(&self, id: u32) -> Option<Appeal> {
        load(&appeal_key(id))
    }

    pub fn get_cases(&self, from: Option<u32>, limit: Option<u32>) -> Vec<Case> {
        let from = from.unwrap_or(0);
        (from..count(KEY_CASES).min(from.saturating_add(limit.unwrap_or(50)))).filter_map(|i| load(&case_key(i))).collect()
    }

    // ---------- the steward's term ----------

    /// DAO only: a steward serves `days` from their appointment (0: no limit). Applies to the current steward too.
    pub fn set_steward_term(&mut self, days: u32) {
        self.assert_dao();
        save(KEY_STEWARD_TERM, &days);
        Event::StewardTermSet { days }.emit();
    }

    /// (term in days, when the current steward's term ends in ns), if the members set a term and a steward serves.
    pub fn get_steward_term(&self) -> (u32, Option<U64>) {
        let days = load::<u32>(KEY_STEWARD_TERM).unwrap_or(0);
        let from = env::storage_read(KEY_STEWARD_FROM).map(|b| u64::from_le_bytes(b.try_into().unwrap_or([u8::MAX; 8])));
        let ends = match (days, from, &self.steward) {
            (1.., Some(f), Some(_)) => Some(U64(f.saturating_add(days as u64 * DAY_NS))),
            _ => None,
        };
        (days, ends)
    }

    /// Anyone, once the term ran out: the role is empty and the bond is settled as on a replacement. A steward who still
    /// holds earnings of jobs paid in the last days gets the same 7 days as `slash_overdue` gives, after the term, to pass
    /// them on: ending the term at once would slash an honest steward for a job paid an hour before.
    pub fn end_steward_term(&mut self) {
        let (_, ends) = self.get_steward_term();
        let ends = ends.unwrap_or_else(|| env::panic_str("no steward with a term"));
        let now = env::block_timestamp();
        require!(now >= ends.0, "the steward's term has not ended");
        require!(now >= ends.0.saturating_add(STEWARD_GRACE_NS) || self.steward_unpaid(u64::MAX) == 0, // every job paid so far
            "the steward has 7 days after the term to pass on the earnings of recent jobs");
        let old = self.steward.clone().unwrap();
        self.replace_steward(None);
        Event::StewardTermEnded { steward: old }.emit();
    }
}

/// Integer square root (floor), for flattening jury weights.
fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}
