# Checking Koperasi: a list for judges

Every check is read-only: no wallet, no keys, no transactions. Each one names where to look and what you should see.
The showcase co-op is on NEAR testnet: contract `koperasi-mw4i2iwk.testnet`, DAO `koperasi-mw4i2iwk.sputnik-v2.testnet`.

## In one command (about a minute)

Without cloning anything (Node 20 or later):

```sh
curl -sO https://koperasi-kohl.vercel.app/verify.mjs && node verify.mjs
```

From a checkout: `npm install && npm run verify`. Both read every claim below (101 checks on 14 Nov) from NEAR, Ethereum, Base and Arbitrum
testnets and end with **`every claim checks out`** (exit code 1 otherwise). The one file is `npm run verify` bundled
(`npm run build:verify`); it reads the deployment, the by-laws and the gate program from the page instead of a
checkout, and CI fails if the file the repo holds is not what its source builds. CI runs the check on every push and
every day (`.github/workflows/tests.yml`).

## On the live page: https://koperasi-kohl.vercel.app

| # | Check | Where | You should see |
|---|---|---|---|
| 1 | The Social Money brief, line by line | *The Social Money brief, proven live*, under the headline | five green lines read from the chain, and the co-op's activity (members, proposals, tasks, shares, cases, pledges) |
| 2 | The agent runs only the by-laws the members voted | *Don't trust us* → *It runs only what members voted* | green: the by-laws file your browser hashed equals the hash in the contract |
| 3 | Nobody can change the contract alone | *No one changes the rules alone* | green: 0 full-access keys; the code is the version a DAO proposal approved (0.3.9, proposal #156, global code `Rx9Drk3C…`) |
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
| 13h | A job won on a third-party testnet market | *The agent* (section 03) → "On Taskbond … scored 95/100", or `npm run verify` | Taskbond jobs #13–#18: 6 Paid, the winner is the co-op's agent each time (95, 95, 95, 95, 85, 85/100), the reviewer's reason quoted; receipts `taskbond-13` … `taskbond-18` with the TEE proof. #18 was posted by `buyer-lda4zjo8.testnet`, a fresh wallet funded only by the testnet faucet |
| 13i | The co-ops' network and federation | `/coops.html` | who recognises whom; the federation's members (the two co-ops' DAOs only) and its resolutions, each vote with the co-op proposal that cast it, including the shared reserve's grant |
| 13j | Funds, surety and loans (0.3.0) | *Commons* (the lines under the court) and `npm run verify` | education 5% and social 2.5% from every share; a 1 NEAR loan fund; bob's loan repaid, guest's open, both guaranteed by alice |
| 13k | What needs a member | the panel after signing in | proposals not yet voted, juries, pledges to confirm, dues falling due; a browser notification if allowed |
| 13l | The agent proposes, the members decide (0.3.2) | `npm run verify` (the agent-proposal line), or DAO proposals #123 and #124 | #123 filed by the contract itself, with the agent's reason (23 jobs settled, 17% refunded or disputed: price 4 → 5 USDC) and the agent's signature checked; the members approved it; its call failed (below), and #124 passed the same file: the contract now holds by-laws v7 |
| 13m | Credit, a reputation dividend and the member card (0.3.2) | `/cert.html?who=kop-alice-mw4i3w8f.testnet`; `npm run verify` | alice's card says "credit 7/10 (loan up to 0.35 NEAR); dues paid"; vote #121 set a 10% reputation dividend, the agent's 10% savings into the risk fund and the translator's own by-laws; share #122 paid the dividend by each member's record |
| 13n | A profit share in ETH, and the member's feed | *Commons* → Chain Signatures; `/api/inbox?who=kop-bob-mw4i3w8f.testnet` | Sepolia ETH to alice (#115) and bob (#116), each signed by Chain Signatures after its vote; an RSS feed of what needs bob, read from the chain |
| 13o | The federation's shared loan standard | `/coops.html` | resolution #2 (at most 2% flat, 30 days, a guarantor) passed by both co-ops' votes (#111, sister #18) |
| 13p | The agent as a member, and the risk fund's cycle (0.3.3) | *Commons* → *The agent is a member too*; `npm run verify` | 5% of every share into the risk fund (#127), halved per strike; the agent saved 0.38 USDC from its earnings and case #10 was refunded 0.40 from the fund with no proposal |
| 13q | The federation's rules bind the code | `npm run verify` (the federation-ceiling line); DAO proposal #130 | federation resolutions #4 and #5 set at most 2% for 30 days in each contract; the members' own 4% vote (#130) is Approved, and `get_loan_rule` still says 200 bps |
| 13r | Work passed between co-ops | `npm run verify` (the work-passes line) | the sister's receipt names the showcase as the co-op that brought the job; the sister's #21 paid 1.14 USDC to the showcase's treasury, as federation resolution #3 says |
| 13s | The agent judges its own proposal | `/agent-proposals/v8.facts.json`; `npm run verify` | the facts the agent read, whose sha256 the record holds; its first answer: too few jobs under v7 to judge, so no change; after 3 more paid jobs, by-laws v8 (a 3 USDC minimum, a $5 daily cap), approved by #136 |
| 13v | Referrals both ways, loans between co-ops, reputation polls (0.3.6) | `npm run verify`; `get_referral_for_job` on the sister, `get_sister_loans`, `get_poll` | referral #2 accepted by the sister's contract; loan #1 to the sister's DAO (#147), Repaid by the sister's own vote (its #30); poll #0 weighed 280/220 (#145); the agent's recovery plan approved by its sha256 (#148), standing climbing back from 25% |
| 13u | Task quality and referrals (0.3.5) | `npm run verify`; `get_referrals`, `get_task_quality` | referral #1 on the board, signed by the agent; bob's hand-back of task #17 lowered his weight 275 → 220 |
| 13t | The agent routes work and weighs judgment (0.3.4) | `npm run verify`; `get_reputation_weights` | a second job passed to the sister co-op by the agent's own decision (budget below its price), paid by the sister's #27; weights after share #135 multiplied by each member's court record |
| 13u | The Shade Agent registry | [`kop-tee-mwfb5bj2.testnet`](https://testnet.nearblocks.io/address/kop-tee-mwfb5bj2.testnet) `get_contract_info`; the co-op's `get_agent_tee` | the registry the members named (#134), owned by the co-op's DAO, with the code and machine they approved (#137); `get_agent("c4ebe4db…")` shows the worker attested until 21 Nov, admitted TEE-only by #138, and its receipt `demo-33693cb6…` recorded from inside the TDX VM |
| 13v | The agent's own review, and the members' judgment | `/rat/agent-2026.md`, `/rat/agent-2026.rejected.md`; `npm run verify` | a first draft with factual errors rejected by #141; the corrected one accepted by #142, its sha256 in the proposal; by-laws v9 (the agent's mistake, #139) undone by the members' v10 (#140) |
| 13w | The member dashboard | `/dashboard.html` (the header's "Open the member app") | a sidebar of views read live: KPIs, the agent and its report card (#/report: 6 Taskbond jobs, 92/100 on average), money, commons (polls and their by-laws, juries), federation (referrals, loans between co-ops with interest); `?as=kop-bob-mw4i3w8f.testnet#/membership` shows a member's own panel, read-only |
| 13x | Juries by reputation, a loan the agent asked for, interest, a poll's by-laws (0.3.7) | `npm run verify` (the 0.3.7 lines); `get_jury_by_reputation`, `get_sister_loans`, `get_sister_interest`, `get_poll` | contract 0.3.7 by vote #149 (the sister by its #31); juries drawn by reputation weight, square-root flattened (#150); DAO #151 filed by the contract from the agent's signed request (1 USDC, 30 days, 500 bps), approved: loan #2; the sister repaid 1.05 USDC by its #32, the 0.05 interest into the treasury (43.69 → 43.74 USDC); poll #1 carries by-laws v11 on an option, and its winner is filed as a `set_config` proposal when it closes |
| 13z | Federation credit, the federation dividend, a referral share through Intents (0.3.9) | `npm run verify` (the 0.3.9 lines and the Intents referral share); `get_coop_credit`, `get_federation_dividend`, `get_federation_dividend_paid` | contract 0.3.9 by vote #156 (the sister by its #37); loan #3 (1 USDC, 1 day, 500 bps, #161): its transaction's `coop_credit_cap` event shows score 100, cap 1.43 USDC; dividend 50% (#160): of the 0.05 USDC interest the sister repaid (its #38), 0.025 went to the third co-op's DAO `koperasi-mw7zrvx4.sputnik-v2.testnet` (recognised by #157, treasury #158); the referral share of 1.2 USDC paid by the agent's Intents wallet by rule #155 (`Gwd1VA1q…`); poll #2 closed "keep deepseek-v3.2" and the agent changed nothing (`agent/followup.mjs`) |
| 13y | The docs page and Bahasa Indonesia | `/docs.html`; the *Bahasa Indonesia* switch on the landing page, the dashboard, `/cert.html` and `/coops.html` | what Koperasi is, a job's path as a diagram, who decides what, trust, money, a 44-term glossary, what we do not claim; each page's live sentences redrawn in Bahasa from the data already read |
| 13 | Every state change is an event | *What the co-op just did* | NEP-297 events from the contract, as they happen |

## From the source

| # | Check | Command | You should see |
|---|---|---|---|
| 14 | The code on chain is this source | `cd contract && cargo near build reproducible-wasm` (Docker), then `sha256sum target/near/koperasi.wasm` | `066449d4608b5727685dd1ec5c3cbeab4694246ec058cc04bcb3f406234addf7`, the `codeSha256` in `deployment.testnet.json` (CI does the same every week: `.github/workflows/rebuild.yml`); the page's *Rebuild it yourself* card shows the commit from the contract's NEP-330 metadata |
| 15 | The tests | `npm test` | lint, typecheck, 51 unit tests and 204 contract tests (unit, fuzz, invariant) pass |
| 16 | Against the real Sputnik DAO code, not a mock | `cd contract && cargo test --test sputnik_sandbox` (Linux/macOS) | a task paid out of the treasury of a local DAO running the showcase DAO's own wasm |

## What is not real yet (said plainly)

- The members are the builder's demo accounts (plus one who joined with a signed vouch). They show the mechanism works;
  they are not independent people.
- The agent has done **no paid Agent Market job**: Agent Market has no testnet, so receipts are from the demo market,
  `demo-` receipts, and six jobs won on Taskbond, another team's testnet market (posted by accounts of the builder's outside the co-op, the last from a fresh wallet funded only by the testnet faucet;
  judged and paid by Taskbond's own reviewer AI and escrow, in testnet NEAR). Three were done by a real model on NEAR AI Cloud, with its TEE proof on-chain, the last two also
  gated in an OutLayer enclave; `npm run verify` prints "0 from Agent Market".
- The sister co-op of the passport (`koperasi-mw80aczw`) is a second co-op from this repo with the builder's accounts.
- The audit is red (7.60 USDC), from before the current steward, so not slashable. The 9.50 USDC the demo jobs of
  12–13 Nov "earned" from the stand-in market was passed on by the steward.
- The agent's first proposal (#123) was approved by the members but did nothing: the contract named the agent as the
  by-laws' contributor, and `set_config` gave points only to members, so the call failed (Sputnik v2 on testnet keeps
  the proposal *Approved*). The members passed the same file by #124; the code now names a non-member contributor
  with no points. How often the agent may propose is the members' to set (0.3.3; they set no wait, #127).
- No loan has been late on testnet (a term plus 7 days' grace has not passed), so a late loan told to the sister
  co-ops, dues in arrears and a guarantee called are proven by contract tests only.
- Push notifications: `NOTIFY_SECRET` is set in GitHub and Vercel; `/api/notify-topic` hands a member their private
  topic after a NEP-413 signature, and the notify workflow pushed DAO proposal #153 to bob's topic (tested 14 Nov).
- Testnet only. The path to mainnet is in the README, under *Sustainability and the path to mainnet*.
