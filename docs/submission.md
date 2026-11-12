# Submission materials (phase 7)

Every number and transaction here can be checked on testnet; see [reports/03-kontrak.md](reports/03-kontrak.md).
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
7. **Validation:** 133 contract tests (unit, fuzz, invariant, a real Sputnik DAO in a local sandbox), 35 unit tests, Playwright on 6 browser/device profiles, `npm run verify` reads every README claim from testnet (CI, daily); tasks #0–#6, bounty #24, profit shares #36 and #51 (filed from a Trezu template), the bonded steward #54, by-laws v4 #55, a member who joined with an NEP-413 signed vouch #56, the DAO's Ethereum address signing by vote through Chain Signatures #57, upgrades by vote up to #75 (0.2.6), the steward's 90-day term #59, a co-op court case upheld by a random jury and refunded from the treasury #60, a member's pledge kept, a 10-minute veto window on no-vote payouts #62 (task #7 released after it, #64; task #8 vetoed by a member and approved by another, #63); tasks #9–#15 in every state, court cases #1–#2 not upheld, profit share #67 claimed, #68 rejected by the members. The DAO pays on Ethereum by vote (Chain Signatures, #74, landed on Sepolia), owns the agent's NEAR Intents wallet with a members-only policy (Tidepool testnet Agent API, #72–#73), and the by-laws gate also ran in an Intel TDX enclave through OutLayer. Checklist for judges: JUDGE.md.
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
- **Savings can't be gamed:** a stake counts toward the profit share only after 7 days of daily readings (security fix S12, upgrades #48 and #50 by vote).
- **Invite links:** a member shares a link; the newcomer's proposal names them, shown as vouched once they vote for it.
- **Evidence:** tasks #0–#6 paid from the treasury by DAO proposals, bounty #24, profit share #36; `npm run verify` checks it all against testnet.

**Autonomous Business.** The agent sells on Agent Market and buys its own inference on NEAR AI Cloud.
- Humans set only the constraints (by-laws: price, caps, kill switch).
- The agent account holds only a function-call key.
- Each job has an on-chain receipt and a public audit.

**Agent Economy.** Bid → deliver → paid. Each job's inference cost comes from NEAR AI Cloud billing, with one receipt
per job, plus a TEE proof that any visitor can verify in their own browser.

## X post (draft, a thread of 3; attach the video to the first)

**1/3**

> This AI agent has 5 owners, and it cannot pay anyone they did not agree to.
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
- [x] Contract running code chosen by vote, reproducible rebuild = on-chain hash (sha256 `c50989e8…`, rev `8d0de11`, proposal #75; CI rebuilds it weekly)
- [x] CI: lint, typecheck, unit, contract, Playwright, npm audit, `npm run verify` (daily)
- [x] Security rounds 1–3 ([05-security](reports/05-security.md)); S12 fixed on-chain (#48); gasless relayer live in production
- [x] **Demo video**: `video/out/koperasi.mp4` (4:27, rendered from `video/`); attach it to the X post
- [x] **Pitch deck**: 9 slides built from the outline above (shared by the builder as a link)
- [ ] **Repo public**: scheduled task on 13 Nov 09:00 WIB (check `.open-repo.log`)
- [ ] **Submission form** before 14 Nov 23:59 UTC (06:59 WIB on 15 Nov)
- [ ] Optional, for a treasury in USDC: Circle faucet → `koperasi-mw4i2iwk.sputnik-v2.testnet`
