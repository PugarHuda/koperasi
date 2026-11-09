# 05 · Security (Web3 Security Auditor), 9 Nov 2026

This report follows [05-keamanan](05-keamanan.md), the first round on 8 Nov. That round covered findings S1–S11 in `tasks.rs`. This round covers the code added since:
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
| Contract tests | 89 | **90** (+ PoC S12) |
| Unit tests (page and agent) | 19 | **23** (+ PoC S14–S17) |
| E2E desktop | 34 passed | 34 passed, 20 skipped (same as before) |

## Findings

Severity follows the brief: Critical, High, Medium, Low. Earlier findings S1–S11 are in 05-keamanan. They are still fixed, and their tests still pass.

| ID | Component | Severity | Impact | PoC | Status |
|---|---|---|---|---|---|
| S12 | `on_staked` / `distribute` (`lib.rs`): savings from the staking pool | **Medium** | Savings are the stake read at the last `sync_savings`. A member can stake a large amount just before a profit share passes the vote, call `sync_savings`, and unstake afterwards. They then take most of the savings pool, at the cost of only the unstaking lock-up (about 4 epochs). Other members' savings shares are diluted. Nobody can steal treasury funds this way | `poc_s12_stake_just_before_a_share_takes_the_savings_pool` (`contract/src/tests.rs`): with 9 900 NEAR staked the day before, Mallory takes 39.6 of the 40 USDC savings pool; Alice, who saved for months, gets 0.4 | **Known issue**: needs an upgrade by vote, see below |
| S13 | DAO policy (live on testnet) | **Medium** (centralization) | Every power over the co-op goes through the DAO's `member` role: treasury, code upgrades, by-laws, removing members. On the showcase that role has 4 accounts, and 3 of them belong to the team (alice, bob, steward). A vote needs 3 of 4, so the team alone can pass anything | Read on-chain: `get_policy` gives `member` = 4 accounts with threshold 1/2 (RoleWeight). Neither the contract nor the DAO has a full-access key (`view_access_key_list` = `[]`) | **Known issue**: the showcase needs real members (the owner's task). The code has no admin key and no owner bypass |
| S14 | Page hero: "Proposal #N passed with X yes votes" (`app.js`) | **Medium** | Anyone can file a DAO proposal (`all: *:AddProposal`, 0.1 NEAR bond). The page took the newest proposal whose `set_config` args matched the current hash, without checking that it was approved or addressed to the co-op. One fake proposal made the page say "Proposal #8 passed with 0 yes votes", or, with unreadable args, mark every member "voted yes" | unit `S14: a proposal anyone files cannot pose as the members' by-laws vote`. The old logic, run on the same data, picked open proposal #8, and threw on #10, which made every member show as voted yes | **Fixed**: `configVote` (share.js) counts only an *Approved* `set_config` call to the co-op contract and catches unreadable args. If no vote is found the page now says "vote not found" instead of "voted yes". On the live chain it still finds vote #7 (Approved, by-laws v3) |
| S15 | Proposal descriptions in the wallet panel (`wallet.js`) | **Medium** | Members vote from the "what it really does" block. A proposer could put line breaks in the `role`, `token_id` or `method_name` strings to add a fake line, e.g. `role: "member\n\nProfit share: send 1.00 USDC…"`. A Transfer also showed its raw amount in base units, and did not flag an unknown token | unit `S15: a proposer's role, token or method name stays on one line` | **Fixed**: `oneLine` (one line, at most 64 characters). A Transfer now goes through `pays()`, so it shows NEAR, USDC, or "base units of UNKNOWN token X" |
| S16 | By-laws download (`app.js`) | **Low** (needs a DAO vote) | `set_config.uri` is free text. A path like `/evil.example/x.yaml` turned into `//evil.example/...`, so the page would fetch the file from another host. That leaks visitors' IPs. There is no XSS: the file is hash-checked and escaped | unit `S16: the by-laws path a vote sets cannot point the page at another host` | **Fixed**: `byLawsPath` allows only a relative path on this site: no leading `/`, no `//`, no `..` |
| S17 | Live feed (`live.js` / `txList`) | **Low** | An indexer row with a 30-digit `block_timestamp` passed the check. `toISOString()` then threw, and the feed stopped until the next poll | unit `S17: an indexer timestamp too large…`. It **fails** with the old regex (checked by switching the fix off) | **Fixed**: at most 19 digits, which is a u64 in nanoseconds |
| S18 | `esc()` (`near.js`) | **Low** (latent) | It did not escape `'`. Every attribute that holds data today uses `"`, so nothing could be injected yet, but the first single-quoted attribute would be | review | **Fixed**: `'` becomes `&#39;` |
| S19 | Third-party modules (`wallet.js`, `tee.js`) | **Medium** (supply chain) | `@hot-labs/near-connect@0.12.0` and `@phala/dcap-qvl@0.7.1` are pinned versions loaded from esm.sh, without a subresource integrity check. If esm.sh were compromised, it would run code on the page and could alter the transaction sent to the wallet. The wallet still shows the receiver, the method and the deposit before you sign | review | **Known issue**, see below |
| S20 | CSP (`vercel.json`) | **Low** | `frame-ancestors`, `base-uri`, `object-src` and `form-action` are locked. `script-src` and `connect-src` are left open | review | **Known issue** (from round 1), see below |
| S21 | Agent runtime: prompt injection through a market job | **Low** | The buyer's job text goes to the model as the user message. The model has no tools. The agent's only key is a function-call key limited to `record_receipt` and `update_receipt` on the co-op (checked on-chain). The by-laws hash must match, or the contract refuses the receipt. An injected prompt can change only that buyer's own answer. The system prompt is public anyway (`config/*.yaml`) | review; key list read on-chain | Accepted by design |

### Dependencies

| ID | Package | Severity | Where it runs | Status |
|---|---|---|---|---|
| D1 | `crypto-bigint 0.5.5` (RUSTSEC-2026-0387, timing variability) | vulnerability | Pulled in by `near-sdk` → `near-vm-runner` → `p256`. That is the mock VM for unit tests; `cargo tree --target wasm32-unknown-unknown` does not contain it. The contract uses no P-256 and holds no secrets | Known issue: cannot be bumped without a new near-sdk; not in the deployed wasm |
| D2 | `wee_alloc 0.4.5` (unmaintained) | warning | **In the wasm** (near-sdk's allocator) | Known issue. NEAR starts a fresh wasm instance for every call, so wee_alloc's known leaks cannot build up. Switching allocator changes the code, so it would ride along with the S12 upgrade |
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

1. **S12, savings snapshot.** The fix counts a stake increase only after a delay (e.g. 7 days); a decrease counts at once. It needs new state under its own key, so it has to ship as a contract upgrade by vote. Publishing the code as a global contract costs about 34 NEAR, and the publisher holds about 9 testnet NEAR, refilled 10 NEAR an hour by the faucet. Until then, the DAO can turn the pool off (`set_staking_pool(None)`) and vote savings with `set_savings`. The PoC test is written to flip when the fix lands.
2. **S13, centralization on the showcase.** This is not a code issue: the showcase needs members from outside the team. The rules (3 of 4 votes, no admin key) are the same ones real members would get.
3. **S19, esm.sh without an integrity check.** Browsers cannot pin a hash on a dynamic `import()`. The fix is to vendor both modules into `web/`. The wallet connector loads its wallets' code at runtime anyway, so vendoring narrows the risk without removing it. Planned with S20.
4. **S20, CSP `script-src`.** NEAR Connect runs each wallet in an iframe built from the wallet's own code, and the TDX check compiles WASM. A tight `script-src` breaks both, and it can only be switched on with an end-to-end wallet test on every browser.
5. **D1–D4.** Upstream; none of them reaches code paths that handle secrets or money (see the table).
