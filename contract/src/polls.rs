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
//! The last 100 polls are kept. State lives under its own storage keys, so the upgrade needs no state migration.

use crate::tasks::{load, save};
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

fn poll_key(id: u32) -> Vec<u8> {
    format!("poll:{id}").into_bytes()
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

    /// A member opens a poll (2 to 8 options, open 1 hour to 30 days). Attach 0.01 NEAR for its storage. Returns its id.
    #[payable]
    pub fn open_poll(&mut self, question: String, options: Vec<String>, kind: PollKind, hours: u32) -> u32 {
        let by = env::predecessor_account_id();
        require!(self.members.contains_key(&by), "only a member");
        require!(env::attached_deposit() >= crate::commons::PLEDGE_FEE, "attach 0.01 NEAR for the poll's storage");
        require!(!question.trim().is_empty() && question.len() <= MAX_QUESTION, "question: 1 to 280 characters");
        require!((2..=MAX_OPTIONS).contains(&options.len()), "2 to 8 options");
        require!(options.iter().all(|o| !o.trim().is_empty() && o.len() <= MAX_OPTION_LEN), "option: 1 to 80 characters");
        require!((1..=MAX_HOURS).contains(&hours), "open 1 hour to 30 days");
        let mode = if kind == PollKind::Technical && tech_reputation() { MODE_REPUTATION } else { MODE_ONE_MEMBER };
        let id: u32 = load(KEY_POLL_COUNT).unwrap_or(0);
        save(KEY_POLL_COUNT, &(id + 1));
        // ponytail: the oldest is dropped even if still open; 100 newer polls cost 1 NEAR in fees to members only
        if id >= MAX_POLLS {
            env::storage_remove(&poll_key(id - MAX_POLLS));
        }
        let now = env::block_timestamp();
        let closes_at = U64(now + hours as u64 * HOUR_NS);
        let n = options.len();
        save(&poll_key(id), &Poll {
            id, question, options, kind, mode: mode.into(), by: by.clone(), opened_at: U64(now), closes_at,
            tallies: vec![U128(0); n], voters: vec![], closed: false, result: None,
        });
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

    pub fn get_poll(&self, id: u32) -> Option<Poll> {
        load(&poll_key(id))
    }

    /// Polls still kept (the last 100), oldest first from `from`; at most `limit` (20 by default, 100 at most).
    pub fn get_polls(&self, from: Option<u32>, limit: Option<u32>) -> Vec<Poll> {
        let n: u32 = load(KEY_POLL_COUNT).unwrap_or(0);
        let from = from.unwrap_or(0).max(n.saturating_sub(MAX_POLLS));
        let to = n.min(from.saturating_add(limit.unwrap_or(20).min(MAX_POLLS)));
        (from..to).filter_map(|i| load(&poll_key(i))).collect()
    }
}
