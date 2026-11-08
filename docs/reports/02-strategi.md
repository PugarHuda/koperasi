# 02 · Strategy and differentiation (Hackathon Strategist), 8 Nov 2026

Builds on [01-audit](01-audit.md). The full competitor analysis, with sources, is in [README › Prior art](../README.md#prior-art-and-what-is-different).
This report covers what changed this round.

## Scorecard (self-assessment, 1–10)

| Criterion (track brief) | Before | After | What it took |
|---|---|---|---|
| Social Money: collective ownership, shared budgets | 9 | 9 | the DAO owns the agent and the treasury |
| Social Money: programmable rewards | 8 | 9 | profit share by rule, plus tasks paid by tier from a voted budget |
| Social Money: reputation-based access | 4 | 9 | task tiers by an on-chain record ([03-kontrak](03-kontrak.md)) |
| Sputnik/Trezu without rebuilding the multisig | 8 | 9 | the tiers sit beside an unmodified Sputnik DAO; large tasks are still Sputnik bounties |
| Autonomous Business / Agent Economy | 7 | 7 | blocked by NEAR AI credits and Agent Market having no testnet |
| Demo with real transactions | 8 | 9 | three tiers, proven by testnet transactions |

Why reputation is not a 10: the trust rule is still the members' choice, and two colluding members can still pay each
other up to `one_vote_max` from the budget (known issue, [05-keamanan](05-keamanan.md)).

## Social Money checklist (the brief's sample prompt)

- [x] Custody and approvals stay with the existing DAO; no new multisig. The budget is voted by Sputnik proposal #22, and large tasks are Sputnik bounties.
- [x] Reputation tied to named accounts, and every point traceable to a finished task: `refs` such as `task:1` or `dao-proposal:24`.
- [x] Tiers:
  - small tasks auto-approve for trusted contributors (task #1);
  - mid-size tasks need one member (task #0, approved by bob);
  - large tasks are a normal DAO proposal (bounty #1, proposal #24).
- [x] A public board showing open tasks, claims, payouts and each contributor's record (section 06 of the page).

## Approval flows that already existed vs what we added (from the source code)

- **Sputnik v2** (`policy.rs`, `bounties.rs`):
  - vote policy per role × proposal kind, with a fixed threshold (`Weight`) or a ratio;
  - built-in bounties: `add_bounty` → `bounty_claim` (bond) → `BountyDone` (a proposal) → payout;
  - **no thresholds by amount**, and **no automatic approval**.
- **Trezu:** Requestor / Finance / Governance roles, one Finance threshold, one voting period. No bounties and no reputation.
- **What we added:** amount tiers, a record-based gate, a NEAR budget capped by vote, and counting DAO bounties on the record.

## Competitors for this feature

| | Reputation | Who pays | On-chain and traceable | Weakness |
|---|---|---|---|---|
| Sputnik bounties | none | the whole DAO, every time | yes | every payout is a full vote |
| Trezu | none | Finance threshold | yes | one threshold for every size |
| [Dework XP (DIA DAO)](https://forum.diadata.org/t/gdp-011-proposing-a-rank-system-for-dia-dao-contributors/450) | XP and ranks | admin, by hand | no (off-chain) | the rank does not change who approves payment |
| [Pocket PEP-42](https://forum.pokt.network/t/pep-42-reward-and-decentralise-rad/3397) | trust thresholds | DAO | partly | trust only unlocks self-assignment |
| [Zodiac Roles (HAI)](https://www.tally.xyz/gov/hai/proposal/71232920685128172221431433589301790868107413093536771388303049247330839170330) | none | role holder, from an allowance | yes | the limit belongs to an address, not to an auditable record |

- **Parity:** bounties and bonds (Sputnik).
- **Gap we fill:** a payout threshold that follows an on-chain record, where every point names its source, on top of an unmodified Sputnik DAO.

## Positioning

> For small communities that want to own the AI agent working for them, Koperasi is a member-owned AI co-op on NEAR
> where one member, one vote pins the agent's mind by hash, every visitor can verify the TEE with their own nonce, and
> contributors earn the right to be paid without a vote, task by task. Token-launched agents leave control with large
> holders, and DAO bounty tools make every payout a full vote.

## Features: decision

| Candidate | Score impact | Competitors have it? | Effort | Decision |
|---|---|---|---|---|
| Task tiers by earned trust (contract + page + script) | high (track brief) | no (see table) | ~6 h | **BUILD** |
| Pay tasks in USDC | medium | Sputnik yes | 2 h, but the treasury has no USDC | NO for now: the faucet needs a captcha; NEAR is real and testable |
| near.social announcements | low | – | 2 h | NO: off the scoring path |
| CSP header | security | – | risk of breaking the wallet and the TEE check | NO, documented |

**Specification for "tasks with earned trust":**
- **User story:** "As a member, I post a 0.05 NEAR task; once a contributor has proven themselves, I pay them by
  accepting the work, without a meeting."
- **Flow:** `post_task` → `claim_task` → `submit_task` → `accept_task`, which pays at once (trust) or goes to
  `approve_task` (one other member, read from the DAO policy) → `on_task_paid` → record. Large tasks go through a
  Sputnik bounty, then `credit_dao_bounty`.
- **Acceptance criteria:** the unit tests in [03-kontrak](03-kontrak.md), the three tiers proven on testnet, and the board plus panel tested in Playwright.

## Copy for the first 10 seconds

- A sixth step in the hero loop: "Earn trust: finished tasks build a record; small payouts then need no vote."
- A "Tasks" nav link, and section 06 "Trust is earned, task by task." with the three tiers taken from the chain.
