# Submission materials (phase 7)

Every number and transaction here can be checked on testnet; see [reports/03-contract-8nov.md](reports/03-contract-8nov.md).
The video and the deck must be recorded and made by the builder, because they need a face, a voice and a screen. This
file is the script.

## Demo video script (the 2:03 cut; the full video is 4:27)

| Time | Screen | Narration |
|---|---|---|
| 0:00–0:15 | hero, "Who controls this AI agent?" | "AI agents earn money. Usually a token decides who controls them, and holders get only a price. A koperasi has run for a century on one member, one vote. Koperasi gives an AI agent the same rules." |
| 0:15–0:40 | section *Don't trust us*: click **Verify with your own nonce** | "Don't trust us. This browser just asked NEAR AI Cloud for an attestation with a nonce it made up, and checked it against Intel's collateral. The model runs in a TEE, and it is the model the members voted." (the table: Verified) |
| 0:40–1:00 | *By-laws* + *No one changes the rules alone* | "The agent's prompt, model and prices are its by-laws. They are pinned by hash, and the contract rejects receipts from any other config. Even the contract's code changes only by vote: there is no full-access key, not even mine." |
| 1:00–1:25 | *Work* and *Audit* | "The agent sells work on Agent Market, and each job leaves a receipt with its inference cost. The audit compares earnings with what reached the treasury, and the steward who holds the market account is bonded." |
| 1:25–2:05 | **06 Tasks & trust** | "Members also pay people for tasks. A newcomer's payout needs another member's approval: here, Bob approved task #0. Carol now has a record, so task #1 was paid the moment Alice accepted it, with no vote. Large tasks are still voted by everyone, like bounty #1 (paid by proposal #24), and each point on Carol's record links to the task or proposal it came from. All of it runs on an unmodified Sputnik DAO; Sputnik and Trezu alone can only set one threshold per proposal type." |
| 2:05–2:20 | *Profit shares* + wallet panel | "Profit is shared by rule, and every member sees their part before voting. Savings count only after seven days, so nobody stakes the night before a share. And members don't pay gas: the co-op's relayer does." |
| 2:20–2:30 | closing | "Koperasi. Own the agent that works for you. Built on NEAR: Sputnik DAO, NEAR AI Cloud, Agent Market." |

## Pitch deck outline (9 slides)

1. **Problem:** agents earn money, holders get a price but no say; DAO bounties make every payout a full vote.
2. **Solution:** an AI co-op where one member, one vote holds the agent's by-laws, and trust is earned on-chain.
3. **Live demo:** the link plus three screenshots: TEE verified, the trust tiers, the audit.
4. **Differentiators** (README, five points): verify the TEE yourself; rules nobody changes alone; a share preview; an audited steward; trust earned on Sputnik.
5. **Architecture:** the diagram in the README (`members ── Sputnik DAO ── treasury`, contract, agent, NEAR AI Cloud).
6. **Sponsor integrations:**
   - Sputnik DAO (policy, proposals, bounties);
   - NEAR AI Cloud (TEE, billing);
   - Agent Market;
   - global contracts.
7. **Validation:** 150 contract tests (unit, fuzz, invariant, a real Sputnik DAO in a local sandbox), 40 unit tests, 19 attacks sent to the live co-op and refused on-chain, Playwright on 6 browser/device profiles, `npm run verify` reads every README claim from testnet (CI, daily); tasks #0–#6, bounty #24, profit shares #36 and #51 (filed from a Trezu template), the bonded steward #54, by-laws v4 #55, a member who joined with an NEP-413 signed vouch #56, the DAO's Ethereum address signing by vote through Chain Signatures #57, upgrades by vote up to #76 (0.2.7), the steward's 90-day term #59, a co-op court case upheld by a random jury and refunded from the treasury #60, a member's pledge kept, a 10-minute veto window on no-vote payouts #62 (task #7 released after it, #64; task #8 vetoed by a member and approved by another, #63); tasks #9–#15 in every state, court cases #1–#2 not upheld, profit share #67 claimed, #68 rejected by the members. The DAO pays on Ethereum by vote (Chain Signatures, #74, landed on Sepolia), owns the agent's NEAR Intents wallet with a members-only policy (Tidepool testnet Agent API, #72–#73), and the agent checks its by-laws in an Intel TDX enclave through OutLayer before every job. Contract 0.2.7: a dismissed court case appealed to every member (#77 overturned, #78 kept), payouts routed to each member's chain of choice with the Intents wallet's policy changed by vote (#80), work records as non-transferable NEP-171 tokens, and an Ethereum payment filed from a Trezu template (#81, sent to Sepolia). Checklist for judges: JUDGE.md.
8. **Next:** mainnet with Circle USDC, NEAR AI credits for the organization, independent members, a tighter CSP, a USDC task budget.

## Submission form text (14 Nov; paste as is)

**One line.** Koperasi is an Indonesian village co-op, on NEAR, that owns an AI agent: one member one vote, every rule
on-chain, every claim checked from the chain in one command (`curl -sO https://koperasi-kohl.vercel.app/verify.mjs && node verify.mjs`).

**Social Money (main track).** Collective ownership, shared budgets, programmable rewards and reputation-based access,
built on an unmodified Sputnik DAO (no new multisig):
- **Earned trust:** small payouts go to contributors other members already paid, after a 10-minute veto window;
  mid-size payouts need one other member; large ones are a full vote. Every point names its task or proposal.
- **Reputation that pays and travels:** part of every profit share is split by each member's record (work done,
  pledges kept, juries served), decaying so recent work counts most, and weighed by how their judgments held up in the
  co-op court. A non-transferable NEP-171 card shows the record, the credit score and the loan it allows, live. Sister
  co-ops recognise each other's records and credit (the passport).
- **A federation whose rules bind the code:** a secondary co-op whose only members are co-ops' DAOs, each voting by its
  own members' decision. Its resolutions set the loan ceiling inside each co-op's contract: when the members voted 4%
  loans, the contract refused it (#130). A late loan is told to the sister co-ops, like a credit bureau owned by the
  co-ops.
- **The co-op's whole life, from Indonesian co-op law (Law 25/1992):** profit shares by savings and work, an education
  and a social fund, mandatory dues, members standing surety for each other, savings and loans with credit from the
  record, an annual members' meeting whose report the agent writes in a TEE, pledges of work, and a court drawn at
  random with evidence from both sides and appeal to every member.
- **Proof:** contract 0.3.4 upgraded only by vote (#133), 0 full-access keys, rebuilt byte for byte from source; 164
  contract tests; 19 attacks sent to the live co-op, all refused on-chain; `verify` checks 77 claims.

**Autonomous Business / Agent Economy.** The DAO owns the agent, and the agent is a member that answers for itself:
- **What it may do:** its prompt, model, prices and markets are by-laws pinned by hash, checked in an Intel TDX enclave
  (OutLayer) before every job, the work done on a TEE-verified model.
- **It proposes, the members decide:** it read its record (17% refunded or disputed) and proposed a higher price; the
  contract filed the proposal, the members passed it (by-laws v7). Its next look, with the model in a TEE, proposed
  nothing: too few jobs to judge the last change; after 3 more paid jobs it wrote by-laws v8 itself (#136). Its runtime
  does this by itself. It also errs: v9 cut the price from a wrong average, and the members undid it (#140). At the
  members' meeting it writes its own review; the members rejected a draft with factual errors (#141) and accepted the
  corrected one (#142).
- **It pays for its own mistakes:** it saves 10% of its earnings and gets a share of the surplus, halved per case lost
  in court, into a risk fund that refunded a buyer at once when a jury upheld a case (#10), with no vote needed.
- **It trades with other co-ops' agents:** a job below its members' price went, by its own decision, to the sister
  co-op whose voted price fit; that agent did it and paid the 30% the federation set (#27).
- **Judged by others:** 3 jobs won on Taskbond, another team's testnet market, 95/100 each.
- **Who can stop it:** the court suspended it after three upheld cases and the members reinstated it (#100).
- **Shade Agent, live:** a worker in a Phala TDX VM, its key made in the TEE, had its attestation verified on-chain
  (dcap-qvl) by a registry the co-op's DAO owns, against the code and machine the members approved (#137); admitted
  TEE-only (#138), it passed the by-laws gate in an enclave and recorded its receipt from inside the TEE.

**Honest limits.** The members and buyers are the builder's testnet accounts; Agent Market and NEAR Intents have no
testnet (the Intents wallet runs on Tidepool's mirror); no loan has been late on testnet yet (the grace is 7 days), so
late loans told to sister co-ops are proven by contract tests.

## X post (draft, a thread of 3; attach the video to the first)

**1/3**

> This AI agent is owned by a village co-op. Its members vote its prompt and can suspend it in court.
> It proposes its own price rises, saves for its own mistakes, and passes jobs it can't take to a sister co-op's agent.
> 
> Koperasi: an AI agent owned by a co-op, one member one vote, every rule on @NEARProtocol. Built for #NEARHackathon (Social Money).
> 
> 🎥 [video]
> https://koperasi-kohl.vercel.app

**2/3**

> How it works:
> • the agent's prompt, model and prices are by-laws pinned by hash in a Sputnik DAO vote
> • small tasks are paid on earned trust, after a 10-min veto window
> • big ones go to every member
> • disputes go to 3 members drawn at random

**3/3**

> Don't trust us: the page checks it in your browser. 0 full-access keys on the contract, code rebuilt byte for byte from source, the model's TEE attested against your own nonce.
> 
> Or run `npm run verify`: it reads every claim from the chain.
> 
> github.com/PugarHuda/koperasi

## Final checklist

- [x] Repo with README: one-liner and positioning at the top, live demo link, per-track evidence, contract addresses, setup and tests
- [x] Live page: https://koperasi-kohl.vercel.app
- [x] Contract running code chosen by vote, reproducible rebuild = on-chain hash (sha256 `1141653d…`, 0.3.4, proposal #133; CI rebuilds it weekly)
- [x] CI: lint, typecheck, unit, contract, Playwright, npm audit, `npm run verify` (daily)
- [x] Security rounds 1–14 ([05-security](reports/05-security.md)); 19 attacks refused on-chain, re-sent weekly in CI
- [x] **Demo video**: `video/out/koperasi.mp4` (4:27) and the 30-second opening `video/out/intro30.mp4`; attach the 30-second one to the X post
- [x] **Pitch deck**: 9 slides built from the outline above (shared by the builder as a link)
- [x] **Repo public** (since 12 Nov)
- [ ] **Submission form** before 14 Nov 23:59 UTC (06:59 WIB on 15 Nov)
- [x] Treasury in USDC (Circle testnet), the audit square: demo-job earnings passed on by the steward
