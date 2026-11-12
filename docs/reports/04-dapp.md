# 04 · dApp / full-stack (9 Nov 2026)

Builds on [01-tech-lead](01-tech-lead.md), [02-strategi](02-strategi.md) and [03-contracts](03-contracts.md). The page
is a static site (`web/`, no build step) on Vercel: https://koperasi-kohl.vercel.app. Commits `f56ee41`, `2574942`.

## Findings fixed

| Finding | Fix | Files |
|---|---|---|
| T8: raw contract panic text | Done earlier (the contract's own sentence). Errors are now classified: cancelled in the wallet, failed on-chain (with the failed tx), or network unknown ("check before retrying", against double sends) | `web/share.js` (`walletError`), `web/wallet.js` |
| T11: CSP | Partly done earlier (framing, base, object, form). Script and connect sources stay open on purpose: NEAR Connect loads wallets from many origins | `vercel.json` |
| T12: E2E flaky under public-RPC 429s | The RPC client no longer retries an answer that is final on every RPC (no such account, a contract refusal). The live feed starts after the page's own reads | `web/near.js`, `web/live.js` |
| Phones scrolled sideways (39 px on iPhone, CI run 42561548758) | The by-laws grid used `1fr`, which grows to its widest content; now `minmax(0, 1fr)`, and the rebuild commands wrap | `web/style.css` |
| PRD F7: no way to leave from the page | *Ask to leave* files `RemoveMemberFromRole` for yourself; after the vote, *Close my membership* returns the deposit | `web/wallet.js` |

**No mock data on the page.**
- Every figure is read from the chain: contract views, the DAO, the token, the staking pool. The live feed adds the
  NearBlocks indexer.
- Addresses come from `web/deployment.json`, a copy of `deployment.testnet.json`. NEAR has no ABI; the contract's
  JSON methods are typed in its source.
- The only demo data are the 4 receipts from `npm run demo`. The page labels them *Demo market, no model*.

## Wallet and transactions

| Brief | How it works here |
|---|---|
| Connect, switch account, disconnect, auto-reconnect | NEAR Connect (Meteor, Intear, Nightly, HOT…). `wallet:signIn` / `wallet:signOut` re-render the panel; `getConnectedWallet()` reconnects on load |
| Switch network | NEAR has no chain id to switch. The panel checks the signed-in account on this network's RPC: if it does not exist, the panel says the wallet is probably on the other network, explains how to switch (Meteor's network menu), and offers *Disconnect and connect a testnet account*. A new implicit account is told it exists only once funded |
| Transaction status | *Checking with the chain first* → *Waiting for your signature… NEAR confirms in about 2 seconds* → **confirmed** (tx link), or **failed on-chain** (the contract's sentence and the failed tx link), **cancelled in your wallet** ("nothing was sent"), or **status unknown** (network; check before retrying) |
| Simulation before sending | NEAR's RPC cannot dry-run a state change, so the page runs the contract's own checks on the current chain state before the wallet opens: task status and roles (`taskCheck`, the same rules as `tasks.rs`), whether a vote is still open and not voted already, whether a claim is still there, whether the account already joined, and whether the account can pay deposit plus gas over its storage lock (`affordable`). A failing check shows **not sent**: the reason, and nothing to sign |
| Double submit, nonce | One transaction at a time: the panel disables every control while busy. Nonces belong to the wallet's access key; NEAR has no replacement transactions (a transaction lands or expires) |

## On-chain data

| Brief | How it works here |
|---|---|
| RPC fallback and retry | 3 RPCs, two rounds, an 8 s timeout each, sticky to the last good RPC; a final answer is not retried |
| Batch reads | NEAR has no multicall. Independent views run in parallel (`Promise.all`) |
| Real-time events | **Live activity** section (`#live`, `web/live.js`). The contract emits NEP-297 events (see 03). The NearBlocks v3 indexer lists the latest transactions to the contract and the DAO, and the RPC returns their logs. Polled every 30 s while the tab is visible and on return to the tab. A new event refreshes the wallet panel (cache invalidation) and offers *refresh the figures*. Polling is used because no indexer streams NEP-297 events on testnet: Intear's stream is mainnet-only |
| Schema validation | No new dependency (the page is plain ES modules). `parseEvents` keeps only logs written by the contract account with `standard: "koperasi"`, a semver version, a known event and object data, so another contract printing `EVENT_JSON` cannot spoof the feed. `txList` checks the indexer's rows (base58 hash, signer, timestamp) |

## Sponsor integrations: before and after this round

| Integration | Before | After |
|---|---|---|
| NEAR protocol | Global contracts for vote-only upgrades | Also NEP-297 events read live on the page, and NEP-330 source metadata shown as a **rebuild it yourself** card: commit link, Docker image, the command, and the sha256 it must give |
| Sputnik DAO | Membership, by-laws, upgrades, bounties, task payouts through role `tasks` | Also: leaving by `RemoveMemberFromRole` from the page, votes checked before signing, every payout proposal visible in the live feed |
| NEAR Connect | Connect, sign, disconnect | Also: network check, the full transaction lifecycle, checks before signing |
| Circle USDC | 0 USDC, no profit share on the showcase | Real profit shares #36 (10 USDC) and #46 (1 USDC); claims on-chain; USDC registration from the page |
| NEAR AI Agent Market | Registered, 0 bids | **9 real bids** live on market.near.ai (agent run of 9 Nov) |
| NEAR AI Cloud | TEE attestation checked in the browser; inference blocked ($0 credits) | Same. The $10 hackathon credit key was claimed today (NEAR Builders dashboard); a real job waits for the key to be saved in `.env` |
| Trezu | Display only (mainnet) | Unchanged |

## New features: how to try them

| Feature | Try it | Evidence |
|---|---|---|
| Live activity | https://koperasi-kohl.vercel.app/#live. Any transaction to the co-op shows within 30 s | The feed shows flows #44–#47: e.g. "The treasury paid kop-steward-mw4i2iwk 0.02 NEAR for task #6" ([5HQXEikJ…](https://testnet.nearblocks.io/txns/5HQXEikJQs3NYjvcisERj5jciShwDu1SYaqRTX7D5c1K)) |
| Rebuild card | https://koperasi-kohl.vercel.app/#bylaws, under "Who can change the contract's code?" | `contract_source_metadata` of upgrade #41 |
| Leave the co-op | Wallet panel → *Ask to leave* → after the vote, *Close my membership* | #39 (join), #40 (leave), [pH35xFRx…](https://testnet.nearblocks.io/txns/pH35xFRxjKWxqwGhJ4VXzL3mvphTQDxAvNF7R1wruzV): 0.5 NEAR back |
| Checks before signing | E.g. *Approve* on a task someone already approved: "not sent. This task is Paying now, not NeedsApproval: someone acted first." | unit tests (below) |
| Wrong network | Sign in with an account that does not exist on testnet | E2E `an account from another network…` |

Previews of each panel state, without a wallet, on localhost: `/?as=<account>`.

## Tests

| Suite | Result |
|---|---|
| Unit (`npm run test:unit`) | **19 pass**. New: the event filter (spoofed account, wrong standard, unknown event, bad version, bad data, broken JSON), event sentences, the indexer check, wallet error classes, affordability with the storage lock, every `taskCheck` rule |
| E2E, local, desktop + Firefox + iPhone | **155 passed**, 3 flaky (public-RPC 429s; passed on retry), 4 skipped (Firefox axe crash, localhost-only previews on live). New: live feed with tx links, the NEP-330 card, the wrong-network state, *Ask to leave* |
| Accessibility (axe, WCAG 2.1 AA) | 0 serious or critical (the refresh button's contrast was fixed) |
| Lint, typecheck | clean |

## Blockers that need the owner

1. **NEAR AI key:** save the new $10 key (dashboard → *copy secret*) as `NEARAI_API_KEY` in `.env`. It is shown only
   once. Then one real Agent Market job runs with its TEE proof.
2. **Mainnet:** no mainnet support program (answer in the NEAR Builders chat); deploying costs real NEAR. Your decision.
3. **Gasless / embedded wallet:** NEAR meta-transactions (NEP-366) need a funded relayer, and NEAR Auth (Google sign-in)
   needs mainnet whitelisting. Not built. Meteor already creates a funded testnet account in a few clicks.
4. **Video, X post, submission form.**

## Earlier round (8 Nov 2026): tasks with earned trust on the page

Builds on [03-kontrak](03-kontrak.md).

## What changed

| File | Change |
|---|---|
| `web/index.html` | New section **06 Tasks & trust**: the three tiers, the "Tasks on the board" table and the "Contributors' records" table. The DAO bounty table moved here as the third tier. "Tasks" added to the nav; "Earn trust" added as the sixth step of the hero loop. |
| `web/app.js` | The board reads `get_board`, `get_tasks` (paged by `all`) and `get_contributors` straight from the chain. Each record source links to its task (`#task-N`) or to the DAO. An error state says the board cannot be read; an empty state says no rule has been voted yet. |
| `web/wallet.js` | The wallet panel gets a "Tasks with earned trust" block for **every** signed-in account, member or not: take, deliver (requires a link), give up. The poster sees **before signing** whether accepting will pay at once or wait for one member. Other members see "Approve paying X"; the poster and the contributor are never offered approval. Members get a posting form that checks the amount (≤ `one_vote_max`, at most 6 decimals) before the wallet opens. |
| `web/share.js` | `nearUnits` (exact NEAR → yocto) and `payPath`, the same rule as `accept_task`, tested in `tests/unit`. |
| `web/style.css` | Tier styles; the hero loop has 6 columns. |
| `scripts/tasks.mjs` | CLI for every step: vote the rule and the budget, post, take, deliver, accept, approve, count a DAO bounty, list. Prints the explorer link and the contract logs. |
| `scripts/bounty.mjs` | `--near`, for bounties paid in NEAR while the treasury has no USDC. |
| `scripts/upgrade.mjs` | Fixed the cost hint (0.0001 NEAR a byte), and the script now waits for the new code before checking. |
| `vercel.json` | Security headers. |

## Wallet and transactions (unchanged, reused)

- Wallet connection goes through `@hot-labs/near-connect` (Meteor, Intear, Nightly…), including connect, disconnect and reconnect on load.
- Each button runs one transaction, with these states:
  1. "confirm in your wallet…"
  2. done, with an explorer link, or the contract's panic message decoded into words
  3. the panel re-reads the chain
- Double submits are blocked (`busy`).
- NEAR has no "wrong network" state in this wallet: the connector is opened for `testnet` only.

## Sponsor integration: before → after

| Integration | Before | After |
|---|---|---|
| Sputnik DAO | Deep: membership, by-laws, upgrade, profit share, bounties | Deeper: approval rights read from `get_policy` at the moment of approval, approved `BountyDone` proposals read through `get_proposal` and counted on the record, the task budget and rule only by `FunctionCall` proposals |
| Trezu | Shallow: the treasury is a Sputnik DAO that Trezu can display (mainnet) | Unchanged. Trezu has no public API for tiers; its Finance threshold is what the tiers complement |
| NEAR AI Cloud (TEE), Agent Market | Deep (earlier rounds) | Unchanged |

## New feature: how to try it

- **Read only:** https://koperasi-kohl.vercel.app/#trust. The data is read from the chain.
- **As a contributor:**
  1. Connect a testnet wallet in "Join the co-op".
  2. Under "Tasks with earned trust", take an open task, then deliver a link.
- **As a member:** use the scripts, as the testnet run shows:
  ```
  node scripts/tasks.mjs post kop-alice-mw4i3w8f.testnet 0.05 "…"
  node scripts/tasks.mjs claim 2 <account>
  node scripts/tasks.mjs submit 2 <account> "<link>"
  node scripts/tasks.mjs accept 2 kop-alice-mw4i3w8f.testnet
  node scripts/tasks.mjs list
  ```
- **Evidence:** the transactions in [03-kontrak](03-kontrak.md#the-main-flow-on-testnet-real-transactions).

## Tests

| Suite | Result |
|---|---|
| Unit (`npm run test:unit`) | 14 pass: one new test for `nearUnits` and `payPath`, which mirror the contract |
| `tests/trust.spec.mjs` | 7 E2E tests |
| Lint, typecheck | clean |

The 7 E2E tests cover:
- the board from the live chain (tiers, "approved by bob", "on earned trust, no vote", sources with links);
- the error state;
- the empty state, with no rule;
- a contributor delivering, where a link is required;
- the poster seeing the pay path;
- the approval button for another member only;
- amount validation on posting.

## Pass 12 Nov: integrations deepened, the first screen, resilience

**Integrations, before → after** (✓ = a transaction on a public chain, read back by `npm run verify`):

| Integration | Before | After |
|---|---|---|
| Chain Signatures | the DAO signed a statement naming its Ethereum address (#57) | ✓ the DAO **pays on Ethereum by vote**: an EIP-1559 transfer the members voted (#74) landed on Sepolia; RLP and low-s by hand, no Ethereum library |
| NEAR Intents | none (no testnet) | ✓ the agent's **Intents wallet owned by the DAO** on Tidepool's testnet mirror of the Intents Agent API: creation (#72) and grant (#73) are owner intents the MPC network signed by vote; the policy pays only members, ≤ 5 USDC a payment, $10 a day, each payout held 10 minutes; ✓ the agent paid bob on NEAR and on Base Sepolia |
| OutLayer | none | ✓ the **by-laws gate inside an Intel TDX enclave**, on-chain: `outlayer/bylaws-check` (WASI) reads the voted hash from NEAR's RPC and hashes the file |
| NEAR AI Cloud | attestation and signatures checked; no job had run | ✓ one job done by a real model, TEE-verified, response signature checked, billed cost ($0.002392) and proof on-chain (demo buyer) |
| Sputnik DAO | tasks, bounties, shares, court | + every task, pledge and case state on the showcase (`scripts/scenarios.mjs`), a rejected proposal (#68) and an open one (#69) |

**The page.** A live "Social Money brief, proven live" section (each line of the track's brief and the co-op's
activity read from the chain); a first screen with one live line and a call to action to the proof (both visible on
a 900 px laptop); proposals to the co-op's own contract read in one plain sentence above their raw arguments;
`/coops.html`, every co-op deployed from the repo; LCP 3.9 s → 1.7 s on a slow phone, CLS 0.

**Resilience** (QA audit): first reads and the shared task board retried; an unread proof shown as unread, never as
"no proof"; a missing by-laws file reported as missing; timeouts on the relayer calls and on Intel's collateral; the
brief's budget line checks the DAO policy.
