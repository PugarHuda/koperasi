# Checking Koperasi: a list for judges

Every check is read-only: no wallet, no keys, no transactions. Each one names where to look and what you should see.
The showcase co-op is on NEAR testnet: contract `koperasi-mw4i2iwk.testnet`, DAO `koperasi-mw4i2iwk.sputnik-v2.testnet`.

## In one command (about a minute)

```sh
npm install && npm run verify
```

It reads every claim below from testnet and ends with **`every claim checks out`** (exit code 1 otherwise). CI runs it
on every push and every day (`.github/workflows/tests.yml`).

## On the live page: https://koperasi-kohl.vercel.app

| # | Check | Where | You should see |
|---|---|---|---|
| 1 | The Social Money brief, line by line | *The Social Money brief, proven live*, under the headline | five green lines read from the chain, and the co-op's activity (members, proposals, tasks, shares, cases, pledges) |
| 2 | The agent runs only the by-laws the members voted | *Don't trust us* → *It runs only what members voted* | green: the by-laws file your browser hashed equals the hash in the contract |
| 3 | Nobody can change the contract alone | *No one changes the rules alone* | green: 0 full-access keys; the code is the version a DAO proposal approved |
| 4 | The model runs in a genuine TEE | *The AI runs sealed in a TEE* → *Verify … with your own nonce* | Intel TDX and NVIDIA GPU attestation bound to a nonce your browser just made |
| 5 | One member, one vote | *Members* | every member holds the DAO role `member`; a decision needs a majority |
| 6 | Earned trust, with a veto window | *Tasks* | the tiers the members voted, a 10-minute veto window (proposal #62), tasks in every state, and the DAO proposal that paid each one |
| 7 | Every point has a source | *Tasks* → contributors | each point on a record links the task or DAO proposal it came from |
| 8 | Profit shared by rule | *Profit shares* | every share was a members' vote; the contract split it by savings and points |
| 9 | The co-op court | *Commons* | case #0 upheld and refunded by DAO proposal #60; cases #1 and #2 not upheld (one split 1–2) |
| 10 | Work members owe each other | *Commons* → pledges | pledges kept, partly called in, and never called in |
| 11 | A work record nobody can type in | `/cert.html?who=kop-alice-mw4i3w8f.testnet` | kept pledges and jury duty, each line read from the chain |
| 12 | The co-op holds an Ethereum address with no private key | *Commons* → Chain Signatures | `0xb3dc…ca7d`; it signed a statement (proposal #57) and a payment of 0.001 Sepolia ETH to a member that landed on Ethereum (proposal #74), each by vote |
| 13b | The by-laws checked inside an Intel TDX enclave | `npm run verify` (the OutLayer line), or the tx in `deployment.testnet.json` → `outlayer` | `outlayer.testnet` ran `web/outlayer/bylaws-check.wasm` (same sha256 as the repo) and answered `match: true` for v4 |
| 13a | The agent's NEAR Intents wallet is the DAO's | *Commons* → Chain Signatures; `npm run verify` | created by vote #72, grant by vote #73, each a `sign` request naming the sha256 of the exact owner intent; owner `0xb3dc…ca7d` |
| 13c | Many co-ops from this repo | `/coops.html` | every co-op deployed from this repo, read live (members, jobs, shares, by-laws); the showcase and one more have 0 full-access keys, so their code changes only by a vote |
| 13d | Trust that travels between co-ops | `/cert.html?who=kop-carol-mw80aczw.testnet` → *Passport* | "2 finished at koperasi-mw80aczw.testnet … counts as one trust source here": the contract read her token on the sister co-op the members voted (#83) |
| 13e | Attacks are refused on-chain | *Don't trust us* → *Attacks are refused on-chain* | green: "19 of 19 attacks on this co-op failed on-chain", each re-read by your browser, with the refusal and the transaction |
| 13 | Every state change is an event | *What the co-op just did* | NEP-297 events from the contract, as they happen |

## From the source

| # | Check | Command | You should see |
|---|---|---|---|
| 14 | The code on chain is this source | `cd contract && cargo near build reproducible-wasm` (Docker), then `sha256sum target/near/koperasi.wasm` | `61f1fa38d4c09a30b125afd561f56230e6c19a849afecb4290223a8ae8a0c358`, the `codeSha256` in `deployment.testnet.json` (CI does the same every week: `.github/workflows/rebuild.yml`); the page's *Rebuild it yourself* card shows the commit from the contract's NEP-330 metadata |
| 15 | The tests | `npm test` | lint, typecheck, unit tests and 143 contract tests (unit, fuzz, invariant) pass |
| 16 | Against the real Sputnik DAO code, not a mock | `cd contract && cargo test --test sputnik_sandbox` (Linux/macOS) | a task paid out of the treasury of a local DAO running the showcase DAO's own wasm |

## What is not real yet (said plainly)

- The members are the builder's demo accounts (plus one who joined with a signed vouch). They show the mechanism works;
  they are not independent people.
- The agent has done **no real paid job**: Agent Market has no testnet, so every receipt is from the demo market or a
  `demo-` receipt. Three were done by a real model on NEAR AI Cloud, with its TEE proof on-chain, the last two also
  gated in an OutLayer enclave; `npm run verify` prints "0 from Agent Market".
- The sister co-op of the passport (`koperasi-mw80aczw`) is a second co-op from this repo with the builder's accounts.
- The audit is red (17.10 USDC): 7.60 from before the current steward (not slashable), and 9.50 that the demo jobs of
  12–13 Nov "earned" from the stand-in market, which pays nothing real. Unless the steward passes that on, anyone can
  slash the steward's bond 7 days after each, as the by-laws say.
- Testnet only. The path to mainnet is in the README, under *Sustainability and the path to mainnet*.
