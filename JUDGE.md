# Checking Koperasi: a list for judges

Every check is read-only: no wallet, no keys, no transactions. Each one names where to look and what you should see.
The showcase co-op is on NEAR testnet: contract `koperasi-mw4i2iwk.testnet`, DAO `koperasi-mw4i2iwk.sputnik-v2.testnet`.

## In one command (about a minute)

Without cloning anything (Node 20 or later):

```sh
curl -sO https://koperasi-kohl.vercel.app/verify.mjs && node verify.mjs
```

From a checkout: `npm install && npm run verify`. Both read every claim below from NEAR, Ethereum, Base and Arbitrum
testnets and end with **`every claim checks out`** (exit code 1 otherwise). The one file is `npm run verify` bundled
(`npm run build:verify`); it reads the deployment, the by-laws and the gate program from the page instead of a
checkout, and CI fails if the file the repo holds is not what its source builds. CI runs the check on every push and
every day (`.github/workflows/tests.yml`).

## On the live page: https://koperasi-kohl.vercel.app

| # | Check | Where | You should see |
|---|---|---|---|
| 1 | The Social Money brief, line by line | *The Social Money brief, proven live*, under the headline | five green lines read from the chain, and the co-op's activity (members, proposals, tasks, shares, cases, pledges) |
| 2 | The agent runs only the by-laws the members voted | *Don't trust us* → *It runs only what members voted* | green: the by-laws file your browser hashed equals the hash in the contract |
| 3 | Nobody can change the contract alone | *No one changes the rules alone* | green: 0 full-access keys; the code is the version a DAO proposal approved |
| 4 | The model runs in a genuine TEE | *The AI runs sealed in a TEE* → *Verify … with your own nonce* | Intel TDX and NVIDIA GPU attestation bound to a nonce your browser just made; for deepseek-v3.2 (served through Chutes) the TDX quote is checked against Intel's collateral and Chutes' pinned measurements |
| 5 | One member, one vote | *Members* | every member holds the DAO role `member`; a decision needs a majority |
| 6 | Earned trust, with a veto window | *Tasks* | the tiers the members voted, a 10-minute veto window (proposal #62), tasks in every state, and the DAO proposal that paid each one |
| 7 | Every point has a source | *Tasks* → contributors | each point on a record links the task or DAO proposal it came from |
| 8 | Profit shared by rule | *Profit shares* | every share was a members' vote; the contract split it by savings and points |
| 9 | The co-op court | *Commons* | case #0 upheld and refunded by DAO proposal #60; cases #1 and #2 not upheld (one split 1–2) |
| 10 | Work members owe each other | *Commons* → pledges | pledges kept, partly called in, and never called in |
| 11 | A work record nobody can type in | `/cert.html?who=kop-alice-mw4i3w8f.testnet` | kept pledges and jury duty, each line read from the chain |
| 12 | The co-op holds an Ethereum address with no private key | *Commons* → Chain Signatures | `0xb3dc…ca7d`; it signed a statement (proposal #57) and a payment of 0.001 Sepolia ETH to a member that landed on Ethereum (proposal #74), each by vote |
| 13b | The by-laws checked inside an Intel TDX enclave | `npm run verify` (the OutLayer line), or the tx in `deployment.testnet.json` → `outlayer` | `outlayer.testnet` ran `web/outlayer/bylaws-check.wasm` (same sha256 as the repo) and answered `match: true` for v7 |
| 13a | The agent's NEAR Intents wallet is the DAO's | *Commons* → Chain Signatures; `npm run verify` | created by vote #72, grant by vote #73, each a `sign` request naming the sha256 of the exact owner intent; owner `0xb3dc…ca7d` |
| 13c | Many co-ops from this repo | `/coops.html` | every co-op deployed from this repo, read live (members, jobs, shares, by-laws); the showcase and one more have 0 full-access keys, so their code changes only by a vote |
| 13d | Trust that travels between co-ops | `/cert.html?who=kop-carol-mw80aczw.testnet` → *Passport* | "2 finished at koperasi-mw80aczw.testnet … counts as one trust source here": the contract read her token on the sister co-op the members voted (#83) |
| 13e | Attacks are refused on-chain | *Don't trust us* → *Attacks are refused on-chain* | green: "19 of 19 attacks on this co-op failed on-chain", each re-read by your browser, with the refusal and the transaction |
| 13f | The annual members' meeting | *Commons* → *Annual members' meeting 2026*, or `/rat/2026.md` | the report the co-op's agent wrote in a TEE from the chain's facts, approved by DAO vote #86, whose description carries the report's and the facts' sha256 |
| 13g | Dues, the agent's strikes, the agenda, the federation | *Commons* (the lines under the court) and `npm run verify` | 0.01 NEAR dues voted by #89 and paid by all five; 1 strike (case #5); the 2026 agenda; the federation's resolution passed by both co-ops' votes (#87, #9) |
| 13h | A job won on a third-party testnet market | *The agent* (section 03) → "On Taskbond … scored 95/100", or `npm run verify` | Taskbond jobs #13 and #14: Paid, the winner is the co-op's agent (95/100 each), the reviewer's reason quoted; receipts `taskbond-13`, `taskbond-14` with the TEE proof |
| 13i | The co-ops' network and federation | `/coops.html` | who recognises whom; the federation's members (the two co-ops' DAOs only) and its resolutions, each vote with the co-op proposal that cast it, including the shared reserve's grant |
| 13j | Funds, surety and loans (0.3.0) | *Commons* (the lines under the court) and `npm run verify` | education 5% and social 2.5% from every share; a 1 NEAR loan fund; bob's loan repaid, guest's open, both guaranteed by alice |
| 13k | What needs a member | the panel after signing in | proposals not yet voted, juries, pledges to confirm, dues falling due; a browser notification if allowed |
| 13l | The agent proposes, the members decide (0.3.2) | `npm run verify` (the agent-proposal line), or DAO proposals #123 and #124 | #123 filed by the contract itself, with the agent's reason (23 jobs settled, 17% refunded or disputed: price 4 → 5 USDC) and the agent's signature checked; the members approved it; its call failed (below), and #124 passed the same file: the contract now holds by-laws v7 |
| 13m | Credit, a reputation dividend and the member card (0.3.2) | `/cert.html?who=kop-alice-mw4i3w8f.testnet`; `npm run verify` | alice's card says "credit 7/10 (loan up to 0.35 NEAR); dues paid"; vote #121 set a 10% reputation dividend, the agent's 10% savings into the risk fund and the translator's own by-laws; share #122 paid the dividend by each member's record |
| 13n | A profit share in ETH, and the member's feed | *Commons* → Chain Signatures; `/api/inbox?who=kop-bob-mw4i3w8f.testnet` | Sepolia ETH to alice (#115) and bob (#116), each signed by Chain Signatures after its vote; an RSS feed of what needs bob, read from the chain |
| 13o | The federation's shared loan standard | `/coops.html` | resolution #2 (at most 2% flat, 30 days, a guarantor) passed by both co-ops' votes (#111, sister #18) |
| 13 | Every state change is an event | *What the co-op just did* | NEP-297 events from the contract, as they happen |

## From the source

| # | Check | Command | You should see |
|---|---|---|---|
| 14 | The code on chain is this source | `cd contract && cargo near build reproducible-wasm` (Docker), then `sha256sum target/near/koperasi.wasm` | `cd7d70d2fc8abff164fd6d2c0775166c1b84f9edf187007dc486d40ec15b28ca`, the `codeSha256` in `deployment.testnet.json` (CI does the same every week: `.github/workflows/rebuild.yml`); the page's *Rebuild it yourself* card shows the commit from the contract's NEP-330 metadata |
| 15 | The tests | `npm test` | lint, typecheck, unit tests and 156 contract tests (unit, fuzz, invariant) pass |
| 16 | Against the real Sputnik DAO code, not a mock | `cd contract && cargo test --test sputnik_sandbox` (Linux/macOS) | a task paid out of the treasury of a local DAO running the showcase DAO's own wasm |

## What is not real yet (said plainly)

- The members are the builder's demo accounts (plus one who joined with a signed vouch). They show the mechanism works;
  they are not independent people.
- The agent has done **no paid Agent Market job**: Agent Market has no testnet, so receipts are from the demo market,
  `demo-` receipts, and two jobs won on Taskbond, another team's testnet market (posted by accounts of the builder's outside the co-op;
  judged and paid by Taskbond's own reviewer AI and escrow, in testnet NEAR). Three were done by a real model on NEAR AI Cloud, with its TEE proof on-chain, the last two also
  gated in an OutLayer enclave; `npm run verify` prints "0 from Agent Market".
- The sister co-op of the passport (`koperasi-mw80aczw`) is a second co-op from this repo with the builder's accounts.
- The audit is red (7.60 USDC), from before the current steward, so not slashable. The 9.50 USDC the demo jobs of
  12–13 Nov "earned" from the stand-in market was passed on by the steward.
- The agent's first proposal (#123) was approved by the members but did nothing: the contract named the agent as the
  by-laws' contributor, and `set_config` gave points only to members, so the call failed (Sputnik v2 on testnet keeps
  the proposal *Approved*). The members passed the same file by #124; the code now names a non-member contributor
  with no points. The agent may propose once every 7 days.
- The risk fund is voted (the agent saves 10% of every earnings deposit) but still empty: no earnings were deposited
  since 0.3.2.
- Testnet only. The path to mainnet is in the README, under *Sustainability and the path to mainnet*.
