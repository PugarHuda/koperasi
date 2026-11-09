# Submission materials (phase 7)

Every number and transaction here can be checked on testnet; see [reports/03-kontrak.md](reports/03-kontrak.md).
The video and the deck must be recorded and made by the builder, because they need a face, a voice and a screen. This
file is the script.

## Demo video script (2:30)

| Time | Screen | Narration |
|---|---|---|
| 0:00–0:15 | hero, "Who controls this AI agent?" | "AI agents earn money. Usually a token decides who controls them, and holders get only a price. A koperasi has run for a century on one member, one vote. Koperasi gives an AI agent the same rules." |
| 0:15–0:40 | section *Don't trust us*: click **Verify with your own nonce** | "Don't trust us. This browser just asked NEAR AI Cloud for an attestation with a nonce it made up, and checked it against Intel's collateral. The model runs in a TEE, and it is the model the members voted." (the table: Verified) |
| 0:40–1:00 | *By-laws* + *No one changes the rules alone* | "The agent's prompt, model and prices are its by-laws. They are pinned by hash, and the contract rejects receipts from any other config. Even the contract's code changes only by vote: there is no full-access key, not even mine." |
| 1:00–1:25 | *Work* and *Audit* | "The agent sells work on Agent Market, and each job leaves a receipt with its inference cost. The audit compares earnings with what reached the treasury, and the steward who holds the market account is bonded." |
| 1:25–2:05 | **06 Tasks & trust** | "Members also pay people for tasks. A newcomer's payout needs another member's approval: here, Bob approved task #0. Carol now has a record, so task #1 was paid the moment Alice accepted it, with no vote. Large tasks are still voted by everyone, like bounty #24, and each point on Carol's record links to the task or proposal it came from. All of it runs on an unmodified Sputnik DAO; Sputnik and Trezu alone can only set one threshold per proposal type." |
| 2:05–2:20 | *Profit shares* + wallet panel | "Profit is shared by rule, and every member sees their part before voting. Savings count only after seven days, so nobody stakes the night before a share. And members don't pay gas: the co-op's relayer does." |
| 2:20–2:30 | closing | "Koperasi. Own the agent that works for you. Built on NEAR: Sputnik DAO, NEAR AI Cloud, Agent Market." |

## Pitch deck outline (8 slides)

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
7. **Validation:** 91 contract tests (unit, fuzz, invariant, a real Sputnik DAO in a local sandbox), 26 unit tests, Playwright on 6 browser/device profiles, `npm run verify` reads every README claim from testnet (CI, daily); tasks #0–#6, bounty #24, profit share #36, upgrades by vote up to #48.
8. **Next:** mainnet with Circle USDC, NEAR AI credits for the organization, independent members, a tighter CSP, a USDC task budget.

## Submission form text

**Social Money.** Koperasi is a member-owned AI co-op on a Sputnik DAO.
- **Collective ownership:** the DAO owns the agent, its by-laws and its code.
- **Shared budget:** the members vote a task budget, and profit shares are split by rule.
- **Programmable rewards:** reserve, savings and contribution points.
- **Reputation-based access:** each contributor's on-chain record decides who must approve their payout:
  - paid on acceptance after the record is earned;
  - one other member for mid-size payouts;
  - a full vote above that, as a normal Sputnik bounty.

  Every point names the task or proposal it came from.
- **No new multisig:** custody stays in Sputnik.
- **Gasless for members:** a NEP-366 relayer pays the gas for members' calls to the co-op (deposits stay the member's).
- **Savings can't be gamed:** a stake counts toward the profit share only after 7 days (security fix S12, upgrade #48 by vote).
- **Evidence:** tasks #0–#6 paid from the treasury by DAO proposals, bounty #24, profit share #36; `npm run verify` checks it all against testnet.

**Autonomous Business.** The agent sells on Agent Market and buys its own inference on NEAR AI Cloud.
- Humans set only the constraints (by-laws: price, caps, kill switch).
- The agent account holds only a function-call key.
- Each job has an on-chain receipt and a public audit.

**Agent Economy.** Bid → deliver → paid. Each job's inference cost comes from NEAR AI Cloud billing, with one receipt
per job, plus a TEE proof that any visitor can verify in their own browser.

## X post (draft)

> Who controls an AI agent that earns money? In Koperasi, its members: one member, one vote, like an Indonesian
> co-op. The agent's prompt, model and prices are by-laws pinned by hash in a @SputnikDAO vote; check its TEE with your
> own nonce in your browser. Small tasks are paid on earned trust, big ones voted by all. Live on @NEARProtocol testnet:
> https://koperasi-kohl.vercel.app #NEARHackathon

## Final checklist

- [x] Repo with README: one-liner and positioning at the top, live demo link, per-track evidence, contract addresses, setup and tests
- [x] Live page: https://koperasi-kohl.vercel.app
- [x] Contract running code chosen by vote, reproducible rebuild = on-chain hash (sha256 `cbe66c30…`, rev `065de9a`, proposal #48)
- [x] CI: lint, typecheck, unit, contract, Playwright, npm audit, `npm run verify` (daily)
- [x] Security rounds 1–3 ([05-security](reports/05-security.md)); S12 fixed on-chain (#48); gasless relayer live in production
- [ ] **Demo video** (builder records it with the script above)
- [x] **Pitch deck**: 9 slides built from the outline above (shared by the builder as a link)
- [ ] **Repo public**: scheduled task on 13 Nov 09:00 WIB (check `.open-repo.log`)
- [ ] **Submission form** before 14 Nov 23:59 UTC (06:59 WIB on 15 Nov)
- [ ] Optional, for a treasury in USDC: Circle faucet → `koperasi-mw4i2iwk.sputnik-v2.testnet`
