# Koperasi: final report (8 Nov 2026)

Per-phase detail is in [`docs/reports/`](reports): [01 audit](reports/01-audit.md) · [02 strategy](reports/02-strategi.md) ·
[03 contract](reports/03-kontrak.md) · [04 dApp](reports/04-dapp.md) · [05 security](reports/05-keamanan.md) ·
[06 QA](reports/06-qa.md) · [09 improvements toward the top 3](reports/09-peningkatan.md) · [submission materials](submission.md).

## 1. Judges' scorecard and checklist

| Criterion | Start | End |
|---|---|---|
| Social Money: ownership and a shared budget | 9 | 9 |
| Social Money: programmable rewards | 8 | 9 |
| Social Money: reputation-based access | 4 | 9 |
| Sputnik/Trezu without a new multisig | 8 | 9 |
| Autonomous Business / Agent Economy | 7 | 7 (blocked by NEAR AI credits and Agent Market having no testnet) |
| Demo with real transactions | 8 | 9 |

The Social Money checklist (custody in the DAO, records per named account, three tiers, a public board) is all ticked,
with testnet evidence in [02](reports/02-strategi.md#social-money-checklist-the-briefs-sample-prompt).

## 2. Audit and security

| ID | Severity | Finding | Status |
|---|---|---|---|
| A1 | High | No reputation-based access | **built**: `contract/src/tasks.rs`, proposals #19 and #25 |
| A2 | Medium | `upgrade.mjs` underestimated the global-code cost tenfold | fixed |
| A3 | Medium | `upgrade.mjs` stopped early on a lagging RPC (duplicate proposal #20) | fixed, proven at #25 (no duplicate) |
| A4 | Low | Bounties only in USDC; `list` printed NEAR bounties as USDC | fixed (`--near`) |
| A5 | Low | No security headers | fixed, except CSP (known issue) |
| A6 / S7 | Low | 3 clippy style warnings in the old on-chain code | known issue |
| S1–S5 | High/Medium (prevented) | self-approval, stale member, bounced payout, approval race, double credit | safe from the start, each with a test |
| S10 | Medium | a removed poster could still pay on trust | **fixed**, proposal #25 |
| S11 | Medium | `trusted_after = 0` made everyone trusted | **fixed**, proposal #25 |
| S6 | Medium | collusion between two members up to `one_vote_max`, capped by the voted budget | **mitigated** (#27/#32): trust needs different posters, a daily no-vote limit per poster, points follow the pay; three colluding members remain a known limit |
| S12–S14 | High/Medium | points farmed with tiny tasks; a bounced transfer left Approved by Sputnik counted as paid; a rejected payout refiled | **fixed**, proposal #32, bounce proven on testnet ([09](reports/09-peningkatan.md)) |
| S15–S16 | Medium | `settle_task` racing the contract's own check; points unclamped after `one_vote_max` drops | **fixed**, proposal #33 |
| S17 | Medium | A payout whose own callback failed stayed Paying for good (T6 in [01-tech-lead](reports/01-tech-lead.md)) | **fixed**, proposals #35 and #38 (four review fixes: never filed twice, a bounce never counted, unclear cases settled by the members) |
| S8, S9 | Low | `TASK_FEE` slightly below the largest task's storage; contributor protection goes through the DAO | known issue |

Scanners:
- `npm audit`: 0 high/critical (2 low).
- clippy wasm: 0 warnings in the new module.
- Secret scan: clean.

## 3. Sponsor integration, before → after

| | Before | After |
|---|---|---|
| Sputnik DAO | Deep | Deeper: the contract is a member of the DAO through role `tasks` (transfer proposals only), so every task payout is a Transfer from the treasury it files and approves under the members' rule; approval rights from `get_policy`; `BountyDone` read through `get_proposal` onto the record; budget and rule only by `FunctionCall` proposals |
| Trezu | Shallow (displays the treasury on mainnet) | Unchanged; the tiers are what its single Finance threshold lacks |
| NEAR AI Cloud, Agent Market, global contracts | Deep | Unchanged; global contracts were used for vote-only upgrades (#19, #25, #27, #32, #33, #35) |

## 4. Competitors and positioning

Full table: README › Prior art (7 agent platforms). For this feature: [02 › competitors](reports/02-strategi.md#competitors-for-this-feature)
(Sputnik, Trezu, Dework XP, Pocket PEP-42, Zodiac Roles).

> For small communities that want to own the AI agent working for them, Koperasi is a member-owned AI co-op on NEAR
> where one member, one vote pins the agent's mind by hash, every visitor can verify the TEE with their own nonce, and
> contributors earn the right to be paid without a vote, task by task. Token-launched agents leave control with large
> holders, and DAO bounty tools make every payout a full vote.

## 5. Differentiators, and why they are hard to copy

1. **The visitor verifies the TEE with their own nonce** (earlier rounds): it needs by-laws pinned by hash to check against.
2. **Rules nobody changes alone:** no full-access key; code only by vote (four times now: #12, #16, #19, #25).
3. **A share preview with the contract's integer maths.**
4. **An audited, bonded steward.**
5. **New: trust earned on-chain, beside an unmodified Sputnik DAO.**
   - Evidence: task #0 approved by one member, [`CUkTGkh4…`](https://testnet.nearblocks.io/txns/CUkTGkh4oRazcc6XshUEoBKjzMcCaiEaVu8PB5cCNTC9);
     task #1 paid on trust, [`AVExx89C…`](https://testnet.nearblocks.io/txns/AVExx89CuGs1PkG3zk5ARdELQMFv3NS9Pdau2E9boFTA);
     DAO bounty #24 counted, [`68LWnW2G…`](https://testnet.nearblocks.io/txns/68LWnW2GYqRxZHFBhrz7MNmsx3sCPVLxfYuG3x1Q8Dvp).
   - Hard to copy: it needs a record whose every point can be traced, and a budget capped by vote, and the rights are read
     from the DAO at the moment of approval.

## 6. New feature: how to try it

- **The board:** https://koperasi-kohl.vercel.app/#trust (read from the chain).
- **As a contributor:** connect a testnet wallet; under "Tasks with earned trust" you can take, deliver and give up tasks.
- **As a member:** `node scripts/tasks.mjs post|accept|approve …` (see [04](reports/04-dapp.md#new-feature-how-to-try-it)).
- **References:** Sputnik v2 `policy.rs`/`bounties.rs`, the Trezu docs (roles, voting), and the patterns in [02](reports/02-strategi.md).

## 7. Testing

| Suite | Result |
|---|---|
| Contract (`cargo test`) | **69 passed**: 13 new for tasks, including 2 for the security fixes |
| Unit (`npm run test:unit`) | **14 pass** |
| Lint, typecheck | clean |
| Playwright local, 6 profiles (desktop, firefox, webkit, tablet, Pixel 7, iPhone 13) | see [06-qa](reports/06-qa.md) |

## 8. Contracts and links

| | |
|---|---|
| Live page | https://koperasi-kohl.vercel.app |
| Contract | [`koperasi-mw4i2iwk.testnet`](https://testnet.nearblocks.io/address/koperasi-mw4i2iwk.testnet), code `3wCdocCi3UyfoBLmKTNFfveH1mDcxskR4Nk3zvde8nhX` (proposal #25), rebuild = chain |
| DAO | [`koperasi-mw4i2iwk.sputnik-v2.testnet`](https://testnet.nearblocks.io/address/koperasi-mw4i2iwk.sputnik-v2.testnet) |
| Video / pitch deck | **not made yet**: script and outline in [submission.md](submission.md) |

## 9. Blockers (only what needs you)

1. **Demo video and pitch deck:** they need your voice and screen. The script is ready.
2. ~~Circle USDC in the treasury~~: done 9 Nov, 20 USDC from faucet.circle.com; profit share by vote #36, bob claimed 4.33 USDC.
3. **NEAR AI credits** for the co-op's organization: without them, the agent refuses real jobs.
4. **Agent Market has no testnet:** the first real loop can only happen on mainnet (a decision for you; not done).
5. **Submit the form** before 14 Nov 23:59 UTC. The repo opens automatically on 13 Nov at 09:00 WIB.
