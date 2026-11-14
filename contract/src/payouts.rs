//! Contract 0.3.10 (after the hackathon deadline): the contract pays through NEAR Intents itself; per-destination caps.
//!
//! - **Through NEAR Intents** (`set_intents_verifier`, DAO only): when a verifier is set, a referral share is not sent
//!   by `ft_transfer` but in two steps, chained by callbacks. (1) `ft_transfer_call` of the USDC to the verifier with
//!   `msg` = this contract's account id: the NEAR Intents deposit convention (the verifier's `ft_on_transfer` reads a
//!   non-JSON `msg` as the receiving intents account; an empty one would credit the sender, the same account here).
//!   (2) Once the verifier kept it all, `ft_withdraw` on the verifier as this contract (predecessor = this contract,
//!   1 yocto) to the referrer's treasury, memo naming the job.
//!   Step 1 refused: USDC is back here and goes to the DAO's `unforwarded` balance (`flush_to_dao`), as today. Step 2
//!   refused: the verifier keeps (or refunds) the USDC on this contract's intents balance, not here, so it is counted
//!   apart (`get_intents_held`) and anyone sends it to the DAO through the verifier (`flush_intents_to_dao`). Either
//!   way the share is marked failed: never paid twice.
//! - **Per-destination cap** (`set_payout_cap`, DAO only): a referral share (either path) over its destination's cap is
//!   cut to the cap; the rest is booked to the DAO with the job's earnings. No cap set: no limit.
//!
//! State lives under its own storage keys, so the upgrade needs no state migration.

use crate::tasks::{load, save};
use crate::*;

const KEY_VERIFIER: &[u8] = b"intents_verifier";
/// USDC deposit to the verifier: the token's ft_transfer_call, the verifier's ft_on_transfer and the token's resolve.
const GAS_INTENTS_DEPOSIT: Gas = Gas::from_tgas(40);
/// The verifier's ft_withdraw: its own ft_transfer and its resolve.
const GAS_INTENTS_WITHDRAW: Gas = Gas::from_tgas(40);
/// The callback after the deposit: it schedules the withdrawal and the last callback.
const GAS_INTENTS_DEPOSITED: Gas = Gas::from_tgas(60);
const GAS_INTENTS_DONE: Gas = Gas::from_tgas(10);

fn cap_key(to: &AccountId) -> Vec<u8> {
    format!("payout_cap:{to}").into_bytes()
}
/// USDC (`token`) this contract holds on `verifier` after a withdrawal there failed.
fn held_key(verifier: &AccountId, token: &AccountId) -> Vec<u8> {
    format!("intents_held:{verifier}:{token}").into_bytes()
}
fn via_key(job_id: &str) -> Vec<u8> {
    format!("referral_share_via:{job_id}").into_bytes()
}

pub(crate) fn intents_verifier() -> Option<AccountId> {
    load(KEY_VERIFIER)
}
/// `amount`, cut to `to`'s payout cap if the members set one.
pub(crate) fn capped(to: &AccountId, amount: u128) -> u128 {
    load::<U128>(&cap_key(to)).map_or(amount, |c| amount.min(c.0))
}
fn add_held(verifier: &AccountId, token: &AccountId, by: u128) {
    if by > 0 {
        let k = held_key(verifier, token);
        save(&k, &(load::<u128>(&k).unwrap_or(0) + by));
    }
}
fn mark_failed(job_id: &str) {
    if let Some(mut p) = load::<crate::referrals::ReferralSharePaid>(&crate::referrals::share_paid_key(job_id)) {
        p.failed = true;
        save(&crate::referrals::share_paid_key(job_id), &p);
        Event::ReferralShareFailed { job_id: job_id.into(), from_coop: p.from_coop, amount: p.amount }.emit();
    }
}

/// The NEAR Intents verifier (intents.near), as this contract calls it.
#[ext_contract(ext_intents)]
#[allow(dead_code)]
trait IntentsVerifier {
    /// Withdraw `amount` of NEP-141 `token` from the caller's intents balance to `receiver_id` (1 yocto); returns the
    /// amount withdrawn (0 when the transfer failed and was refunded to the caller's intents balance).
    fn ft_withdraw(&mut self, token: AccountId, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: Option<String>) -> U128;
}

#[ext_contract(ext_ft_call)]
#[allow(dead_code)]
trait FungibleTokenCall {
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> U128;
}

impl Koperasi {
    /// Step 1: deposit `amount` on `verifier` as this contract's own intents balance. The caller has booked it in flight.
    pub(crate) fn pay_via_intents(&mut self, job_id: &str, verifier: AccountId, to: AccountId, amount: u128) {
        save(&via_key(job_id), &verifier);
        Event::ReferralShareViaIntents { job_id: job_id.into(), verifier: verifier.clone(), to: to.clone(), amount: U128(amount) }.emit();
        let _ = ext_ft_call::ext(self.usdc_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_INTENTS_DEPOSIT)
            .ft_transfer_call(verifier.clone(), U128(amount), Some(format!("koperasi referral share {job_id}")), env::current_account_id().to_string())
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_INTENTS_DEPOSITED)
                .on_intents_deposit(job_id.into(), verifier, to, U128(amount), self.usdc_id.clone()));
    }
}

#[near]
impl Koperasi {
    /// DAO only: the NEAR Intents verifier referral shares are paid through (None: plain ft_transfer, as before).
    pub fn set_intents_verifier(&mut self, verifier: Option<AccountId>) {
        self.assert_dao();
        match &verifier {
            Some(v) => {
                require!(*v != env::current_account_id() && *v != self.usdc_id && *v != self.dao_id, "not a NEAR Intents verifier");
                save(KEY_VERIFIER, v);
            }
            None => {
                env::storage_remove(KEY_VERIFIER);
            }
        }
        Event::IntentsVerifierSet { verifier }.emit();
    }

    pub fn get_intents_verifier(&self) -> Option<AccountId> {
        intents_verifier()
    }

    /// DAO only: the most one payment to `destination` may be (a referral share over it is cut to it); 0 removes the cap.
    pub fn set_payout_cap(&mut self, destination: AccountId, max_per_payment: U128) {
        self.assert_dao();
        if max_per_payment.0 == 0 {
            env::storage_remove(&cap_key(&destination));
        } else {
            save(&cap_key(&destination), &max_per_payment);
        }
        Event::PayoutCapSet { destination, max_per_payment }.emit();
    }

    pub fn get_payout_cap(&self, destination: AccountId) -> Option<U128> {
        load(&cap_key(&destination))
    }

    /// The verifier a job's referral share was paid through, if it went through NEAR Intents.
    pub fn get_referral_share_verifier(&self, job_id: String) -> Option<AccountId> {
        load(&via_key(&job_id))
    }

    /// USDC (`token`) this contract holds on `verifier` after a failed withdrawal: owed to the DAO.
    pub fn get_intents_held(&self, verifier: AccountId, token: AccountId) -> U128 {
        U128(load(&held_key(&verifier, &token)).unwrap_or(0))
    }

    /// Callback of step 1. The verifier kept it all: step 2, withdraw it to the referrer's treasury. Otherwise what came
    /// back goes to `unforwarded`, anything the verifier kept to the held balance, and the share is marked failed.
    #[private]
    pub fn on_intents_deposit(&mut self, job_id: String, verifier: AccountId, to: AccountId, amount: U128, token: AccountId,
        #[callback_result] used: Result<U128, PromiseError>) -> PromiseOrValue<()> {
        let used = used.map_or(0, |u| u.0.min(amount.0));
        if used == amount.0 {
            return ext_intents::ext(verifier.clone())
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(GAS_INTENTS_WITHDRAW)
                .ft_withdraw(token.clone(), to, amount, Some(format!("koperasi referral share {job_id}")), None)
                .then(Self::ext(env::current_account_id()).with_static_gas(GAS_INTENTS_DONE)
                    .on_intents_withdrawn(Some(job_id), verifier, amount, token))
                .into();
        }
        bump(crate::KEY_IN_FLIGHT, amount.0, true);
        self.unforwarded += amount.0 - used;
        add_held(&verifier, &token, used);
        mark_failed(&job_id);
        PromiseOrValue::Value(())
    }

    /// Callback of a withdrawal from the verifier (a referral share's step 2, or `flush_intents_to_dao` with no job):
    /// what it did not withdraw stays on this contract's intents balance, counted as held; a share is marked failed.
    #[private]
    pub fn on_intents_withdrawn(&mut self, job_id: Option<String>, verifier: AccountId, amount: U128, token: AccountId,
        #[callback_result] r: Result<U128, PromiseError>) {
        bump(crate::KEY_IN_FLIGHT, amount.0, true);
        let left = amount.0 - r.map_or(0, |w| w.0.min(amount.0));
        if left > 0 {
            add_held(&verifier, &token, left);
            match job_id {
                Some(j) => mark_failed(&j),
                None => Event::ForwardFailed { amount: U128(left) }.emit(),
            }
        }
    }

    /// Anyone: send the USDC held on `verifier` (in `token`) to the DAO, withdrawn through that verifier.
    pub fn flush_intents_to_dao(&mut self, verifier: AccountId, token: AccountId) -> Promise {
        let k = held_key(&verifier, &token);
        let amount: u128 = load(&k).unwrap_or(0);
        require!(amount > 0, "nothing held on that verifier");
        env::storage_remove(&k);
        bump(crate::KEY_IN_FLIGHT, amount, false);
        ext_intents::ext(verifier.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_INTENTS_WITHDRAW)
            .ft_withdraw(token.clone(), self.dao_id.clone(), U128(amount), Some("koperasi".into()), None)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_INTENTS_DONE).on_intents_withdrawn(None, verifier, U128(amount), token))
    }
}
