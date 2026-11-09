# 01 · Tech Lead: an honest map of the project (8 Nov 2026, after upgrade #33)

Audit only, no code fixes. Earlier reports: [01-audit](01-audit.md) (before the trust tiers), [09](09-peningkatan.md) (improvements since).

## Summary

Submission readiness: **about 80%**.

**Engineering is ready:**
- Contract: 73 tests pass.
- Unit: 14 tests pass.
- Lint and typecheck: clean.
- E2E: Playwright on 6 browsers/devices against live testnet. The last full CI run passed.
- `npm run verify`: every claim checks out.
- The contract runs code voted by the members and has 0 full-access keys.

**The missing 20% cannot be done by code. It needs the builder:**
- Real usage: independent members, a real Agent Market job, and USDC in the treasury.
- The demo video and the X post (required, Q-012).
- The repo opens on 13 Nov.

## How everything was run

| Step | Command | Result |
|---|---|---|
| Compile the contract | `cargo near build non-reproducible-wasm --no-abi` | OK, 330,055 bytes, sha256 `e9b5c1d3…` = `codeSha256` in `deployment.testnet.json` = the global code on-chain |
| Contract tests | `cd contract && cargo test` | 73 passed |
| Lint, types, unit | `npm run lint`, `npm run typecheck`, `npm run test:unit` | clean, clean, 14 passed |
| Clippy | `cargo clippy --all-targets` | 0 warnings in `tasks.rs`; 3 style warnings in `lib.rs` (known, A6) |
| Dependencies | `npm audit` | 2 low, 0 high/critical |
| Frontend | `npm run web:files && cd web && python -m http.server 5173` | runs; E2E trust/page/checks × desktop/firefox/iphone: 95 passed; desktop flakes come from public-RPC 429s (9/9 serially) |
| Live page | `curl -I https://koperasi-kohl.vercel.app` | 200; HSTS, X-Frame-Options DENY, Referrer-Policy; no CSP |
| On-chain claims | `npm run verify` | every claim checks out (also the CI job `chain`, every push and daily) |
| Wallet | NEAR Connect (Meteor, Intear, Nightly…), testnet | signing in a real browser was done before (guest joined, proposal #8); there is no headless test for it |

Setup steps that are not documented, or are hard:
- On Windows, `cargo build` fails ("use cargo near build"). The README names `cargo near` but not this error.
- ABI generation does not link on Windows, so the build needs `--no-abi`.
- The testnet faucet rate-limits (429, 12 hours). The README mentions `KOP_FUNDER_KEYS`.

## On-chain addresses (NEAR testnet)

| What | Account | Status |
|---|---|---|
| Contract (showcase) | `koperasi-mw4i2iwk.testnet` | global code `GjJjx49G…` (vote #33), **0 full-access keys**; NEAR has no "verified source" like Etherscan; the equivalent: code sha256 = local build, and the vote that installed it |
| Sputnik DAO | `koperasi-mw4i2iwk.sputnik-v2.testnet` | role `member` (4), RoleWeight 1/2; role `tasks` = the contract (transfer:AddProposal/VoteApprove only, #29) |
| Agent | `agent.koperasi-mw4i2iwk.testnet` | 1 function-call key: `record_receipt`, `update_receipt` |
| USDC | Circle `3e2210e1…afcb8af` | treasury **0 USDC** |
| Demo co-op | `koperasi-mw57ou3m.testnet` | locked, 0 keys; profit share and claim done there with `usdc.fakes.testnet` |
| Test co-ops (this session) | `koperasi-mw7zrvx4`, `koperasi-mw80aczw` | DAO payouts and the bounce test; their NEAR went into publishing #32/#33 |

The front end reads `web/deployment.json`, which is copied from `deployment.testnet.json`; `codeSha256` matches. There
is no ABI (NEAR uses JSON); the views and methods the front end calls exist in the code (E2E against live testnet).

**Tx hashes for the main flow:**
- Join: proposal #8.
- By-laws: #7.
- Upgrades: #27, #32, #33.
- Rule: #28. Role: #29.
- Task payouts from the treasury:
  - #30, `approve_task` [DdZhNN31…](https://testnet.nearblocks.io/txns/DdZhNN31dMoicn76bpqR9iQcpgwnGVVbf8jCg4W3Czpp).
  - #31, `accept_task` [7QbPcRmd…](https://testnet.nearblocks.io/txns/7QbPcRmdx6tTYrXsCdwKJrJthCEZvqQNTbbChc9JhNK7).
  - #34.
- Bounce test: test co-op #5, [BpccRtdt…](https://testnet.nearblocks.io/txns/BpccRtdtAakvzAakvyxMZCmAFPPsWneMfz53FgWhXXL9).

More are listed in [03](03-kontrak.md) and [09](09-peningkatan.md).

## Claimed vs. what actually runs

| Claim (README/UI) | Status |
|---|---|
| One member, one vote; membership = DAO role | **Runs** (verify) |
| By-laws only by vote; the agent and the contract refuse any other config | **Runs** (tests, demo step 4) |
| The visitor checks the TEE with their own nonce | **Runs** (in the browser, `evidence/` re-checked daily) |
| Contract code only by vote, no full-access key | **Runs** (verify, #33) |
| Tasks with earned trust, paid from the treasury through role `tasks` | **Runs** (#30, #31, #34) |
| Profit share by savings and contribution, claimed by each member | **Runs on the demo co-op** (fake USDC); **never on the showcase** (0 USDC) |
| The agent works on Agent Market with a receipt + proof | **Not yet real**: the 4 receipts come from `agent/mock-market.mjs` (`npm run demo`), labelled on the page; no NEAR AI credits |
| Staking for inference | Partly: stake read from a testnet pool; credits from stake exist only on mainnet (disclosed) |
| Trezu | Display only, on mainnet (disclosed) |

Grep for `mock|fake|dummy|TODO|FIXME|lorem|placeholder|coming soon|0x000`:
- Mock: only `agent/mock-market.mjs` and its use in `scripts/demo.mjs`, both disclosed as a demo stand-in. The receipts it produces are labelled *Demo market, no model* on the page.
- `usdc.fakes.testnet`: only the default for the demo co-op.
- `placeholder`: HTML input attributes only.
- No TODO or FIXME, no hardcoded tx hash or balance in the UI.

## Sponsor integrations vs. what the brief asks

| Integration | Depth | Meets the brief? |
|---|---|---|
| Sputnik DAO v2 | **Deep**: membership, by-laws, upgrades, bounties, the policy read on-chain; the contract is a DAO member (role `tasks`) | yes (Social Money: "on Sputnik, no new multisig") |
| NEAR global contracts | **Deep**: vote-only upgrades | – |
| NEAR AI Cloud (TEE) | **Deep** for attestation (TDX + GPU, verified in the browser); **Medium** for inference (blocked by credits) | partly |
| NEAR AI Agent Market | **Medium**: registered, real API client, 0 real jobs | not yet (Agent Economy wants real tasks) |
| Staking pool | **Medium** | – |
| Circle USDC | **Shallow**: the token is set by vote, balance 0 | not yet |
| Trezu | **Shallow** (mainnet only) | partly; the brief accepts Sputnik |
| NEAR Connect | **Medium**: join, vote, tasks, claim from the page | yes |

## Findings

| ID | Category | Severity | Location | Description | Owner |
|---|---|---|---|---|---|
| T1 | Impact | **High** | `agent/`, README | No real Agent Market job; all 4 receipts come from the mock. Needs NEAR AI credits (NEAR Builders, Q-000) | builder (account) → Backend |
| T2 | Impact | **High** (fixed 9 Nov, below) | DAO treasury | 0 USDC: the profit share never ran on the showcase. Needs the faucet.circle.com captcha | builder → Contract (run the share) |
| T3 | Impact / integration | **High** | `.github/workflows/members.yml` | Secret `KOP_MEMBER_KEYS` **not set**: every run logs "not set: nothing to do", so someone who joins from the page is never voted in automatically. Blocks inviting real members | builder (the secret) |
| T4 | Submission | **High** | – | Demo video and X post not made yet (Q-012 requires them) | builder |
| T5 | Reproducibility | Medium | GitHub | The repo stays private until 13 Nov (scheduled task); the GitHub links in tasks #2–#4 return 404 until then | automatic |
| T6 | Contract | Medium | `tasks.rs` `inflight:` | If a callback in the payout chain fails (e.g. out of gas), the flag is never cleared and the task stays Paying for good; `cancel_task` cannot cancel Paying. The money stays in the treasury, and the members can restore the allowance with `set_task_budget`. Fix: a timeout on the flag or DAO-only `clear` (next upgrade, ~33 NEAR) | Contract |
| T7 | Integration | Medium | Trezu | Not integrated beyond display (mainnet only) | – (disclosed) |
| T8 | UX web3 | Low | `web/wallet.js:131` | A failed transaction shows the raw contract panic text ("Smart contract panicked: …"); readable but not polished | Frontend |
| T9 | Security | Low | `approve-requests.mjs` | Anyone who pays the 0.5 NEAR deposit is voted in automatically (sybil); disclosed | – |
| T10 | Contract | Low | `tasks.rs` `PAYOUT_BOND` | The 0.1 NEAR bond is fronted from the contract's balance (which also holds join deposits); it comes back on approval | Contract |
| T11 | Security | Low | `vercel.json` | No CSP (A5) | Frontend |
| T12 | QA | Low | E2E | Flaky under public-RPC 429s; no headless wallet signing | QA |
| T13 | Quality | Low | `lib.rs` | 3 clippy style warnings in the old code (A6) | Contract |
| T14 | Deps | Low | npm | 2 low advisories | – |
| T15 | DX | Low | README | The Windows `cargo build` error and `--no-abi` are not documented | Docs |

## Done after this audit (same day)

- **T3 fixed.** The builder approved setting the `KOP_MEMBER_KEYS` secret (testnet keys of the 4 demo members only). Manual run [42499483559](https://github.com/PugarHuda/koperasi/actions/runs/42499483559) logs `no open requests to join` and the savings sync. From now on, someone who joins from the page is voted in within 30 minutes.
- **T8 fixed.** A failed transaction shows the contract's own sentence without the VM's prefix (`web/wallet.js`).
- **T11 partly fixed.** CSP `frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'`. Script and connect sources stay open on purpose, because NEAR Connect loads wallets from many origins.
- **T15 fixed.** The README documents `cargo near build … --no-abi`.
- **T6 fixed (9 Nov), showcase upgraded by vote #35** (global code `GtB4Dk9J…`, sha256 `ebfb4b82…`, 0 full-access keys; `npm run verify` finds #35 itself). The `inflight:` flag now holds the time it was set. `settle_task` refuses while it is younger than an hour; after that, a task with no proposal on record goes back to Submitted with the budget restored, and a task with a proposal is settled from that proposal as usual. Flags written by the old code (one byte) count as stuck. Test `a_payout_whose_callback_failed_is_unstuck_after_an_hour`; 74 contract tests pass. Not shown on testnet: the callbacks have fixed gas, so a failed callback cannot be caused on demand. The ~34 NEAR came from unused test accounts of this builder (old co-op tags), not the faucet.
- **T2 fixed (9 Nov).** The builder sent 20 Circle testnet USDC to the treasury; proposal #36: 10 of the 20 Circle testnet USDC from faucet.circle.com shared with the 4 members (bob 4.33 USDC, most of it from his 11 task points; guest 2.33, alice 0.67, steward 0.67; 2 USDC reserve back in the DAO); bob claimed his in [Cq25VUHM…](https://testnet.nearblocks.io/txns/Cq25VUHME68yfVZDM7ZxdKnjHttHtBhSUF6GXHhsCzxd). Contribution points now weigh a real payout: trust → task pay → points → profit share, all on the showcase. The first claim attempt failed because bob was not registered with the USDC contract, and the contract rolled his share back as designed; he registered, then claimed.
- **T1 in progress.** `NEARAI_API_KEY` and `KOP_MARKET_TOKEN` are set. One pass placed 9 real bids on market.near.ai, and the model's TEE attestation passed with our nonce. NEAR AI Cloud still refuses to bill, because the organization has $0 credits ("No spending limit configured"). The builder's question about credits is posted in the NEAR Builders Telegram chat.
- **PRD F7 (leave) done from the page.** A member files `RemoveMemberFromRole` for themselves; after the vote, `sync_member` returns the deposit. No contract change was needed. Proof: proposals #39 (join) and #40 (leave), [pH35xFRx…](https://testnet.nearblocks.io/txns/pH35xFRxjKWxqwGhJ4VXzL3mvphTQDxAvNF7R1wruzV), 0.5 NEAR back; E2E `a member sees…` checks the button.
- **A security review of #35 found two real issues, fixed in code (not on-chain yet):**
  - With no proposal id on record, a proposal may still have been filed. Sending the task back to Submitted would let the contract file and approve a second one, so it is now **Cancelled**. The members can still vote the stray proposal or pay with a bounty.
  - A stuck payout was settled as if the transfer had moved, so a bounce could have counted as paid. `on_payout_voted` now records the transfer's result before it reads the proposal, and settling uses that result. If the result was never read, only the DAO can settle the task (as paid) or cancel it (`cancel_task` now accepts a stuck Paying task, with the budget restored).
  - A third finding: when `get_proposal` failed, the "wait" branch erased that record, so a later `settle_task` would have taken a bounce as moved. The record now stays until the task settles, and `settle_task` always uses it.
  - A fourth finding: a failed `act_proposal` (e.g. role missing) also looks like "failed", so a later vote by hand would have been refunded although paid. A proposal still InProgress after the contract's vote means the vote failed, not the transfer, so that record is dropped. Left open, and documented in the code: a failed vote together with a failed read, followed by a vote by hand, settles as not paid.
  - Tests `…without_paying_twice_or_counting_a_bounce`, `a_bounce_on_record_still_counts_after_an_unreadable_proposal`, `a_failed_contract_vote_then_a_vote_by_hand_counts_as_paid`; 76 tests pass.
  - **On-chain: upgrade by vote #38** (global code `CUY3VjKc…`, sha256 `aa7e56a7…`, 0 full-access keys; `npm run verify` finds #38). The NEAR came from the testnet faucet. #37 was a duplicate filed when the script's first vote failed on the RPC; the members rejected it.
- E2E resilience + trust, desktop: 23/23 passed.

## Priorities by impact on the judging criteria

1. **T3:** set the secret. Without it, inviting real people (Impact) is useless. 1 command, by the builder.
2. **T4:** video + X post. Required; Design + Impact.
3. **T2:** USDC + one real profit share on the showcase. Impact, Social Money fit.
4. **T1:** NEAR AI credits → one real job. Impact, Autonomous Business.
5. ~~T6~~: done, #35.
6. T8, T11, T15: polish.
