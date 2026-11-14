//! Contract 0.3.6: from strike to recovery.
//!
//! - While the court has the agent suspended, the agent (or the steward on its behalf) files a recovery plan
//!   (`propose_recovery`: where it is and its sha256). Only the members, by a DAO vote, approve it (`approve_recovery`):
//!   that reinstates the agent (as `reinstate_agent` does) and starts a ramp: the agent's standing in every profit share
//!   climbs linearly from 25% of its normal (strike-scaled) value back to all of it over `recovery_days` (30 until the
//!   members set it). A new suspension during the ramp cancels it.
//! - `reinstate_agent` still works without a plan: the members may reinstate outright, at full standing.
//!
//! State lives under its own storage keys, so the upgrade needs no state migration.

use crate::tasks::{load, save, DAY_NS};
use crate::*;

const KEY_RECOVERY: &[u8] = b"agent_recovery";
const KEY_RECOVERY_DAYS: &[u8] = b"recovery_days";
pub const RECOVERY_DAYS: u32 = 30;
/// Where the ramp starts, out of 10_000.
pub const RAMP_FROM_BPS: u64 = 2_500;

/// The agent's recovery plan and, once the members approved it, its ramp.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Recovery {
    pub plan_uri: String,
    pub plan_sha256: String,
    pub proposed_by: AccountId,
    pub proposed_at: U64,
    pub approved_at: Option<U64>,
    /// the ramp's length, fixed when approved
    pub ramp_days: u32,
    /// set when a new suspension cut the ramp short
    pub cancelled_at: Option<U64>,
}

/// What the agent's standing is scaled by now (10_000 outside a ramp).
pub(crate) fn ramp_bps() -> u64 {
    let Some(r) = load::<Recovery>(KEY_RECOVERY) else { return 10_000 };
    let (Some(at), None) = (r.approved_at, r.cancelled_at) else { return 10_000 };
    let len = r.ramp_days as u64 * DAY_NS;
    let gone = env::block_timestamp().saturating_sub(at.0);
    if gone >= len {
        return 10_000;
    }
    RAMP_FROM_BPS + (10_000 - RAMP_FROM_BPS) * gone / len
}

/// Called from `meeting::strike`: a suspension during the ramp cancels it.
pub(crate) fn cancel_ramp() {
    if let Some(mut r) = load::<Recovery>(KEY_RECOVERY) {
        if r.approved_at.is_some() && r.cancelled_at.is_none() && ramp_bps() < 10_000 {
            r.cancelled_at = Some(U64(env::block_timestamp()));
            save(KEY_RECOVERY, &r);
        }
    }
}

#[near]
impl Koperasi {
    /// While suspended, the agent or the steward files the agent's recovery plan (replacing one not yet approved).
    pub fn propose_recovery(&mut self, plan_uri: String, plan_sha256: String) {
        require!(!self.paused, "koperasi is paused");
        let who = env::predecessor_account_id();
        require!(who == self.agent_id || self.steward.as_ref() == Some(&who), "only the co-op's agent or its steward");
        require!(crate::meeting::agent_suspended(), "the agent is not suspended");
        require!(valid_hash(&plan_sha256), "plan_sha256: 64 lowercase hex digits");
        require!(!plan_uri.is_empty() && plan_uri.len() <= 200 && plan_uri.bytes().all(|b| b.is_ascii_graphic()), "plan_uri: 1 to 200 characters, no spaces");
        save(KEY_RECOVERY, &Recovery { plan_uri: plan_uri.clone(), plan_sha256: plan_sha256.clone(), proposed_by: who.clone(),
            proposed_at: U64(env::block_timestamp()), approved_at: None, ramp_days: 0, cancelled_at: None });
        Event::RecoveryProposed { plan_uri, plan_sha256, by: who }.emit();
    }

    /// DAO only: the members approve the plan on file. The agent is reinstated and its standing ramps back up.
    /// `plan_sha256` must be the plan's: a vote on one plan never approves another filed after it.
    pub fn approve_recovery(&mut self, plan_sha256: String) {
        self.assert_dao();
        let mut r: Recovery = load(KEY_RECOVERY).unwrap_or_else(|| env::panic_str("no recovery plan on file"));
        require!(r.approved_at.is_none(), "this plan is already approved");
        require!(r.plan_sha256 == plan_sha256, "not the plan on file");
        require!(crate::meeting::agent_suspended(), "the agent is not suspended");
        let now = U64(env::block_timestamp());
        crate::meeting::reinstate_now();
        r.approved_at = Some(now);
        r.ramp_days = self.get_recovery_days();
        save(KEY_RECOVERY, &r);
        Event::AgentReinstated {}.emit();
        Event::RecoveryApproved { plan_sha256, ramp_days: r.ramp_days }.emit();
    }

    /// DAO only: how many days the agent's standing takes to ramp back after an approved plan (0 to 365; 0: at once).
    pub fn set_recovery_days(&mut self, days: u32) {
        self.assert_dao();
        require!(days <= 365, "at most 365 days");
        save(KEY_RECOVERY_DAYS, &days);
        Event::RecoveryDaysSet { days }.emit();
    }

    pub fn get_recovery_days(&self) -> u32 {
        load(KEY_RECOVERY_DAYS).unwrap_or(RECOVERY_DAYS)
    }

    /// The last recovery plan and (bps, out of 10_000) what the agent's standing is scaled by now.
    pub fn get_recovery(&self) -> (Option<Recovery>, u16) {
        (load(KEY_RECOVERY), ramp_bps() as u16)
    }
}
