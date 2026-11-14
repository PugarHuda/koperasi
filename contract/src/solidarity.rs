//! Contract 0.3.3: what binds the co-op to its agent and to its sister co-ops.
//!
//! - **The agent as a member**: the members vote it a share of every profit share (`set_agent_share`, out of the
//!   reserve part). It goes into the risk fund the agent's mistakes are refunded from (the agent's own savings: its key
//!   can only record receipts, so it cannot hold money), halved for each live strike and nothing while suspended.
//! - **The federation's rules bind the code**: a co-op names the federation it belongs to (`set_federation`, by its own
//!   vote); only that federation's DAO, by a resolution its member co-ops voted, sets the loan ceiling
//!   (`set_federation_rules`). `set_loan_rule` and `request_loan` refuse anything above it. Leaving is a vote too.
//! - **A late loan is told to the sister co-ops**: `call_loan_late` notes the borrower at every co-op the members
//!   recognise; there (if it recognises this co-op back) the borrower's credit is 0 and no loan is lent, until the loan
//!   is repaid here, which clears the note the same way.
//! - **A reputation dividend that decays**: a member's weight is the work added to their record since the last
//!   dividend plus half of their previous weight, so it is never capped and recent work counts most.
//!
//! - **Quality, not only quantity** (0.3.4): each member's reputation weight is multiplied by how their judgments
//!   held up in the co-op court: a juror who ruled with the case's outcome, a claimant whose case was upheld, count for
//!   them; a juror against the outcome, a claimant whose case was dismissed, against. Factor (good + 2) / (bad + 2).
//! - **Agents that must run in a TEE** (0.3.4, the Shade Agent pattern): the members name a TEE registry
//!   (`set_tee_registry`, its own contract, `tee-registry/`) that verifies an Intel TDX attestation on-chain and then
//!   calls `note_attested`. An agent the members mark `set_agent_tee(account, true)` records receipts only while its
//!   attestation holds: the contract refuses them from that key otherwise, whoever holds it.
//!
//! - **Quality from tasks** (0.3.5): the same factor also counts each task a member delivered and was paid for, and
//!   against them each task they took and handed back and each payout of theirs another member vetoed. Counted as it
//!   happens (`quality:<account>`), from the upgrade on: nothing before it is counted.
//! - **A referral board between federation co-ops** (0.3.5): the founding agent (directly, or anyone with its signature,
//!   as for `agent_propose_bylaws`) posts a job it passes to a sister co-op (`post_referral`); the last 200 are kept.
//!
//! State lives under its own storage keys, so the upgrade needs no state migration.

use crate::tasks::{load, save};
use crate::*;

const KEY_REFERRAL_COUNT: &[u8] = b"referral_count";
/// Referral signatures consumed so far: only ever goes up (separate from the by-laws proposals' nonce).
const KEY_REFERRAL_NONCE: &[u8] = b"referral_nonce";
/// Referrals kept: older ones are removed as new ones are posted.
pub const MAX_REFERRALS: u32 = 200;
const MAX_REFERRAL_REASON: usize = 280;

fn referral_key(id: u32) -> Vec<u8> {
    format!("referral:{id}").into_bytes()
}
fn quality_key(a: &AccountId) -> Vec<u8> {
    format!("quality:{a}").into_bytes()
}

/// A member's task record for the reputation factor (0.3.5).
#[near(serializers = [borsh, json])]
#[derive(Clone, Default, PartialEq, Debug)]
pub struct TaskQuality {
    /// tasks delivered and paid
    pub paid: u32,
    /// tasks taken and handed back
    pub handed_back: u32,
    /// payouts on trust another member vetoed
    pub vetoed: u32,
}

/// Called from tasks.rs where a task is paid, handed back or vetoed.
pub(crate) fn note_task(a: &AccountId, f: impl FnOnce(&mut TaskQuality)) {
    let mut q: TaskQuality = load(&quality_key(a)).unwrap_or_default();
    f(&mut q);
    save(&quality_key(a), &q);
}

/// What the agent signs to pass a job to a sister co-op (bound to this contract and to the referral nonce).
pub fn referral_message(contract: &AccountId, nonce: u32, job_id: &str, to_coop: &AccountId, budget_usdc: u128, reason: &str) -> String {
    format!("koperasi-agent-referral/1 {contract} #{nonce} {job_id} {to_coop} {budget_usdc}
{reason}")
}

/// A job the agent passed to a sister co-op.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Referral {
    pub id: u32,
    pub job_id: String,
    pub to_coop: AccountId,
    pub budget_usdc: U128,
    pub reason: String,
    pub at: U64,
}

const KEY_AGENT_SHARE: &[u8] = b"agent_share_bps";
const KEY_AGENT_SHU: &[u8] = b"agent_shu_total";
const KEY_FEDERATION: &[u8] = b"federation";
const KEY_FED_RULES: &[u8] = b"federation_rules";
const GAS_NOTE: Gas = Gas::from_tgas(5);
const KEY_TEE_REGISTRY: &[u8] = b"tee_registry";

fn attested_key(a: &AccountId) -> Vec<u8> {
    format!("attested:{a}").into_bytes()
}
fn tee_revoked_key(a: &AccountId) -> Vec<u8> {
    format!("tee_revoked:{a}").into_bytes()
}
fn tee_required_key(a: &AccountId) -> Vec<u8> {
    format!("tee_required:{a}").into_bytes()
}

/// Called from `record_receipt`/`update_receipt`: an agent the members marked TEE-only acts only while attested.
pub(crate) fn assert_tee_ok(a: &AccountId) {
    if env::storage_has_key(&tee_required_key(a)) {
        let until = load::<(U64, String)>(&attested_key(a)).map_or(0, |(u, _)| u.0);
        require!(until > env::block_timestamp(), "this agent must run in an attested TEE: register its attestation first");
    }
}

/// (judgments that held, judgments that did not) in the co-op court: as juror against the outcome, as claimant.
fn court_record(cases: &[crate::commons::Case], a: &AccountId) -> (u32, u32) {
    let (mut good, mut bad) = (0, 0);
    for c in cases {
        let upheld = match c.status {
            crate::commons::CaseStatus::Upheld => true,
            crate::commons::CaseStatus::Dismissed => false,
            crate::commons::CaseStatus::Open => continue,
        };
        if let Some((_, v)) = c.votes.iter().find(|(j, _)| j == a) {
            if *v == upheld { good += 1 } else { bad += 1 }
        }
        if c.claimant == *a {
            if upheld { good += 1 } else { bad += 1 }
        }
    }
    (good, bad)
}

fn late_key(a: &AccountId) -> Vec<u8> {
    format!("late_elsewhere:{a}").into_bytes()
}
fn rep_key(a: &AccountId) -> Vec<u8> {
    format!("rep:{a}").into_bytes()
}

/// A loan ceiling a federation set for its member co-ops.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct FederationRules {
    pub max_rate_bps: u16,
    pub max_term_days: u32,
    pub set_at: U64,
}

/// What the co-op knows of its agent as a member.
#[near(serializers = [borsh, json])]
pub struct AgentMember {
    pub share_bps: u16,
    /// what the agent's share would be scaled by now: 1/2 per live strike, 0 suspended (out of 10_000)
    pub standing_bps: u16,
    pub strikes: u32,
    pub suspended: bool,
    /// USDC its shares put into the risk fund, all time
    pub shu_total: U128,
}

#[ext_contract(ext_sister)]
#[allow(dead_code)]
trait Sister {
    fn note_late_elsewhere(&mut self, account_id: AccountId, late: bool);
}

pub(crate) fn fed_rules() -> Option<FederationRules> {
    load::<AccountId>(KEY_FEDERATION).and(load(KEY_FED_RULES))
}

/// Within the federation's ceiling (or no federation)?
pub(crate) fn within_federation(rate_bps: u16, term_days: u32) -> bool {
    fed_rules().is_none_or(|r| rate_bps <= r.max_rate_bps && term_days <= r.max_term_days)
}

/// The sister co-ops that noted this account's loan late there (each lifts only its own note).
fn late_notes(a: &AccountId) -> Vec<AccountId> {
    load(&late_key(a)).unwrap_or_default()
}

/// A sister co-op that noted this account's loan late, if any.
pub(crate) fn late_elsewhere(a: &AccountId) -> Option<AccountId> {
    late_notes(a).into_iter().next()
}

/// Tell every recognised sister co-op that `a`'s loan here is late (or settled).
pub(crate) fn tell_sisters(a: &AccountId, late: bool) {
    for coop in load::<Vec<AccountId>>(b"sister_coops").unwrap_or_default() {
        let _ = ext_sister::ext(coop).with_static_gas(GAS_NOTE).note_late_elsewhere(a.clone(), late);
    }
}

impl Koperasi {
    /// The agent's part of a profit share of `amount`, out of `reserve`: into the risk fund. Returns what is left.
    pub(crate) fn pay_agent_share(&mut self, amount: u128, reserve: u128) -> u128 {
        let m = self.get_agent_member();
        let x = (amount * m.share_bps as u128 / 10_000 * m.standing_bps as u128 / 10_000).min(reserve);
        if x == 0 {
            return reserve;
        }
        crate::lending::add_risk(x);
        save(KEY_AGENT_SHU, &U128(load::<U128>(KEY_AGENT_SHU).map_or(0, |t| t.0) + x));
        Event::AgentShare { amount: U128(x), standing_bps: m.standing_bps }.emit();
        reserve - x
    }

    /// Each member's reputation weight now (good standing only): new work since the last dividend + half the last weight.
    /// With `commit`, the weights are kept as the new baseline (a dividend was paid by them).
    pub(crate) fn reputation_weights(&self, commit: bool) -> Vec<(AccountId, u128)> {
        let mut out = vec![];
        // the court record of the last 200 cases: recent conduct, like the decay, and bounded gas for any co-op
        let n = crate::commons::cases_count();
        let cases = self.get_cases(Some(n.saturating_sub(200)), Some(200));
        for a in self.members.keys() {
            let done = self.get_record(a.clone()).map_or(0, |r| r.done);
            let s = crate::commons::standing_of(a);
            let total = done + s.pledges_honored + s.juries_served;
            let (last, carried): (u32, u32) = load(&rep_key(a)).unwrap_or((0, 0));
            let w = total.saturating_sub(last) + carried / 2;
            if commit {
                save(&rep_key(a), &(total, w));
            }
            if self.in_good_standing(a) && w > 0 {
                // 0.3.4: weighted by how the member's judgments held up in court (x100 to keep the fraction)
                // 0.3.5: and by their tasks: paid for them; handed back or vetoed against them
                let (court_good, court_bad) = court_record(&cases, a);
                let q: TaskQuality = load(&quality_key(a)).unwrap_or_default();
                let good = court_good as u128 + q.paid.min(10) as u128; // ponytail: a cap, not weighting by amount or distinct posters
                let bad = court_bad as u128 + q.handed_back as u128 + q.vetoed as u128;
                out.push((a.clone(), w as u128 * 100 * (good + 2) / (bad + 2)));
            }
        }
        out
    }
}

#[near]
impl Koperasi {
    // ---------- the agent as a member ----------

    /// DAO only: the agent's share of every profit share (bps, out of the reserve part), paid into the risk fund.
    pub fn set_agent_share(&mut self, bps: u16) {
        self.assert_dao();
        require!(bps as u32 <= self.share_rule.reserve_bps as u32, "it comes out of the reserve: at most its bps");
        save(KEY_AGENT_SHARE, &bps);
        Event::AgentShareSet { bps }.emit();
    }

    pub fn get_agent_member(&self) -> AgentMember {
        let strikes = crate::meeting::live_strikes().len() as u32;
        let suspended = crate::meeting::agent_suspended();
        AgentMember {
            share_bps: load(KEY_AGENT_SHARE).unwrap_or(0),
            // 0.3.6: and by the recovery ramp after an approved plan (25% back up to 100%)
            standing_bps: if suspended { 0 } else { ((10_000u64 >> strikes.min(14)) * crate::recovery::ramp_bps() / 10_000) as u16 },
            strikes,
            suspended,
            shu_total: load(KEY_AGENT_SHU).unwrap_or(U128(0)),
        }
    }

    // ---------- the federation's rules ----------

    /// DAO only: the federation (a Sputnik DAO whose members are co-ops) whose rules bind this co-op; None leaves it.
    pub fn set_federation(&mut self, federation: Option<AccountId>) {
        self.assert_dao();
        match &federation {
            Some(f) => save(KEY_FEDERATION, f),
            None => {
                env::storage_remove(KEY_FEDERATION);
                env::storage_remove(KEY_FED_RULES);
            }
        }
        Event::FederationSet { federation }.emit();
    }

    /// The federation's DAO only, by a resolution: the loan ceiling for its member co-ops.
    pub fn set_federation_rules(&mut self, max_rate_bps: u16, max_term_days: u32) {
        let fed: AccountId = load(KEY_FEDERATION).unwrap_or_else(|| env::panic_str("this co-op belongs to no federation"));
        require!(env::predecessor_account_id() == fed, "only the federation's DAO");
        require!(max_rate_bps <= 5_000 && (1..=365).contains(&max_term_days), "rate at most 50%, term 1 to 365 days");
        save(KEY_FED_RULES, &FederationRules { max_rate_bps, max_term_days, set_at: U64(env::block_timestamp()) });
        Event::FederationRulesSet { max_rate_bps, max_term_days }.emit();
    }

    /// (the federation, its rules) if this co-op belongs to one.
    pub fn get_federation(&self) -> Option<(AccountId, Option<FederationRules>)> {
        load::<AccountId>(KEY_FEDERATION).map(|f| (f, load(KEY_FED_RULES)))
    }

    // ---------- late loans told to sister co-ops ----------

    /// Called by a sister co-op's contract (one this co-op recognises): `account_id`'s loan there is late, or settled.
    pub fn note_late_elsewhere(&mut self, account_id: AccountId, late: bool) {
        let coop = env::predecessor_account_id();
        require!(self.get_sister_coops().contains(&coop), "only a sister co-op the members recognise");
        let mut notes = late_notes(&account_id);
        notes.retain(|c| *c != coop);
        if late {
            notes.push(coop.clone());
        }
        if notes.is_empty() {
            env::storage_remove(&late_key(&account_id));
        } else {
            save(&late_key(&account_id), &notes);
        }
        Event::LateElsewhere { account_id, coop, late }.emit();
    }

    /// The sister co-ops where `account_id` has a late loan.
    pub fn get_late_elsewhere(&self, account_id: AccountId) -> Vec<AccountId> {
        late_notes(&account_id)
    }

    /// DAO only: clear a sister's note by hand (a sister that left, or a note the members judged settled).
    pub fn clear_late_elsewhere(&mut self, account_id: AccountId) {
        self.assert_dao();
        env::storage_remove(&late_key(&account_id));
        Event::LateElsewhere { account_id, coop: env::current_account_id(), late: false }.emit();
    }

    // ---------- agents in a TEE (0.3.4) ----------

    /// DAO only: the TEE registry whose attestations count here (None: none).
    pub fn set_tee_registry(&mut self, registry: Option<AccountId>) {
        self.assert_dao();
        match &registry {
            Some(r) => save(KEY_TEE_REGISTRY, r),
            None => {
                env::storage_remove(KEY_TEE_REGISTRY);
            }
        };
        Event::TeeRegistrySet { registry }.emit();
    }

    /// DAO only: whether an agent may record receipts only while attested in a TEE.
    pub fn set_agent_tee(&mut self, account_id: AccountId, required: bool) {
        self.assert_dao();
        if required {
            save(&tee_required_key(&account_id), &true);
            env::storage_remove(&tee_revoked_key(&account_id)); // marking it again is the members' way back in
        } else {
            env::storage_remove(&tee_required_key(&account_id));
        }
        Event::AgentTeeSet { account_id, required }.emit();
    }

    /// The TEE registry only: `account_id`'s attestation was verified on-chain and holds until `until`.
    pub fn note_attested(&mut self, account_id: AccountId, until: U64, compose_hash: String) {
        let reg: Option<AccountId> = load(KEY_TEE_REGISTRY);
        require!(reg.as_ref() == Some(&env::predecessor_account_id()), "only the TEE registry the members named");
        require!(compose_hash.len() <= 64, "compose hash: 64 hex");
        require!(!env::storage_has_key(&tee_revoked_key(&account_id)), "the members revoked this agent's attestation");
        save(&attested_key(&account_id), &(until, compose_hash.clone()));
        Event::AgentAttested { account_id, until, compose_hash }.emit();
    }

    /// DAO only: drop an agent's attestation at once (code or a machine the members no longer trust).
    pub fn revoke_attestation(&mut self, account_id: AccountId) {
        self.assert_dao();
        env::storage_remove(&attested_key(&account_id));
        save(&tee_revoked_key(&account_id), &true); // it stays out until the members mark it again (set_agent_tee)
        Event::AgentAttested { account_id, until: U64(0), compose_hash: String::new() }.emit();
    }

    /// (TEE-only?, attested until, compose hash) for an agent; and the registry.
    pub fn get_agent_tee(&self, account_id: AccountId) -> (bool, Option<(U64, String)>, Option<AccountId>) {
        (env::storage_has_key(&tee_required_key(&account_id)), load(&attested_key(&account_id)), load(KEY_TEE_REGISTRY))
    }

    // ---------- the reputation dividend's weights ----------

    /// Each member's reputation weight if a dividend were paid now (good standing, weight > 0).
    pub fn get_reputation_weights(&self) -> Vec<(AccountId, U128)> {
        self.reputation_weights(false).into_iter().map(|(a, w)| (a, U128(w))).collect()
    }

    /// An account's task record for the reputation factor (counted from 0.3.5 on).
    pub fn get_task_quality(&self, account_id: AccountId) -> TaskQuality {
        load(&quality_key(&account_id)).unwrap_or_default()
    }

    // ---------- the referral board (0.3.5) ----------

    /// The founding agent passes a job to a sister co-op: directly, or anyone submitting the agent's ed25519 signature
    /// (base64) of `get_referral_message(...)`. Returns the referral's id.
    pub fn post_referral(&mut self, job_id: String, to_coop: AccountId, budget_usdc: U128, reason: String, signature: Option<String>) -> u32 {
        require!(!self.paused, "koperasi is paused");
        // the same gates as the agent's receipts: not while the court has it suspended, nor a TEE-only agent unattested
        require!(!crate::meeting::agent_suspended(), "the agent is suspended");
        assert_tee_ok(&self.agent_id);
        let nonce: u32 = load(KEY_REFERRAL_NONCE).unwrap_or(0);
        crate::meeting::assert_agent_or_signed(&self.agent_id, signature.as_deref(),
            || referral_message(&env::current_account_id(), nonce, &job_id, &to_coop, budget_usdc.0, &reason));
        // fixed fields first, separated by spaces, the free text last: the signed text reads one way only
        require!(!job_id.is_empty() && job_id.len() <= 128 && job_id.bytes().all(|b| b.is_ascii_graphic()), "job_id: 1 to 128 characters, no spaces");
        require!(!reason.trim().is_empty() && reason.len() <= MAX_REFERRAL_REASON, "reason: 1 to 280 characters");
        require!(self.get_sister_coops().contains(&to_coop), "not a sister co-op the members recognise");
        save(KEY_REFERRAL_NONCE, &(nonce + 1)); // a signature counts once
        let id: u32 = load(KEY_REFERRAL_COUNT).unwrap_or(0);
        save(KEY_REFERRAL_COUNT, &(id + 1));
        if id >= MAX_REFERRALS {
            env::storage_remove(&referral_key(id - MAX_REFERRALS));
        }
        save(&referral_key(id), &Referral { id, job_id: job_id.clone(), to_coop: to_coop.clone(), budget_usdc, reason, at: U64(env::block_timestamp()) });
        Event::JobReferred { id, job_id, to_coop, budget_usdc }.emit();
        id
    }

    /// The exact text the agent signs for its next `post_referral`.
    pub fn get_referral_message(&self, job_id: String, to_coop: AccountId, budget_usdc: U128, reason: String) -> String {
        referral_message(&env::current_account_id(), load(KEY_REFERRAL_NONCE).unwrap_or(0), &job_id, &to_coop, budget_usdc.0, &reason)
    }

    /// Referrals still kept (the last 200), oldest first from `from`; at most `limit` (50 by default, 200 at most).
    pub fn get_referrals(&self, from: Option<u32>, limit: Option<u32>) -> Vec<Referral> {
        let n: u32 = load(KEY_REFERRAL_COUNT).unwrap_or(0);
        let from = from.unwrap_or(0).max(n.saturating_sub(MAX_REFERRALS));
        let to = n.min(from.saturating_add(limit.unwrap_or(50).min(MAX_REFERRALS)));
        (from..to).filter_map(|i| load(&referral_key(i))).collect()
    }
}
