# 01 · Audit (Tech Lead), 8 Nov 2026

The project's state before this round's changes, checked by running it rather than by reading claims.

## Summary

- **Submission readiness: about 85% before this round.** Everything shown on the page runs end to end on testnet: the
  contract, the DAO, the agent loop against a local market, the TEE checks in the browser, profit shares and Sputnik
  bounties. Three things are missing, and all of them need outside input (see [REPORT.md](../REPORT.md#9-blocker)):
  1. Circle USDC in the treasury.
  2. NEAR AI credits for the co-op's organization.
  3. Agent Market has no testnet.
- **The biggest gap against the track brief (Social Money):** "reputation-based access" was only partly there.
  - Contribution points existed, but they only weighed the profit share.
  - Every bounty payout still needed the full vote, whatever its size and whatever the contributor's record.
  - Sputnik DAO cannot tell payouts apart by size: its vote policy is per proposal *kind*.

## Stack, and how it was run

| Part | Files | Run | Result |
|---|---|---|---|
| Contract (Rust, near-sdk 5) | `contract/src/lib.rs` | `cargo test` | 56 passed |
| Wasm build | `contract/` | `cargo near build non-reproducible-wasm --no-abi` | OK (ABI generation fails to link on Windows, so it is skipped) |
| Agent (Node) | `agent/*.mjs` | `npm run test:unit` | 13 passed |
| Scripts | `scripts/*.mjs` | run against testnet | OK; `upgrade.mjs` fixes listed below |
| Page (static) | `web/` | Playwright on 6 projects | 124 + 84 passed |
| CI | `.github/workflows/tests.yml` | GitHub Actions | green on `5c4aedd` |

## On-chain state (testnet)

| Contract | Address | Code | Status |
|---|---|---|---|
| Koperasi | [`koperasi-mw4i2iwk.testnet`](https://testnet.nearblocks.io/address/koperasi-mw4i2iwk.testnet) | global contract, chosen by a DAO vote | no full-access key (locked) |
| Sputnik DAO | [`koperasi-mw4i2iwk.sputnik-v2.testnet`](https://testnet.nearblocks.io/address/koperasi-mw4i2iwk.sputnik-v2.testnet) | Sputnik v2 (factory) | 4 members, threshold 1/2 |
| USDC | `3e2210e1…afcb8af` (Circle testnet) | Circle | treasury balance **0**: blocker |

- **Explorer verification.** NEAR has no source verification like Etherscan. Instead, the wasm is rebuilt from source and
  its sha256 is compared with `global_contract_hash`.
  - After this round, rebuilding from `contract/` gives `3wCdocCi3UyfoBLmKTNFfveH1mDcxskR4Nk3zvde8nhX` (proposal #25), the same hash as on-chain.
  - This was checked on Windows with a non-reproducible build.
- **ABI.** The page does not use an ABI. It calls views by name and reads `deployment.json` (same address as `deployment.testnet.json`).

## Inventory: claims vs reality

| Claim (README/page) | Status |
|---|---|
| Membership by DAO vote, refundable deposit | runs, tested on-chain |
| By-laws pinned by hash, the agent refuses another config | runs; on the page, the visitor's browser hashes the file |
| TEE verified by the visitor with their own nonce | runs (Intel collateral, `@phala/dcap-qvl` in the browser) |
| Agent sells on Agent Market | real API client; the demo uses a local stand-in (`agent/mock-market.mjs`), labelled as such, because the market has no testnet |
| Audit, steward bond and slash | runs |
| Profit share with a per-member preview | runs; the treasury is empty (USDC blocker), so the page says so and hides the form |
| Sputnik bounties | runs |
| Reputation-based access | **missing** (finding A1) |

Grep for `mock|fake|dummy|TODO|FIXME|lorem|placeholder|coming soon`:
- **No TODOs and no fake data in the UI.**
- `mock-market.mjs` is a disclosed stand-in for the demo.
- `usdc.fakes.testnet` is the name of the public test token that the demo co-op uses.
- `placeholder=` hits are the HTML attribute on input fields.

## Findings

| ID | Category | Severity | Location | Description |
|---|---|---|---|---|
| A1 | Product/track | High | contract, page | No reputation-based access: every task payout needs the full DAO vote, and the track brief asks for tiers. **Built in phase 3.** |
| A2 | Script | Medium | `scripts/upgrade.mjs` | The cost hint for publishing global code said ~wasm/1e5 NEAR. The real cost is 0.0001 NEAR per byte (31 NEAR for 305 KB); the first publish failed with `LackBalanceForStateAction`. Fixed. |
| A3 | Script | Medium | `scripts/upgrade.mjs` | After the upgrade vote, the script read the running code once. A lagging RPC returned the old hash, so the script stopped early, and a re-run filed a duplicate proposal (#20, harmless: same code). It now waits up to 15 s. Fixed. |
| A4 | Script | Low | `scripts/bounty.mjs` | Bounties could only be posted in USDC, and the treasury holds none; `list` printed NEAR bounties as USDC. Added `--near`. Fixed. |
| A5 | Security/infra | Low | `vercel.json` | No security headers. Added nosniff, X-Frame-Options, Referrer-Policy and Permissions-Policy. CSP: known issue (phase 5). |
| A6 | Quality | Low | `contract/src/lib.rs` | 3 clippy warnings (too many arguments in `new`, manual checked division). This code is already on-chain, and changing it changes the code hash. Known issue. |

Earlier rounds (see git log `8947ba8`, `6d2f5ad`, `5c4aedd`) fixed the agent's money path, the RPC failover, member
paging and module preloading.

## Priority for the judges' criteria

1. **A1:** this is the track brief itself (Social Money: "reputation-based access", "programmable rewards").
2. **A2 and A3:** they block the upgrade A1 needs.
3. **A4, A5 and A6.**

## Pass 12 Nov (the day the repo went public)

Two independent read-only reviews (security; claims, integrations and DX), a Lighthouse audit and a performance trace,
and a grep for mocks and placeholders. Every finding below was fixed and checked the same day unless marked.

**Mocks and placeholders.** None in what the page shows. `agent/mock-market.mjs` is the local stand-in for Agent
Market (which has no testnet), used by `npm run demo` only; its jobs are now `demo-` prefixed on-chain and the page
labels them ("Demo market, no model", or "demo buyer, real model" for the one a real model did). `todo` in
`wallet.js` is a step state; `mock` in `tests.rs` is near-sdk's test VM.

**Readiness for submission: 95%.** What is left is not code: the submission form, the X post (draft and a 2:03 cut of
the video ready), real members beyond the builder's demo accounts.

| ID | Area | Severity | Finding | Fix |
|---|---|---|---|---|
| K1 | Security | Critical | The members' bot voted in anyone who paid a deposit: a few accounts out-vote the DAO | Signed vouch required ([05-security](05-security.md) round 7) |
| T1 | CI | High | Every run 9–12 Nov failed in 2–4 s (Actions billing on a private repo); "daily CI" was not true | The repo is public: rebuild, tee-attestation, members, chain, contract, sandbox and static jobs are green |
| T2 | DX | High | `cp .env.example .env` then `node agent/runtime.mjs`: nothing loads `.env` | `node --env-file=.env …` in the docs |
| T3 | DX | High | The local page from a clean clone misses `config/` and `evidence/` (gitignored, copied at deploy) | `npm run web:files` first, in the docs |
| T4 | Page | High | The brief's retry reused one rejected promise | A shared read that is forgotten on failure |
| T5 | Page | High | A proof the RPC did not answer showed as "Demo market, no model" | Shown as unread; the status says "TEE proofs not read yet" |
| P1 | Performance | High | LCP 3.9 s on a slow phone: the headline started hidden and the text faded in after 2 s | 1.7 s, CLS 0 (headline whole at first paint, no fade on text) |
| S1–S4 | Security | Medium | Relayer gas, pledge storage, steward slashed at term end, owner intents | Fixed (round 7) |
| Q1 | Page | Medium | By-laws *Verify* hashed a 404 page and said "Mismatch" | Reports the missing file |
| Q2 | Page | Medium | The brief's budget line was always green | Checks the DAO policy: no role but the members' does more than file proposals, except `tasks` (transfers only) |
| Q3 | Page | Medium | "earns 5 points" per task | The contract's rule: in proportion to the pay, members only |
| Q4 | verify | Medium | Payouts only printed WARN; outbound calls had no timeout or fallback | Payouts are checks; 15 s timeout and fallback RPCs |
| Q5 | Agent, scripts, page | Medium | No timeout on 16 outbound calls (a hung API stopped a `--loop` agent) | Timeouts everywhere (inference 180 s) |
| Q6 | Scripts | Medium | `intents.mjs` booked a payout from an unreadable status; `outlayer.mjs` hashed a 404 | Refused |
| Q7 | Docs | Medium | Stale numbers (tests, tasks, pledges, upgrade cost, who the members are), links to `docs/docs/…`, a dead `#try-it` anchor | Updated; live counts where they change |
| Q8 | DX | Low | `.env.example` missed 9 variables; no `engines` | Every variable with where to get it; `node >= 22.3` |
| Q9 | Tests | Low | A unit test read a signed transaction at fixed offsets and failed 1 run in 8 on CI | An RLP decoder; 300 signatures a run, 10 runs in a row pass |
| Q10 | CI | Medium | Six browser profiles from one runner hit the public RPCs' 429 limit: 52 flaky and 3 failed tests, 43 min | A per-worker cache of answered RPC reads in the specs; it then showed a deep-link scroll race and a Reject button with no ground of its own (axe, mobile), both fixed. All green, 13 min |
| R1–R3 | Security | Low | CSP, pledge disputes, NEAR AI measurements not pinned | Known issues, reasons in round 7 |

Lighthouse (mobile, live): Accessibility 100, Best Practices 100, SEO 100, Agentic Browsing 100.
