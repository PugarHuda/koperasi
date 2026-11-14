//! Contract 0.3.6: the receiving side of the referral board.
//!
//! A sister co-op's agent posts a job it passes to this co-op (`post_referral` there). This co-op's agent (directly, or
//! anyone with its signature) accepts it here (`accept_referral`): the contract reads the referral from the sister's
//! own board and keeps it only if it is there and names this co-op. A receipt recorded later for that job is linked
//! to it (`get_referral_for_job`, `get_receipt_with_referral`). The last 200 accepted are kept.
//!
//! - **The referral share, paid automatically** (0.3.8, Federation resolution 3): the members vote a share
//!   (`set_referral_share`, at most 50%) and each sister co-op's treasury (`set_coop_treasury`). When the steward deposits
//!   a job's earnings with `ft_transfer_call` msg `"earnings:<job_id>"` and that job came from an accepted referral, that
//!   share goes to the referring co-op's treasury, once per job; the rest is booked as usual. A failed transfer goes to
//!   the DAO's unforwarded balance, for the members to pay by vote as before.
//!
//! State lives under its own storage keys, so the upgrade needs no state migration.

use crate::solidarity::{Referral, MAX_REFERRALS};
use crate::tasks::{load, save};
use crate::*;

const KEY_REFERRAL_SHARE: &[u8] = b"referral_share_bps";
pub const MAX_REFERRAL_SHARE_BPS: u16 = 5000;

fn treasury_key(coop: &AccountId) -> Vec<u8> {
    format!("coop_treasury:{coop}").into_bytes()
}
/// job_id -> the referral share paid for it: once per job.
fn share_paid_key(job_id: &str) -> Vec<u8> {
    format!("referral_share_paid:{job_id}").into_bytes()
}

/// The referral share sent for a job; `failed` when the transfer bounced and the amount went to the DAO instead.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct ReferralSharePaid {
    pub from_coop: AccountId,
    pub to: AccountId,
    pub amount: U128,
    pub failed: bool,
    pub at: U64,
}

impl Koperasi {
    /// From `ft_on_transfer` ("earnings:<job_id>"): send the referral share of `amount` for this job, if the job came from
    /// an accepted referral whose co-op has a treasury, the share is set, and none was sent for it yet. Returns what was sent.
    pub(crate) fn pay_referral_share(&mut self, job_id: &str, amount: u128) -> u128 {
        let bps = load::<u16>(KEY_REFERRAL_SHARE).unwrap_or(0) as u128;
        if bps == 0 || env::storage_has_key(&share_paid_key(job_id)) {
            return 0;
        }
        let Some(r) = self.get_referral_for_job(job_id.to_string()) else { return 0 };
        let Some(to) = load::<AccountId>(&treasury_key(&r.from_coop)) else { return 0 };
        let share = amount * bps / BPS;
        if share == 0 {
            return 0;
        }
        save(&share_paid_key(job_id), &ReferralSharePaid { from_coop: r.from_coop.clone(), to: to.clone(), amount: U128(share),
            failed: false, at: U64(env::block_timestamp()) });
        bump(KEY_IN_FLIGHT, share, false);
        Event::ReferralSharePaid { job_id: job_id.into(), from_coop: r.from_coop, to: to.clone(), amount: U128(share) }.emit();
        let _ = ext_ft::ext(self.usdc_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(to, U128(share), Some(format!("koperasi referral share {job_id}")))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_referral_share(job_id.into(), U128(share)));
        share
    }
}

const KEY_ACCEPTED_COUNT: &[u8] = b"accepted_ref_count";
/// Acceptance signatures consumed so far: only ever goes up (its own nonce, apart from the board's and the by-laws').
const KEY_ACCEPT_NONCE: &[u8] = b"accept_ref_nonce";
const GAS_READ_BOARD: Gas = Gas::from_tgas(10);
const GAS_ACCEPTED: Gas = Gas::from_tgas(15);

fn accepted_key(i: u32) -> Vec<u8> {
    format!("accepted_ref:{i}").into_bytes()
}
/// (sister co-op, its referral id) -> index here: each referral is accepted once.
fn from_key(coop: &AccountId, id: u32) -> Vec<u8> {
    format!("accepted_from:{coop}:{id}").into_bytes()
}
/// job_id -> index here: a job is accepted once, and its receipt finds its referral.
fn job_key(job_id: &str) -> Vec<u8> {
    format!("accepted_job:{job_id}").into_bytes()
}

/// What this co-op's agent signs to accept a sister's referral (bound to this contract and to the accept nonce).
pub fn accept_message(contract: &AccountId, nonce: u32, from_coop: &AccountId, referral_id: u32) -> String {
    format!("koperasi-agent-accept/1 {contract} #{nonce} {from_coop} {referral_id}")
}

/// A job a sister co-op passed to this one, accepted here.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct AcceptedReferral {
    pub id: u32,
    pub job_id: String,
    pub from_coop: AccountId,
    pub referral_id: u32,
    pub budget_usdc: U128,
    pub accepted_at: U64,
}

#[ext_contract(ext_board)]
#[allow(dead_code)]
trait ReferralBoard {
    fn get_referrals(&self, from: Option<u32>, limit: Option<u32>) -> Vec<Referral>;
}

#[near]
impl Koperasi {
    /// This co-op's agent accepts referral `referral_id` from sister co-op `from_coop`: directly, or anyone submitting
    /// the agent's ed25519 signature (base64) of `get_accept_message(...)`. The referral is read from the sister's board
    /// (`get_referrals`, so a 0.3.5 sister works too) and kept by the callback if it names this co-op.
    pub fn accept_referral(&mut self, from_coop: AccountId, referral_id: u32, signature: Option<String>) -> Promise {
        require!(!self.paused, "koperasi is paused");
        require!(!crate::meeting::agent_suspended(), "the agent is suspended");
        crate::solidarity::assert_tee_ok(&self.agent_id);
        let nonce: u32 = load(KEY_ACCEPT_NONCE).unwrap_or(0);
        crate::meeting::assert_agent_or_signed(&self.agent_id, signature.as_deref(),
            || accept_message(&env::current_account_id(), nonce, &from_coop, referral_id));
        require!(self.get_sister_coops().contains(&from_coop), "not a sister co-op the members recognise");
        require!(!env::storage_has_key(&from_key(&from_coop, referral_id)), "this referral is already accepted");
        // a signature counts once, even if the sister's board then says no (as for the agent's by-laws proposals)
        save(KEY_ACCEPT_NONCE, &(nonce + 1));
        ext_board::ext(from_coop.clone())
            .with_static_gas(GAS_READ_BOARD)
            .get_referrals(Some(referral_id), Some(1))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ACCEPTED).on_referral_read(from_coop, referral_id))
    }

    /// Callback of `accept_referral`: keep the referral if the sister's board holds it for this co-op.
    #[private]
    pub fn on_referral_read(&mut self, from_coop: AccountId, referral_id: u32,
        #[callback_result] board: Result<Vec<Referral>, PromiseError>) -> u32 {
        let board = board.unwrap_or_else(|_| env::panic_str("could not read the sister co-op's referral board"));
        // the sister's board returns the oldest it still keeps when this id is gone: match the id
        let r = board.into_iter().find(|r| r.id == referral_id).unwrap_or_else(|| env::panic_str("no such referral on the sister's board"));
        require!(r.to_coop == env::current_account_id(), "that referral is for another co-op");
        require!(!r.job_id.is_empty() && r.job_id.len() <= 128 && r.job_id.bytes().all(|b| b.is_ascii_graphic()), "bad job_id");
        // again here: another acceptance may have landed between the call and this callback
        require!(!self.paused, "koperasi is paused");
        require!(!env::storage_has_key(&from_key(&from_coop, referral_id)), "this referral is already accepted");
        require!(!env::storage_has_key(&job_key(&r.job_id)), "this job is already accepted");
        // a receipt here already names this job: a referral accepted now would link work it did not bring
        require!(!self.receipt_index.contains_key(&r.job_id), "this job already has a receipt here");
        let id: u32 = load(KEY_ACCEPTED_COUNT).unwrap_or(0);
        save(KEY_ACCEPTED_COUNT, &(id + 1));
        if id >= MAX_REFERRALS {
            // bounded storage, paid by the contract: the oldest goes, with its links
            if let Some(old) = load::<AcceptedReferral>(&accepted_key(id - MAX_REFERRALS)) {
                env::storage_remove(&accepted_key(old.id));
                env::storage_remove(&from_key(&old.from_coop, old.referral_id));
                env::storage_remove(&job_key(&old.job_id));
            }
        }
        let a = AcceptedReferral { id, job_id: r.job_id.clone(), from_coop: from_coop.clone(), referral_id, budget_usdc: r.budget_usdc, accepted_at: U64(env::block_timestamp()) };
        save(&accepted_key(id), &a);
        save(&from_key(&from_coop, referral_id), &id);
        save(&job_key(&r.job_id), &id);
        Event::ReferralAccepted { id, job_id: r.job_id, from_coop, referral_id, budget_usdc: r.budget_usdc }.emit();
        id
    }

    /// The exact text the agent signs for its next `accept_referral`.
    pub fn get_accept_message(&self, from_coop: AccountId, referral_id: u32) -> String {
        accept_message(&env::current_account_id(), load(KEY_ACCEPT_NONCE).unwrap_or(0), &from_coop, referral_id)
    }

    /// Accepted referrals still kept (the last 200), oldest first from `from`; at most `limit` (50 by default, 200 at most).
    pub fn get_accepted_referrals(&self, from: Option<u32>, limit: Option<u32>) -> Vec<AcceptedReferral> {
        let n: u32 = load(KEY_ACCEPTED_COUNT).unwrap_or(0);
        let from = from.unwrap_or(0).max(n.saturating_sub(MAX_REFERRALS));
        let to = n.min(from.saturating_add(limit.unwrap_or(50).min(MAX_REFERRALS)));
        (from..to).filter_map(|i| load(&accepted_key(i))).collect()
    }

    /// The sister co-op's referral this job came from, if it was accepted here (and is still kept).
    pub fn get_referral_for_job(&self, job_id: String) -> Option<AcceptedReferral> {
        load::<u32>(&job_key(&job_id)).and_then(|i| load(&accepted_key(i)))
    }

    /// Callback of a referral share's transfer: failed, the amount goes to the DAO's unforwarded balance (`flush_to_dao`)
    /// and the job stays marked, so the members pay the sister by vote as before; never sent twice.
    #[private]
    pub fn on_referral_share(&mut self, job_id: String, amount: U128, #[callback_result] r: Result<(), PromiseError>) {
        bump(KEY_IN_FLIGHT, amount.0, true);
        if r.is_err() {
            self.unforwarded += amount.0;
            let mut p: ReferralSharePaid = load(&share_paid_key(&job_id)).unwrap_or_else(|| env::panic_str("no referral share"));
            p.failed = true;
            save(&share_paid_key(&job_id), &p);
            Event::ReferralShareFailed { job_id, from_coop: p.from_coop, amount }.emit();
        }
    }

    /// DAO only: the share (bps, at most 5000) of a referred job's earnings paid to the co-op that referred it (0: none).
    pub fn set_referral_share(&mut self, bps: u16) {
        self.assert_dao();
        require!(bps <= MAX_REFERRAL_SHARE_BPS, "at most 5000 bps");
        save(KEY_REFERRAL_SHARE, &bps);
        Event::ReferralShareSet { bps }.emit();
    }

    pub fn get_referral_share(&self) -> u16 {
        load(KEY_REFERRAL_SHARE).unwrap_or(0)
    }

    /// DAO only: where a sister co-op's referral share is paid (its treasury, i.e. its DAO; not a contract of either
    /// co-op); None removes it.
    pub fn set_coop_treasury(&mut self, coop: AccountId, treasury: Option<AccountId>) {
        self.assert_dao();
        match &treasury {
            Some(t) => {
                require!(self.get_sister_coops().contains(&coop), "not a sister co-op the members recognise");
                require!(*t != coop && *t != env::current_account_id(), "pay the sister's treasury (its DAO), not a contract");
                save(&treasury_key(&coop), t);
            }
            None => {
                env::storage_remove(&treasury_key(&coop));
            }
        }
        Event::CoopTreasurySet { coop, treasury }.emit();
    }

    pub fn get_coop_treasury(&self, coop: AccountId) -> Option<AccountId> {
        load(&treasury_key(&coop))
    }

    /// The referral share sent for a job, if any.
    pub fn get_referral_share_paid(&self, job_id: String) -> Option<ReferralSharePaid> {
        load(&share_paid_key(&job_id))
    }

    /// A job's receipt and the referral it came from, if any.
    pub fn get_receipt_with_referral(&self, job_id: String) -> Option<(Receipt, Option<AcceptedReferral>)> {
        let i = *self.receipt_index.get(&job_id)?;
        Some((self.receipts.get(i)?.clone(), self.get_referral_for_job(job_id)))
    }
}
