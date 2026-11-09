# 09 · Improvements toward the top 3 in Social Money (8 Nov 2026)

Builds on [05-keamanan](05-keamanan.md) and [06-qa](06-qa.md). Priorities came from an honest comparison with the
strongest projects in the track, scored against the judging criteria (technical, design, impact, originality,
sustainability). That comparison is internal and not committed. Its conclusions:

1. Our trust tiers held the budget **outside** the DAO; the strongest entries pay from the Sputnik treasury itself.
2. Judges could not check our claims in one command.
3. Two members could collude to make each other "trusted".

The builder approved the contract change (rule 7: contract architecture).

## What changed

| # | Change | Criterion | Evidence |
|---|---|---|---|
| 1 | **`npm run verify`** (`scripts/verify.mjs`): read-only; checks every README claim about the showcase against testnet and finds the vote behind each one itself, instead of trusting a number in the README. CI runs it on every push and daily (`tests.yml`, job `chain`). | Sustainability, reproducibility | `every claim checks out`; commit `6648e05` |
| 2 | README opens with **"Check it in 2 minutes"** (do X, see Y), plus [`docs/MULAI.md`](../MULAI.md) in Bahasa Indonesia. | Design | commit `6648e05`, `d7afa28` |
| 3 | **Payouts from the treasury through a scoped DAO role.** The contract holds role `tasks` (`transfer:AddProposal`, `transfer:VoteApprove`, nothing else). Each payout is a Transfer proposal it files and approves itself under the members' rule, so the money never leaves the DAO before a payout and every payout is a DAO proposal. | Technical, track fit | showcase #26 (contract-held 0.87 NEAR back to the treasury), #27 (code), #28 (rule v2, 1 NEAR budget), #29 (role) |
| 4 | **Collusion:** trust counts **different** posters (and the DAO for voted bounties); each poster pays with no vote at most `poster_daily_auto` a day. | Technical, security | contract test `two_friends_cannot_make_each_other_trusted…`, `a_poster_pays_with_no_vote_only_up_to_the_daily_limit` |
| 5 | **Trust → pay → profit share:** a member's finished task earns contribution points, which weigh the profit share. | Originality | task #2: bob 5 → 10 points |
| 6 | **Security review of #27**, three fixes (#32), then a second review, two more fixes (#33): see below. | Technical | test co-op `koperasi-mw80aczw`, proposal #5; showcase task #4 (#34) |

## Security review of #27 (automated review, then checked on testnet)

| Finding | Real? | Fix in #32 | Proof |
|---|---|---|---|
| Points inflation: two members post many tiny tasks, each worth the full points | **Yes** | Points = `points × amount / one_vote_max`, floored. A 0.05 NEAR task earns 0 of 5; points grow only as fast as the treasury pays. | test `a_member_who_finishes_a_task…` (0.05 → 0, 0.5 → 5, 0.2 → 2) |
| Status read too early / fail-open | **Yes, in another form.** The receipts of approve_task #2 show that act_proposal returns the transfer's promise, so the read is not early. But testnet's Sputnik has no `on_proposal_callback`, so **a bounced transfer stays Approved**. | The contract reads the result of the transfer promise that act_proposal returns: Approved without a successful transfer is not counted. | test co-op proposal #5: contributor account deleted, transfer `AccountDoesNotExist`, proposal **Approved**, task **Cancelled**, budget unchanged, no record |
| A failed payout accepted again | Partly. A Failed transfer does not run twice, but a payout the members **rejected** could be refiled and self-approved by the contract. | Rejected, Removed, Expired, Failed, or a bounced transfer → task **Cancelled**. Only an add_proposal that failed (nothing filed) returns to Submitted. | test `…is_not_filed_again` |
| (review 2) `settle_task` in the middle of the contract's own chain could read Approved before the transfer's result and count a bounced payout | **Yes** | Key `inflight:<id>` from `pay` until the check; `settle_task` refuses while it is set (#33) | test `a_payout_still_open…` |
| (review 2) points above `points` if the members lower `one_vote_max` after a task is posted | **Yes** | `min(points)` (#33) | test: 0.5 NEAR task after one_vote_max fell to 0.001 → 5 points, not 2,500 |
| (review 2) budget refunded when the act_proposal chain fails although the transfer happened | **No.** The promise act_proposal returns is the transfer receipt itself (receipts of #30); if act_proposal panics, its state reverts and the proposal stays InProgress (the "wait" branch, not a refund) | – | receipts of approve_task #2 |

## Transactions (testnet)

| What | Tx / proposal |
|---|---|
| Test co-op `koperasi-mw7zrvx4`, approved by another member, paid from the treasury | DAO proposal #3, `approve_task` [FLfT1UTA…](https://testnet.nearblocks.io/txns/FLfT1UTA7mmiz9T5FwrSm7GYLjJCUuk3uaYs1ppXaF2H) (22.2 Tgas) |
| Same, on earned trust with no vote | DAO proposal #4, `accept_task` [2rBCUATR…](https://testnet.nearblocks.io/txns/2rBCUATRnRYf5Yq3fPAMe7SeR3Sey29jLe4dR1DPok4Z) (17.7 Tgas) |
| Showcase task #2: Bahasa Indonesia quick start, by bob (member), approved by the steward | DAO proposal #30, [DdZhNN31…](https://testnet.nearblocks.io/txns/DdZhNN31dMoicn76bpqR9iQcpgwnGVVbf8jCg4W3Czpp); bob +5 points (under #27's flat rule) |
| Showcase task #3: `scripts/verify.mjs`, by carol, on earned trust | DAO proposal #31, [7QbPcRmd…](https://testnet.nearblocks.io/txns/7QbPcRmdx6tTYrXsCdwKJrJthCEZvqQNTbbChc9JhNK7) |
| Bounce test (test co-op `koperasi-mw80aczw`) | DAO proposal #5, `approve_task` [BpccRtdt…](https://testnet.nearblocks.io/txns/BpccRtdtAakvzAakvyxMZCmAFPPsWneMfz53FgWhXXL9): task Cancelled |
| Showcase task #4: report 09, by bob, on earned trust under #33 | DAO proposal #34; bob 10 → 11 points (5 × 0.1 / 0.5) |
| Upgrades by vote | #27 `C17FHkdu…`, #32 `AK4hrshT…`, #33 `GjJjx49G…`, #35 `GtB4Dk9J…` (sha256 `ebfb4b82…`, stuck payouts unstick after an hour), 0 full-access keys |

## Tests

- **Contract:** 74 passed (73 at #33, plus the stuck-payout test of #35). 13 task tests were rewritten for the DAO path; new: different posters, daily limit, points, the DAO said no, a payout still open, a bounced transfer.
- **Unit:** 14 passed. `trustSources` in `web/share.js` mirrors the contract.
- **E2E** (`trust`, `page`, `checks` × desktop, firefox, iphone):
  - Parallel run: 95 passed. 3 failed and 4 were flaky, all on desktop from public-RPC 429s.
  - The same 9 desktop tests run serially: 9/9 passed.
- **`npm run verify`:** every claim checks out.

## What still needs the builder (it cannot be faked)

1. ~~Circle USDC in the treasury~~: done, profit share #36, bob claimed 4.33 USDC.
2. NEAR AI credits (NEAR Builders, Q-000): one real Agent Market job with an on-chain proof.
3. **Independent members:** every demo account is held by the builder, and the README says so. 3–5 people joining from the page would move Impact the most.
4. The demo video and the X post (Q-012); submit with Social Money and Autonomous Business as tracks.

## Known limits

- **A payout the members approve by hand** (only possible if the contract's own vote failed) is taken as moved when `settle_task` reads it. Their own vote transaction shows the transfer.
- **Three colluding members** (poster, approver, contributor) can still pay a friend up to `one_vote_max`. The amount is capped by the budget the members voted, and the points follow the pay.
- **The payout bond** (0.1 NEAR) is fronted from the contract's balance and returned on approval. A bond the DAO keeps after a rejection comes out of the contract's balance.
