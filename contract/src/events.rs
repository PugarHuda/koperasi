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
    /// Earnings of jobs paid more than the grace period ago were not passed on (`overdue` USDC), so anyone slashed the bond.
    #[event_version("1.0.0")]
    StewardSlashedOverdue { amount: NearToken, overdue: U128 },
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
    /// The least USDC the DAO must keep outside a profit share.
    #[event_version("1.0.0")]
    ReserveFloorSet { amount: U128 },
    /// A profit share went back to the DAO: it would have left the treasury below the floor (or its balance was unreadable).
    #[event_version("1.0.0")]
    ShareRefused { amount: U128, dao_balance: Option<U128>, floor: U128 },
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
    /// The members' veto window for payouts on trust (0: none).
    #[event_version("1.0.0")]
    VetoWindowSet { minutes: u32 },
    /// A payout on trust waits for a member's veto until `until` (ns).
    #[event_version("1.0.0")]
    TaskHeld { id: u32, until: U64 },
    /// A member vetoed a held payout; it now needs one other member's approval.
    #[event_version("1.0.0")]
    TaskVetoed { id: u32, by: AccountId },
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

    // ---------- commons: pledges, the co-op court, standing, the steward's term ----------
    /// A member promised a service to the co-op, `units` times (a commitment voucher).
    #[event_version("1.0.0")]
    PledgeMade { id: u32, issuer: AccountId, what: String, units: u32 },
    /// Another member called in one unit of a pledge.
    #[event_version("1.0.0")]
    PledgeRedeemed { id: u32, claim: u32, holder: AccountId },
    /// The holder said whether the pledge was kept (or, after the due time, that it was not).
    #[event_version("1.0.0")]
    PledgeSettled { claim: u32, issuer: AccountId, honored: bool },
    /// Someone disputed a paid job; three members were drawn at random as jurors.
    #[event_version("1.0.0")]
    CaseOpened { id: u32, job_id: String, claimant: AccountId, refund_to: AccountId, amount: U128, jurors: Vec<AccountId> },
    /// A juror's ruling.
    #[event_version("1.0.0")]
    CaseVoted { id: u32, juror: AccountId, uphold: bool },
    /// The jury decided; an upheld case refunds `amount` USDC from the treasury.
    #[event_version("1.0.0")]
    CaseClosed { id: u32, upheld: bool, missed: Vec<AccountId> },
    /// The contract filed (and approved, as role `tasks`) the refund of an upheld case.
    #[event_version("1.0.0")]
    RefundFiled { id: u32, proposal_id: u64 },
    /// The claimant took a dismissed case to the members: `proposal_id` is the refund, for every member to vote.
    #[event_version("1.0.0")]
    CaseAppealed { id: u32, proposal_id: u64, claimant: AccountId },
    /// The members decided an appeal: upheld means they paid the refund.
    #[event_version("1.0.0")]
    AppealSettled { id: u32, upheld: bool },
    /// Where a member wants the co-op's payouts (profit shares through the agent's Intents wallet) to land.
    #[event_version("1.0.0")]
    PayoutRouteSet { account_id: AccountId, chain: String, address: String },
    /// How long a steward serves before the role lapses unless the members re-appoint them (0: no limit).
    #[event_version("1.0.0")]
    StewardTermSet { days: u32 },
    /// The steward's term ran out: the role is empty until the members appoint one.
    #[event_version("1.0.0")]
    StewardTermEnded { steward: AccountId },
    /// The members voted the agent's share of every profit share (into the risk fund).
    #[event_version("1.0.0")]
    AgentShareSet { bps: u16 },
    /// The agent's share of a profit share went into the risk fund, scaled by its standing.
    #[event_version("1.0.0")]
    AgentShare { amount: U128, standing_bps: u16 },
    /// The members named the federation whose rules bind this co-op (None: left it).
    #[event_version("1.0.0")]
    FederationSet { federation: Option<AccountId> },
    /// The federation set the loan ceiling for its member co-ops.
    #[event_version("1.0.0")]
    FederationRulesSet { max_rate_bps: u16, max_term_days: u32 },
    /// A sister co-op said an account's loan there is late (or settled).
    #[event_version("1.0.0")]
    LateElsewhere { account_id: AccountId, coop: AccountId, late: bool },
    /// The members named the TEE registry whose attestations count.
    #[event_version("1.0.0")]
    TeeRegistrySet { registry: Option<AccountId> },
    /// The members said whether an agent must run in an attested TEE.
    #[event_version("1.0.0")]
    AgentTeeSet { account_id: AccountId, required: bool },
    /// The TEE registry verified an agent's attestation on-chain.
    #[event_version("1.0.0")]
    AgentAttested { account_id: AccountId, until: U64, compose_hash: String },
    /// The members set how many days apart the agent may propose by-laws.
    #[event_version("1.0.0")]
    AgentProposeEverySet { days: u64 },
    /// The co-op's agent put new by-laws to the members (a DAO proposal the contract filed).
    #[event_version("1.0.0")]
    AgentProposed { version: u32, hash: String, proposal_id: u64 },
    /// The members voted the share of every profit share split by credit score.
    #[event_version("1.0.0")]
    ReputationShareSet { bps: u16 },
    /// A profit share's reputation dividend was credited by credit score.
    #[event_version("1.0.0")]
    ReputationDividend { amount: U128 },
    /// The members voted the share of every earnings deposit kept in the risk fund.
    #[event_version("1.0.0")]
    AgentSavesSet { bps: u16 },
    /// Part of an earnings deposit stayed in the risk fund.
    #[event_version("1.0.0")]
    AgentSaved { amount: U128 },
    /// A court case was refunded from the risk fund at once.
    #[event_version("1.0.0")]
    RefundFromRiskFund { id: u32, amount: U128 },
    /// A refund from the risk fund bounced; the amount went back to the fund.
    #[event_version("1.0.0")]
    RiskRefundFailed { id: u32, amount: U128 },
    /// The members voted a further agent its own by-laws.
    #[event_version("1.0.0")]
    AgentConfigSet { account_id: AccountId, version: u32, hash: String },
    /// The members voted further agents and the job tags each takes.
    #[event_version("1.0.0")]
    AgentsSet { agents: Vec<AccountId> },
    /// The members voted the funds paid from every profit share's reserve (education, social…).
    #[event_version("1.0.0")]
    ShareFundsSet { funds: u32 },
    /// A fund's part of a profit share was paid.
    #[event_version("1.0.0")]
    FundPaid { name: String, to: AccountId, amount: U128 },
    /// A member guaranteed an account.
    #[event_version("1.0.0")]
    Guaranteed { account_id: AccountId, guarantor: AccountId },
    /// A guarantor withdrew.
    #[event_version("1.0.0")]
    GuaranteeWithdrawn { account_id: AccountId, guarantor: AccountId },
    /// The guaranteed account fell out of good standing: the guarantor answers for it.
    #[event_version("1.0.0")]
    GuaranteeCalled { account_id: AccountId, guarantor: AccountId },
    /// The members cleared a guarantor's marks.
    #[event_version("1.0.0")]
    GuaranteeCleared { account_id: AccountId },
    /// The members voted the loan rule and the fund.
    #[event_version("1.0.0")]
    LoanRuleSet { max_loan: U128, rate_bps: u16, term_days: u32, fund: U128 },
    /// A member borrowed from the loan fund.
    #[event_version("1.0.0")]
    LoanRequested { account_id: AccountId, amount: U128, due: U64 },
    /// The contract filed the loan as a DAO Transfer.
    #[event_version("1.0.0")]
    LoanFiled { account_id: AccountId, proposal_id: u64 },
    /// A loan was repaid into the treasury.
    #[event_version("1.0.0")]
    LoanRepaid { account_id: AccountId, amount: U128 },
    /// A loan was called late.
    #[event_version("1.0.0")]
    LoanLate { account_id: AccountId },
    /// The members voted the mandatory dues (amount 0: none).
    #[event_version("1.0.0")]
    DuesSet { amount: U128, every_days: u32 },
    /// A member paid dues into the DAO treasury.
    #[event_version("1.0.0")]
    DuesPaid { account_id: AccountId, periods: u32, amount: U128, paid_until: U64 },
    /// A member put an item on the annual meeting's agenda.
    #[event_version("1.0.0")]
    AgendaProposed { year: u32, by: AccountId },
    /// The members approved the year's accountability report.
    #[event_version("1.0.0")]
    AnnualMeetingHeld { year: u32, report_sha256: String },
    /// A court case was upheld against the agent's job.
    #[event_version("1.0.0")]
    AgentStruck { case: u32, strikes: u32, suspended: bool },
    /// The members reinstated the agent.
    #[event_version("1.0.0")]
    AgentReinstated {},
    /// The claimant or the steward filed a piece of evidence in a court case.
    #[event_version("1.0.0")]
    EvidenceFiled { id: u32, by: AccountId },
    /// The members voted which other co-ops' work records count here (the passport).
    #[event_version("1.0.0")]
    SisterCoopsSet { coops: Vec<AccountId> },
    /// A sister co-op's work record was read and stamped into an account's passport (`kept` false: the stamp removed).
    #[event_version("1.0.0")]
    PassportStamped { account_id: AccountId, coop: AccountId, done: u32, kept: bool },
    /// The co-op's agent passed a job to a sister co-op (the referral board).
    #[event_version("1.0.0")]
    JobReferred { id: u32, job_id: String, to_coop: AccountId, budget_usdc: U128 },
    /// The co-op's agent accepted a job a sister co-op referred to it, read from the sister's board (0.3.6).
    #[event_version("1.0.0")]
    ReferralAccepted { id: u32, job_id: String, from_coop: AccountId, referral_id: u32, budget_usdc: U128 },
    /// The suspended agent (or the steward for it) filed a recovery plan (0.3.6).
    #[event_version("1.0.0")]
    RecoveryProposed { plan_uri: String, plan_sha256: String, by: AccountId },
    /// The members approved the recovery plan: the agent is reinstated, its standing ramps back over `ramp_days`.
    #[event_version("1.0.0")]
    RecoveryApproved { plan_sha256: String, ramp_days: u32 },
    /// How many days the agent's standing ramps back after an approved recovery plan.
    #[event_version("1.0.0")]
    RecoveryDaysSet { days: u32 },

    // ---------- 0.3.6 (part B): polls and loans to sister co-ops ----------
    /// The members voted how technical polls are weighed ("reputation" or "one_member").
    #[event_version("1.0.0")]
    TechnicalVoteSet { mode: String },
    /// A member opened a poll; `mode` is how its votes are weighed, fixed now.
    #[event_version("1.0.0")]
    PollOpened { id: u32, kind: crate::polls::PollKind, mode: String, by: AccountId, options: u32, closes_at: U64 },
    /// A member voted in a poll, with the weight counted (1, or their reputation weight).
    #[event_version("1.0.0")]
    PollVoted { id: u32, by: AccountId, option: u32, weight: U128 },
    /// A poll was counted after its deadline (`result` None: no votes or a tie for first).
    #[event_version("1.0.0")]
    PollClosed { id: u32, result: Option<u32>, mode: String, tallies: Vec<U128> },
    /// The members lent a sister co-op USDC from the risk fund.
    #[event_version("1.0.0")]
    SisterLoan { id: u32, coop: AccountId, paid_to: AccountId, amount: U128, due: U64 },
    /// A sister loan's transfer failed; the amount went back to the risk fund.
    #[event_version("1.0.0")]
    SisterLoanFailed { id: u32, coop: AccountId, amount: U128 },
    /// A sister loan was (partly) repaid into the risk fund.
    #[event_version("1.0.0")]
    SisterRepaid { id: u32, coop: AccountId, amount: U128, outstanding: U128 },
    /// A sister loan was called late after its due date; told to every sister co-op.
    #[event_version("1.0.0")]
    SisterLate { id: u32, coop: AccountId, outstanding: U128 },

    // ---------- 0.3.7 (part A): poll results to the DAO, juries by reputation ----------
    /// A closed technical poll's winning by-laws were filed as DAO proposal `proposal` (set_config).
    #[event_version("1.0.0")]
    PollProposed { id: u32, proposal: u64 },
    /// The members voted how jurors are drawn: by reputation weight, or uniformly.
    #[event_version("1.0.0")]
    JuryModeSet { by_reputation: bool },
    // ---------- 0.3.7 (part B): interest on sister loans; the agent asks for one ----------
    /// Interest paid on a sister loan, forwarded to the DAO treasury: surplus for the next profit share.
    #[event_version("1.0.0")]
    SisterInterest { id: u32, coop: AccountId, amount: U128 },
    /// The agent asked the members to lend a sister co-op: the DAO proposal that calls `lend_to_sister`.
    #[event_version("1.0.0")]
    LoanSuggested { coop: AccountId, amount: U128, proposal: u64 },

    // ---------- 0.3.8: the agent opens polls; the referral share is paid automatically ----------
    /// The co-op's agent opened technical poll `id`, for this reason.
    #[event_version("1.0.0")]
    AgentPollOpened { id: u32, reason: String },
    /// The members voted the share of a referred job's earnings paid to the co-op that referred it.
    #[event_version("1.0.0")]
    ReferralShareSet { bps: u16 },
    /// The members named (or, None, removed) the treasury a sister co-op's referral share is paid to.
    #[event_version("1.0.0")]
    CoopTreasurySet { coop: AccountId, treasury: Option<AccountId> },
    /// Part of a referred job's earnings was sent to the referring co-op's treasury.
    #[event_version("1.0.0")]
    ReferralSharePaid { job_id: String, from_coop: AccountId, to: AccountId, amount: U128 },
    /// That transfer failed: the amount went to the DAO's unforwarded balance (`flush_to_dao`), for the members to pay.
    #[event_version("1.0.0")]
    ReferralShareFailed { job_id: String, from_coop: AccountId, amount: U128 },

    // ---------- 0.3.9: binding federation credit; the federation dividend ----------
    /// A sister loan was lent under the co-op's federation credit score: at most `cap` (half the risk fund x score/100).
    #[event_version("1.0.0")]
    CoopCreditCap { coop: AccountId, score: u32, cap: U128 },
    /// The members voted the share of each sister loan's interest split among the other sister co-ops' treasuries.
    #[event_version("1.0.0")]
    FederationDividendSet { bps: u16 },
    /// Part of a sister loan's interest was sent to another sister co-op's treasury.
    #[event_version("1.0.0")]
    FederationDividend { loan_id: u32, to: AccountId, amount: U128 },
    /// That transfer failed: the amount went to the DAO's unforwarded balance (`flush_to_dao`).
    #[event_version("1.0.0")]
    FederationDividendFailed { loan_id: u32, to: AccountId, amount: U128 },

    // ---------- 0.3.10 (after the hackathon deadline): NEAR Intents payouts, payout caps, the co-op job market ----------
    /// The members named (or, None, removed) the NEAR Intents verifier referral shares are paid through.
    #[event_version("1.0.0")]
    IntentsVerifierSet { verifier: Option<AccountId> },
    /// A referral share goes through NEAR Intents: deposited on `verifier`, then withdrawn to the treasury `to`.
    #[event_version("1.0.0")]
    ReferralShareViaIntents { job_id: String, verifier: AccountId, to: AccountId, amount: U128 },
    /// The members capped one payment to `destination` (0: no cap).
    #[event_version("1.0.0")]
    PayoutCapSet { destination: AccountId, max_per_payment: U128 },
    /// This co-op's agent offered its sister co-ops a job.
    #[event_version("1.0.0")]
    CoopJobPosted { job_id: String, budget_usdc: U128, deadline: U64 },
    /// This co-op's agent bid for a job a sister co-op offered.
    #[event_version("1.0.0")]
    CoopBidPlaced { from_coop: AccountId, job_id: String, price_usdc: U128 },
    /// A job this co-op offered went to the sister co-op with the best bid.
    #[event_version("1.0.0")]
    CoopJobAwarded { job_id: String, coop: AccountId, price: U128 },
}
