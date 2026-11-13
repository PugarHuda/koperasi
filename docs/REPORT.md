# Koperasi: final report (12 Nov 2026)

Koperasi is a co-op on NEAR that owns an AI agent, one member one vote. The agent's prompt, model, prices, its NEAR
Intents wallet and the co-op's Ethereum address all answer to the members' votes, and every claim is checked from the
chain, in the browser or with `npm run verify`.

Per-phase detail is in [`docs/reports/`](reports), each with a *12 Nov* pass at the end: [01 audit](reports/01-audit.md) ·
[02 strategy](reports/02-strategi.md) · [03 contracts](reports/03-contracts.md) · [04 dApp](reports/04-dapp.md) ·
[05 security](reports/05-security.md) (round 7) · [06 QA](reports/06-qa.md) · [submission materials](submission.md) ·
[the judges' checklist](../JUDGE.md).

## 1. Judges' scorecard and the track's brief

Our own estimate on the rubric (technical, design, impact, originality, sustainability), so read it as biased:

| Criterion | 8 Nov | 12 Nov | What moved it |
|---|---|---|---|
| Technical | 8 | 9–10 | 0.2.7 (appeals, payout routes, work-record tokens) after round-7 fixes; the DAO pays on Ethereum by vote; the agent's Intents wallet is the DAO's; the by-laws gate ran in a TDX enclave; a real TEE-proven job; 143 contract + 40 unit tests; 0.2.8 (passport, evidence), the gate judges each job, 19 attacks refused on-chain; byte-for-byte rebuild in CI |
| Design | 8 | 8.5–9 | live proof on the first screen; Lighthouse 100 on accessibility, best practices, SEO; LCP 1.7 s on a slow phone, CLS 0 |
| Impact | 5 | 6 | testnet money landed on NEAR, Ethereum and Base by member votes; still demo members and no Agent Market job |
| Originality | 9 | 9 | a co-op's whole life on chain, not only "an agent bound by a DAO" |
| Sustainability | 6 | 7–8 | public repo; green CI for rebuild, TEE re-checks, members, verify, contract, sandbox and static jobs |

The Social Money brief, each line proven live on the page's first section: collective ownership (DAO role `member`, a
majority decides), a shared budget (only a vote spends the treasury; the contract's role `tasks` files transfers only),
programmable rewards (shares split by savings and points), access by reputation (earned trust, a veto window, jurors
in good standing), built on Sputnik DAO (every payout a Transfer proposal) with Trezu forms.

## 2. Audit and security

Round 7 ([05-security](reports/05-security.md)): an independent review the day the repo went public.

| ID | Severity | Finding | Status |
|---|---|---|---|
| K1 | Critical | the members' bot voted in anyone who paid a deposit: a few accounts could out-vote the DAO | fixed: a member's signed vouch is required (`6787171`) |
| A2 | High | the OutLayer program trusted a caller-chosen RPC | fixed: NEAR's RPCs only, named in the signed output |
| S1 | Medium | strangers could make the relayer pay gas | fixed: only after the join deposit |
| S2 | Medium | pledges and claims filled storage for free | fixed in 0.2.6 (#75), proven on testnet |
| S3 | Medium | an honest steward slashed when the term ended just after a paid job | fixed in 0.2.6 (#75) |
| S4, A1 | Medium | the DAO's owner signature on Agent API intents | fixed: exact fields, whole text in the proposal; #72/#73 audited |
| R1–R3, D | Low | CSP, pledge disputes, NEAR AI measurements, `video/` dependencies | known issues, with reasons |

QA ([01-audit](reports/01-audit.md) pass 12 Nov): a retry that reused a failed read, an unread proof shown as "no
proof", a false "Mismatch" on a missing file, a check that could not fail, no timeouts on 16 outbound calls, two setup
steps that worked only on the builder's machine, stale numbers in the docs. All fixed.

Scanners: `npm audit` 0 high/critical at the root (2 low); no secrets in the repo or its history; no XSS found.

## 3. Integrations, before → after

| | Before | After (✓ = on a public chain, read back by `npm run verify`) |
|---|---|---|
| Sputnik DAO | deep | ✓ every task, pledge and case state on the showcase; a rejected and an open proposal |
| Chain Signatures | a signed statement (#57) | ✓ a payment on Ethereum Sepolia by vote (#74); ✓ one filed from the Trezu template `kop-pay-ethereum` (#81), whose hash the page rebuilds before members vote |
| NEAR Intents | none (no testnet) | ✓ the agent's wallet owned by the DAO (Tidepool's testnet Agent API, #72/#73), members-only policy, payouts on NEAR and Base Sepolia; ✓ each member's payout route set on the contract, the policy changed to list exactly those routes by vote #80 |
| OutLayer | none | ✓ the by-laws gate inside an Intel TDX enclave, on-chain, before every job the agent starts; the receipt names the transaction |
| NEAR AI Cloud | attestation, no job | ✓ one job by a TEE-verified model, billed cost and proof on-chain |
| Global contracts | upgrades by vote | ✓ #76 (0.2.7), rebuilt byte for byte by CI from the commit the chain names |
| Trezu | forms, #51 | ✓ a seventh template, `kop-pay-ethereum`, compiled by Trezu's own engine into #81 |

## 4. Competitors and positioning

The track had 74 entries on 12 Nov. "An AI agent bound by DAO rules" is now parity; none of them combines a co-op's
whole life on chain with an agent whose wallet and cross-chain payments answer to the members. Detail and positioning:
[02-strategi](reports/02-strategi.md).

> For communities that want an AI agent to earn for them, Koperasi is a co-op on NEAR that owns its agent, one member
> one vote, unlike agent launchpads where holders vote by weight if at all and the operator holds the keys.

## 5. Differentiators, and why they are hard to copy

1. **The agent's money answers to the co-op, on every chain.** Its Intents wallet and the co-op's Ethereum address have
   no private key anywhere: the owner is the DAO's Chain Signatures address, which signs only after a vote. Copying it
   needs a DAO that votes the exact text it signs, which we check field by field.
2. **The co-op's whole life on chain**, not a payout tool: membership by vote and signed vouch, savings, shares by
   rule, earned trust with a veto window, pledges, a court drawn at random.
3. **Don't trust us:** the page checks the by-laws hash, the code (0 full-access keys, rebuilt byte for byte), the
   model's TEE with the visitor's own nonce, and the brief itself, live.

## 6. How to try it

- **The page:** https://koperasi-kohl.vercel.app — *Check it yourself* goes to the live brief.
- **Every claim, read-only:** `npm install && npm run verify` (ends with `every claim checks out`).
- **Step by step for judges:** [JUDGE.md](../JUDGE.md).
- **Join:** a member's invite link with a signed vouch, a testnet wallet and the 0.5 NEAR deposit.

## 7. Testing

| Suite | Result |
|---|---|
| Contract (`cargo test --lib`) | **141 passed** |
| Sandbox against the real Sputnik DAO wasm | green on CI (Linux) |
| Unit (`npm run test:unit`) | **38 pass**; the Ethereum-signature test 10 runs in a row (3 000 signatures) |
| Lint, typecheck | clean |
| `npm run verify` | **every claim checks out** |
| Playwright, locally, desktop + mobile | 42 passed, 1 flaky (passed on retry), 0 failed; axe clean; visual snapshots for 6 profiles |
| CI on the public repo | rebuild, tee-attestation, members, chain, contract, sandbox: green |

## 8. Contracts and links

| | |
|---|---|
| Live page | https://koperasi-kohl.vercel.app |
| Contract | [`koperasi-mw4i2iwk.testnet`](https://testnet.nearblocks.io/address/koperasi-mw4i2iwk.testnet), 0.2.8, global code `7bLZ4Sq9…`, sha256 `61f1fa38…`, proposal #82, 0 full-access keys |
| DAO | [`koperasi-mw4i2iwk.sputnik-v2.testnet`](https://testnet.nearblocks.io/address/koperasi-mw4i2iwk.sputnik-v2.testnet) |
| The DAO's Ethereum address | `0xb3dc0128b4a9804de94796480bef8ba014dfca7d` (Chain Signatures) |
| The agent's Intents wallet | `agent_7faa1d7f6f2be9e778c9fd18` (Tidepool testnet), owner: the address above |
| Every co-op from this repo | https://koperasi-kohl.vercel.app/coops.html |
| Video | rendered: 4:27, and a 2:03 cut for X (`video/`); not posted yet |

## 9. Blockers (only what needs you)

1. **Submit the form** on nearhackathon.com before 14 Nov 23:59 UTC (it cannot be edited after).
2. **Post on X** with the 2:03 video (draft in [submission.md](submission.md)).
3. **Real members:** 2–3 people outside the builder, through a member's invite link with a signed vouch.
4. **A real Agent Market job:** the agent has bid on every matching job; a buyer has to award one.
5. **Mainnet:** not deployed, by choice (rule 7: it needs real NEAR and your decision).
