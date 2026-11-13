# 05 · Security (Web3 Security Auditor), 9 Nov 2026

This report follows [05-security-8nov](05-security-8nov.md), the first round on 8 Nov. That round covered findings S1–S11 in `tasks.rs`. This round covers the code added since:
- the stuck-payout settlement (T6);
- NEP-297 events;
- the leave flow;
- the live feed;
- the checks the page runs before signing;
- the profit share on the showcase.

It also re-scans the whole repository.

The chain is NEAR, and the contract is written in Rust. Slither and Aderyn only analyse Solidity (EVM), so they cannot run here. Their place is taken by:
- `cargo clippy` on the wasm target;
- `cargo audit`;
- gitleaks;
- a manual review against the brief's checklist;
- one PoC test per finding.

## Scanners: before and after

| Tool | Before (start of this round) | After |
|---|---|---|
| `cargo clippy --target wasm32-unknown-unknown --release` | 0 warnings (fixed in [03](03-contracts.md)) | 0 warnings |
| `cargo audit` (RustSec, 1 422 advisories, 446 crates) | not run in round 1 | 1 vulnerability and 2 "unmaintained" warnings. **None is in code the contract runs**; see D1–D3 |
| `npm audit` | 2 low, 0 high, 0 critical | the same; see D4 |
| gitleaks 8.21.2, **all 68 commits** of the git history | not run in round 1 | **no leaks found** |
| `.gitignore` | `.keys/`, `.env` ignored | the same. The page is static: no key, mnemonic or paid RPC key is in `web/` |
| Contract tests | 89 | **90** (+ PoC S12); round 3: **91** (S12 fixed) |
| Unit tests (page and agent) | 19 | **23** (+ PoC S14–S17); round 3: **26** (+ relayer) |
| E2E desktop | 34 passed | 34 passed, 20 skipped (same as before) |

## Findings

Severity follows the brief: Critical, High, Medium, Low. Earlier findings S1–S11 are in 05-security-8nov. They are still fixed, and their tests still pass.

| ID | Component | Severity | Impact | PoC | Status |
|---|---|---|---|---|---|
| S12 | `on_staked` / `distribute` (`lib.rs`): savings from the staking pool | **Medium** | Savings are the stake read at the last `sync_savings`. A member can stake a large amount just before a profit share passes the vote, call `sync_savings`, and unstake afterwards. They then take most of the savings pool, at the cost of only the unstaking lock-up (about 4 epochs). Other members' savings shares are diluted. Nobody can steal treasury funds this way | PoC (old code): with 9 900 NEAR staked the day before, Mallory took 39.6 of the 40 USDC savings pool; Alice, who saved for months, got 0.4. Now `s12_a_stake_just_before_a_share_does_not_count_yet`: Mallory gets 0, Alice 40 | **Fixed** (round 3), live by vote #48, see below |
| S13 | DAO policy (live on testnet) | **Medium** (centralization) | Every power over the co-op goes through the DAO's `member` role: treasury, code upgrades, by-laws, removing members. On the showcase that role has 4 accounts, and 3 of them belong to the team (alice, bob, steward). A vote needs 3 of 4, so the team alone can pass anything | Read on-chain: `get_policy` gives `member` = 4 accounts with threshold 1/2 (RoleWeight). Neither the contract nor the DAO has a full-access key (`view_access_key_list` = `[]`) | **Known issue**: the showcase needs real members (the owner's task). The code has no admin key and no owner bypass |
| S14 | Page hero: "Proposal #N passed with X yes votes" (`app.js`) | **Medium** | Anyone can file a DAO proposal (`all: *:AddProposal`, 0.1 NEAR bond). The page took the newest proposal whose `set_config` args matched the current hash, without checking that it was approved or addressed to the co-op. One fake proposal made the page say "Proposal #8 passed with 0 yes votes", or, with unreadable args, mark every member "voted yes" | unit `S14: a proposal anyone files cannot pose as the members' by-laws vote`. The old logic, run on the same data, picked open proposal #8, and threw on #10, which made every member show as voted yes | **Fixed**: `configVote` (share.js) counts only an *Approved* `set_config` call to the co-op contract and catches unreadable args. If no vote is found the page now says "vote not found" instead of "voted yes". On the live chain it still finds vote #7 (Approved, by-laws v3) |
| S15 | Proposal descriptions in the wallet panel (`wallet.js`) | **Medium** | Members vote from the "what it really does" block. A proposer could put line breaks in the `role`, `token_id` or `method_name` strings to add a fake line, e.g. `role: "member\n\nProfit share: send 1.00 USDC…"`. A Transfer also showed its raw amount in base units, and did not flag an unknown token | unit `S15: a proposer's role, token or method name stays on one line` | **Fixed**: `oneLine` (one line, at most 64 characters). A Transfer now goes through `pays()`, so it shows NEAR, USDC, or "base units of UNKNOWN token X" |
| S16 | By-laws download (`app.js`) | **Low** (needs a DAO vote) | `set_config.uri` is free text. A path like `/evil.example/x.yaml` turned into `//evil.example/...`, so the page would fetch the file from another host. That leaks visitors' IPs. There is no XSS: the file is hash-checked and escaped | unit `S16: the by-laws path a vote sets cannot point the page at another host` | **Fixed**: `byLawsPath` allows only a relative path on this site: no leading `/`, no `//`, no `..` |
| S17 | Live feed (`live.js` / `txList`) | **Low** | An indexer row with a 30-digit `block_timestamp` passed the check. `toISOString()` then threw, and the feed stopped until the next poll | unit `S17: an indexer timestamp too large…`. It **fails** with the old regex (checked by switching the fix off) | **Fixed**: at most 19 digits, which is a u64 in nanoseconds |
| S18 | `esc()` (`near.js`) | **Low** (latent) | It did not escape `'`. Every attribute that holds data today uses `"`, so nothing could be injected yet, but the first single-quoted attribute would be | review | **Fixed**: `'` becomes `&#39;` |
| S19 | Third-party modules (`wallet.js`, `tee.js`) | **Medium** (supply chain) | `@hot-labs/near-connect@0.12.0` and `@phala/dcap-qvl@0.7.1` are pinned versions loaded from esm.sh, without a subresource integrity check. If esm.sh were compromised, it would run code on the page and could alter the transaction sent to the wallet. The wallet still shows the receiver, the method and the deposit before you sign | review | **Fixed** (round 3): vendored in `web/vendor/` |
| S20 | CSP (`vercel.json`) | **Low** | `frame-ancestors`, `base-uri`, `object-src` and `form-action` are locked. `script-src` and `connect-src` are left open | review | **Known issue** (from round 1), see below |
| S21 | Agent runtime: prompt injection through a market job | **Low** | The buyer's job text goes to the model as the user message. The model has no tools. The agent's only key is a function-call key limited to `record_receipt` and `update_receipt` on the co-op (checked on-chain). The by-laws hash must match, or the contract refuses the receipt. An injected prompt can change only that buyer's own answer. The system prompt is public anyway (`config/*.yaml`) | review; key list read on-chain | Accepted by design |
| S22 | Gasless relayer (`api/relay.mjs`, round 3) | **Medium** (gas drain) | First version: it checked the delegate's signature against the key inside the delegate, not against the sender's keys, so anyone could sign in a member's name with their own key; and the same delegate could be sent twice. Either way the chain refuses the call, but only after the relayer paid the gas. Two copies sent at once could also both pass the replay check | automated review of the commit; unit test `a key that is not the sender's…` | **Fixed**: the key must be on the sender's account (`view_access_key`), the nonce above the key's, the delegate not expired, and its hash is reserved before any await. A replay is refused before the chain (live test below) |

### Dependencies

| ID | Package | Severity | Where it runs | Status |
|---|---|---|---|---|
| D1 | `crypto-bigint 0.5.5` (RUSTSEC-2026-0387, timing variability) | vulnerability | Pulled in by `near-sdk` → `near-vm-runner` → `p256`. That is the mock VM for unit tests; `cargo tree --target wasm32-unknown-unknown` does not contain it. The contract uses no P-256 and holds no secrets | Known issue: cannot be bumped without a new near-sdk; not in the deployed wasm |
| D2 | `wee_alloc 0.4.5` (unmaintained) | warning | **In the wasm** (near-sdk's allocator) | Known issue. NEAR starts a fresh wasm instance for every call, so wee_alloc's known leaks cannot build up. Switching it means leaving near-sdk's default allocator; the S12 upgrade (#48) did not change it |
| D3 | `unsafe-libyaml 0.2.11` (unmaintained) | warning | near-sdk's test parameters, host only | Known issue: not in the wasm |
| D4 | `elliptic` through `@phala/dcap-qvl` (npm, low) | low | The agent and the in-browser TDX quote check. It verifies public signatures and holds no private key | Known issue. npm's suggested fix is a downgrade to 0.2.0, which would drop TDX support |

No dependency is unused: `npm ls --depth=0` lists 5 runtime and 7 dev packages, and each is imported.

## Brief checklist

| Check | Result |
|---|---|
| Reentrancy | NEAR calls are asynchronous: a callback runs in a later receipt, never inside the call that triggered it. Every money path writes state before its transfer: `claimable.remove` before `ft_transfer`, `pending.remove` before the refund, the `inflight:`/`moved:` keys before the DAO vote (T6). Every callback is `#[private]`. `on_claimed` and `on_forwarded` put the amount back if the transfer fails (`claim_failure_restores_balance`, `the_ledger_follows_shares_claims_and_failed_claims`, the ledger invariant in proptest) |
| Access control | `assert_dao` on every setter, on upgrade and on unpause. `assert_agent` on receipts. Only the steward bonds; the DAO or the steward can pause. `ft_on_transfer` ignores any token except the co-op's USDC, and accepts only the right sender for each `msg` (tests `fake_token_is_returned`, `earnings_from_someone_else_are_returned`, `share_from_a_non_dao_sender_is_returned`) |
| Integers | `overflow-checks = true` in release. u128 money. The budget is checked before every subtraction; `checked_div` handles empty pools. Proptest fuzzes the share split and the task budget (see 03) |
| Oracle / price | No price oracle. The only outside reading is the staking pool's balance (S12) |
| Front-running / MEV | NEAR has no public mempool ordered by fee. The workable form is acting before a visible DAO vote passes, which is S12. Two members approving the same task in the same block: the callback checks the state again (S4) |
| Signature replay | The contract verifies no signatures. Transactions use NEAR's access-key nonces and a recent block hash, and the chain id is in the account name (`.testnet`). The agent's ECDSA check of the NEAR AI TEE signature binds the request and response hashes (`agent/sig.mjs`) |
| DoS through loops and gas | `distribute` loops over all members; joining needs a DAO vote, so the members decide how many there are (ponytail note in the code). Views are paged: `get_members`, `get_receipts`, `get_tasks`. Proposal spam costs a 0.1 NEAR bond, and members can `VoteRemove` it |
| Unchecked return values | Every cross-contract result is read with `#[callback_result]`. A failed policy or staking-pool read panics and changes nothing (`on_policy_failure_changes_nothing`). Payouts record the transfer result (`moved:`, review fixes #38) |
| Upgrades, storage collision | Code changes only by DAO vote (`upgrade(code_hash)` to an immutable global contract). The contract has no full-access key. New state goes under raw keys with their own prefixes (`inflight:`, `moved:`, `task:`…) apart from the Borsh root, and three upgrades (#35, #38, #41) migrated without breaking state. The build is reproducible (NEP-330, see 03) |
| Centralization | S13 |
| Secrets in code, history, bundle | gitleaks: no leaks in 68 commits. The `web/` bundle has no key. The NEAR AI key and the market token live only in `.env` (ignored) |
| Server-side input validation, SSRF | There is no server: the page reads public RPCs straight from the browser. The agent fetches fixed hosts only (NEAR AI Cloud, the market URL from `.env`); no URL from a job is ever fetched. S16 closes the one place where on-chain data chose a URL |
| XSS | A subagent reviewed every `innerHTML` sink in `web/` independently. No sink can be exploited. Free text is escaped; values written unescaped are numbers, enums, or account ids the contract validated. Data links must match `^https://\S+$` or `^https://github.com/` |
| SIWE | Not applicable: there are no sessions and no backend; every action is a signed NEAR transaction |
| Rate limiting, CORS | No API of our own, so nothing to limit. The public RPCs and NearBlocks rate-limit themselves; the page retries and backs off (T12) |
| Headers | `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, and a CSP with `frame-ancestors 'none'`. Vercel adds HSTS. See S20 |
| Honest transaction details | NEAR has no unlimited `approve`: USDC moves only by `ft_transfer`/`ft_transfer_call` with an exact amount. Every button names its deposit, and the page checks the action against chain state before signing (see 04). The proposal descriptions members vote from were hardened in S15 |

## Known issues and why they are not fixed

1. **S13, centralization on the showcase.** This is not a code issue: the showcase needs members from outside the team. The rules (3 of 4 votes, no admin key) are the same ones real members would get.
2. **S20, CSP `script-src`.** NEAR Connect runs each wallet in an iframe built from the wallet's own code, and the TDX check compiles WASM. A tight `script-src` breaks both, and it can only be switched on with an end-to-end wallet test on every browser.
3. **S12's remaining ceiling** (round 4 narrowed it from 7 days to 1): an increase now counts only after readings at most a day apart show it for 7 days, so only a dip shorter than a day between two readings is unseen. Reading every epoch would close the rest. If the keeper is down for more than a day, a member's wait restarts (they lose time, never money).
4. **Relayer limits** (S22) are kept per server instance (rate limit, replay set). A replay that reaches another instance still fails on the key's nonce. A shared store (KV) if someone farms it. Round 4 tried to connect one of the team's existing Upstash databases; Vercel's dashboard kept "Connect Project" disabled, and a new database has no free plan there, so it is not done.
5. **D1–D4.** Upstream; none of them reaches code paths that handle secrets or money (see the table).

## Round 3 (9 Nov, later): fixes shipped

| Item | What changed | Evidence |
|---|---|---|
| S12 | A stake increase read by `sync_savings` counts only when a fresh reading at least 7 days after the first still shows it; a decrease counts at once; a larger top-up restarts the wait; a members' `set_savings` vote counts at once. New event `savings_pending`, view `get_pending_savings`; the wallet panel shows what waits and when. An automated review of the first version found it promoted the waiting stake during a profit share from stored state (stake, sync, unstake, wait); fixed in `065de9a` | 91 contract tests. **Upgrade by vote #48**: global code `EiwYsmhq34fYdZRsvd446g51TYpbPPn68kb2vpdfDsBe`, sha256 `cbe66c30…`, NEP-330 rev `065de9a`, 0 full-access keys. Live: kop-alice staked 1 more NEAR ([8MsZPyJc…](https://testnet.nearblocks.io/txns/8MsZPyJcADw9LZxsz7UrPFwtGz8L4H7cYiXihW4bZeJQ)) and synced ([CndDorLF…](https://testnet.nearblocks.io/txns/CndDorLFCpBcCbob9Yq7XM2FHbzqKevuLNLme9Mx4A6t)): savings stay 1.0 NEAR, the 2.0 waits until 16 Nov |
| S19 | NEAR Connect 0.12.0 and dcap-qvl 0.7.1 are served from `web/vendor/` (sources and sha256 in its README); both bundles have no imports | Desktop E2E 54/54 on localhost, TEE check included |
| D2 | Not changed: the allocator comes with near-sdk; switching it is a separate code change | — |
| New: gasless calls (NEP-366) | `api/relay.mjs` pays the gas for a member's signed delegate to the co-op's contract or DAO (function calls only, ≤ 300 Tgas, members only except `join`/`cancel_join`/`sync_member`, 20 an hour per account). The member still pays any deposit. The page uses it with wallets that sign delegates (Meteor, Intear, Ledger on testnet) and falls back to the wallet paying gas. Relayer `kop-relayer-mw4i2iwk.testnet`, 5 testnet NEAR | Unit tests (3). Live: kop-alice paid 0 for `sync_member`, the relayer 0.0007 NEAR ([6kCovF4M…](https://testnet.nearblocks.io/txns/6kCovF4MuNAaAf3EQJcRbtKkPK7RznMs37qyScrdWN66)); a call to another contract: 403; the same delegate twice: the second refused before the chain. Through production (`https://koperasi-kohl.vercel.app/api/relay`, rotated key): kop-alice `sync_member` relayed, status `SuccessValue` ([7pziyP7a…](https://testnet.nearblocks.io/txns/7pziyP7aXe8aKMKKRSWo18dfCpAhTaHtHc2vTJsNmdBN)) |

The NEAR for the upgrade (34.8 for the global code) came from the testnet faucet (3 accounts swept into the publisher) and 4.9 NEAR left on an old test co-op.

## Round 4 (10 Nov): S12's ceiling, invite links

| # | What changed | Evidence |
|---|---|---|
| S12 ceiling | A waiting stake increase counts only after an unbroken run of readings, each at most a day apart (`SAVINGS_GAP_NS`), still shows it for 7 days; a longer gap restarts the wait. Before, two readings a week apart were enough, so a stake that left and came back between them counted. Old pending entries (two fields) no longer decode and restart at the next reading. The keeper `api/keeper.mjs` (Vercel cron twice a day, relayer account) reads every member whose increase waits and was not read in 6 hours; only the cron may run it (`CRON_SECRET`, from an automated review: parallel calls could otherwise make the relayer pay for the same reading many times) | Contract test `a_stake_that_was_not_read_for_more_than_a_day_waits_again` (mallory's sync on day 0 and day 7 no longer counts; exactly 24 h apart does), 92 contract tests, keeper unit test. **Upgrade by vote #50**: global code `2T2iphGN1DLDye8YmF2v8wNiSMTsLGtAatRQzntVJMcw`, sha256 `1586bbe6…`, NEP-330 rev `cc6641c`, 0 full-access keys, members, receipts and by-laws intact. kop-alice's old pending restarted on the first reading ([CkZvUnpu…](https://testnet.nearblocks.io/txns/CkZvUnpuZNw6c3wKQUuudGc9p9MtrSxzaX2LMR5mTPQU)): 2.0 NEAR now counts from 17 Nov if read daily. #49 is a duplicate of #50 filed by a run that hit the RPC's rate limit; alice and bob had approved it, so it cannot be rejected and expires on its own |
| Invite links (new) | `?invite=<member>` names the inviter in the newcomer's membership proposal; members see "vouched" only when the inviter, a member, voted to approve it. From an automated review: vouching shows only on an `AddMemberToRole` proposal for role `member` whose text is exactly the page's own, never on free text of another proposal | Unit test (27 → 28 with the keeper) |

## Round 5 (10 Nov): a hostile review, an automated review, reference projects

A reviewer asked to act as a hostile judge and attacker read the code and the live chain; an automated review read
each commit. What it found, and what happened:

| # | Finding | Status | Evidence |
|---|---|---|---|
| R1 | **The relayer paid deposits.** Under NEP-366 the relayer pays the inner actions' deposits (nearcore `core/primitives/src/fees.rs` `total_deposit`: "here Relayer pays the deposit"). A stranger's relayed `join` with the relayer's balance as deposit drained it; the contract refunds the excess to the joiner. | Fixed (5082ce5): the relayer refuses any call with a deposit; the page sends those from the member's wallet | Production answered a 9 NEAR `join` with 403 "calls with a deposit are not relayed"; unit tests (9 NEAR join, 1-yocto `add_proposal`) |
| R2 | **Savings never counted for an honest staker.** Staking rewards raise the stake every epoch, and a reading above the waiting amount restarted the 7-day wait. | Fixed in contract 0.2.2: what counts is the least stake every reading of the wait showed; more staked later waits its own turn | Tests `staking_rewards_do_not_restart_the_wait`, `what_counts_is_the_least_stake_every_reading_of_the_wait_showed` |
| R3 | **Savings weight outlived the stake.** The keeper read only members with an increase waiting, so a member who unstaked kept their savings weight until someone synced them. | Fixed (keeper): every member is read twice a day; a decrease counts within 12 hours | Unit test of `stale` |
| R4 | **The poster could vouch for their own no-vote payout.** With `trusted_after` 1, a contributor whose only source was alice was paid on trust when alice herself accepted (live: task #4). | Fixed in contract 0.2.2: trust for a no-vote payout counts sources other than this poster | Tests: alice alone cannot pay carol with no vote; bob can |
| R5 | **Auto-slash on a single "red since" clock** (automated review): a steward who passed every job on within 7 days but always had a newer one unpaid would be slashed; the clock was computed inside deposits and receipt updates (gas grows with receipts). | Redesigned before release: each paid job has its own 7 days (`paid_at`), deposits pay the oldest first; nothing in the deposit or receipt path reads all receipts | Tests: a steward who pays each job in time is not slashed while the audit stays red; exactly 7 days is not late |
| R6 | **A replaced steward got the bond back while owing.** | Fixed in 0.2.2: the bond goes to the DAO if any paid job's earnings are not passed on; the new steward answers only for jobs paid after their appointment | Tests for both cases |
| R7 | **The audit trusts the agent's receipts** (automated review, hostile review): only the agent key marks a job Paid. A steward who runs the agent can hide a payout by never reporting it; an agent operator other than the steward could report a fake paid job and get the bond slashed. | Accepted, disclosed: the DAO appoints the agent by vote and can already slash by vote; the permissionless slash adds no power the DAO does not have. Trust assumptions 1 and 2 | `slash_overdue` doc comment |
| R8 | A member the DAO removed can still accept a task or receive a share until someone calls `sync_member`. | Open, disclosed: `accept_task` reads the contract's member list, not the DAO policy | Mitigation: the page's leave flow and `approve-requests.mjs` sync at once |
| R9 | Each profit share halves points; a majority could wipe points with dust shares (each needs a vote). Integer halving turns 1 point into 0. | Accepted: every share is a members' vote and its amount is public | `distribute` |
| R10 | Anyone can claim every open task and never deliver; the poster cancels and reposts (pays `TASK_FEE` again). | Open | `claim_task` |
| R11 | The reserve floor reads the DAO's USDC before the share's own reserve comes back and ignores USDC in flight; it errs toward refusing. After `set_usdc` to a token with other decimals the floor must be set again. | Accepted, documented | `on_dao_balance` |
| R12 | `PAYOUT_BOND` for a payout proposal is fronted from the contract's balance, which also holds join deposits and the steward's bond. | Open, low: a rejected payout loses 0.1 NEAR of the contract's own funds | `tasks.rs` |
| R13 | (automated review of 0.2.2, live as #52 for a few minutes) Replacing a steward read every receipt, so with thousands of receipts the DAO could not replace one; and receipts and a steward from before the upgrade were judged by the new 7-day rule. | Fixed in 0.2.3: a running total of jobs paid since the appointment makes the replacement O(1); `slash_overdue` works only for a steward the DAO appointed under this code, for jobs paid since (fail closed) | Tests `no_slash_for_a_steward_appointed_before_this_code`, `a_steward_appointed_before_this_code_gets_the_bond_back_as_before` |
| R14 | (automated review of 0.2.3) Without a steward appointed under the new code, `slash_overdue` does nothing, a "fail-open" compared with 0.2.2. | Accepted by design: before 0.2.2 (live minutes) there was no permissionless slash at all; a steward appointed under older code agreed to no 7-day rule and stays slashable by the DAO's vote. The members switch the rule on with one vote, `set_steward` (re-appointing the same steward works) | `steward_unpaid` |

## Round 6 (10 Nov): commons (pledges, the co-op court, standing, the steward's term)

Contract 0.2.4 adds `contract/src/commons.rs`. An automated review read each of five commits before release; nothing
below reached the chain before its fix.

| # | Finding | Status | Evidence |
|---|---|---|---|
| C1 | Anyone could open a case for any job and name any `refund_to`, so a stranger could ask the treasury to pay them. | Fixed: only a member in good standing takes a buyer's case, and only for a job the buyer disputed on Agent Market (the agent mirrors `Disputed`). The market names buyers by its own ids (UUIDs, read from `/v1/jobs/board`), not NEAR accounts, so the contract cannot check `refund_to`: the jurors do, from the market's job page | Tests `an_outsider_cannot_open_a_case`, `only_a_job_the_buyer_disputed_goes_to_court` |
| C2 | A case closed after 3 days with one uphold and no other ruling refunded (majority of the rulings cast). | Fixed: a refund needs two of the three jurors; a jury that never decides dismisses | Test `a_case_nobody_ruled_on_is_dismissed_after_3_days` |
| C3 | Kept pledges earned profit-share points, so two members could mint points by confirming each other's pledges. | Fixed: pledges are reputation only (standing) | Test `a_kept_pledge_earns_the_issuer_points_and_standing` asserts 0 points |
| C4 | A refund while the market could still refund the job (double refund). | Fixed: only a job the market finally paid to the agent; a paid receipt never changes | Test `a_job_still_disputed_on_the_market_is_not_taken_to_court` |
| C5 | Jury shopping (re-filing until a jury agrees) against case squatting (a bogus case blocking the real one). | Mitigated, residual risk accepted: one open case per job, at most two cases and one refund per job, each member once per job, a lost case costs the 0.5 NEAR bond, jurors earn points only for a verdict. Two members in good standing could still burn both slots with bogus cases and two bonds; the members can always refund a buyer by an ordinary Transfer vote, so the court is an extra path, never the only one | Tests `one_open_case_per_job`, `a_rejected_case_closes_the_job_and_a_lone_ruling_earns_no_points`, `a_job_has_at_most_two_cases` |
| C6 | The jury is drawn from `env::random_seed()`; a block producer could bias it. | Accepted, disclosed (`ponytail:` comment in `open_case`): a commit-reveal draw if the stakes grow | `open_case` |
| C7 | An upheld refund is filed and approved by the contract's `tasks` role, like a task payout: three random members move up to one job's price without the whole membership. | Accepted by design and bounded: at most the job's price, once per job, only after a market dispute; every refund is a public DAO proposal `npm run verify` checks | `close`, `on_refund_filed` |
| C8 | (automated review of the release commit) `cert.html` put the `who` query parameter, the visitor's input, into a link's `href` unescaped: a crafted link could inject markup. | Fixed: only a well-formed NEAR account id (2 to 64 characters, the protocol's pattern) is rendered, and the link is escaped | `web/cert.html` |

## Round 7 (12 Nov): the repo goes public, an independent review

An independent read-only review of the contract, the page, the relayer, the scripts and the dependencies, the day the
repo went public (and its GitHub Actions, including the members' bot, started running). Plus two automated reviews of
new commits (Chain Signatures payments, the Intents wallet, OutLayer).

| ID | Component | Severity | Risk | Evidence / test | Status |
|---|---|---|---|---|---|
| K1 | `scripts/approve-requests.mjs`, run every 30 minutes by `members.yml` | **Critical** | The bot voted in anyone who had paid the 0.5 NEAR join deposit (3 a run). With 5 members and a majority threshold, about 7 sybil accounts in 1.5 hours out-vote the members, and their own votes then approve the next ones: the treasury, `upgrade`, the policy, the DAO's Chain Signatures address and the Intents wallet's owner all fall to them. Round 1 had rated this "low, disclosed"; it was not, because an attacker's votes add up. Live from the moment the repo went public. | The bot now votes only for a request carrying a member's signed vouch (NEP-413), checked as the page checks it, signed with a full-access key of that member; anything else waits for the members by hand. Checked against the real vouch of proposal #56 (accepted), a tampered signature and the same vouch for another account (both refused). No open request had arrived before the fix. | **Fixed** (`6787171`) |
| S1 | `api/relay.mjs` | Medium | A stranger could have the relayer pay gas for `join` (always failing: it carries a deposit the relayer never pays), `cancel_join` and `sync_member`, from as many free testnet accounts as they like; the relayer is also the keeper's account. | A stranger is relayed only once they paid the join deposit (`is_pending`), and never for `join`. Unit tests: a paid stranger may `cancel_join`, an unpaid one is refused, `join` is not open. | **Fixed** (`6787171`) |
| S2 | `contract/src/commons.rs` `pledge`, `redeem_pledge` | Medium | No storage fee: one member (gasless, through the relayer) could create pledges and claims until the contract could not write state or refund deposits. | 0.2.6: both pay `PLEDGE_FEE` (0.01 NEAR), as `post_task` pays `TASK_FEE`. Tests `a_pledge_pays_for_its_storage`, `calling_in_a_pledge_pays_for_the_claim`. On testnet after upgrade #75: a pledge without the fee is refused ("attach 0.01 NEAR for the pledge's storage"); with it, pledge #4 ([BKB2kFQp…](https://testnet.nearblocks.io/txns/BKB2kFQp6JJ9uF25nyLsNR3bChsUoVEYUPvp69aDrGqb)). | **Fixed** (0.2.6, #75) |
| S3 | `end_steward_term` → `replace_steward` | Medium | Anyone (and the keeper) can end a term the moment it runs out; the replacement slashes the bond if any paid job is not passed on yet, even one paid an hour before. The 7-day grace of `slash_overdue` did not apply on this path. | 0.2.6: while the steward holds earnings of any job, the term can be ended only 7 days after it ran out; a steward who still owes then is slashed. Test `a_term_ending_just_after_a_paid_job_gives_the_steward_seven_days` (found a boundary bug in the first fix: a job paid at the very end of the term was not counted). | **Fixed** (0.2.6, #75) |
| S4 | `scripts/intents.mjs` `refuseUnlessAsked` | Medium | The DAO's owner signature was checked field by field only for fields the request had: a missing expiry passed, and extra fields (top level or in `details`) were not looked at. A hostile Agent API could have the DAO sign a grant with no expiry or more rights; the demo members' votes are automatic. | Exact key sets per intent type (read from the Agent API's own previews), every requested field required and unchanged. Unit tests for an extra top-level field, an extra permission in `details`, a missing expiry, an unknown type. | **Fixed** (`a761837`) |
| A1 | (automated review) `scripts/intents.mjs` | Medium | The DAO signed the intent text the Agent API returned without reading it. | Fixed before S4: the text must say what was asked, and the whole text goes into the proposal the members vote on. Votes #72 and #73, made before the fix, were audited against the live wallet: the policy and the grant credential are exactly what was asked. | **Fixed** (`1a104bc`) |
| A2 | (automated review) `outlayer/bylaws-check` | High | The caller chose the RPC the enclave read the voted hash from: a fake RPC could get an enclave-signed "match" for any file. | Only NEAR's own RPCs are accepted, and the RPC and page used are part of the signed output; `npm run verify` checks the RPC. | **Fixed** (`839e8bb`) |
| R1 | `vercel.json` CSP | Low | No `script-src`/`connect-src`. | Not applied: `near-connect` loads each wallet's code from its manifest (jsdelivr, esm.sh, raw.githubusercontent) into a sandboxed iframe, and a tight `script-src` would break wallets the day judges try them. No XSS was found: every chain value written as HTML is escaped or validated. | Known issue |
| R2 | `settle_pledge` | Low | The holder alone marks a pledge broken after 14 days, which takes the issuer out of good standing (and of juries). | By design (the holder is the only one who knows); a dispute path to a DAO vote would be the upgrade. | Known issue |
| R3 | `web/tee.js`, `agent/tee.mjs` (NEAR AI path) | Low | sha256(app_compose) = mr_config_id is checked, but MRTD/RTMRs and the compose's image digest are not pinned for NEAR AI's own servers (they are for Chutes). | Pinning needs NEAR AI to publish the expected measurements. | Known issue |
| R4 | `web/wallet.js` proposal descriptions | Low | Account ids in `AddMemberToRole`, `RemoveMemberFromRole`, `Transfer`, `BountyDone` were not put on one line (escaped, so no XSS). | `oneLine()` on all of them. | **Fixed** |
| D | `npm audit` | Info | Root: 2 low (`elliptic` through `@phala/dcap-qvl`). `video/`: critical and high in Remotion's tree. | `video/` is local tooling, never installed by Vercel or CI. | Known issue |

Verified still in place from earlier rounds: S14, S15 (`oneLine`), S16 (`byLawsPath`), S17, S18, S19 (vendored
modules), S22 (relayer key, nonce and expiry), deposits never relayed, C8, `CRON_SECRET`, `claim_share` rollback.
The reviewer found no XSS, no open redirect, and every DAO-only or agent-only function guarded, callbacks `#[private]`,
state changed before promises with a rollback.

## Round 8 (13 Nov): contract 0.2.7 and the integrations made routine

A review of the new code by its author (not independent: read it as such), before and after the upgrade by vote #76.
New surface: `appeal_case` / `settle_appeal`, `set_payout_route`, the NEP-171 work-record token, the OutLayer gate in
the agent runtime, the agent wallet's `policy_update`, and the page's Ethereum payment form.

| ID | Component | Severity | Risk | Evidence / test | Status |
|---|---|---|---|---|---|
| A1 | `appeal_case` | Medium (design) | An appeal must not let one member refund a buyer twice, block the job's other case, or have the contract vote for itself. | Only the claimant, only a case a juror dismissed, 1 NEAR bond, within 7 days after the jury's 3; the job is marked open while the members vote (no second case meanwhile), refunded once if they approve; the contract files the refund and never votes (`npm run verify` checks the votes). Tests: `the_members_overturn_…`, `the_members_confirm_…`, `an_appeal_that_could_not_be_filed_…`, `only_the_claimant_appeals_…`, `a_case_nobody_ruled_on_is_not_appealed`, `an_upheld_case_is_not_appealed`. On testnet: #77 approved (case #2), #78 rejected (case #1). | **By design, tested** |
| A2 | `on_appeal_read` | Low | Sputnik leaves a Transfer that bounced as Approved; the appeal then reads as refunded. | Same rule as `settle_task` (a payout approved by hand is taken as moved); the claimant asks the members again. | Known issue |
| A3 | `settle_appeal` | Low | It reserves 80 Tgas for the read and 80 for the callback: a call with 100 Tgas fails with "Exceeded the prepaid gas" (no state change). Found on testnet. | The page and `scripts/commons.mjs` attach 300 Tgas. | **Fixed** (callers) |
| R5 | `set_payout_route` | Low | The contract checks an address's form (0x and 40 lowercase hex digits, chain base/arb/eth), not that the member holds its key. | A member's own word, as their NEAR account is; the agent's wallet pays only routes its policy lists, and only a vote changes the policy (`policy_update`, #80). Members only, one route each, so storage is bounded by the membership. | By design |
| T1 | `mint_work_record`, `nft_*` views | Low | The minted list is one storage value: the views read all of it. | 0.01 NEAR a token for its storage, one per account with a record or standing; fine for a co-op's contributors (ponytail note: page it if it grows past a few hundred). `nft_transfer` and `nft_transfer_call` always panic. | Known limit |
| T2 | the token's image, `web/cert.html` | Info | The SVG is built from account ids and counts. | NEAR account ids are `[a-z0-9._-]`; the page shows the image only if it is `data:image/svg+xml;base64,…` and in an `<img>` (no script runs from it); title and description are escaped. | Checked |
| E1 | `web/wallet.js` (Ethereum payments) | Medium (design) | A `sign` proposal asks members to sign a 32-byte hash they cannot read. | The description must carry the transaction's fields; the page rebuilds the hash (RLP and keccak-256 in `web/eth.js`, shared with `scripts/chainsig.mjs`) and shows the payment only when they match, else a warning not to approve. It sends the signed transaction only after a vote that matched. The nonce is read when the proposal is filed: if another payment uses it first, this one becomes invalid, never a different payment. Tests: a Playwright case with a matching and a mismatching hash; `trezu/check.mjs` rebuilds the hash from Trezu's own compiled description. | **By design, tested** |
| E2 | `web/eth.js`, `web/wallet.js` (automated review) | Medium | A matching hash only proves the description's fields are what is signed: a proposal for chain 1 (Ethereum mainnet, where the same address exists) or with an outsized fee would still have read "checked". | The page reads only a Sepolia transaction (chain id 11155111) from a description and shows it as a payment only within the fees `transfer` sets (5 gwei max, 1 gwei tip, at most 100 000 gas); the fee is shown; anything else is a warning, and the page sends nothing for it. Playwright case: the same payment with chain 1 is never shown as a payment. | **Fixed** |
| I1 | `scripts/intents.mjs` | Medium | The swap check before a withdrawal tested `/^d+$/` (a missing backslash), so every payout to another chain was refused after its swap. | Fixed in the shared `payout()`; profit shares and `pay … base` use it. | **Fixed** |
| O1 | `agent/gate.mjs` | Info | The gate costs the steward an OutLayer execution per job (deposit refunded when unused), and a gate that does not answer stops the run. | Fail closed: no job starts without a match on-chain against the hash the receipt will carry; `npm run verify` checks each gate named in a receipt. | By design |

## Round 9 (13 Nov): contract 0.2.8, the gate that judges jobs, attacks sent to the live co-op

The author's review of the new surface (not independent), the automated review of each commit, and 19 attacks sent
to the live co-op as real transactions (`scripts/redteam.mjs`, re-read by `npm run verify` and by the page).

| ID | Component | Severity | Risk | Evidence / test | Status |
|---|---|---|---|---|---|
| P1 | `stamp_passport` | Medium (design) | Anyone could type in a reputation from a co-op of their own making. | Only co-ops the members voted (`set_sister_coops`, DAO only, at most 20); the stamp is what the contract itself read from that co-op's `nft_token` (owner, finished work, good standing), one per co-op; a failed read changes nothing, a read that no longer holds removes the stamp. Test `a_sister_coops_work_record_counts_as_one_trust_source…`; on testnet #83 | **Fixed by design** |
| P2 | `stamp_passport` | Low | A sister co-op's own members could inflate records there (two friends paying each other tasks). | Counts as one trust source at most, whatever the record says; the members choose which co-ops to recognise and can drop one by vote, which stops it counting at once | Accepted, documented |
| C1 | `add_evidence` | Low | Evidence is a line of text, not the file. | Up to 280 characters each, 3 per side, 0.01 NEAR storage, only the claimant and the steward, only while the case is open; a hash in it can be checked against the receipt's `deliverable_hash` | By design |
| G1 | `agent/runtime.mjs` (automated review) | Medium | A job the enclave judged not allowed by the by-laws halted the agent and stayed assigned, so every pass ran the gate on it again. | The job is handed back to the market with a message and the agent goes on with the others; unit test *a job it refuses is handed back, not started, and not gated again* | **Fixed** |
| G2 | `agent/runtime.mjs` | Low | OutLayer's worker fails often on testnet ("Execution promise failed", deposit refunded, 0.001 NEAR kept): the gate answered `null` and no job started. | Asked up to twice more; a mismatch or a refusal is never asked again. Seen on 13 Nov (tx `HCAJ3cvP…`), the next attempt answered | **Fixed** |
| G3 | `scripts/verify.mjs` | Low | A new gate build would make the gates already on-chain (run by the older build) fail verification. | Earlier builds from the repo's history are listed by sha256 | **Fixed** |
| U1 | `scripts/upgrade.mjs` | Low | It wrote the deployment files from the copy it read at the start, so a script that wrote them meanwhile (an Intents share) lost its record. | Reads the files again just before writing | **Fixed** |
| I2 | `scripts/intents.mjs share` | Medium | A share cut short (a timeout) lost which members were already paid: running it again would pay them twice. | Each request is saved the moment the Agent API takes it and the run resumes from there; the 13 Nov share was resumed this way from the API's own history | **Fixed** |

Attacks sent on 13 Nov, all refused on-chain: an outsider rewrites the by-laws; a member votes themselves points,
swaps the code, sets the share rule or the trust rule, pauses the co-op, writes a receipt as the agent, sells a work
record, routes payouts to a malformed address, appeals someone else's case, recognises a sister co-op without a vote;
the agent records a job under by-laws nobody voted, or the same job twice; an account with no work mints a record; an
outsider routes payouts, opens a case, stamps a passport from a co-op nobody voted, files evidence, or votes in the DAO.
The agent's key cannot even ask for anything but `record_receipt` and `update_receipt` (refused before the chain).

## Round 10 (13 Nov): contract 0.2.9 (dues, the annual meeting, the agent as a defendant), the federation

| ID | Component | Severity | Risk | Evidence / test | Status |
|---|---|---|---|---|---|
| M1 | `pay_dues`, `dues_ok` (automated review) | Medium | A paid-until date from earlier dues (voted off, then on again) made a member owe for the time no dues were voted, out of good standing at once. | Dues are owed from the latest of what was paid, the vote that set them, and joining; test *a member behind on dues …* covers a re-vote | **Fixed before the upgrade** |
| M2 | `scripts/rat.mjs` (automated review) | Medium | Agenda items and proposal descriptions are members' own words in the model's prompt: "ignore the facts" could steer the report. | They reach the model in a fenced block as untrusted questions only; the report's header names every figure not found in the facts; the members vote on the report itself | **Fixed** |
| M3 | `strike`, `record_receipt` | Low (design) | A suspended agent cannot record receipts, so a job finished just before the third strike cannot be booked. | By design: the members reinstate by vote, after which the receipt goes through; strikes count once per case | Accepted |
| M4 | `record_annual_meeting` | Low | Once a year: a report approved by mistake cannot be replaced on-chain. | The DAO vote is the check; a correction is a new year's agenda item | Accepted |
| F1 | the federation DAO | Info | Its founder account pays the DAO's storage and holds no role; only the co-ops' DAOs vote. | `npm run verify` checks no other role can vote and each co-op's vote came from its own approved proposal | By design |

