//! Koperasi: an AI agent owned and governed by its members.
//!
//! The Sputnik DAO (`dao_id`) is the source of truth for membership (role `member`) and the only account that
//! can change the agent's config (its by-laws), award contribution points, set savings weights
//! ("savings") or move the steward's bond. This contract adds what Sputnik does not have: the config the
//! agent must run, a receipt for every job, on-chain reconciliation of the steward's deposits, and the
//! profit share split by savings + contribution points, with a reserve returned to the DAO.

// #[near] generates a wrapper for `new` with one more argument than its 7 founding terms
#![allow(clippy::too_many_arguments)]

use near_sdk::json_types::{Base58CryptoHash, U128, U64};
use near_sdk::serde_json::Value;
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{
    env, ext_contract, log, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};

const MEMBER_ROLE: &str = "member";
const BPS: u128 = 10_000;
/// Agent Market keeps 5% of every accepted job; the steward owes the rest.
const MARKET_FEE_BPS: u128 = 500;
/// savings is weighed in milli-NEAR so `pool * weight` stays far below u128::MAX.
const SAVINGS_UNIT: u128 = 1_000_000_000_000_000_000_000; // 10^21 yocto
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
const GAS_VIEW: Gas = Gas::from_tgas(10);
/// The callback that splits a share under a reserve floor: one pass over the members plus the transfer to the DAO.
const GAS_SHARE: Gas = Gas::from_tgas(60);

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn ft_balance_of(&self, account_id: AccountId) -> U128;
}

#[ext_contract(ext_dao)]
#[allow(dead_code)]
trait SputnikDao {
    fn get_policy(&self) -> Value;
}

#[ext_contract(ext_pool)]
#[allow(dead_code)]
trait StakingPool {
    fn get_account_staked_balance(&self, account_id: AccountId) -> U128;
}

/// The staking pool members stake in for inference credits ("savings"), chosen by the DAO.
// ponytail: kept in its own storage key instead of a struct field, so the upgrade needs no state migration.
const KEY_STAKING_POOL: &[u8] = b"staking_pool";
/// Per-job proof of the inference (NEAR AI inference id, attested TEE signer, signed hashes), keyed by job id.
const PROOF_PREFIX: &[u8] = b"proof:";
const MAX_PROOF_LEN: usize = 1024;
/// Σ profit shares credited and not yet claimed, by anyone (members and former members), in the current token.
pub(crate) const KEY_OWED_SHARES: &[u8] = b"owed_shares";
/// Σ USDC sent by ft_transfer whose callback has not come back yet (claims and transfers to the DAO).
const KEY_IN_FLIGHT: &[u8] = b"in_flight";
/// The least USDC the DAO must keep outside a profit share (set by vote; 0 = no floor). Its own key: no migration.
const KEY_RESERVE_FLOOR: &[u8] = b"reserve_floor";
/// When the current steward was appointed (ns) and the deposits counted until then: they answer only for jobs paid
/// since, against what they deposited since.
const KEY_STEWARD_FROM: &[u8] = b"steward_from";
const KEY_STEWARD_DEPOSITED: &[u8] = b"steward_deposited";
/// Σ earnings (net of the market fee) of jobs paid since the current steward's appointment: kept as a running total so
/// replacing a steward never reads every receipt.
const KEY_STEWARD_PAID: &[u8] = b"steward_paid";
/// When a receipt became Paid (ns), keyed by job id; receipts from before this code fall back to when they were recorded.
const PAID_AT_PREFIX: &[u8] = b"paid_at:";
/// How long the steward has to pass a paid job's earnings on before anyone can slash the bond: time to collect from
/// Agent Market. Deposits pay the oldest jobs first, so each job has its own grace period.
const STEWARD_GRACE_NS: u64 = 7 * 24 * 3600 * 1_000_000_000;

fn read_u128(key: &[u8]) -> Option<u128> {
    env::storage_read(key).map(|b| u128::from_le_bytes(b.try_into().unwrap_or_else(|_| env::panic_str("bad counter"))))
}
fn write_u128(key: &[u8], v: u128) {
    env::storage_write(key, &v.to_le_bytes());
}
/// Add to (or, with `sub`, take from) a counter. Counters exist from `new`, or from `init_ledger` on older co-ops.
pub(crate) fn bump(key: &[u8], by: u128, sub: bool) {
    if let Some(v) = read_u128(key) {
        write_u128(key, if sub { v.saturating_sub(by) } else { v + by });
    }
}

/// A stake increase read by `sync_savings` counts only after an unbroken run of readings this long still shows it
/// (security finding S12: without it, a large stake a block before a profit share took the savings pool and left
/// right after). A decrease counts at once.
const SAVINGS_DELAY_NS: u64 = 7 * 24 * 3600 * 1_000_000_000;
/// The longest gap between two readings of a waiting increase; a longer one restarts the wait, so a stake that left
/// and came back between readings cannot count. Anyone can read; the co-op's keeper (`api/keeper.mjs`) reads twice a day.
// ponytail: a dip shorter than this between two readings is not seen; reading every epoch would close the rest.
const SAVINGS_GAP_NS: u64 = 24 * 3600 * 1_000_000_000;
/// Per-member stake increase waiting for SAVINGS_DELAY_NS: (yoctoNEAR, since, last reading) in borsh, keyed by account.
/// An entry from before the gap rule (two fields) no longer decodes, so its wait restarts at the next reading.
const PENDING_SAVINGS_PREFIX: &[u8] = b"savings_pending:";

fn pending_key(a: &AccountId) -> Vec<u8> {
    [PENDING_SAVINGS_PREFIX, a.as_bytes()].concat()
}
fn read_pending(a: &AccountId) -> Option<(u128, u64, u64)> {
    env::storage_read(&pending_key(a)).and_then(|b| near_sdk::borsh::from_slice(&b).ok())
}

fn proof_key(job_id: &str) -> Vec<u8> {
    [PROOF_PREFIX, job_id.as_bytes()].concat()
}

mod events;
pub use events::Event;

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Members,
    Pending,
    ConfigHistory,
    Receipts,
    ReceiptIndex,
    Periods,
    Claimable,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Config {
    pub version: u32,
    /// sha256 of the config file, lowercase hex.
    pub hash: String,
    pub uri: String,
    pub contributor: Option<AccountId>,
    pub activated_at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Member {
    pub join_deposit: NearToken,
    /// yoctoNEAR staked for inference, as last set by the DAO.
    pub savings: U128,
    /// contribution points earned since the last profit share.
    pub points: u64,
    pub joined_at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum ReceiptStatus {
    Submitted,
    Paid,
    Refunded,
    Disputed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Receipt {
    pub job_id: String,
    /// price in the job currency's smallest unit (USDC: 6 decimals).
    pub price: U128,
    /// inference cost in micro-USD, from NEAR AI Cloud billing.
    pub inference_cost: U128,
    pub config_version: u32,
    pub config_hash: String,
    pub deliverable_hash: String,
    pub status: ReceiptStatus,
    pub ts: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct ShareRule {
    pub reserve_bps: u16,
    pub savings_bps: u16,
    pub points_bps: u16,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Period {
    pub id: u32,
    pub amount: U128,
    pub reserve: U128,
    pub members: u32,
    pub ts: U64,
}

#[near(serializers = [json])]
pub struct Audit {
    /// Σ price of paid receipts, net of the market fee: what the steward should have deposited.
    pub expected: U128,
    pub deposited: U128,
    /// expected - deposited, 0 if the steward is ahead.
    pub owed: U128,
}

#[near(serializers = [json])]
pub struct Info {
    pub dao_id: AccountId,
    pub usdc_id: AccountId,
    pub agent_id: AccountId,
    pub steward: Option<AccountId>,
    pub steward_bond: NearToken,
    pub join_deposit: NearToken,
    pub paused: bool,
    pub config: Config,
    pub share_rule: ShareRule,
    pub members: u32,
    pub receipts: u32,
    pub periods: u32,
    pub unforwarded: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Koperasi {
    dao_id: AccountId,
    usdc_id: AccountId,
    agent_id: AccountId,
    steward: Option<AccountId>,
    steward_bond: NearToken,
    join_deposit: NearToken,
    paused: bool,
    config: Config,
    config_history: Vector<Config>,
    share_rule: ShareRule,
    members: IterableMap<AccountId, Member>,
    pending: LookupMap<AccountId, NearToken>,
    receipts: Vector<Receipt>,
    receipt_index: LookupMap<String, u32>,
    periods: Vector<Period>,
    claimable: LookupMap<AccountId, u128>,
    deposited: u128,
    /// USDC meant for the DAO whose transfer failed; anyone can retry with `flush_to_dao`.
    unforwarded: u128,
}

fn valid_hash(h: &str) -> bool {
    h.len() == 64 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn check_rule(r: &ShareRule) {
    require!(
        r.reserve_bps as u128 + r.savings_bps as u128 + r.points_bps as u128 == BPS,
        "share_rule must add up to 10000 bps"
    );
}

/// Is `account` listed in the `role` group of a Sputnik policy?
pub fn role_has(policy: &Value, role: &str, account: &AccountId) -> bool {
    policy["roles"].as_array().is_some_and(|roles| {
        roles.iter().any(|r| {
            r["name"] == role
                && r["kind"]["Group"].as_array().is_some_and(|g| g.iter().any(|a| a == account.as_str()))
        })
    })
}

#[near]
impl Koperasi {
    /// Found the co-op: its DAO, token, agent account, join deposit, profit-share rule and first by-laws.
    #[init]
    pub fn new(
        dao_id: AccountId,
        usdc_id: AccountId,
        agent_id: AccountId,
        join_deposit: NearToken,
        share_rule: ShareRule,
        config_hash: String,
        config_uri: String,
    ) -> Self {
        check_rule(&share_rule);
        require!(valid_hash(&config_hash), "config_hash must be 64 lowercase hex chars");
        let config = Config {
            version: 1,
            hash: config_hash,
            uri: config_uri,
            contributor: None,
            activated_at: U64(env::block_timestamp()),
        };
        let mut config_history = Vector::new(Key::ConfigHistory);
        config_history.push(config.clone());
        write_u128(KEY_OWED_SHARES, 0);
        write_u128(KEY_IN_FLIGHT, 0);
        Self {
            dao_id,
            usdc_id,
            agent_id,
            steward: None,
            steward_bond: NearToken::from_yoctonear(0),
            join_deposit,
            paused: false,
            config,
            config_history,
            share_rule,
            members: IterableMap::new(Key::Members),
            pending: LookupMap::new(Key::Pending),
            receipts: Vector::new(Key::Receipts),
            receipt_index: LookupMap::new(Key::ReceiptIndex),
            periods: Vector::new(Key::Periods),
            claimable: LookupMap::new(Key::Claimable),
            deposited: 0,
            unforwarded: 0,
        }
    }

    fn assert_dao(&self) {
        require!(env::predecessor_account_id() == self.dao_id, "only the DAO");
    }

    fn assert_agent(&self) {
        let who = env::predecessor_account_id();
        // 0.3.1: or a further agent the members voted (lending.rs `set_agents`)
        require!(who == self.agent_id || crate::lending::more_agents().iter().any(|a| a.account == who), "only the agent");
    }

    // ---------- membership: Sputnik role `member` is the source of truth ----------

    /// Pay the join deposit and wait for the DAO to add you to role `member` (AddMemberToRole proposal),
    /// then call `sync_member`.
    #[payable]
    pub fn join(&mut self) {
        let who = env::predecessor_account_id();
        let paid = env::attached_deposit();
        require!(paid >= self.join_deposit, "attach at least the join deposit");
        require!(!self.members.contains_key(&who) && !self.pending.contains_key(&who), "already joined");
        self.pending.insert(who.clone(), self.join_deposit);
        Event::JoinRequested { account_id: who.clone(), deposit: self.join_deposit }.emit();
        let change = paid.saturating_sub(self.join_deposit);
        if !change.is_zero() {
            let _ = Promise::new(who).transfer(change);
        }
    }

    /// Withdraw a join request the DAO has not accepted yet. If the members already voted you in, this admits you
    /// instead and keeps the deposit as your member's deposit: nobody can hold a vote in the DAO without one.
    pub fn cancel_join(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        require!(self.pending.contains_key(&who), "no pending join");
        ext_dao::ext(self.dao_id.clone())
            .with_static_gas(GAS_VIEW)
            .get_policy()
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_cancel_policy(who))
    }

    /// Callback of `cancel_join`.
    #[private]
    pub fn on_cancel_policy(&mut self, account_id: AccountId, #[callback_result] policy: Result<Value, PromiseError>) {
        let policy = policy.unwrap_or_else(|_| env::panic_str("could not read DAO policy"));
        if role_has(&policy, MEMBER_ROLE, &account_id) {
            log!("{} was already voted in: admitted instead of refunded", account_id);
            self.apply_membership(account_id, true);
        } else if let Some(join_deposit) = self.pending.remove(&account_id) {
            Event::JoinCancelled { account_id: account_id.clone(), refunded: join_deposit }.emit();
            let _ = Promise::new(account_id).transfer(join_deposit);
        }
    }

    /// Read the DAO policy and admit (pending → member) or release (member removed from role → refund join_deposit).
    /// Anyone can call it.
    pub fn sync_member(&mut self, account_id: AccountId) -> Promise {
        ext_dao::ext(self.dao_id.clone())
            .with_static_gas(GAS_VIEW)
            .get_policy()
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_policy(account_id))
    }

    /// Callback of `sync_member`.
    #[private]
    pub fn on_policy(&mut self, account_id: AccountId, #[callback_result] policy: Result<Value, PromiseError>) {
        let policy = policy.unwrap_or_else(|_| env::panic_str("could not read DAO policy"));
        let in_role = role_has(&policy, MEMBER_ROLE, &account_id);
        self.apply_membership(account_id, in_role);
    }

    fn apply_membership(&mut self, account_id: AccountId, in_role: bool) {
        if in_role {
            if let Some(join_deposit) = self.pending.remove(&account_id) {
                self.members.insert(
                    account_id.clone(),
                    Member { join_deposit, savings: U128(0), points: 0, joined_at: U64(env::block_timestamp()) },
                );
                Event::MemberAdded { account_id }.emit();
            }
        } else if let Some(m) = self.members.remove(&account_id) {
            env::storage_remove(&pending_key(&account_id));
            Event::MemberLeft { account_id: account_id.clone(), refunded: m.join_deposit }.emit();
            let _ = Promise::new(account_id).transfer(m.join_deposit);
        }
    }

    // ---------- members' vote (DAO only) ----------

    /// Change the agent's by-laws. The agent refuses to work until it runs this exact config.
    pub fn set_config(&mut self, version: u32, hash: String, uri: String, contributor: Option<AccountId>, points: u64) {
        self.assert_dao();
        require!(version > self.config.version, "version must increase");
        require!(valid_hash(&hash), "hash must be 64 lowercase hex chars");
        // 0.3.2: a contributor who is not a member (the agent, proposing its own by-laws) is named, with no points
        if let Some(c) = contributor.as_ref().filter(|_| points > 0) {
            self.add_points(c, points);
        }
        Event::ConfigSet { version, hash: hash.clone(), uri: uri.clone(), contributor: contributor.clone(), points }.emit();
        self.config = Config { version, hash, uri, contributor, activated_at: U64(env::block_timestamp()) };
        self.config_history.push(self.config.clone());
    }

    /// DAO only: contribution points for work outside the by-laws (e.g. a new tool); they weigh the next profit share.
    pub fn award_points(&mut self, account_id: AccountId, points: u64, reason: String) {
        self.assert_dao();
        self.add_points(&account_id, points);
        Event::PointsAwarded { account_id, points, reason }.emit();
    }

    fn add_points(&mut self, account_id: &AccountId, points: u64) {
        let m = self.members.get_mut(account_id).unwrap_or_else(|| env::panic_str("not a member"));
        m.points += points;
    }

    /// Savings weights for the next profit share, from each member's stake for inference.
    pub fn set_savings(&mut self, entries: Vec<(AccountId, U128)>) {
        self.assert_dao();
        for (a, s) in entries {
            self.members.get_mut(&a).unwrap_or_else(|| env::panic_str("not a member")).savings = s;
            env::storage_remove(&pending_key(&a)); // a members' vote counts at once
            Event::SavingsSet { account_id: a, savings: s }.emit();
        }
    }

    /// Choose the staking pool whose stake counts as savings (None: savings only by `set_savings` votes).
    pub fn set_staking_pool(&mut self, pool: Option<AccountId>) {
        self.assert_dao();
        Event::StakingPoolSet { pool: pool.clone() }.emit();
        match pool {
            Some(p) => {
                env::storage_write(KEY_STAKING_POOL, p.as_bytes());
            }
            None => {
                env::storage_remove(KEY_STAKING_POOL);
            }
        }
    }

    /// The staking pool whose stake counts as savings, if the DAO chose one.
    pub fn get_staking_pool(&self) -> Option<AccountId> {
        env::storage_read(KEY_STAKING_POOL).and_then(|b| String::from_utf8(b).ok()?.parse().ok())
    }

    /// Anyone can call: reads the member's stake in the co-op's staking pool on-chain and makes it their savings.
    pub fn sync_savings(&mut self, account_id: AccountId) -> Promise {
        require!(self.members.contains_key(&account_id), "not a member");
        let pool = self.get_staking_pool().unwrap_or_else(|| env::panic_str("the DAO has not chosen a staking pool"));
        ext_pool::ext(pool)
            .with_static_gas(GAS_VIEW)
            .get_account_staked_balance(account_id.clone())
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_staked(account_id))
    }

    /// Callback of `sync_savings`.
    #[private]
    pub fn on_staked(&mut self, account_id: AccountId, #[callback_result] staked: Result<U128, PromiseError>) {
        let staked = staked.unwrap_or_else(|_| env::panic_str("could not read the staking pool")).0;
        let Some(m) = self.members.get_mut(&account_id) else { return };
        let now = env::block_timestamp();
        if staked <= m.savings.0 {
            // a decrease counts at once and cancels any increase still waiting
            env::storage_remove(&pending_key(&account_id));
            if staked < m.savings.0 {
                m.savings = U128(staked);
                Event::SavingsSet { account_id, savings: m.savings }.emit();
            }
            return;
        }
        // an increase waits, and what counts is the least stake every reading of the wait showed: more staked later
        // (or staking rewards) does not restart it, it waits its own turn after this one counts; a reading more than
        // a day after the last restarts it (what happened in between was not seen)
        let (amount, since) = match read_pending(&account_id) {
            Some((p, since, seen)) if now - seen <= SAVINGS_GAP_NS => (staked.min(p), since),
            _ => (staked, now),
        };
        if now - since >= SAVINGS_DELAY_NS {
            env::storage_remove(&pending_key(&account_id));
            m.savings = U128(amount);
            Event::SavingsSet { account_id, savings: m.savings }.emit();
        } else {
            env::storage_write(&pending_key(&account_id), &near_sdk::borsh::to_vec(&(amount, since, now)).unwrap());
            Event::SavingsPending { account_id, savings: U128(amount), counts_from: U64(since + SAVINGS_DELAY_NS) }.emit();
        }
    }

    /// A stake increase `sync_savings` read that does not count yet: (yoctoNEAR, counts from, last read), in ns. It
    /// counts from then only if no two readings until then are more than a day apart.
    pub fn get_pending_savings(&self, account_id: AccountId) -> Option<(U128, U64, U64)> {
        read_pending(&account_id).map(|(s, since, seen)| (U128(s), U64(since + SAVINGS_DELAY_NS), U64(seen)))
    }

    /// DAO only: the profit-share rule (reserve, savings, contribution), adding up to 10000 bps.
    pub fn set_share_rule(&mut self, rule: ShareRule) {
        self.assert_dao();
        check_rule(&rule);
        Event::ShareRuleSet { reserve_bps: rule.reserve_bps, savings_bps: rule.savings_bps, points_bps: rule.points_bps }.emit();
        self.share_rule = rule;
    }

    /// Move the co-op to another USDC contract (e.g. from a testnet stand-in to Circle's). Refused while any member
    /// still has a profit share to claim or a transfer to the DAO is pending: those are owed in the current token.
    pub fn set_usdc(&mut self, usdc_id: AccountId) {
        self.assert_dao();
        require!(usdc_id != self.usdc_id, "already this token");
        require!(self.unforwarded == 0, "flush_to_dao first: USDC owed to the DAO in the current token");
        let owed = read_u128(KEY_OWED_SHARES).unwrap_or_else(|| env::panic_str("call init_ledger first"));
        require!(owed == 0, "profit shares are still to be claimed in the current token");
        require!(read_u128(KEY_IN_FLIGHT) == Some(0), "a USDC transfer is still in flight");
        Event::UsdcSet { from: self.usdc_id.clone(), to: usdc_id.clone() }.emit();
        self.usdc_id = usdc_id;
    }

    /// Once, on a co-op deployed before the counters: start them from the current state. Exact when no former member
    /// holds an unclaimed share (true when the DAO never removed a member who had one); the DAO decides when to call it.
    pub fn init_ledger(&mut self) {
        self.assert_dao();
        require!(read_u128(KEY_OWED_SHARES).is_none(), "ledger already started");
        let owed: u128 = self.members.keys().map(|a| self.claimable.get(a).copied().unwrap_or(0)).sum();
        write_u128(KEY_OWED_SHARES, owed);
        write_u128(KEY_IN_FLIGHT, 0);
        Event::LedgerStarted { owed: U128(owed) }.emit();
    }

    /// (owed profit shares, USDC in flight); None before `init_ledger` on an older co-op.
    pub fn get_ledger(&self) -> Option<(U128, U128)> {
        Some((U128(read_u128(KEY_OWED_SHARES)?), U128(read_u128(KEY_IN_FLIGHT)?)))
    }

    /// DAO only: the account whose function-call key records receipts.
    pub fn set_agent(&mut self, agent_id: AccountId) {
        self.assert_dao();
        Event::AgentSet { agent_id: agent_id.clone() }.emit();
        env::storage_remove(crate::meeting::KEY_AGENT_PK); // a key seen before this appointment never counts
        self.agent_id = agent_id;
    }

    /// Appoint a new steward (the Agent Market account holder). The previous steward's bond goes back if they passed
    /// on every paid job's earnings; if they still owe any, it goes to the DAO (settle before handing over).
    pub fn set_steward(&mut self, steward: Option<AccountId>) {
        self.assert_dao();
        self.replace_steward(steward);
    }

    /// Settle the old steward's bond and start the new steward's term (also when a term runs out: `None`).
    fn replace_steward(&mut self, steward: Option<AccountId>) {
        let mut returned = NearToken::from_yoctonear(0);
        if let Some(old) = self.steward.take() {
            let bond = std::mem::replace(&mut self.steward_bond, NearToken::from_yoctonear(0));
            // a steward appointed before this code had no such rule: their bond goes back as it used to
            let owes = read_u128(KEY_STEWARD_PAID).is_some_and(|paid| paid > self.deposited - read_u128(KEY_STEWARD_DEPOSITED).unwrap_or(0));
            if !bond.is_zero() && owes {
                commons::mark(&old, |s| s.slashed += 1);
                Event::StewardSlashed { amount: bond }.emit();
                let _ = Promise::new(self.dao_id.clone()).transfer(bond);
            } else if !bond.is_zero() {
                returned = bond;
                let _ = Promise::new(old).transfer(returned);
            }
        }
        Event::StewardSet { steward: steward.clone(), bond_returned: returned }.emit();
        self.steward = steward;
        // the new steward answers only for jobs paid from now on
        env::storage_write(KEY_STEWARD_FROM, &env::block_timestamp().to_le_bytes());
        write_u128(KEY_STEWARD_DEPOSITED, self.deposited);
        write_u128(KEY_STEWARD_PAID, 0);
    }

    /// The steward kept money: its whole bond goes to the DAO.
    pub fn slash_steward(&mut self) -> NearToken {
        self.assert_dao();
        let bond = self.steward_bond;
        require!(!bond.is_zero(), "no bond");
        self.steward_bond = NearToken::from_yoctonear(0);
        if let Some(s) = &self.steward {
            commons::mark(s, |x| x.slashed += 1);
        }
        Event::StewardSlashed { amount: bond }.emit();
        let _ = Promise::new(self.dao_id.clone()).transfer(bond);
        bond
    }

    /// Anyone: if earnings of jobs paid more than `STEWARD_GRACE_NS` ago are still not passed on by this steward, the
    /// bond goes to the DAO, no vote needed. Only for a steward the DAO appointed under this code, and only for jobs paid
    /// since then: what was owed before had no such rule. The audit trusts the receipts of the agent the DAO appointed;
    /// a steward who runs that agent can hide a payout by never reporting it (trust assumptions in the README).
    pub fn slash_overdue(&mut self) -> NearToken {
        let overdue = self.get_overdue().0;
        require!(overdue > 0, "nothing is overdue: every job paid more than 7 days ago was passed on");
        let bond = std::mem::replace(&mut self.steward_bond, NearToken::from_yoctonear(0));
        require!(!bond.is_zero(), "no bond");
        if let Some(s) = &self.steward {
            commons::mark(s, |x| x.slashed += 1);
        }
        Event::StewardSlashedOverdue { amount: bond, overdue: U128(overdue) }.emit();
        let _ = Promise::new(self.dao_id.clone()).transfer(bond);
        bond
    }

    /// USDC of this steward's jobs, paid more than 7 days ago, that their deposits do not cover (oldest first).
    pub fn get_overdue(&self) -> U128 {
        U128(self.steward_unpaid(env::block_timestamp().saturating_sub(STEWARD_GRACE_NS)))
    }

    /// Earnings (net of the market fee) of jobs paid since this steward's appointment and before `until`, minus what
    /// they deposited since. ponytail: reads every receipt; only the permissionless slash and a steward change call it.
    fn steward_unpaid(&self, until: u64) -> u128 {
        let Some(from) = env::storage_read(KEY_STEWARD_FROM).map(|b| u64::from_le_bytes(b.try_into().unwrap_or([u8::MAX; 8]))) else {
            return 0; // no steward appointed under this code yet: fail closed
        };
        let gross: u128 = self.receipts.iter()
            .filter(|r| r.status == ReceiptStatus::Paid)
            // 0.3.2: only the founding agent's jobs, whose market account the steward holds; a further agent's receipts
            // cannot make the steward owe (automated review A1)
            .filter(|r| env::storage_read(&crate::lending::receipt_agent_key(&r.job_id)).is_none())
            .filter(|r| {
                let at = env::storage_read(&[PAID_AT_PREFIX, r.job_id.as_bytes()].concat())
                    .map_or(r.ts.0, |b| u64::from_le_bytes(b.try_into().unwrap_or([0; 8])));
                at >= from && at < until
            })
            .map(|r| r.price.0)
            .sum();
        let due = gross - gross * MARKET_FEE_BPS / BPS;
        due.saturating_sub(self.deposited - read_u128(KEY_STEWARD_DEPOSITED).unwrap_or(0))
    }

    /// The steward locks NEAR as a bond the DAO can slash if deposits fall short of the receipts.
    #[payable]
    pub fn bond_steward(&mut self) {
        let who = env::predecessor_account_id();
        require!(Some(&who) == self.steward.as_ref(), "only the steward");
        self.steward_bond = self.steward_bond.saturating_add(env::attached_deposit());
        Event::StewardBonded { steward: who, amount: env::attached_deposit(), bond: self.steward_bond }.emit();
    }

    /// Kill switch: the DAO or the steward can stop the agent; only the DAO can restart it.
    pub fn pause(&mut self) {
        let who = env::predecessor_account_id();
        require!(who == self.dao_id || Some(&who) == self.steward.as_ref(), "only the DAO or the steward");
        self.paused = true;
        Event::Paused { by: who }.emit();
    }

    /// DAO only: restart the agent after a pause.
    pub fn unpause(&mut self) {
        self.assert_dao();
        self.paused = false;
        Event::Unpaused {}.emit();
    }

    /// The only way to change this contract's code. Wasm is far too large to pass through a proposal, so a member
    /// first publishes it as a NEAR global contract (immutable, addressed by its sha256); the members then vote a
    /// FunctionCall `upgrade({code_hash})` and the contract switches itself to exactly that code. The contract
    /// account keeps no full-access key, so nobody can deploy around the vote. New code must keep the state layout.
    pub fn upgrade(&mut self, code_hash: Base58CryptoHash) -> Promise {
        self.assert_dao();
        Event::Upgraded { code_hash: String::from(&code_hash) }.emit();
        Promise::new(env::current_account_id()).use_global_contract(code_hash)
    }

    // ---------- the agent (function-call key, no deposit) ----------

    /// Agent only: the receipt of one job, refused unless the agent runs the approved config and the co-op runs.
    pub fn record_receipt(
        &mut self,
        job_id: String,
        price: U128,
        inference_cost: U128,
        config_hash: String,
        deliverable_hash: String,
        proof: Option<String>,
    ) {
        self.assert_agent();
        crate::meeting::note_agent_key(&self.agent_id);
        crate::solidarity::assert_tee_ok(&env::predecessor_account_id());
        require!(!self.paused, "koperasi is paused");
        require!(!crate::meeting::agent_suspended(), "the agent is suspended by the co-op court (3 upheld cases in 90 days): the members reinstate it by vote");
        // 0.3.2: a further agent with its own voted by-laws runs those; every other agent the co-op's
        let own = crate::lending::agent_config(&env::predecessor_account_id());
        let (want, version) = own.as_ref().map_or((&self.config.hash, self.config.version), |c| (&c.hash, c.version));
        require!(config_hash == *want, "config_mismatch: the agent is not running the approved config");
        require!(!job_id.is_empty() && job_id.len() <= 128, "bad job_id");
        require!(deliverable_hash.len() <= 128, "bad deliverable_hash");
        require!(!self.receipt_index.contains_key(&job_id), "receipt exists");
        if let Some(p) = proof {
            require!(p.len() <= MAX_PROOF_LEN, "proof too long");
            env::storage_write(&proof_key(&job_id), p.as_bytes());
        }
        Event::ReceiptRecorded { job_id: job_id.clone(), price, inference_cost, config_version: self.config.version }.emit();
        if env::predecessor_account_id() != self.agent_id {
            env::storage_write(&crate::lending::receipt_agent_key(&job_id), env::predecessor_account_id().as_bytes());
        }
        self.receipt_index.insert(job_id.clone(), self.receipts.len());
        self.receipts.push(Receipt {
            job_id,
            price,
            inference_cost,
            config_version: version,
            config_hash,
            deliverable_hash,
            status: ReceiptStatus::Submitted,
            ts: U64(env::block_timestamp()),
        });
    }

    /// Agent only: mirror the market's verdict (Submitted to Paid, Refunded or Disputed; Disputed to Paid or Refunded).
    pub fn update_receipt(&mut self, job_id: String, status: ReceiptStatus) {
        self.assert_agent();
        crate::meeting::note_agent_key(&self.agent_id);
        crate::solidarity::assert_tee_ok(&env::predecessor_account_id());
        let i = *self.receipt_index.get(&job_id).unwrap_or_else(|| env::panic_str("no receipt"));
        require!(self.get_receipt_agent(job_id.clone()) == env::predecessor_account_id(), "only the agent that recorded it");
        let r = self.receipts.get_mut(i).unwrap();
        use ReceiptStatus::*;
        let ok = matches!((r.status, status), (Submitted, Paid | Refunded | Disputed) | (Disputed, Paid | Refunded));
        require!(ok, "invalid status change");
        r.status = status;
        if status == Disputed {
            env::storage_write(&commons::disputed_key(&job_id), &[1]);
        }
        if status == Paid {
            env::storage_write(&[PAID_AT_PREFIX, job_id.as_bytes()].concat(), &env::block_timestamp().to_le_bytes());
            let net = r.price.0 - r.price.0 * MARKET_FEE_BPS / BPS;
            if env::storage_read(&crate::lending::receipt_agent_key(&job_id)).is_none() {
                bump(KEY_STEWARD_PAID, net, false); // only once a steward was appointed under this code; founding agent only
            }
        }
        Event::ReceiptUpdated { job_id, status }.emit();
    }

    // ---------- money in: USDC ft_transfer_call ----------

    /// `msg = "earnings"` from the steward: Agent Market earnings, forwarded to the DAO and counted for reconciliation.
    /// `msg = "share"` from the DAO: split as a profit share. Anything else is returned.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        if env::predecessor_account_id() != self.usdc_id {
            return PromiseOrValue::Value(amount);
        }
        match msg.as_str() {
            "earnings" if Some(&sender_id) == self.steward.as_ref() => {
                self.deposited += amount.0;
                Event::EarningsDeposited { amount }.emit();
                // 0.3.2: the agent saves a voted share of what it earned into the risk fund, for its own mistakes
                let saved = amount.0 * crate::lending::agent_saves_bps() as u128 / BPS;
                if saved > 0 {
                    crate::lending::add_risk(saved);
                    Event::AgentSaved { amount: U128(saved) }.emit();
                }
                self.forward_to_dao(amount.0 - saved);
                PromiseOrValue::Value(U128(0))
            }
            "share" if sender_id == self.dao_id => {
                if read_u128(KEY_RESERVE_FLOOR).unwrap_or(0) == 0 {
                    return PromiseOrValue::Value(U128(self.share_now(amount.0)));
                }
                // read what the DAO keeps outside this share before splitting it
                ext_ft::ext(self.usdc_id.clone())
                    .with_static_gas(GAS_VIEW)
                    .ft_balance_of(self.dao_id.clone())
                    .then(Self::ext(env::current_account_id()).with_static_gas(GAS_SHARE).on_dao_balance(amount))
                    .into()
            }
            _ => PromiseOrValue::Value(amount),
        }
    }

    fn share_now(&mut self, amount: u128) -> u128 {
        let reserve = self.distribute(amount);
        // 0.3.0: the education and social funds the members voted come out of the reserve part
        let reserve = self.pay_funds(amount, reserve);
        // 0.3.2: a reputation dividend, by each member's credit score, also out of the reserve part
        let reserve = self.pay_reputation(amount, reserve);
        // 0.3.3: the agent's own share, into the risk fund its mistakes are refunded from
        let reserve = self.pay_agent_share(amount, reserve);
        if reserve > 0 {
            self.forward_to_dao(reserve);
        }
        0
    }

    /// Callback of a profit share under a reserve floor: split it, or send it all back (returned as unused).
    #[private]
    pub fn on_dao_balance(&mut self, amount: U128, #[callback_result] balance: Result<U128, PromiseError>) -> U128 {
        let floor = read_u128(KEY_RESERVE_FLOOR).unwrap_or(0);
        match balance {
            Ok(b) if b.0 >= floor => U128(self.share_now(amount.0)),
            b => {
                Event::ShareRefused { amount, dao_balance: b.ok(), floor: U128(floor) }.emit();
                amount
            }
        }
    }

    /// DAO only: the least USDC the treasury must keep outside a profit share (0: no floor). A share that would leave
    /// less goes back to the DAO whole.
    pub fn set_reserve_floor(&mut self, amount: U128) {
        self.assert_dao();
        write_u128(KEY_RESERVE_FLOOR, amount.0);
        Event::ReserveFloorSet { amount }.emit();
    }

    pub fn get_reserve_floor(&self) -> U128 {
        U128(read_u128(KEY_RESERVE_FLOOR).unwrap_or(0))
    }

    /// Credit every member's share and return what stays in the DAO (reserve + rounding + unused pools).
    fn distribute(&mut self, amount: u128) -> u128 {
        require!(!self.members.is_empty(), "no members");
        let r = &self.share_rule;
        let simp_pool = amount * r.savings_bps as u128 / BPS;
        let points_pool = amount * r.points_bps as u128 / BPS;
        // ponytail: one pass over all members; fine for a co-op of hundreds, page it if one grows past that.
        let total_simp: u128 = self.members.values().map(|m| m.savings.0 / SAVINGS_UNIT).sum();
        let total_points: u128 = self.members.values().map(|m| m.points as u128).sum();
        let mut paid = 0u128;
        let count = self.members.len();
        for (a, m) in self.members.iter_mut() {
            let mut share = 0;
            // checked_div: an empty pool (nobody saved, or no points) pays nothing from it
            share += (simp_pool * (m.savings.0 / SAVINGS_UNIT)).checked_div(total_simp).unwrap_or(0);
            share += (points_pool * m.points as u128).checked_div(total_points).unwrap_or(0);
            // points halve at each share instead of resetting: recent work counts most, and a share right after the
            // last one still has a points pool to pay (a reset sent that 40% to the reserve)
            m.points /= 2;
            if share > 0 {
                let c = self.claimable.get(a).copied().unwrap_or(0);
                self.claimable.insert(a.clone(), c + share);
                paid += share;
            }
        }
        bump(KEY_OWED_SHARES, paid, false);
        let reserve = amount - paid;
        Event::ShareDistributed { period: self.periods.len() + 1, amount: U128(amount), paid: U128(paid), reserve: U128(reserve), members: count }.emit();
        self.periods.push(Period {
            id: self.periods.len() + 1,
            amount: U128(amount),
            reserve: U128(reserve),
            members: count,
            ts: U64(env::block_timestamp()),
        });
        reserve
    }

    fn forward_to_dao(&mut self, amount: u128) {
        bump(KEY_IN_FLIGHT, amount, false);
        let _ = ext_ft::ext(self.usdc_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(self.dao_id.clone(), U128(amount), Some("koperasi".into()))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_forwarded(U128(amount)));
    }

    /// Callback of a transfer to the DAO.
    #[private]
    pub fn on_forwarded(&mut self, amount: U128, #[callback_result] r: Result<(), PromiseError>) {
        bump(KEY_IN_FLIGHT, amount.0, true);
        if r.is_err() {
            self.unforwarded += amount.0;
            Event::ForwardFailed { amount }.emit();
        }
    }

    /// Retry USDC transfers to the DAO that failed (e.g. before the DAO registered storage on the token).
    pub fn flush_to_dao(&mut self) {
        let amount = std::mem::take(&mut self.unforwarded);
        require!(amount > 0, "nothing to flush");
        self.forward_to_dao(amount);
    }

    // ---------- profit share ----------

    /// Take your profit share in USDC (pull: each member claims their own). A failed transfer puts it back.
    pub fn claim_share(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        let amount = self.claimable.remove(&who).unwrap_or(0);
        require!(amount > 0, "nothing to claim");
        bump(KEY_OWED_SHARES, amount, true);
        bump(KEY_IN_FLIGHT, amount, false);
        Event::ShareClaimed { account_id: who.clone(), amount: U128(amount) }.emit();
        ext_ft::ext(self.usdc_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(who.clone(), U128(amount), Some("Koperasi profit share".into()))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_claimed(who, U128(amount)))
    }

    /// Callback of `claim_share`.
    #[private]
    pub fn on_claimed(&mut self, account_id: AccountId, amount: U128, #[callback_result] r: Result<(), PromiseError>) {
        bump(KEY_IN_FLIGHT, amount.0, true);
        if r.is_err() {
            Event::ClaimRolledBack { account_id: account_id.clone(), amount }.emit();
            bump(KEY_OWED_SHARES, amount.0, false);
            let c = self.claimable.get(&account_id).copied().unwrap_or(0);
            self.claimable.insert(account_id, c + amount.0);
        }
    }

    // ---------- views ----------

    /// Everything a dashboard needs in one read.
    pub fn get_info(&self) -> Info {
        Info {
            dao_id: self.dao_id.clone(),
            usdc_id: self.usdc_id.clone(),
            agent_id: self.agent_id.clone(),
            steward: self.steward.clone(),
            steward_bond: self.steward_bond,
            join_deposit: self.join_deposit,
            paused: self.paused,
            config: self.config.clone(),
            share_rule: self.share_rule.clone(),
            members: self.members.len(),
            receipts: self.receipts.len(),
            periods: self.periods.len(),
            unforwarded: U128(self.unforwarded),
        }
    }

    /// The by-laws in force.
    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    /// Every version of the by-laws, oldest first.
    pub fn get_config_history(&self, from: Option<u32>, limit: Option<u32>) -> Vec<Config> {
        let from = from.unwrap_or(0);
        self.config_history.iter().skip(from as usize).take(limit.unwrap_or(50) as usize).cloned().collect()
    }

    /// Members with their deposit, savings and points, a page at a time.
    pub fn get_members(&self, from: Option<u32>, limit: Option<u32>) -> Vec<(AccountId, Member)> {
        self.members
            .iter()
            .skip(from.unwrap_or(0) as usize)
            .take(limit.unwrap_or(100) as usize)
            .map(|(a, m)| (a.clone(), m.clone()))
            .collect()
    }

    /// One member, if they are one.
    pub fn get_member(&self, account_id: AccountId) -> Option<Member> {
        self.members.get(&account_id).cloned()
    }

    /// Paid the join deposit and waits for the vote.
    pub fn is_pending(&self, account_id: AccountId) -> bool {
        self.pending.contains_key(&account_id)
    }

    /// The agent's receipts, a page at a time.
    pub fn get_receipts(&self, from: Option<u32>, limit: Option<u32>) -> Vec<Receipt> {
        self.receipts.iter().skip(from.unwrap_or(0) as usize).take(limit.unwrap_or(50) as usize).cloned().collect()
    }

    /// The inference proof the agent recorded with a job's receipt, if any (JSON text).
    pub fn get_proof(&self, job_id: String) -> Option<String> {
        env::storage_read(&proof_key(&job_id)).and_then(|b| String::from_utf8(b).ok())
    }

    /// Every profit share so far.
    pub fn get_periods(&self) -> Vec<Period> {
        self.periods.iter().cloned().collect()
    }

    /// The profit share waiting for this account.
    pub fn get_claimable(&self, account_id: AccountId) -> U128 {
        U128(self.claimable.get(&account_id).copied().unwrap_or(0))
    }

    /// What the steward owes: paid receipts net of the market fee, against deposits.
    pub fn get_audit(&self) -> Audit {
        let gross: u128 =
            self.receipts.iter().filter(|r| r.status == ReceiptStatus::Paid).map(|r| r.price.0).sum();
        let expected = gross - gross * MARKET_FEE_BPS / BPS;
        Audit {
            expected: U128(expected),
            deposited: U128(self.deposited),
            owed: U128(expected.saturating_sub(self.deposited)),
        }
    }
}

#[cfg(test)]
mod tests;
mod tasks;
mod commons;
mod reach;
mod meeting;
mod lending;
mod solidarity;
mod referrals;
mod recovery;
pub use commons::*;
pub use tasks::*;
