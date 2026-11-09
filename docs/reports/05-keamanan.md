# 05 · Security (Web3 Security Auditor), 8 Nov 2026

Builds on [04-dapp](04-dapp.md). The chain is NEAR (Rust), so Slither and Aderyn do not apply. Their counterparts here
are clippy for wasm and a manual review; there is a PoC test for every flow-level finding.

## Scanners

| Tool | Before | After |
|---|---|---|
| `cargo clippy --target wasm32-unknown-unknown` | 3 warnings in `lib.rs` (existing) | the same 3 (on-chain code, see S7), with 0 warnings in `tasks.rs` (the doc-style warnings were fixed in the #25 upgrade) |
| `cargo audit` | not installed | not run (known issue): the only dependency is `near-sdk 5.30` |
| `npm audit --audit-level=high` | 0 high/critical, 2 low | the same; CI fails on high |
| Secret scan: `git ls-files` and history for `.keys`, `.env`, `ed25519:` keys | clean | clean (`.keys/` and `.env` are in `.gitignore`) |

## Manual review of `tasks.rs`

| ID | Component | Severity | Risk | PoC / test | Status |
|---|---|---|---|---|---|
| S1 | `approve_task` | High (prevented) | The poster or the contributor approving their own payout | `the_poster_cannot_approve_their_own_payout` | safe from the start |
| S2 | `on_approve_policy` | High (prevented) | A former member (removed from the DAO, not yet synced to the contract) approving | `a_non_member_cannot_approve`; the role is read from `get_policy` at that moment, not from the contract's copy | safe |
| S3 | `pay` / callback | High (prevented) | A failed transfer reducing the budget or creating a record without payment | `a_bounced_payout_goes_back_to_the_budget_and_earns_nothing` | safe |
| S4 | Approval race | Medium (prevented) | Two approvals in the same block paying twice | the callback checks again for `NeedsApproval`; the first sets `Paying` | safe |
| S5 | `credit_dao_bounty` | Medium (prevented) | The same proposal counted twice, or an unapproved proposal or one of another kind counted | `an_approved_dao_bounty_counts_once_on_the_receivers_record`; the `credited:` key is checked again inside the callback | safe |
| S6 | Collusion | Medium | Two members (poster plus approver) can pay a friend up to `one_vote_max` per task. A member posting for a contributor with a record can pay up to `auto_max` without anyone else. | Limited by the **budget the members voted** (`payouts_stop_at_the_budget_the_members_voted`). The DAO can cancel a task and take the budget back (`return_budget`). | known issue, documented |
| S10 | `accept_task` | Medium | A poster the members removed could still accept their old tasks and pay on trust from the budget (automated review finding) | `a_poster_the_members_removed_cannot_pay_on_trust` | **fixed**, proposal #25 |
| S11 | `set_trust` | Medium | `trusted_after = 0` would make anyone trusted from their first task (automated review finding) | `trust_needs_at_least_one_finished_task` | **fixed**, proposal #25 |
| S7 | `lib.rs` clippy | Low | Style only, not a bug | – | known issue |
| S8 | Storage | Low | `TASK_FEE` of 0.01 NEAR covers about 1 KB. The longest task (500 + 500 characters + accounts) is about 1.2 KB, and the shortfall comes from the contract's own balance (about 7 NEAR besides the budget). | – | known issue; fix in the next upgrade |
| S9 | Contributor protection | Low | The poster can cancel a `Claimed` task after the contributor has started. The poster can also never accept, so the task waits until the DAO cancels it. | – | known issue: disputes go to the DAO, which can pay by `Transfer` proposal |

**Reentrancy and CEI:** state is written before every transfer, and every callback is `#[private]`. **Integer:**
`overflow-checks = true` in release; budget arithmetic uses u128 with a `<=` check before subtracting. **DoS:**
`get_tasks` is paged; `get_contributors` is a single list, marked `ponytail:` with its limit.

## Frontend and infra

- **XSS.** Every value from the chain passes through `esc()` before `innerHTML`. Links are only created for
  `^https://\S+$`, and are escaped as well. `rel="noopener"` is set.
- **No server and no secrets** in the bundle: a static page that reads public RPCs. No SIWE, because there is no backend session.
- **Honest transaction details.**
  - The posting button names the amount and the 0.01 NEAR storage fee.
  - Accepting says whether it will pay at once.
  - There are no token approvals (NEAR has no unlimited `approve`; the USDC transfer to the contract is a proposal that members see in full).
- **Headers:** added `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy` and `Permissions-Policy`; HSTS
  comes from Vercel. **CSP: known issue.** The page loads modules from esm.sh, the wallet connector and WASM for the TDX
  check, and a CSP that is too tight would break them. This needs an end-to-end CSP test before it is switched on.

## Known issues (not fixed)

S6, S7, S8 and S9; CSP; `cargo audit` not run.

The next round is in [05-security](05-security.md).
