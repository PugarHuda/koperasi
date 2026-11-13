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
//! State lives under its own storage keys, so the upgrade needs no state migration.

use crate::tasks::{load, save};
use crate::*;

const KEY_AGENT_SHARE: &[u8] = b"agent_share_bps";
const KEY_AGENT_SHU: &[u8] = b"agent_shu_total";
const KEY_FEDERATION: &[u8] = b"federation";
const KEY_FED_RULES: &[u8] = b"federation_rules";
const GAS_NOTE: Gas = Gas::from_tgas(5);

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
                out.push((a.clone(), w as u128));
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
            standing_bps: if suspended { 0 } else { (10_000u32 >> strikes.min(14)) as u16 },
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

    // ---------- the reputation dividend's weights ----------

    /// Each member's reputation weight if a dividend were paid now (good standing, weight > 0).
    pub fn get_reputation_weights(&self) -> Vec<(AccountId, U128)> {
        self.reputation_weights(false).into_iter().map(|(a, w)| (a, U128(w))).collect()
    }
}
