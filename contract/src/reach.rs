//! What reaches beyond the co-op.
//!
//! - **Payout routes**: a member says where the co-op's payouts should land, on NEAR (the default) or at an address on
//!   Base, Arbitrum or Ethereum. The agent's NEAR Intents wallet pays profit shares by these routes, and its policy
//!   (owned by the DAO, changed only by a members' vote) lists exactly these destinations: `scripts/intents.mjs`.
//! - **The work record as a token** (NEP-171, non-transferable): anyone with a record here (tasks, DAO bounties) or a
//!   standing (pledges, juries) can mint it once. Its metadata is read live from the record and the standing, so it never
//!   goes stale and cannot be edited by anyone; any wallet or explorer that reads NEP-171 shows it, outside this co-op.
//!   It cannot be transferred: reputation earned by one account is not for sale to another.
//! - **The passport**: the members vote which other co-ops they recognise (`set_sister_coops`). Anyone then asks this
//!   contract to read an account's work-record token on a sister co-op (`stamp_passport`); a record there with finished
//!   work and good standing is stamped here and counts as one more trust source for payouts on trust, once per co-op.
//!   The read is a cross-contract call, so nobody can type a stamp in. A stamp that no longer holds (the record lost its
//!   good standing, or the token was burned) is removed by the same call, and a co-op the members drop stops counting.

use crate::tasks::{load, save};
use crate::*;
use near_sdk::base64::{engine::general_purpose::STANDARD as B64, Engine};
use near_sdk::serde_json::json;

const KEY_ROUTES: &[u8] = b"payout_routes";
const KEY_WORK_TOKENS: &[u8] = b"work_tokens";
const KEY_SISTERS: &[u8] = b"sister_coops";
/// The most sister co-ops the members can list: each stamp is read against this list.
const MAX_SISTERS: usize = 20;
const GAS_READ_TOKEN: Gas = Gas::from_tgas(20);
const GAS_STAMPED: Gas = Gas::from_tgas(15);

#[ext_contract(ext_work)]
#[allow(dead_code)]
trait WorkRecords {
    fn nft_token(&self, token_id: String) -> Option<Value>;
}

/// One sister co-op's word on an account: its work there, as read from its work-record token.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Stamp {
    pub coop: AccountId,
    pub done: u32,
    pub earned: U128,
    pub at: U64,
}

fn passport_key(a: &AccountId) -> Vec<u8> {
    format!("passport:{a}").into_bytes()
}

/// Stamps from co-ops the members still recognise: what trust counts (one source each).
pub(crate) fn passport_sources(a: &AccountId) -> u32 {
    let sisters: Vec<AccountId> = load(KEY_SISTERS).unwrap_or_default();
    load::<Vec<Stamp>>(&passport_key(a)).unwrap_or_default().iter().filter(|s| sisters.contains(&s.coop)).count() as u32
}

/// What a sister's token says, if it holds: owned by `who`, finished work, good standing. Some((done, earned)).
fn holds(token: &Value, who: &AccountId) -> Option<(u32, U128)> {
    if token.get("owner_id")?.as_str()? != who.as_str() {
        return None;
    }
    let extra: Value = near_sdk::serde_json::from_str(token.get("metadata")?.get("extra")?.as_str()?).ok()?;
    let done = extra.get("done")?.as_u64()? as u32;
    let earned: U128 = near_sdk::serde_json::from_value(extra.get("earned")?.clone()).ok()?;
    (extra.get("good_standing")?.as_bool()? && done > 0).then_some((done, earned))
}
/// The chains the agent's Intents wallet can withdraw to (EVM addresses); "near" is the member's own account.
const ROUTE_CHAINS: [&str; 3] = ["base", "arb", "eth"];

fn evm_address(a: &str) -> bool {
    a.len() == 42 && a.starts_with("0x") && a[2..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn nep171(event: &str, owner: &AccountId) {
    log!("EVENT_JSON:{}", json!({ "standard": "nep171", "version": "1.0.0", "event": event,
        "data": [{ "owner_id": owner, "token_ids": [owner] }] }));
}

fn near2(yocto: u128) -> String {
    let centi = yocto / 10u128.pow(22);
    format!("{}.{:02}", centi / 100, centi % 100)
}

#[near]
impl Koperasi {
    // ---------- payout routes ----------

    /// A member: where payouts to you should land. `chain` "near" (your own account, the default) or "base", "arb",
    /// "eth" with a lowercase 0x address. The agent's wallet pays there only after the members vote its policy to list it.
    pub fn set_payout_route(&mut self, chain: String, address: Option<String>) {
        let who = env::predecessor_account_id();
        require!(self.members.contains_key(&who), "only a member");
        let mut routes: Vec<(AccountId, String, String)> = load(KEY_ROUTES).unwrap_or_default();
        routes.retain(|(a, _, _)| *a != who);
        let address = if chain == "near" {
            who.to_string()
        } else {
            require!(ROUTE_CHAINS.contains(&chain.as_str()), "chain: near, base, arb or eth");
            let a = address.unwrap_or_else(|| env::panic_str("an address on that chain"));
            require!(evm_address(&a), "address: 0x and 40 lowercase hex digits");
            routes.push((who.clone(), chain.clone(), a.clone()));
            a
        };
        save(KEY_ROUTES, &routes);
        Event::PayoutRouteSet { account_id: who, chain, address }.emit();
    }

    /// Every current member's route other than NEAR: (account, chain, address).
    pub fn get_payout_routes(&self) -> Vec<(AccountId, String, String)> {
        load::<Vec<(AccountId, String, String)>>(KEY_ROUTES).unwrap_or_default()
            .into_iter().filter(|(a, _, _)| self.members.contains_key(a)).collect()
    }

    // ---------- the passport: work records from sister co-ops ----------

    /// DAO only: the co-ops whose work records count here (at most 20; not this one).
    pub fn set_sister_coops(&mut self, coops: Vec<AccountId>) {
        self.assert_dao();
        require!(coops.len() <= MAX_SISTERS, "at most 20 sister co-ops");
        require!(!coops.contains(&env::current_account_id()), "a co-op is not its own sister");
        save(KEY_SISTERS, &coops);
        Event::SisterCoopsSet { coops }.emit();
    }

    pub fn get_sister_coops(&self) -> Vec<AccountId> {
        load(KEY_SISTERS).unwrap_or_default()
    }

    /// Anyone: read `account_id`'s work-record token on sister co-op `coop` and stamp it into their passport here, or
    /// remove the stamp when it no longer holds. Attach 0.01 NEAR for the stamp's storage (returned if nothing is kept).
    #[payable]
    pub fn stamp_passport(&mut self, account_id: AccountId, coop: AccountId) -> Promise {
        require!(env::attached_deposit() >= crate::commons::PLEDGE_FEE, "attach 0.01 NEAR for the stamp's storage");
        require!(self.get_sister_coops().contains(&coop), "not a co-op the members recognise");
        ext_work::ext(coop.clone())
            .with_static_gas(GAS_READ_TOKEN)
            .nft_token(account_id.to_string())
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_STAMPED)
                .on_token_read(account_id, coop, env::predecessor_account_id()))
    }

    /// Callback of `stamp_passport`. True when a stamp is kept.
    #[private]
    pub fn on_token_read(&mut self, account_id: AccountId, coop: AccountId, payer: AccountId,
        #[callback_result] token: Result<Option<Value>, PromiseError>) -> bool {
        // a failed read (the co-op is down, or not a Koperasi) changes nothing
        let Ok(token) = token else {
            let _ = Promise::new(payer).transfer(crate::commons::PLEDGE_FEE);
            return false;
        };
        let mut stamps: Vec<Stamp> = load(&passport_key(&account_id)).unwrap_or_default();
        let had = stamps.iter().any(|s| s.coop == coop);
        stamps.retain(|s| s.coop != coop);
        let held = token.as_ref().and_then(|t| holds(t, &account_id));
        if let Some((done, earned)) = held {
            stamps.push(Stamp { coop: coop.clone(), done, earned, at: U64(env::block_timestamp()) });
            Event::PassportStamped { account_id: account_id.clone(), coop, done, kept: true }.emit();
        } else {
            let _ = Promise::new(payer).transfer(crate::commons::PLEDGE_FEE);
            if had {
                Event::PassportStamped { account_id: account_id.clone(), coop, done: 0, kept: false }.emit();
            }
        }
        save(&passport_key(&account_id), &stamps);
        held.is_some()
    }

    /// An account's stamps from sister co-ops (also from co-ops the members no longer recognise: those do not count).
    pub fn get_passport(&self, account_id: AccountId) -> Vec<Stamp> {
        load(&passport_key(&account_id)).unwrap_or_default()
    }

    // ---------- the work record as a token (NEP-171, non-transferable) ----------

    /// Mint your work record as a token, once; attach 0.01 NEAR for its storage. Token id = your account id.
    #[payable]
    pub fn mint_work_record(&mut self) {
        let who = env::predecessor_account_id();
        require!(env::attached_deposit() >= crate::commons::PLEDGE_FEE, "attach 0.01 NEAR for the token's storage");
        let (s, _) = self.get_standing(who.clone());
        let has = self.get_record(who.clone()).is_some() || self.members.contains_key(&who)
            || s.pledges_honored + s.pledges_broken + s.juries_served + s.juries_missed + s.slashed > 0;
        require!(has, "no record here to mint");
        let mut all: Vec<AccountId> = load(KEY_WORK_TOKENS).unwrap_or_default();
        require!(!all.contains(&who), "your work record is already a token");
        all.push(who.clone());
        save(KEY_WORK_TOKENS, &all);
        nep171("nft_mint", &who);
    }

    /// Burn your own work-record token (the record itself stays on the contract).
    pub fn burn_work_record(&mut self) {
        let who = env::predecessor_account_id();
        let mut all: Vec<AccountId> = load(KEY_WORK_TOKENS).unwrap_or_default();
        require!(all.contains(&who), "no work-record token to burn");
        all.retain(|a| *a != who);
        save(KEY_WORK_TOKENS, &all);
        nep171("nft_burn", &who);
    }

    pub fn nft_metadata(&self) -> Value {
        json!({ "spec": "nft-1.0.0", "name": "Koperasi work records", "symbol": "KOPWORK", "icon": null,
            "base_uri": null, "reference": null, "reference_hash": null })
    }

    pub fn nft_token(&self, token_id: String) -> Option<Value> {
        let all: Vec<AccountId> = load(KEY_WORK_TOKENS).unwrap_or_default();
        all.into_iter().find(|a| a.as_str() == token_id).map(|a| self.work_token(&a))
    }

    pub fn nft_total_supply(&self) -> U128 {
        U128(load::<Vec<AccountId>>(KEY_WORK_TOKENS).unwrap_or_default().len() as u128)
    }

    pub fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Value> {
        let all: Vec<AccountId> = load(KEY_WORK_TOKENS).unwrap_or_default();
        all.iter().skip(from_index.map_or(0, |i| i.0 as usize)).take(limit.unwrap_or(50) as usize)
            .map(|a| self.work_token(a)).collect()
    }

    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        U128(self.nft_token(account_id.to_string()).is_some() as u128)
    }

    pub fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<Value> {
        let _ = (from_index, limit); // at most one token per owner
        self.nft_token(account_id.to_string()).into_iter().collect()
    }

    /// Refused: a work record is its owner's own.
    #[payable]
    pub fn nft_transfer(&mut self, receiver_id: AccountId, token_id: String, approval_id: Option<u64>, memo: Option<String>) {
        let _ = (receiver_id, token_id, approval_id, memo);
        env::panic_str("a work record cannot be transferred: it belongs to the account that earned it");
    }

    /// Refused, as `nft_transfer`.
    #[payable]
    pub fn nft_transfer_call(&mut self, receiver_id: AccountId, token_id: String, approval_id: Option<u64>, memo: Option<String>, msg: String) {
        let _ = (receiver_id, token_id, approval_id, memo, msg);
        env::panic_str("a work record cannot be transferred: it belongs to the account that earned it");
    }

    fn work_token(&self, who: &AccountId) -> Value {
        let r = self.get_record(who.clone()).unwrap_or_default();
        let (s, good) = self.get_standing(who.clone());
        let member = self.members.contains_key(who);
        let line1 = format!("{} finished, {} NEAR earned", r.done, near2(r.earned.0));
        let line2 = format!("pledges {} kept, {} broken", s.pledges_honored, s.pledges_broken);
        let line3 = format!("juries {} served, {} missed; slashed {}", s.juries_served, s.juries_missed, s.slashed);
        // 0.3.2: the member card: credit score, dues and loan, read live like the rest
        let (score, limit) = self.get_credit(who.clone());
        let dues = self.get_dues_status(who.clone());
        let loan = self.get_loan(who.clone()).filter(|l| l.status != crate::lending::LoanStatus::Repaid);
        let line4 = format!("credit {score}/10 (loan up to {} NEAR); {}{}", near2(limit.0),
            match &dues { Some((_, true)) => "dues paid", Some((_, false)) => "dues late", None => "no dues" },
            match &loan { Some(l) if l.status == crate::lending::LoanStatus::Late => "; loan LATE".to_string(),
                Some(l) => format!("; loan {} NEAR open", near2(l.principal.0)), None => String::new() });
        let svg = format!(
            "<svg xmlns='http://www.w3.org/2000/svg' width='600' height='340' viewBox='0 0 600 340'>\
             <rect width='600' height='340' fill='#030a2a'/><rect x='0' y='0' width='600' height='8' fill='#1a4bff'/>\
             <text x='36' y='70' fill='#fff' font-family='sans-serif' font-size='30' font-weight='700'>KOPERASI WORK RECORD</text>\
             <text x='36' y='112' fill='#9fb4ff' font-family='monospace' font-size='18'>{who}</text>\
             <text x='36' y='170' fill='#fff' font-family='sans-serif' font-size='22'>{line1}</text>\
             <text x='36' y='206' fill='#fff' font-family='sans-serif' font-size='22'>{line2}</text>\
             <text x='36' y='242' fill='#fff' font-family='sans-serif' font-size='22'>{line3}</text>\
             <text x='36' y='274' fill='#ffd54a' font-family='sans-serif' font-size='18'>{line4}</text>\
             <text x='36' y='312' fill='{c}' font-family='sans-serif' font-size='18'>{g}</text>\
             <text x='564' y='312' fill='#9fb4ff' font-family='monospace' font-size='14' text-anchor='end'>{co}</text></svg>",
            c = if good { "#7ee2a8" } else { "#ff9a94" },
            g = if good { "in good standing" } else { "not in good standing" },
            co = env::current_account_id(),
        );
        json!({
            "token_id": who,
            "owner_id": who,
            "metadata": {
                "title": format!("Koperasi work record: {who}"),
                "description": format!("{line1}; {line2}; {line3}; {line4}; {}{}. Read live from {} each time: nobody can edit it, \
                    and it cannot be transferred.", if good { "in good standing" } else { "not in good standing" },
                    if member { ", a member" } else { "" }, env::current_account_id()),
                "media": format!("data:image/svg+xml;base64,{}", B64.encode(svg)),
                "media_hash": null, "copies": 1, "issued_at": null, "expires_at": null, "starts_at": null, "updated_at": null,
                "extra": json!({ "done": r.done, "earned": r.earned, "refs": r.refs, "standing": s, "good_standing": good,
                    "member": member, "passport": self.get_passport(who.clone()),
                    "credit": { "score": score, "loan_limit": limit }, "dues": dues, "loan": loan }).to_string(),
                "reference": null, "reference_hash": null,
            },
            "approved_account_ids": {},
        })
    }
}
