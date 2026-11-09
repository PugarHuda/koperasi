//! NEP-297 events. Every state change that matters is logged as `EVENT_JSON:{"standard":"koperasi",...}`, so an
//! indexer or an explorer can follow the co-op without reading its state.

use crate::*;

/// The co-op's events; `data` is the variant's fields, `event` its name in snake_case.
#[near(event_json(standard = "koperasi"))]
pub enum Event {
    // ---------- membership ----------
    /// Someone paid the join deposit and waits for the DAO's vote.
    #[event_version("1.0.0")]
    JoinRequested { account_id: AccountId, deposit: NearToken },
    /// A join request was withdrawn before the vote; the deposit went back.
    #[event_version("1.0.0")]
    JoinCancelled { account_id: AccountId, refunded: NearToken },
    /// The DAO added the account to role `member`; it is now a member here.
    #[event_version("1.0.0")]
    MemberAdded { account_id: AccountId },
    /// The DAO removed the account from role `member`; its join deposit went back.
    #[event_version("1.0.0")]
    MemberLeft { account_id: AccountId, refunded: NearToken },

    // ---------- members' votes ----------
    /// New by-laws: the agent must run this config.
    #[event_version("1.0.0")]
    ConfigSet { version: u32, hash: String, uri: String, contributor: Option<AccountId>, points: u64 },
    /// Contribution points awarded by vote.
    #[event_version("1.0.0")]
    PointsAwarded { account_id: AccountId, points: u64, reason: String },
    /// A member's savings weight (yoctoNEAR staked for inference), by vote or read from the staking pool.
    #[event_version("1.0.0")]
    SavingsSet { account_id: AccountId, savings: U128 },
    /// A stake increase read from the staking pool; it counts as savings from `counts_from` (ns), if still staked.
    #[event_version("1.0.0")]
    SavingsPending { account_id: AccountId, savings: U128, counts_from: U64 },
    /// The staking pool whose stake counts as savings.
    #[event_version("1.0.0")]
    StakingPoolSet { pool: Option<AccountId> },
    /// The profit-share rule.
    #[event_version("1.0.0")]
    ShareRuleSet { reserve_bps: u16, savings_bps: u16, points_bps: u16 },
    /// The co-op moved to another USDC contract.
    #[event_version("1.0.0")]
    UsdcSet { from: AccountId, to: AccountId },
    /// The share ledger was started on an older co-op.
    #[event_version("1.0.0")]
    LedgerStarted { owed: U128 },
    /// The account allowed to record receipts.
    #[event_version("1.0.0")]
    AgentSet { agent_id: AccountId },
    /// A new steward; the previous steward's bond went back.
    #[event_version("1.0.0")]
    StewardSet { steward: Option<AccountId>, bond_returned: NearToken },
    /// The steward added to its bond.
    #[event_version("1.0.0")]
    StewardBonded { steward: AccountId, amount: NearToken, bond: NearToken },
    /// The steward's whole bond went to the DAO.
    #[event_version("1.0.0")]
    StewardSlashed { amount: NearToken },
    /// The agent stopped (kill switch).
    #[event_version("1.0.0")]
    Paused { by: AccountId },
    /// The DAO restarted the agent.
    #[event_version("1.0.0")]
    Unpaused {},
    /// The contract switched to new code by vote.
    #[event_version("1.0.0")]
    Upgraded { code_hash: String },

    // ---------- the agent's work ----------
    /// A job's receipt, under the approved config.
    #[event_version("1.0.0")]
    ReceiptRecorded { job_id: String, price: U128, inference_cost: U128, config_version: u32 },
    /// A receipt's status moved (paid, refunded, disputed).
    #[event_version("1.0.0")]
    ReceiptUpdated { job_id: String, status: ReceiptStatus },

    // ---------- money ----------
    /// The steward deposited Agent Market earnings (forwarded to the DAO).
    #[event_version("1.0.0")]
    EarningsDeposited { amount: U128 },
    /// The DAO shared profit: `paid` credited to members, `reserve` back to the DAO.
    #[event_version("1.0.0")]
    ShareDistributed { period: u32, amount: U128, paid: U128, reserve: U128, members: u32 },
    /// A transfer to the DAO failed; `flush_to_dao` retries it.
    #[event_version("1.0.0")]
    ForwardFailed { amount: U128 },
    /// A member took their profit share.
    #[event_version("1.0.0")]
    ShareClaimed { account_id: AccountId, amount: U128 },
    /// The claim's transfer failed; the share is claimable again.
    #[event_version("1.0.0")]
    ClaimRolledBack { account_id: AccountId, amount: U128 },

    // ---------- tasks with earned trust ----------
    /// The members' trust rule.
    #[event_version("1.0.0")]
    TrustRuleSet { rule: TrustRule },
    /// What the contract may still pay from the treasury.
    #[event_version("1.0.0")]
    TaskBudgetSet { amount: U128 },
    /// A member posted a task.
    #[event_version("1.0.0")]
    TaskPosted { id: u32, poster: AccountId, amount: U128 },
    /// Someone took a task.
    #[event_version("1.0.0")]
    TaskClaimed { id: u32, contributor: AccountId },
    /// The contributor handed the task back.
    #[event_version("1.0.0")]
    TaskGivenUp { id: u32, contributor: AccountId },
    /// The contributor delivered.
    #[event_version("1.0.0")]
    TaskSubmitted { id: u32, deliverable: String },
    /// The poster accepted; `on_trust` = paid with no vote, else it waits for one other member.
    #[event_version("1.0.0")]
    TaskAccepted { id: u32, on_trust: bool },
    /// One other member approved the payout.
    #[event_version("1.0.0")]
    TaskApproved { id: u32, approver: AccountId },
    /// The poster or the DAO cancelled the task.
    #[event_version("1.0.0")]
    TaskCancelled { id: u32, by: AccountId },
    /// The contract filed the payout as a Transfer proposal in the DAO.
    #[event_version("1.0.0")]
    PayoutFiled { id: u32, proposal_id: u64 },
    /// The payout moved from the treasury.
    #[event_version("1.0.0")]
    TaskPaid { id: u32, contributor: AccountId, amount: U128, points: u64 },
    /// The payout did not happen; the budget is back and the task is `status`.
    #[event_version("1.0.0")]
    TaskUnpaid { id: u32, status: TaskStatus },
    /// One more point on a record, from `source` ("task:<id>" or "dao-proposal:<id>").
    #[event_version("1.0.0")]
    RecordCredited { account_id: AccountId, source: String, points: u64 },
}
