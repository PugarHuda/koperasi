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
