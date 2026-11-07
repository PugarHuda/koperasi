//! Koperasi: an AI agent owned and governed by its members.
//!
//! The Sputnik DAO (`dao_id`) is the source of truth for membership (role `member`) and the only account that
//! can change the agent's config (its by-laws), award contribution points, set savings weights
//! ("savings") or move the steward's bond. This contract adds what Sputnik does not have: the config the
//! agent must run, a receipt for every job, on-chain reconciliation of the steward's deposits, and the
//! profit share split by savings + contribution points, with a reserve returned to the DAO.

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

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
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
const KEY_OWED_SHARES: &[u8] = b"owed_shares";
/// Σ USDC sent by ft_transfer whose callback has not come back yet (claims and transfers to the DAO).
const KEY_IN_FLIGHT: &[u8] = b"in_flight";

fn read_u128(key: &[u8]) -> Option<u128> {
    env::storage_read(key).map(|b| u128::from_le_bytes(b.try_into().unwrap_or_else(|_| env::panic_str("bad counter"))))
}
fn write_u128(key: &[u8], v: u128) {
    env::storage_write(key, &v.to_le_bytes());
}
/// Add to (or, with `sub`, take from) a counter. Counters exist from `new`, or from `init_ledger` on older co-ops.
fn bump(key: &[u8], by: u128, sub: bool) {
    if let Some(v) = read_u128(key) {
        write_u128(key, if sub { v.saturating_sub(by) } else { v + by });
    }
}

fn proof_key(job_id: &str) -> Vec<u8> {
    [PROOF_PREFIX, job_id.as_bytes()].concat()
}

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
        require!(env::predecessor_account_id() == self.agent_id, "only the agent");
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

    #[private]
    pub fn on_cancel_policy(&mut self, account_id: AccountId, #[callback_result] policy: Result<Value, PromiseError>) {
        let policy = policy.unwrap_or_else(|_| env::panic_str("could not read DAO policy"));
        if role_has(&policy, MEMBER_ROLE, &account_id) {
            log!("{} was already voted in: admitted instead of refunded", account_id);
            self.apply_membership(account_id, true);
        } else if let Some(join_deposit) = self.pending.remove(&account_id) {
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
                log!("new member: {}", account_id);
            }
        } else if let Some(m) = self.members.remove(&account_id) {
            log!("member left: {}", account_id);
            let _ = Promise::new(account_id).transfer(m.join_deposit);
        }
    }

    // ---------- members' vote (DAO only) ----------

    /// Change the agent's by-laws. The agent refuses to work until it runs this exact config.
    pub fn set_config(&mut self, version: u32, hash: String, uri: String, contributor: Option<AccountId>, points: u64) {
        self.assert_dao();
        require!(version > self.config.version, "version must increase");
        require!(valid_hash(&hash), "hash must be 64 lowercase hex chars");
        if let Some(c) = &contributor {
            self.add_points(c, points);
        }
        self.config = Config { version, hash, uri, contributor, activated_at: U64(env::block_timestamp()) };
        self.config_history.push(self.config.clone());
    }

    pub fn award_points(&mut self, account_id: AccountId, points: u64, reason: String) {
        self.assert_dao();
        self.add_points(&account_id, points);
        log!("+{} points for {}: {}", points, account_id, reason);
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
        }
    }

    /// Choose the staking pool whose stake counts as savings (None: savings only by `set_savings` votes).
    pub fn set_staking_pool(&mut self, pool: Option<AccountId>) {
        self.assert_dao();
        match pool {
            Some(p) => {
                env::storage_write(KEY_STAKING_POOL, p.as_bytes());
            }
            None => {
                env::storage_remove(KEY_STAKING_POOL);
            }
        }
    }

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

    #[private]
    pub fn on_staked(&mut self, account_id: AccountId, #[callback_result] staked: Result<U128, PromiseError>) {
        let staked = staked.unwrap_or_else(|_| env::panic_str("could not read the staking pool"));
        if let Some(m) = self.members.get_mut(&account_id) {
            m.savings = staked;
            log!("savings of {}: {} yocto staked", account_id, staked.0);
        }
    }

    pub fn set_share_rule(&mut self, rule: ShareRule) {
        self.assert_dao();
        check_rule(&rule);
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
        log!("usdc: {} -> {}", self.usdc_id, usdc_id);
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
        log!("ledger started: {} owed in profit shares", owed);
    }

    /// (owed profit shares, USDC in flight); None before `init_ledger` on an older co-op.
    pub fn get_ledger(&self) -> Option<(U128, U128)> {
        Some((U128(read_u128(KEY_OWED_SHARES)?), U128(read_u128(KEY_IN_FLIGHT)?)))
    }

    pub fn set_agent(&mut self, agent_id: AccountId) {
        self.assert_dao();
        self.agent_id = agent_id;
    }

    /// Appoint a new steward (the Agent Market account holder). Any bond of the previous steward goes back.
    pub fn set_steward(&mut self, steward: Option<AccountId>) {
        self.assert_dao();
        if let Some(old) = self.steward.take() {
            if !self.steward_bond.is_zero() {
                let _ = Promise::new(old).transfer(self.steward_bond);
                self.steward_bond = NearToken::from_yoctonear(0);
            }
        }
        self.steward = steward;
    }

    /// The steward kept money: its whole bond goes to the DAO.
    pub fn slash_steward(&mut self) -> NearToken {
        self.assert_dao();
        let bond = self.steward_bond;
        require!(!bond.is_zero(), "no bond");
        self.steward_bond = NearToken::from_yoctonear(0);
        let _ = Promise::new(self.dao_id.clone()).transfer(bond);
        bond
    }

    #[payable]
    pub fn bond_steward(&mut self) {
        require!(Some(env::predecessor_account_id()) == self.steward, "only the steward");
        self.steward_bond = self.steward_bond.saturating_add(env::attached_deposit());
    }

    /// Kill switch: the DAO or the steward can stop the agent; only the DAO can restart it.
    pub fn pause(&mut self) {
        let who = env::predecessor_account_id();
        require!(who == self.dao_id || Some(who) == self.steward, "only the DAO or the steward");
        self.paused = true;
    }

    pub fn unpause(&mut self) {
        self.assert_dao();
        self.paused = false;
    }

    /// The only way to change this contract's code. Wasm is far too large to pass through a proposal, so a member
    /// first publishes it as a NEAR global contract (immutable, addressed by its sha256); the members then vote a
    /// FunctionCall `upgrade({code_hash})` and the contract switches itself to exactly that code. The contract
    /// account keeps no full-access key, so nobody can deploy around the vote. New code must keep the state layout.
    pub fn upgrade(&mut self, code_hash: Base58CryptoHash) -> Promise {
        self.assert_dao();
        log!("upgrade by vote to global contract code {}", String::from(&code_hash));
        Promise::new(env::current_account_id()).use_global_contract(code_hash)
    }

    // ---------- the agent (function-call key, no deposit) ----------

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
        require!(!self.paused, "koperasi is paused");
        require!(config_hash == self.config.hash, "config_mismatch: the agent is not running the approved config");
        require!(!job_id.is_empty() && job_id.len() <= 128, "bad job_id");
        require!(deliverable_hash.len() <= 128, "bad deliverable_hash");
        require!(!self.receipt_index.contains_key(&job_id), "receipt exists");
        if let Some(p) = proof {
            require!(p.len() <= MAX_PROOF_LEN, "proof too long");
            env::storage_write(&proof_key(&job_id), p.as_bytes());
        }
        self.receipt_index.insert(job_id.clone(), self.receipts.len());
        self.receipts.push(Receipt {
            job_id,
            price,
            inference_cost,
            config_version: self.config.version,
            config_hash,
            deliverable_hash,
            status: ReceiptStatus::Submitted,
            ts: U64(env::block_timestamp()),
        });
    }

    pub fn update_receipt(&mut self, job_id: String, status: ReceiptStatus) {
        self.assert_agent();
        let i = *self.receipt_index.get(&job_id).unwrap_or_else(|| env::panic_str("no receipt"));
        let r = self.receipts.get_mut(i).unwrap();
        use ReceiptStatus::*;
        let ok = matches!((r.status, status), (Submitted, Paid | Refunded | Disputed) | (Disputed, Paid | Refunded));
        require!(ok, "invalid status change");
        r.status = status;
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
                self.forward_to_dao(amount.0);
                PromiseOrValue::Value(U128(0))
            }
            "share" if sender_id == self.dao_id => {
                let reserve = self.distribute(amount.0);
                if reserve > 0 {
                    self.forward_to_dao(reserve);
                }
                PromiseOrValue::Value(U128(0))
            }
            _ => PromiseOrValue::Value(amount),
        }
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
            if total_simp > 0 {
                share += simp_pool * (m.savings.0 / SAVINGS_UNIT) / total_simp;
            }
            if total_points > 0 {
                share += points_pool * m.points as u128 / total_points;
            }
            m.points = 0;
            if share > 0 {
                let c = self.claimable.get(a).copied().unwrap_or(0);
                self.claimable.insert(a.clone(), c + share);
                paid += share;
            }
        }
        bump(KEY_OWED_SHARES, paid, false);
        let reserve = amount - paid;
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

    #[private]
    pub fn on_forwarded(&mut self, amount: U128, #[callback_result] r: Result<(), PromiseError>) {
        bump(KEY_IN_FLIGHT, amount.0, true);
        if r.is_err() {
            self.unforwarded += amount.0;
        }
    }

    /// Retry USDC transfers to the DAO that failed (e.g. before the DAO registered storage on the token).
    pub fn flush_to_dao(&mut self) {
        let amount = std::mem::take(&mut self.unforwarded);
        require!(amount > 0, "nothing to flush");
        self.forward_to_dao(amount);
    }

    // ---------- profit share ----------

    pub fn claim_share(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        let amount = self.claimable.remove(&who).unwrap_or(0);
        require!(amount > 0, "nothing to claim");
        bump(KEY_OWED_SHARES, amount, true);
        bump(KEY_IN_FLIGHT, amount, false);
        ext_ft::ext(self.usdc_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(who.clone(), U128(amount), Some("Koperasi profit share".into()))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_claimed(who, U128(amount)))
    }

    #[private]
    pub fn on_claimed(&mut self, account_id: AccountId, amount: U128, #[callback_result] r: Result<(), PromiseError>) {
        bump(KEY_IN_FLIGHT, amount.0, true);
        if r.is_err() {
            bump(KEY_OWED_SHARES, amount.0, false);
            let c = self.claimable.get(&account_id).copied().unwrap_or(0);
            self.claimable.insert(account_id, c + amount.0);
        }
    }

    // ---------- views ----------

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

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    pub fn get_config_history(&self, from: Option<u32>, limit: Option<u32>) -> Vec<Config> {
        let from = from.unwrap_or(0);
        self.config_history.iter().skip(from as usize).take(limit.unwrap_or(50) as usize).cloned().collect()
    }

    pub fn get_members(&self, from: Option<u32>, limit: Option<u32>) -> Vec<(AccountId, Member)> {
        self.members
            .iter()
            .skip(from.unwrap_or(0) as usize)
            .take(limit.unwrap_or(100) as usize)
            .map(|(a, m)| (a.clone(), m.clone()))
            .collect()
    }

    pub fn get_member(&self, account_id: AccountId) -> Option<Member> {
        self.members.get(&account_id).cloned()
    }

    pub fn is_pending(&self, account_id: AccountId) -> bool {
        self.pending.contains_key(&account_id)
    }

    pub fn get_receipts(&self, from: Option<u32>, limit: Option<u32>) -> Vec<Receipt> {
        self.receipts.iter().skip(from.unwrap_or(0) as usize).take(limit.unwrap_or(50) as usize).cloned().collect()
    }

    /// The inference proof the agent recorded with a job's receipt, if any (JSON text).
    pub fn get_proof(&self, job_id: String) -> Option<String> {
        env::storage_read(&proof_key(&job_id)).and_then(|b| String::from_utf8(b).ok())
    }

    pub fn get_periods(&self) -> Vec<Period> {
        self.periods.iter().cloned().collect()
    }

    pub fn get_claimable(&self, account_id: AccountId) -> U128 {
        U128(self.claimable.get(&account_id).copied().unwrap_or(0))
    }

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
