//! Koperasi's TEE registry: the Shade Agent pattern for the co-op's agents.
//!
//! A worker running in an Intel TDX confidential VM (Phala Cloud, dstack) derives its NEAR key inside the TEE; its
//! account is the implicit account of that key. It calls `register_agent` with its attestation (the same shape
//! `@neardefi/shade-agent-js` produces). This contract verifies, on-chain, with `shade-attestation` (dcap-qvl):
//! the quote is genuine Intel TDX with an up-to-date TCB, its report data is the caller's account (so the key is the
//! TEE's), the PPID is one the members approved, and the measurements (MRTD, RTMR0-2, the key-provider event and the
//! app-compose hash: which code, pinned to a commit of the public repo) are ones the members approved. Then it tells the
//! co-op's contract that this account is attested until a date; the co-op accepts receipts from an agent the members
//! marked "TEE only" only while that holds. The owner is the co-op's DAO: only its vote approves code or hardware.

use near_sdk::json_types::U64;
use near_sdk::store::LookupMap;
use near_sdk::{env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault};
use shade_attestation::attestation::DstackAttestation;
use shade_attestation::measurements::{FullMeasurements, FullMeasurementsHex};
use shade_attestation::report_data::ReportData;
use shade_attestation::tcb_info::HexBytes;

const VALID_FOR_NS: u64 = 7 * 86_400_000_000_000;
const GAS_NOTE: Gas = Gas::from_tgas(10);
const REGISTER_DEPOSIT: NearToken = NearToken::from_millinear(5);

#[ext_contract(ext_coop)]
#[allow(dead_code)]
trait Coop {
    fn note_attested(&mut self, account_id: AccountId, until: U64, compose_hash: String);
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Agent {
    pub compose_hash: String,
    pub ppid: String,
    pub registered_at: U64,
    pub valid_until: U64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    owner: AccountId,
    coop: AccountId,
    measurements: Vec<FullMeasurementsHex>,
    ppids: Vec<HexBytes<16>>,
    agents: LookupMap<AccountId, Agent>,
}

#[near]
impl Registry {
    #[init]
    pub fn new(owner: AccountId, coop: AccountId) -> Self {
        Self { owner, coop, measurements: vec![], ppids: vec![], agents: LookupMap::new(b"a") }
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the co-op's DAO");
    }

    /// The co-op's DAO: code (measurements) a worker may run.
    pub fn approve_measurements(&mut self, measurements: FullMeasurementsHex) {
        self.assert_owner();
        if !self.measurements.contains(&measurements) {
            self.measurements.push(measurements);
        }
        env::log_str("approved measurements");
    }

    /// The co-op's DAO: TDX machines (PPIDs) a worker may run on.
    pub fn approve_ppids(&mut self, ppids: Vec<HexBytes<16>>) {
        self.assert_owner();
        for p in ppids {
            if !self.ppids.contains(&p) {
                self.ppids.push(p);
            }
        }
    }

    /// The co-op's DAO: forget all approved code and machines (no worker registers again). An attestation already
    /// noted at the co-op holds until it expires (7 days) unless the members also call its `revoke_attestation`.
    pub fn revoke_all(&mut self) {
        self.assert_owner();
        self.measurements.clear();
        self.ppids.clear();
    }

    /// A worker in a TEE registers its implicit account with its attestation (verified here, on-chain).
    #[payable]
    pub fn register_agent(&mut self, attestation: DstackAttestation) -> bool {
        require!(env::attached_deposit() >= REGISTER_DEPOSIT || self.agents.contains_key(&env::predecessor_account_id()),
            "attach 0.005 NEAR for the record's storage");
        let who = env::predecessor_account_id();
        // the report data is the account: an implicit account is the hex of the TEE-derived public key
        let id = who.as_str();
        require!(id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()), "register from the TEE's implicit account");
        let mut rd = [0u8; 64];
        for (i, c) in id.as_bytes().chunks(2).enumerate() {
            rd[i] = u8::from_str_radix(core::str::from_utf8(c).unwrap(), 16).unwrap();
        }
        let accepted: Vec<FullMeasurements> = self.measurements.iter().cloned().map(Into::into).collect();
        let now = env::block_timestamp();
        let ok = attestation
            .verify(ReportData::from(rd), now / 1_000_000_000, &accepted, &self.ppids)
            .unwrap_or_else(|e| env::panic_str(&format!("attestation refused: {e}")));
        let compose_hash = hex(ok.measurements.app_compose_hash_payload.as_ref());
        let agent = Agent {
            compose_hash: compose_hash.clone(),
            ppid: hex(ok.ppid.as_ref()),
            registered_at: U64(now),
            valid_until: U64(now + VALID_FOR_NS),
        };
        env::log_str(&format!("EVENT_JSON:{{\"standard\":\"koperasi-tee\",\"version\":\"1.0.0\",\"event\":\"agent_attested\",\"data\":{{\"account_id\":\"{who}\",\"compose_hash\":\"{compose_hash}\",\"ppid\":\"{}\",\"valid_until\":\"{}\"}}}}", agent.ppid, agent.valid_until.0));
        self.agents.insert(who.clone(), agent.clone());
        let _ = ext_coop::ext(self.coop.clone()).with_static_gas(GAS_NOTE).note_attested(who, agent.valid_until, compose_hash);
        true
    }

    pub fn get_agent(&self, account_id: AccountId) -> Option<Agent> {
        self.agents.get(&account_id).cloned()
    }

    pub fn get_contract_info(&self) -> (AccountId, AccountId, Vec<FullMeasurementsHex>, Vec<String>) {
        (self.owner.clone(), self.coop.clone(), self.measurements.clone(), self.ppids.iter().map(|p| hex(p.as_ref())).collect())
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
