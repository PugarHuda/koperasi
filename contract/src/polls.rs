//! Contract 0.3.6: polls, a recorded and weighted opinion of the members.
//!
//! The co-op decides one member, one vote, in its Sputnik DAO. A poll binds nothing: it records what the members think,
//! and the DAO may then pass a poll's result into a binding proposal. Any member opens one (`open_poll`, attaching
//! 0.01 NEAR for its storage); members vote once each; after the deadline anyone closes it and the result is stored.
//!
//! - **General** polls are always one member, one vote.
//! - **Technical** polls weigh each vote by the member's reputation weight (`get_reputation_weights`, read when they
//!   vote) only if the by-laws say so (`set_technical_vote("reputation")`, DAO only); otherwise one member, one vote.
//!   The mode is fixed when the poll opens, so a change of mode never reweighs a poll halfway.
//!
//! - **A technical poll's result becomes a DAO proposal** (0.3.7): its opener may attach a by-laws reference to each
//!   option (`bylaws`: version, sha256, uri, or null). Once the poll is closed with a winner that carries one, anyone
//!   (once per poll, attaching the 0.1 NEAR proposal bond) calls `poll_to_proposal`: the contract files a Sputnik
//!   proposal calling its own `set_config` with that reference. The poll still binds nothing: the members vote it.
//!
//! The last 100 polls are kept. State lives under its own storage keys, so the upgrade needs no state migration.

use crate::tasks::{ext_dao_proposals, load, save, GAS_PROPOSE, PAYOUT_BOND};
use crate::*;

const KEY_POLL_COUNT: &[u8] = b"poll_count";
const KEY_TECH_REPUTATION: &[u8] = b"technical_vote_reputation";
pub const MAX_POLLS: u32 = 100;
const MAX_OPTIONS: usize = 8;
const MAX_OPTION_LEN: usize = 80;
const MAX_QUESTION: usize = 280;
const MAX_HOURS: u32 = 30 * 24;
const HOUR_NS: u64 = 3_600_000_000_000;
pub const MODE_REPUTATION: &str = "reputation";
pub const MODE_ONE_MEMBER: &str = "one_member";

const GAS_POLL_PROPOSED: Gas = Gas::from_tgas(10);
const MAX_URI: usize = 200;

fn poll_key(id: u32) -> Vec<u8> {
    format!("poll:{id}").into_bytes()
}
/// 0.3.7: per option, the by-laws it would adopt (kept apart so the `Poll` borsh layout does not change)
fn bylaws_key(id: u32) -> Vec<u8> {
    format!("poll_bylaws:{id}").into_bytes()
}
/// 0.3.7: the DAO proposal filed from the poll; `None` stored while the filing is in flight (once per poll)
fn proposal_key(id: u32) -> Vec<u8> {
    format!("poll_proposal:{id}").into_bytes()
}

/// A by-laws file, as `set_config` takes it: the version, its sha256 (64 lowercase hex) and where to read it.
#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub struct BylawsRef {
    pub version: u32,
    pub hash: String,
    pub uri: String,
}

/// `get_poll`: the poll, plus (0.3.7) its by-laws per option and the DAO proposal filed from it.
#[near(serializers = [json])]
pub struct PollView {
    #[serde(flatten)]
    pub poll: Poll,
    pub bylaws: Option<Vec<Option<BylawsRef>>>,
    pub proposal: Option<u64>,
}

// ponytail: lets callers read `get_poll(id).unwrap().mode` as before
impl std::ops::Deref for PollView {
    type Target = Poll;
    fn deref(&self) -> &Poll {
        &self.poll
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum PollKind {
    Technical,
    General,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Poll {
    pub id: u32,
    pub question: String,
    pub options: Vec<String>,
    pub kind: PollKind,
    /// "reputation" or "one_member", fixed when the poll opened
    pub mode: String,
    pub by: AccountId,
    pub opened_at: U64,
    pub closes_at: U64,
    /// per option: votes (one_member) or the sum of the voters' reputation weights (reputation)
    pub tallies: Vec<U128>,
    pub voters: Vec<AccountId>,
    pub closed: bool,
    /// the winning option once closed; None with no votes or a tie for first
    pub result: Option<u32>,
}

fn get(id: u32) -> Poll {
    load(&poll_key(id)).unwrap_or_else(|| env::panic_str("no such poll (only the last 100 are kept)"))
}

fn tech_reputation() -> bool {
    load::<bool>(KEY_TECH_REPUTATION).unwrap_or(false)
}

#[near]
impl Koperasi {
    /// DAO only: how technical polls are weighed, "reputation" or "one_member" (the default).
    pub fn set_technical_vote(&mut self, mode: String) {
        self.assert_dao();
        let rep = match mode.as_str() {
            MODE_REPUTATION => true,
            MODE_ONE_MEMBER => false,
            _ => env::panic_str("mode: \"reputation\" or \"one_member\""),
        };
        save(KEY_TECH_REPUTATION, &rep);
        Event::TechnicalVoteSet { mode }.emit();
    }

    pub fn get_technical_vote_mode(&self) -> String {
        if tech_reputation() { MODE_REPUTATION } else { MODE_ONE_MEMBER }.into()
    }

    /// A member opens a poll (2 to 8 options, open 1 hour to 30 days). Attach 0.01 NEAR for its storage, and 0.01 more
    /// per by-laws reference. A technical poll may give each option the by-laws it would adopt (`bylaws`, one entry per
    /// option, null for none; each a version above the current one). Returns its id.
    #[payable]
    pub fn open_poll(&mut self, question: String, options: Vec<String>, kind: PollKind, hours: u32,
                     bylaws: Option<Vec<Option<BylawsRef>>>) -> u32 {
        let by = env::predecessor_account_id();
        require!(self.members.contains_key(&by), "only a member");
        let refs = bylaws.as_ref().map_or(0, |b| b.iter().flatten().count());
        require!(env::attached_deposit() >= crate::commons::PLEDGE_FEE.saturating_mul(1 + refs as u128),
            "attach 0.01 NEAR for the poll's storage, and 0.01 NEAR per by-laws reference");
        if let Some(b) = &bylaws {
            require!(kind == PollKind::Technical, "only a technical poll carries by-laws");
            require!(b.len() == options.len(), "by-laws: one entry per option (null for none)");
            require!(refs > 0, "by-laws: at least one reference, or omit the field");
            for r in b.iter().flatten() {
                require!(r.version > self.config.version, "by-laws: a version above the current one");
                require!(valid_hash(&r.hash), "by-laws: hash must be 64 lowercase hex chars");
                require!(!r.uri.is_empty() && r.uri.len() <= MAX_URI && r.uri.bytes().all(|b| b.is_ascii_graphic()),
                    "by-laws: uri of 1 to 200 characters, no spaces");
            }
        }
        require!(!question.trim().is_empty() && question.len() <= MAX_QUESTION, "question: 1 to 280 characters");
        require!((2..=MAX_OPTIONS).contains(&options.len()), "2 to 8 options");
        require!(options.iter().all(|o| !o.trim().is_empty() && o.len() <= MAX_OPTION_LEN), "option: 1 to 80 characters");
        require!((1..=MAX_HOURS).contains(&hours), "open 1 hour to 30 days");
        let mode = if kind == PollKind::Technical && tech_reputation() { MODE_REPUTATION } else { MODE_ONE_MEMBER };
        let id: u32 = load(KEY_POLL_COUNT).unwrap_or(0);
        // the oldest kept poll is dropped only once it is decided: 100 newer polls cannot erase an open one
        if id >= MAX_POLLS {
            let old = poll_key(id - MAX_POLLS);
            if let Some(p) = load::<Poll>(&old) {
                require!(p.closed || env::block_timestamp() >= p.closes_at.0, "the oldest kept poll is still open: close it first");
            }
            env::storage_remove(&old);
            env::storage_remove(&bylaws_key(id - MAX_POLLS));
            env::storage_remove(&proposal_key(id - MAX_POLLS));
        }
        save(KEY_POLL_COUNT, &(id + 1));
        let now = env::block_timestamp();
        let closes_at = U64(now + hours as u64 * HOUR_NS);
        let n = options.len();
        save(&poll_key(id), &Poll {
            id, question, options, kind, mode: mode.into(), by: by.clone(), opened_at: U64(now), closes_at,
            tallies: vec![U128(0); n], voters: vec![], closed: false, result: None,
        });
        if let Some(b) = bylaws {
            save(&bylaws_key(id), &b);
        }
        Event::PollOpened { id, kind, mode: mode.into(), by, options: n as u32, closes_at }.emit();
        id
    }

    /// A member votes once for option `option` (0-based) before the deadline. Returns the weight counted.
    pub fn vote_poll(&mut self, id: u32, option: u32) -> U128 {
        let by = env::predecessor_account_id();
        require!(self.members.contains_key(&by), "only a member");
        let mut p = get(id);
        require!(!p.closed && env::block_timestamp() < p.closes_at.0, "the poll is closed");
        require!((option as usize) < p.options.len(), "no such option");
        require!(!p.voters.contains(&by), "you already voted");
        // reputation weights are read now: what the member's record weighs at the moment they vote
        let weight = if p.mode == MODE_REPUTATION {
            self.reputation_weights(false).into_iter().find(|(a, _)| *a == by).map_or(0, |(_, w)| w)
        } else {
            1
        };
        p.tallies[option as usize].0 += weight;
        p.voters.push(by.clone());
        save(&poll_key(id), &p);
        Event::PollVoted { id, by, option, weight: U128(weight) }.emit();
        U128(weight)
    }

    /// Anyone, after the deadline: count the poll and store its result (None: no votes, or a tie for first).
    pub fn close_poll(&mut self, id: u32) -> Option<u32> {
        let mut p = get(id);
        require!(!p.closed, "already closed");
        require!(env::block_timestamp() >= p.closes_at.0, "the poll is still open");
        let top = p.tallies.iter().map(|t| t.0).max().unwrap_or(0);
        let mut leaders = p.tallies.iter().enumerate().filter(|(_, t)| t.0 == top);
        p.result = match (leaders.next(), leaders.next()) {
            (Some((i, _)), None) if top > 0 => Some(i as u32),
            _ => None,
        };
        p.closed = true;
        save(&poll_key(id), &p);
        Event::PollClosed { id, result: p.result, mode: p.mode.clone(), tallies: p.tallies.clone() }.emit();
        p.result
    }

    pub fn get_poll(&self, id: u32) -> Option<PollView> {
        load(&poll_key(id)).map(|poll| PollView {
            poll, bylaws: load(&bylaws_key(id)), proposal: load::<Option<u64>>(&proposal_key(id)).flatten(),
        })
    }

    /// Anyone, once per poll, attaching the 0.1 NEAR proposal bond (the DAO returns it to the co-op, not the caller):
    /// a closed poll whose winning option carries by-laws becomes a DAO proposal calling `set_config` with them.
    #[payable]
    pub fn poll_to_proposal(&mut self, id: u32) -> Promise {
        require!(!self.paused, "koperasi is paused");
        let p = get(id);
        require!(p.closed, "close the poll first");
        let i = p.result.unwrap_or_else(|| env::panic_str("the poll has no result")) as usize;
        let refs: Vec<Option<BylawsRef>> = load(&bylaws_key(id)).unwrap_or_else(|| env::panic_str("this poll carries no by-laws"));
        let r = refs[i].clone().unwrap_or_else(|| env::panic_str("the winning option carries no by-laws"));
        require!(env::storage_read(&proposal_key(id)).is_none(), "this poll was already put to the DAO");
        require!(r.version > self.config.version, "those by-laws are no longer newer than the current ones");
        let paid = env::attached_deposit();
        require!(paid >= PAYOUT_BOND, "attach the 0.1 NEAR proposal bond");
        let caller = env::predecessor_account_id();
        if paid > PAYOUT_BOND {
            let _ = Promise::new(caller.clone()).transfer(paid.saturating_sub(PAYOUT_BOND));
        }
        save(&proposal_key(id), &None::<u64>); // in flight: a second call is refused
        let args = near_sdk::serde_json::json!({ "version": r.version, "hash": r.hash, "uri": r.uri,
            "contributor": null, "points": 0 }).to_string();
        let kind = near_sdk::serde_json::json!({ "FunctionCall": { "receiver_id": env::current_account_id(), "actions": [{
            "method_name": "set_config", "args": near_sdk::base64::Engine::encode(&near_sdk::base64::engine::general_purpose::STANDARD, args),
            "deposit": "0", "gas": "30000000000000" }] } });
        let description = format!("Poll #{id} ({}): {} \u{2192} {}; by-laws v{} {}", p.mode, p.question, p.options[i], r.version, r.hash);
        ext_dao_proposals::ext(self.dao_id.clone())
            .with_attached_deposit(PAYOUT_BOND)
            .with_static_gas(GAS_PROPOSE)
            .add_proposal(near_sdk::serde_json::json!({ "description": description, "kind": kind }))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_POLL_PROPOSED).on_poll_proposed(id, caller))
    }

    /// Callback: the proposal's id is kept; not filed, the poll may be tried again and the bond goes back.
    #[private]
    pub fn on_poll_proposed(&mut self, id: u32, caller: AccountId, #[callback_result] pid: Result<u64, PromiseError>) {
        match pid {
            Ok(proposal) => {
                save(&proposal_key(id), &Some(proposal));
                Event::PollProposed { id, proposal }.emit();
            }
            Err(_) => {
                env::storage_remove(&proposal_key(id));
                let _ = Promise::new(caller).transfer(PAYOUT_BOND);
                log!("poll #{}: the proposal was not filed; bond returned", id);
            }
        }
    }

    /// Polls still kept (the last 100), oldest first from `from`; at most `limit` (20 by default, 100 at most).
    pub fn get_polls(&self, from: Option<u32>, limit: Option<u32>) -> Vec<Poll> {
        let n: u32 = load(KEY_POLL_COUNT).unwrap_or(0);
        let from = from.unwrap_or(0).max(n.saturating_sub(MAX_POLLS));
        let to = n.min(from.saturating_add(limit.unwrap_or(20).min(MAX_POLLS)));
        (from..to).filter_map(|i| load(&poll_key(i))).collect()
    }
}
