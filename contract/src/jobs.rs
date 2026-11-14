//! Contract 0.3.10 (after the hackathon deadline): a job market between the co-ops' agents.
//!
//! - **Offering** (this co-op posts): its agent (directly, or anyone with its signature, own nonce) offers its sister
//!   co-ops a job with a budget and a deadline (`post_coop_job`).
//! - **Bidding** (this co-op bids on a sister's job): a sister's contract does not know this co-op's agent key, so a bid is
//!   kept HERE, on the bidder's own contract, by its own agent (`place_bid`, same gates as its receipts: not paused, not
//!   suspended, attested if TEE-only), and read by the posting co-op (`get_bids_for`).
//! - **Awarding**: after the deadline anyone calls `award_coop_job` on the posting co-op; it reads each sister's bid
//!   (one view per sister, at most 5) and gives the job to the best: credit x budget / price, with the bidder's
//!   federation credit score as this co-op sees it (`get_coop_credit`; score 0 does not win). A bid counts only if it
//!   names this co-op and the job, asks 1..=budget, and was placed between the posting and the deadline.
//!
//! Bounded: job_id 1 to 128 printable characters, description at most 280, one bid per co-op per job, the last 200 jobs
//! and bids kept. State lives under its own storage keys, so the upgrade needs no state migration.

use crate::tasks::{load, save, DAY_NS};
use crate::*;

const KEY_JOB_NONCE: &[u8] = b"coop_job_nonce";
const KEY_BID_NONCE: &[u8] = b"coop_bid_nonce";
const KEY_JOB_COUNT: &[u8] = b"coop_job_count";
const KEY_BID_COUNT: &[u8] = b"coop_bid_count";
pub const MAX_COOP_JOBS: u32 = 200;
pub const MAX_COOP_BIDS: u32 = 200;
/// Sisters whose bids an award reads (one cross-contract view each).
pub const MAX_BIDDERS: usize = 5;
const MAX_DESCRIPTION: usize = 280;
const MAX_DEADLINE_HOURS: u32 = 720;
const HOUR_NS: u64 = DAY_NS / 24;
const GAS_READ_BID: Gas = Gas::from_tgas(5);
const GAS_AWARDED: Gas = Gas::from_tgas(20);
/// A sister's answer longer than this is not a bid.
const MAX_BID_BYTES: usize = 1024;

fn job_key(i: u32) -> Vec<u8> {
    format!("coop_job:{i}").into_bytes()
}
fn job_id_key(job_id: &str) -> Vec<u8> {
    format!("coop_job_id:{job_id}").into_bytes()
}
fn bid_key(from_coop: &AccountId, job_id: &str) -> Vec<u8> {
    format!("coop_bid:{from_coop}:{job_id}").into_bytes()
}
fn bid_index_key(i: u32) -> Vec<u8> {
    format!("coop_bid_index:{i}").into_bytes()
}
fn check_job_id(job_id: &str) {
    require!(!job_id.is_empty() && job_id.len() <= 128 && job_id.bytes().all(|b| b.is_ascii_graphic()), "job_id: 1 to 128 characters, no spaces");
}
/// The agent's gates: not paused, not suspended, attested if TEE-only; then the agent itself or its signature.
fn assert_agent_gate(k: &Koperasi, signature: Option<&str>, msg: impl FnOnce() -> String) {
    require!(!k.paused, "koperasi is paused");
    require!(!crate::meeting::agent_suspended(), "the agent is suspended");
    crate::solidarity::assert_tee_ok(&k.agent_id);
    crate::meeting::assert_agent_or_signed(&k.agent_id, signature, msg);
}

/// What this co-op's agent signs to offer a job (bound to this contract and to the job nonce).
pub fn coop_job_message(contract: &AccountId, nonce: u32, job_id: &str, budget_usdc: u128, deadline_hours: u32, description: &str) -> String {
    format!("koperasi-agent-job/1 {contract} #{nonce} {job_id} {budget_usdc} {deadline_hours}\n{description}")
}
/// What this co-op's agent signs to bid for sister `from_coop`'s job (bound to this contract and to the bid nonce).
pub fn bid_message(contract: &AccountId, nonce: u32, from_coop: &AccountId, job_id: &str, price_usdc: u128) -> String {
    format!("koperasi-agent-bid/1 {contract} #{nonce} {from_coop} {job_id} {price_usdc}")
}

/// A job this co-op offers its sister co-ops; `winner` and `price` once awarded.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct CoopJob {
    pub id: u32,
    pub job_id: String,
    pub budget_usdc: U128,
    pub description: String,
    pub posted_at: U64,
    pub deadline: U64,
    pub winner: Option<AccountId>,
    pub price: Option<U128>,
}

/// This co-op's bid for a job sister co-op `from_coop` offers.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct CoopBid {
    pub job_id: String,
    pub from_coop: AccountId,
    pub price_usdc: U128,
    pub at: U64,
}

#[ext_contract(ext_bids)]
#[allow(dead_code)]
trait CoopBids {
    fn get_bids_for(&self, from_coop: AccountId, job_id: String) -> Option<CoopBid>;
}

#[near]
impl Koperasi {
    /// This co-op's agent offers its sister co-ops `job_id` for at most `budget_usdc`, bids open for `deadline_hours`
    /// (1 to 720): directly, or anyone submitting its ed25519 signature (base64) of `get_coop_job_message(...)`.
    pub fn post_coop_job(&mut self, job_id: String, budget_usdc: U128, deadline_hours: u32, description: String, signature: Option<String>) -> u32 {
        let nonce: u32 = load(KEY_JOB_NONCE).unwrap_or(0);
        assert_agent_gate(self, signature.as_deref(),
            || coop_job_message(&env::current_account_id(), nonce, &job_id, budget_usdc.0, deadline_hours, &description));
        check_job_id(&job_id);
        require!(!description.trim().is_empty() && description.len() <= MAX_DESCRIPTION, "description: 1 to 280 characters");
        require!(budget_usdc.0 > 0, "a budget");
        require!((1..=MAX_DEADLINE_HOURS).contains(&deadline_hours), "deadline 1 to 720 hours");
        require!(!env::storage_has_key(&job_id_key(&job_id)), "this job is already offered");
        save(KEY_JOB_NONCE, &(nonce + 1)); // a signature counts once
        let id: u32 = load(KEY_JOB_COUNT).unwrap_or(0);
        save(KEY_JOB_COUNT, &(id + 1));
        if id >= MAX_COOP_JOBS {
            if let Some(old) = load::<CoopJob>(&job_key(id - MAX_COOP_JOBS)) {
                env::storage_remove(&job_key(old.id));
                env::storage_remove(&job_id_key(&old.job_id));
            }
        }
        let now = env::block_timestamp();
        let deadline = U64(now + deadline_hours as u64 * HOUR_NS);
        save(&job_key(id), &CoopJob { id, job_id: job_id.clone(), budget_usdc, description, posted_at: U64(now), deadline, winner: None, price: None });
        save(&job_id_key(&job_id), &id);
        Event::CoopJobPosted { job_id, budget_usdc, deadline }.emit();
        id
    }

    /// The exact text the agent signs for its next `post_coop_job`.
    pub fn get_coop_job_message(&self, job_id: String, budget_usdc: U128, deadline_hours: u32, description: String) -> String {
        coop_job_message(&env::current_account_id(), load(KEY_JOB_NONCE).unwrap_or(0), &job_id, budget_usdc.0, deadline_hours, &description)
    }

    pub fn get_coop_job(&self, job_id: String) -> Option<CoopJob> {
        load::<u32>(&job_id_key(&job_id)).and_then(|i| load(&job_key(i)))
    }

    /// Jobs still kept (the last 200), oldest first from `from`; at most `limit` (50 by default, 200 at most).
    pub fn get_coop_jobs(&self, from: Option<u32>, limit: Option<u32>) -> Vec<CoopJob> {
        let n: u32 = load(KEY_JOB_COUNT).unwrap_or(0);
        let from = from.unwrap_or(0).max(n.saturating_sub(MAX_COOP_JOBS));
        let to = n.min(from.saturating_add(limit.unwrap_or(50).min(MAX_COOP_JOBS)));
        (from..to).filter_map(|i| load(&job_key(i))).collect()
    }

    /// Anyone, after the deadline: read each sister co-op's bid (the first 5 sisters) and award the job to the best.
    pub fn award_coop_job(&mut self, job_id: String) -> Promise {
        require!(!self.paused, "koperasi is paused");
        let job = self.get_coop_job(job_id.clone()).unwrap_or_else(|| env::panic_str("no such job"));
        require!(job.winner.is_none(), "already awarded");
        require!(env::block_timestamp() > job.deadline.0, "bids are still open");
        let coops: Vec<AccountId> = self.get_sister_coops().into_iter().take(MAX_BIDDERS).collect();
        require!(!coops.is_empty(), "no sister co-ops");
        let me = env::current_account_id();
        let read = |c: &AccountId| ext_bids::ext(c.clone()).with_static_gas(GAS_READ_BID).get_bids_for(me.clone(), job_id.clone());
        let all = coops[1..].iter().fold(read(&coops[0]), |p, c| p.and(read(c)));
        all.then(Self::ext(me.clone()).with_static_gas(GAS_AWARDED).on_coop_bids(job_id, coops))
    }

    /// Callback of `award_coop_job`: result i is sister `coops[i]`'s bid (a failed or malformed read is no bid).
    #[private]
    pub fn on_coop_bids(&mut self, job_id: String, coops: Vec<AccountId>) -> AccountId {
        require!(env::promise_results_count() == coops.len() as u64, "one answer per sister");
        let bids = coops.iter().enumerate().map(|(i, _)| env::promise_result_checked(i as u64, MAX_BID_BYTES).ok()
            .and_then(|b| near_sdk::serde_json::from_slice::<Option<CoopBid>>(&b).ok()).flatten()).collect();
        self.award(job_id, coops, bids)
    }

    /// This co-op's agent bids `price_usdc` for job `job_id` that sister co-op `from_coop` offers: directly, or anyone
    /// submitting its ed25519 signature (base64) of `get_bid_message(...)`. One bid per job; the poster reads it.
    pub fn place_bid(&mut self, from_coop: AccountId, job_id: String, price_usdc: U128, signature: Option<String>) {
        let nonce: u32 = load(KEY_BID_NONCE).unwrap_or(0);
        assert_agent_gate(self, signature.as_deref(), || bid_message(&env::current_account_id(), nonce, &from_coop, &job_id, price_usdc.0));
        check_job_id(&job_id);
        require!(price_usdc.0 > 0, "a price");
        require!(self.get_sister_coops().contains(&from_coop), "not a sister co-op the members recognise");
        require!(!env::storage_has_key(&bid_key(&from_coop, &job_id)), "already bid for this job");
        save(KEY_BID_NONCE, &(nonce + 1)); // a signature counts once
        let i: u32 = load(KEY_BID_COUNT).unwrap_or(0);
        save(KEY_BID_COUNT, &(i + 1));
        if i >= MAX_COOP_BIDS {
            if let Some((c, j)) = load::<(AccountId, String)>(&bid_index_key(i - MAX_COOP_BIDS)) {
                env::storage_remove(&bid_key(&c, &j));
                env::storage_remove(&bid_index_key(i - MAX_COOP_BIDS));
            }
        }
        save(&bid_index_key(i), &(from_coop.clone(), job_id.clone()));
        save(&bid_key(&from_coop, &job_id), &CoopBid { job_id: job_id.clone(), from_coop: from_coop.clone(), price_usdc, at: U64(env::block_timestamp()) });
        Event::CoopBidPlaced { from_coop, job_id, price_usdc }.emit();
    }

    /// The exact text the agent signs for its next `place_bid`.
    pub fn get_bid_message(&self, from_coop: AccountId, job_id: String, price_usdc: U128) -> String {
        bid_message(&env::current_account_id(), load(KEY_BID_NONCE).unwrap_or(0), &from_coop, &job_id, price_usdc.0)
    }

    /// This co-op's bid for sister `from_coop`'s job, if any (read by that co-op's `award_coop_job`).
    pub fn get_bids_for(&self, from_coop: AccountId, job_id: String) -> Option<CoopBid> {
        load(&bid_key(&from_coop, &job_id))
    }
}

impl Koperasi {
    /// Award `job_id` to the best valid bid among `bids` (bids[i] from `coops[i]`).
    pub(crate) fn award(&mut self, job_id: String, coops: Vec<AccountId>, bids: Vec<Option<CoopBid>>) -> AccountId {
        let mut job = self.get_coop_job(job_id.clone()).unwrap_or_else(|| env::panic_str("no such job"));
        // again here: another award may have landed between the call and this callback
        require!(job.winner.is_none(), "already awarded");
        let me = env::current_account_id();
        let budget = job.budget_usdc.0;
        let mut best: Option<(u128, AccountId, u128)> = None;
        for (c, b) in coops.into_iter().zip(bids) {
            let Some(b) = b else { continue };
            let p = b.price_usdc.0;
            if b.from_coop != me || b.job_id != job_id || p == 0 || p > budget || b.at.0 < job.posted_at.0 || b.at.0 > job.deadline.0 {
                continue;
            }
            let credit = self.get_coop_credit(c.clone()).score as u128;
            // credit x budget / price; strict: on a tie the earlier sister keeps it
            let score = credit.saturating_mul(budget) / p;
            if score > 0 && best.as_ref().is_none_or(|(s, _, _)| score > *s) {
                best = Some((score, c, p));
            }
        }
        let (_, coop, price) = best.unwrap_or_else(|| env::panic_str("no valid bid"));
        job.winner = Some(coop.clone());
        job.price = Some(U128(price));
        save(&job_key(job.id), &job);
        Event::CoopJobAwarded { job_id, coop: coop.clone(), price: U128(price) }.emit();
        coop
    }
}
