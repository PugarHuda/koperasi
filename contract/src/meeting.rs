//! What a co-op asks of its members and of its agent, year by year.
//!
//! - **Mandatory dues** (an Indonesian co-op's *simpanan wajib*): the members vote an amount of NEAR and a period
//!   (`set_dues`); each member pays it into the DAO treasury (`pay_dues`, several periods at once if they like). A member
//!   more than 7 days behind is out of good standing (no jury seat, no court case) until they catch up, arrears included.
//! - **The annual members' meeting** (Law 25/1992 art. 22–26): members put items on the year's agenda
//!   (`propose_agenda`); the co-op's agent writes the accountability report from the chain's facts and the agenda
//!   (`scripts/rat.mjs`); the members approve it by a DAO proposal that calls `record_annual_meeting` with the report's and
//!   the facts' sha256, and may carry the decisions it took (a new share rule, dues) as further actions of the same
//!   proposal. Rejected, nothing is recorded and the agenda stays open.
//! - **The agent as a defendant**: every court case upheld against one of its jobs (by the jury, or by the members on
//!   appeal) is a strike against the agent. The agent's runtime halves its daily inference budget for each strike in the
//!   last 90 days; at 3 the contract suspends it (it records no new receipt) until the members reinstate it by vote.
//!
//! - **The agent proposes** (0.3.2): the founding agent may put new by-laws to the members (`agent_propose_bylaws`),
//!   with the reason it read from its own record (prices, refunds, inference cost). The contract files a DAO proposal
//!   for `set_config`, paying the bond itself, and does not vote on it: only the members decide. One every 7 days.
//!
//! State lives under its own storage keys, so the upgrade needs no state migration.

use crate::tasks::{load, save, DAY_NS};
use crate::*;

const KEY_DUES: &[u8] = b"dues";
const KEY_MEETINGS: &[u8] = b"annual_meetings";
const KEY_STRIKES: &[u8] = b"agent_strikes";
const KEY_REINSTATED: &[u8] = b"agent_reinstated";
const KEY_AGENT_PROPOSALS: &[u8] = b"agent_proposals";
/// 0.3.3: how many days apart the agent may propose, set by the members (7 until they do).
const KEY_AGENT_EVERY: &[u8] = b"agent_propose_every_days";
/// Signatures consumed so far: only ever goes up, even when a filing fails.
const KEY_AGENT_NONCE: &[u8] = b"agent_proposal_nonce";
/// The founding agent and the public key it last signed a receipt with (ed25519 only: curve byte 0, then 32 bytes).
/// A key noted for an earlier agent no longer counts once the members appoint another.
pub(crate) const KEY_AGENT_PK: &[u8] = b"agent_signing_key"; // 0.3.2 live kept a bare key under "agent_pk"
/// The agent may put new by-laws to the members at most once in this many days.
pub const AGENT_PROPOSE_EVERY_DAYS: u64 = 7;
const MAX_REASON: usize = 500;
const GAS_AGENT_PROPOSED: Gas = Gas::from_tgas(10);
/// Days a member may be behind on dues before losing good standing.
pub const DUES_GRACE_DAYS: u64 = 7;
/// At most this many periods paid at once.
const MAX_PERIODS: u128 = 12;
/// Strikes count for this long.
pub const STRIKE_DAYS: u64 = 90;
/// Strikes in the window that suspend the agent.
pub const SUSPEND_AT: u32 = 3;
const MAX_AGENDA_EACH: usize = 3;
const MAX_ITEM: usize = 280;

/// What the agent signs to put new by-laws to the members (bound to this contract and to the next version).
pub fn agent_proposal_message(contract: &AccountId, nonce: u32, version: u32, hash: &str, uri: &str, reason: &str) -> String {
    format!("koperasi-agent-proposal/1 {contract} #{nonce} v{version} {hash} {uri}
{reason}")
}

/// Called from `record_receipt`/`update_receipt`: the founding agent's own signing key is kept.
pub(crate) fn note_agent_key(agent: &AccountId) {
    if env::signer_account_id() == *agent && env::predecessor_account_id() == *agent {
        let pk: Vec<u8> = env::signer_account_pk().into_bytes();
        let now = (agent.clone(), pk);
        if now.1.first() == Some(&0) && load::<(AccountId, Vec<u8>)>(KEY_AGENT_PK).as_ref() != Some(&now) {
            save(KEY_AGENT_PK, &now);
        }
    }
}

/// New by-laws the agent put to the members; `proposal` is the DAO proposal once filed.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct AgentProposal {
    pub version: u32,
    pub hash: String,
    pub uri: String,
    pub reason: String,
    pub proposal: Option<u64>,
    pub at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Dues {
    /// yoctoNEAR a period; 0 means no dues.
    pub amount: U128,
    pub every_days: u32,
    /// When the members voted these dues: nobody owes for the time before.
    pub since: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct AnnualMeeting {
    pub year: u32,
    pub report_sha256: String,
    pub facts_sha256: String,
    pub at: U64,
}

#[near(serializers = [json])]
pub struct AgentStanding {
    /// (case id, when) for each upheld case in the last 90 days since the last reinstatement.
    pub strikes: Vec<(u32, U64)>,
    pub suspended: bool,
    pub reinstated_at: Option<U64>,
}

fn paid_key(a: &AccountId) -> Vec<u8> {
    format!("dues_paid:{a}").into_bytes()
}
fn agenda_key(year: u32) -> Vec<u8> {
    format!("agenda:{year}").into_bytes()
}
fn hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Strikes that count now: upheld cases in the window, after the last reinstatement.
pub(crate) fn live_strikes() -> Vec<(u32, U64)> {
    let now = env::block_timestamp();
    let from = load::<U64>(KEY_REINSTATED).map_or(0, |t| t.0).max(now.saturating_sub(STRIKE_DAYS * DAY_NS));
    load::<Vec<(u32, U64)>>(KEY_STRIKES).unwrap_or_default().into_iter().filter(|(_, t)| t.0 >= from).collect()
}

pub(crate) fn agent_suspended() -> bool {
    live_strikes().len() as u32 >= SUSPEND_AT
}

/// A court case upheld against the agent's job: one strike (once per case).
pub(crate) fn strike(case: u32) {
    let mut all: Vec<(u32, U64)> = load(KEY_STRIKES).unwrap_or_default();
    if all.iter().any(|(c, _)| *c == case) {
        return;
    }
    all.push((case, U64(env::block_timestamp())));
    save(KEY_STRIKES, &all);
    Event::AgentStruck { case, strikes: live_strikes().len() as u32, suspended: agent_suspended() }.emit();
}

/// Paid until: the latest of what the member paid, when the members voted these dues, and when they joined. A record
/// from earlier dues (voted off, then on again) never makes anyone owe for the time no dues were voted.
fn paid_until(d: &Dues, joined: u64, a: &AccountId) -> u64 {
    load::<U64>(&paid_key(a)).map_or(0, |t| t.0).max(d.since.0).max(joined)
}

impl Koperasi {
    /// Up to date on dues (true when the members voted none, and for anyone who is not a member).
    pub(crate) fn dues_ok(&self, a: &AccountId) -> bool {
        let Some(d) = load::<Dues>(KEY_DUES).filter(|d| d.amount.0 > 0) else { return true };
        let Some(m) = self.members.get(a) else { return true };
        env::block_timestamp() <= paid_until(&d, m.joined_at.0, a) + DUES_GRACE_DAYS * DAY_NS
    }
}

#[near]
impl Koperasi {
    // ---------- mandatory dues ----------

    /// DAO only: dues of `amount` yoctoNEAR every `every_days` days (amount 0: none). Applies from now.
    pub fn set_dues(&mut self, amount: U128, every_days: u32) {
        self.assert_dao();
        require!(amount.0 == 0 || (1..=366).contains(&every_days), "every_days: 1 to 366");
        let d = Dues { amount, every_days, since: U64(env::block_timestamp()) };
        save(KEY_DUES, &d);
        Event::DuesSet { amount, every_days }.emit();
    }

    pub fn get_dues(&self) -> Option<Dues> {
        load(KEY_DUES)
    }

    /// A member pays dues into the DAO treasury: whole periods (1 to 12) of the attached deposit, arrears first; the
    /// rest comes back. Returns the date (ns) they are paid until.
    #[payable]
    pub fn pay_dues(&mut self) -> U64 {
        let who = env::predecessor_account_id();
        let m = self.members.get(&who).cloned().unwrap_or_else(|| env::panic_str("only a member"));
        let d: Dues = load::<Dues>(KEY_DUES).filter(|d| d.amount.0 > 0).unwrap_or_else(|| env::panic_str("the members voted no dues"));
        let paid = env::attached_deposit().as_yoctonear();
        let periods = (paid / d.amount.0).min(MAX_PERIODS);
        require!(periods >= 1, "attach at least one period's dues");
        let from = paid_until(&d, m.joined_at.0, &who);
        let until = from + periods as u64 * d.every_days as u64 * DAY_NS;
        save(&paid_key(&who), &U64(until));
        let total = d.amount.0 * periods;
        let _ = Promise::new(self.dao_id.clone()).transfer(NearToken::from_yoctonear(total));
        if paid > total {
            let _ = Promise::new(who.clone()).transfer(NearToken::from_yoctonear(paid - total));
        }
        Event::DuesPaid { account_id: who, periods: periods as u32, amount: U128(total), paid_until: U64(until) }.emit();
        U64(until)
    }

    /// (paid until, in good standing on dues) for a member; None when the members voted no dues or for a non-member.
    pub fn get_dues_status(&self, account_id: AccountId) -> Option<(U64, bool)> {
        let d = load::<Dues>(KEY_DUES).filter(|d| d.amount.0 > 0)?;
        let m = self.members.get(&account_id)?;
        Some((U64(paid_until(&d, m.joined_at.0, &account_id)), self.dues_ok(&account_id)))
    }

    // ---------- the annual members' meeting ----------

    /// A member puts an item on `year`'s agenda (up to 3 each, 280 characters); attach 0.01 NEAR for its storage.
    #[payable]
    pub fn propose_agenda(&mut self, year: u32, item: String) {
        let who = env::predecessor_account_id();
        require!(self.members.contains_key(&who), "only a member");
        require!(env::attached_deposit() >= crate::commons::PLEDGE_FEE, "attach 0.01 NEAR for the item's storage");
        require!(!item.trim().is_empty() && item.len() <= MAX_ITEM, "item: 1 to 280 characters");
        require!(!self.get_annual_meetings().iter().any(|m| m.year == year), "that year's meeting is already held");
        let mut all: Vec<(AccountId, String, U64)> = load(&agenda_key(year)).unwrap_or_default();
        require!(all.iter().filter(|(a, _, _)| *a == who).count() < MAX_AGENDA_EACH, "at most 3 items each");
        all.push((who.clone(), item, U64(env::block_timestamp())));
        save(&agenda_key(year), &all);
        Event::AgendaProposed { year, by: who }.emit();
    }

    pub fn get_agenda(&self, year: u32) -> Vec<(AccountId, String, U64)> {
        load(&agenda_key(year)).unwrap_or_default()
    }

    /// DAO only: the members approved `year`'s accountability report (these sha256, of the report and of the facts it
    /// was written from). Once a year.
    pub fn record_annual_meeting(&mut self, year: u32, report_sha256: String, facts_sha256: String) {
        self.assert_dao();
        require!(hex64(&report_sha256) && hex64(&facts_sha256), "sha256: 64 lowercase hex digits");
        let mut all: Vec<AnnualMeeting> = load(KEY_MEETINGS).unwrap_or_default();
        require!(!all.iter().any(|m| m.year == year), "that year's meeting is already recorded");
        all.push(AnnualMeeting { year, report_sha256: report_sha256.clone(), facts_sha256, at: U64(env::block_timestamp()) });
        save(KEY_MEETINGS, &all);
        Event::AnnualMeetingHeld { year, report_sha256 }.emit();
    }

    pub fn get_annual_meetings(&self) -> Vec<AnnualMeeting> {
        load(KEY_MEETINGS).unwrap_or_default()
    }

    // ---------- the agent as a defendant ----------

    pub fn get_agent_standing(&self) -> AgentStanding {
        AgentStanding { strikes: live_strikes(), suspended: agent_suspended(), reinstated_at: load(KEY_REINSTATED) }
    }

    /// DAO only: the members reinstate a suspended agent; strikes before now no longer count.
    pub fn reinstate_agent(&mut self) {
        self.assert_dao();
        save(KEY_REINSTATED, &U64(env::block_timestamp()));
        Event::AgentReinstated {}.emit();
    }

    // ---------- the agent proposes ----------

    /// The founding agent puts new by-laws to the members, with the reason it read from its record. The contract files
    /// the DAO proposal (`set_config`, the agent named as contributor, no points) and pays its bond; the members vote.
    ///
    /// The agent's key may call only `record_receipt` and `update_receipt`, so it signs instead: anyone may submit the
    /// proposal with the agent's ed25519 signature of `agent_proposal_message(...)`, checked against the key the agent
    /// last signed a receipt with (the contract keeps it then). The agent itself may also call directly.
    pub fn agent_propose_bylaws(&mut self, version: u32, hash: String, uri: String, reason: String, signature: Option<String>) -> Promise {
        require!(!self.paused, "koperasi is paused");
        let mut all: Vec<AgentProposal> = load(KEY_AGENT_PROPOSALS).unwrap_or_default();
        // a nonce that only goes up, on either path; it starts past every proposal filed before it existed
        let nonce: u32 = load(KEY_AGENT_NONCE).unwrap_or(all.len() as u32);
        if env::predecessor_account_id() != self.agent_id {
            let pk = load::<(AccountId, Vec<u8>)>(KEY_AGENT_PK).filter(|(a, _)| *a == self.agent_id).map(|(_, pk)| pk)
                .unwrap_or_else(|| env::panic_str("only the co-op's agent: it has signed no receipt under this code yet"));
            let sig = signature.as_deref().and_then(|s| near_sdk::base64::Engine::decode(&near_sdk::base64::engine::general_purpose::STANDARD, s).ok())
                .and_then(|b| <[u8; 64]>::try_from(b).ok()).unwrap_or_else(|| env::panic_str("only the co-op's agent, or its signature (base64, 64 bytes)"));
            // bound to this contract, to the next version and to the nonce: a signature counts once
            let msg = agent_proposal_message(&env::current_account_id(), nonce, version, &hash, &uri, &reason);
            require!(pk.len() == 33 && pk[0] == 0 && env::ed25519_verify(&sig, msg.as_bytes(), &pk[1..].try_into().unwrap()), "not the agent's signature");
        }
        save(KEY_AGENT_NONCE, &(nonce + 1));
        require!(!agent_suspended(), "the agent is suspended");
        require!(version == self.config.version + 1, "the next version only");
        require!(valid_hash(&hash), "hash must be 64 lowercase hex chars");
        // fixed fields first, separated by spaces, the free text last: the signed text reads one way only
        require!(!uri.is_empty() && uri.len() <= 200 && uri.bytes().all(|b| b.is_ascii_graphic()), "uri: 1 to 200 characters, no spaces");
        require!(!reason.trim().is_empty() && reason.len() <= MAX_REASON, "reason: 1 to 500 characters");
        let now = env::block_timestamp();
        let every = load::<u64>(KEY_AGENT_EVERY).unwrap_or(AGENT_PROPOSE_EVERY_DAYS);
        require!(all.last().is_none_or(|p| now >= p.at.0 + every * DAY_NS), "too soon after the agent's last proposal: the members set how often");
        all.push(AgentProposal { version, hash: hash.clone(), uri: uri.clone(), reason: reason.clone(), proposal: None, at: U64(now) });
        save(KEY_AGENT_PROPOSALS, &all);
        let args = near_sdk::serde_json::json!({ "version": version, "hash": hash, "uri": uri,
            "contributor": self.agent_id, "points": 0 }).to_string();
        let kind = near_sdk::serde_json::json!({ "FunctionCall": { "receiver_id": env::current_account_id(), "actions": [{
            "method_name": "set_config", "args": near_sdk::base64::Engine::encode(&near_sdk::base64::engine::general_purpose::STANDARD, args),
            "deposit": "0", "gas": "30000000000000" }] } });
        let description = format!("By-laws v{version}, proposed by the co-op's agent from its record: {reason}");
        crate::tasks::ext_dao_proposals::ext(self.dao_id.clone())
            .with_attached_deposit(crate::tasks::PAYOUT_BOND)
            .with_static_gas(crate::tasks::GAS_PROPOSE)
            .add_proposal(near_sdk::serde_json::json!({ "description": description, "kind": kind }))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_AGENT_PROPOSED).on_agent_proposed())
    }

    /// Callback: the DAO filed the agent's proposal (its id kept); nothing filed, the attempt is forgotten.
    #[private]
    pub fn on_agent_proposed(&mut self, #[callback_result] pid: Result<u64, PromiseError>) {
        let mut all: Vec<AgentProposal> = load(KEY_AGENT_PROPOSALS).unwrap_or_default();
        let Some(last) = all.last_mut() else { return };
        match pid {
            Ok(id) => {
                last.proposal = Some(id);
                Event::AgentProposed { version: last.version, hash: last.hash.clone(), proposal_id: id }.emit();
            }
            Err(_) => {
                all.pop();
            }
        }
        save(KEY_AGENT_PROPOSALS, &all);
    }

    /// DAO only: how many days apart the agent may put new by-laws to the members (0 to 30).
    pub fn set_agent_propose_every(&mut self, days: u64) {
        self.assert_dao();
        require!(days <= 30, "at most 30 days");
        save(KEY_AGENT_EVERY, &days);
        Event::AgentProposeEverySet { days }.emit();
    }

    pub fn get_agent_propose_every(&self) -> u64 {
        load(KEY_AGENT_EVERY).unwrap_or(AGENT_PROPOSE_EVERY_DAYS)
    }

    /// The exact text the agent signs for its next `agent_propose_bylaws`.
    pub fn get_agent_proposal_message(&self, version: u32, hash: String, uri: String, reason: String) -> String {
        let n = load(KEY_AGENT_NONCE).unwrap_or_else(|| load::<Vec<AgentProposal>>(KEY_AGENT_PROPOSALS).map_or(0, |v| v.len() as u32));
        agent_proposal_message(&env::current_account_id(), n, version, &hash, &uri, &reason)
    }

    pub fn get_agent_proposals(&self) -> Vec<AgentProposal> {
        load(KEY_AGENT_PROPOSALS).unwrap_or_default()
    }
}
