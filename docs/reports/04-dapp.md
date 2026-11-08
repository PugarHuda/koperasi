# 04 · dApp and integration (dApp Engineer), 8 Nov 2026

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
