# Koperasi

**A shared treasury for a community that owns an AI agent, built on an unmodified Sputnik DAO.
One member, one vote. Small payouts on earned trust, large ones by vote. Profit shared by a rule everyone voted.**

A group that pools money gets the same vote for a 5 USDC tip as for a 5,000 USDC grant. So every small payment
waits for a quorum, or one person starts paying out of pocket and settling later. And when the money comes from work
done for the group (here, an AI agent's work), only the person running it can see where it went.

Indonesian villages have solved this for a century with the *koperasi* (co-operative): the members own the
business, every member has one vote, and profit is shared by savings and by contribution. Koperasi puts those rules on NEAR:

- **The money never leaves the Sputnik treasury without a proposal.** The contract holds a DAO role, `tasks`, that may
  only file and approve `Transfer` proposals, and only under the rules below (small payouts it files and approves
  with no member's vote). There is no second wallet and no new multisig. Task payouts are in NEAR, profit shares in USDC.
- **Trust is earned, and it decides who has to vote.** A contributor that another member already paid (never the poster
  alone: a member cannot vouch for someone and then pay them with no vote) is paid when the poster accepts, up to a
  small limit a day. Mid-size tasks need one other member, and large ones go to every member as a DAO bounty.
  Every point on a record links to the task or proposal it came from.
- **Profit is shared by rule.** The members vote a split (reserve, savings, contribution). The contract divides
  each payout to the last USDC unit, and each member claims their own share.
- **The business is an AI agent the members steer.** Its prompt, model, prices and spend caps are by-laws hashed
  on-chain, and they change only by vote. The model's TEE is re-verified within the hour before each job, and any visitor can check it with their own nonce.
- **The person in the middle is bonded and audited.** The steward who collects the agent's earnings must pass them on.
  The audit is public. The members can slash the steward's bond by vote, and anyone can slash it once a paid job's
  earnings are more than 7 days late (`slash_overdue`).

Built at NEAR HACKATHON (Nov 2026). Main track: **Social Money**. Also Autonomous Business and Agent Economy.

| The live page: who controls the agent, read from the DAO | Tasks paid from the treasury, by earned trust or by vote |
|---|---|
| [![Who controls this AI agent](docs/img/page-top.png)](https://koperasi-kohl.vercel.app) | [![Tasks and trust](docs/img/page-trust.png)](https://koperasi-kohl.vercel.app/#trust) |

## Every claim, its evidence, and the check that reads it

Testnet. `npm run verify` (read-only, no keys) reads each row from the chain and prints PASS or FAIL; the last column
quotes its line.

| Claim | On-chain evidence | `npm run verify` line |
|---|---|---|
| The members own the co-op, one vote each | DAO [`koperasi-mw4i2iwk.sputnik-v2.testnet`](https://testnet.nearblocks.io/address/koperasi-mw4i2iwk.sputnik-v2.testnet): role `member`, RoleWeight, threshold 1/2 | *every member in the contract holds role `member`*; *one member, one vote* |
| No role can act alone | `member` votes, `tasks` only files and approves transfers, outsiders only file proposals (with a bond) | *no role can act alone* |
| The agent runs only by-laws the members voted | v3 by proposal #7 (a member found v2's model was not served), v4 by #55 (the steward's handover); the agent runs only `4e28de45…` | *the agent's by-laws … are the ones the members voted* |
| Nobody can change the code alone, the builder included | [`koperasi-mw4i2iwk.testnet`](https://testnet.nearblocks.io/address/koperasi-mw4i2iwk.testnet): 0 full-access keys; upgrades only by vote, now #53 | *the contract runs the global contract the members voted*; *nobody holds a full-access key* |
| The agent can only record receipts | `agent.koperasi-mw4i2iwk.testnet`: one function-call key, `record_receipt` / `update_receipt` | *the agent account has only function-call keys …* |
| Small payouts on earned trust, from the treasury itself | Task #2 needed another member (#30); #3 and #4 paid on trust, no vote (#31, #34); #5, #6 (#44, #45). Each a DAO `Transfer` the contract filed | *task #n was paid from the treasury by DAO proposal #m, filed by the contract*; *the trust tiers were voted* |
| Every point on a record names its source | carol 5 tasks, bob 2, the steward 1, each linked to a task or a DAO bounty | *…'s record: n finished, each traced to its source* |
| Profit is shared only by a members' vote, split by the contract | #36: 10 Circle testnet USDC to 4 members; bob claimed his 4.33 in [Cq25VUHM…](https://testnet.nearblocks.io/txns/Cq25VUHME68yfVZDM7ZxdKnjHttHtBhSUF6GXHhsCzxd); #51 filed from a [Trezu](trezu/README.md) form | *the members voted every profit share out of the treasury* |
| The person in the middle is bonded | Appointed by vote #54 under contract 0.2.3, 1 NEAR bond [k6MzrgXV…](https://testnet.nearblocks.io/txns/k6MzrgXVf9E8styeNa5zNoYryY9aLCPvAqoPV1waFKZ); anyone can slash it once a paid job's earnings are 7 days late | *the steward was appointed by a vote and is bonded* |
| Anyone can join and leave; a member can vouch with a signature | `kop-guest-984702.testnet` asked from the page and was voted in (#8); `vouched-mwa7jwhw…` asked with alice's **NEP-413 signed vouch**, which every member's browser checks against alice's full-access key before voting ([screenshot](docs/img/signed-vouch.png)), and was voted in (#56, [joined](https://testnet.nearblocks.io/txns/CEPs9FH7U7Ng9wQowsWYoGQgYRvDELFc4BpRnPDdYpCf)); `kop-leaver-mw8pw94w.testnet` left with its deposit in [pH35xFRx…](https://testnet.nearblocks.io/txns/pH35xFRxjKWxqwGhJ4VXzL3mvphTQDxAvNF7R1wruzV) | (page flows; E2E tests) |
| Members pay no gas | NEP-366 relayer, calls without a deposit: [7pziyP7a…](https://testnet.nearblocks.io/txns/7pziyP7aXe8aKMKKRSWo18dfCpAhTaHtHc2vTJsNmdBN) | (unit tests of `api/relay.mjs`) |
| The model runs in a TEE, checkable by you | Intel TDX + NVIDIA attestation, re-verified by the agent within the hour before each job (last saved in [`evidence/`](evidence), 10 Nov); the page checks it with your browser's nonce | `node agent/tee.mjs z-ai/glm-5.3-flash` → `VERIFIED` |

Live page: **https://koperasi-kohl.vercel.app** (static, reads the contract and the DAO straight from NEAR).

The accounts alice, bob, carol and the steward are the builder's demo members. They show that the mechanism works,
but they are not independent people. The agent has done **no real paid job yet**: the 4 receipts come from `npm run
demo` against a local stand-in for Agent Market, which has no testnet. The co-op's NEAR AI credits are in place and the
agent has bid on 9 real Agent Market jobs; none was awarded yet. The old audit shortfall (7.60 USDC) dates from before
the steward's appointment under 0.2.3, so it is not slashable; it stays red on purpose (the demo's last step).

## For judges: 60 seconds, no wallet, no keys

1. Open **https://koperasi-kohl.vercel.app**. Under the headline, *Don't trust us* runs four checks in your browser:
   the by-laws hash matches the vote, the contract has 0 full-access keys and runs voted code, and the audit is shown. Click
   *Verify … with your own nonce* to check the model's Intel TDX and GPU attestation against a nonce your browser made.
2. Scroll to **06 Tasks & trust**. It shows the three tiers the members voted, who approved each task, and the DAO proposal
   that paid it. A member's record links each point to its source.
3. `npm install && npm run verify` reads every claim above from testnet, without keys or transactions: by-laws, code,
   keys, members, the `tasks` role, the trust rule, every payout and profit share against the vote behind it.
   It ends with `every claim checks out`.

Want to join? Open the page with a member's invite link (`?invite=<member>`), connect a testnet wallet, and ask.
The members vote you in.

## What is new here

The closest earlier projects let a DAO own an AI agent; none lets the owners check what the agent runs or audit who
holds its money:

- [**Agents With Benefits**](https://devfolio.co/projects/agents-with-benefits-3569) (ETHDenver 2024, on NEAR): DAOs
  register agents and share their revenue. Koperasi adds by-laws the contract enforces by hash, the model's TEE checked
  against the visitor's own nonce, a bonded and audited steward, and payouts tiered by trust earned on-chain.
- [**DAO Genie**](https://ethglobal.com/showcase/daogenie-nha62) (ETHGlobal Bangkok 2024 finalist): members vote and an
  agent acts. Here the vote pins the agent itself (prompt, model, prices, caps), and every claim is checked on-chain by
  `npm run verify`.
- Savings circles (Celo's [AjoAI](https://www.karmahq.xyz/project/ajoai/about), [Tanda](https://ethglobal.com/showcase/tanda-zt3es))
  pool money; Koperasi pools ownership of a business that earns, and pays its members and contributors by rule.

More in [`docs/DETAILS.md`](docs/DETAILS.md#prior-art-and-what-is-different).

## Built on NEAR, end to end

| NEAR piece | What it does here |
|---|---|
| **Sputnik DAO v2** | membership (role `member`), every vote, the treasury; the contract holds role `tasks` (file and approve transfers only); bounties for large tasks |
| **Trezu** | [custom proposal templates](trezu/README.md) for profit shares, trust rules, budgets, points, slashing, pause; #51 was filed from one |
| **Global contracts** | the code is a global contract the members switch to by vote (`upgrade({code_hash})`); the account has no full-access key |
| **NEP-141** | Circle's USDC on NEAR: earnings in (`ft_transfer_call` "earnings"), profit shares (`"share"`), claims |
| **NEP-297 / NEP-330** | an event for every state change (the page's live feed); source metadata of a reproducible `cargo near` build |
| **NEP-366** | meta-transactions: members pay no gas for calls without a deposit |
| **NEP-413** | signed messages: a member signs "I vouch for X joining this DAO" in their wallet (no transaction); X's membership request carries it, and the page checks the signature and that the key is the member's full-access key on-chain |
| **Function-call access keys** | the agent's only key can call `record_receipt` / `update_receipt`, nothing else |
| **Staking pools** | savings are NEAR staked in the pool the DAO chose, read on-chain (`sync_savings`); on mainnet the yield buys NEAR AI credits (Staking for Inference) |
| **NEAR AI Cloud** | private inference in TEEs (Intel TDX + NVIDIA, also Chutes-served models), attestation, signed responses, billing per request |
| **NEAR AI Agent Market** | where the agent bids, delivers and is paid |
| **NEAR Connect, near-api-js 7** | wallets on the page; every script and the relayer |

## Run it yourself

```sh
npm install
npm test        # lint, typecheck, 29 unit tests, 104 contract tests (unit, fuzz, invariant)
npm run demo    # deploys its own co-op on testnet and runs the whole story in ~3 min
```

The walkthrough covers the demo's seven steps, the page, the browser tests, running the agent on the real Agent
Market, and the scripts that keep the co-op running. It is in [`docs/DETAILS.md`](docs/DETAILS.md), together with the
competitor scan. There are Trezu forms for the co-op's proposals in [`trezu/`](trezu/README.md).

## How it works

```
 members ── Sputnik DAO (role member, 1 member 1 vote) ── treasury in USDC (Trezu shows it on mainnet; forms in trezu/)
               │ FunctionCall proposals: set_config, award_points, set_savings, set_steward, slash_steward, set_trust, set_task_budget, share
               ▼                                  ▲ role `tasks`: Transfer proposals for task payouts (file + approve only)
         koperasi contract ── by-laws hash ── receipts ── audit ── task records ── profit share (claim yourself)
               ▲ record_receipt (function-call key only)
               │
         agent runtime ── NEAR AI Agent Market (bid, start, submit; aat_ token)
                       └─ NEAR AI Cloud (private inference in a TEE, cost per request)
         members' stake ── Staking for Inference ── credits for the co-op's NEAR AI organization
```

| Co-op concept | On NEAR |
|---|---|
| Member | role `member` in the Sputnik DAO; the contract reads the DAO policy and keeps no member list of its own to trust |
| Join deposit | refundable, paid on `join`, returned when the DAO removes the member |
| Savings | NEAR the member staked in the pool the DAO chose (`set_staking_pool`), read on-chain by `sync_savings`; weights the profit share |
| Members' meeting | DAO proposals and votes |
| By-laws | the agent config; its sha256 is the only one the contract accepts receipts for (`set_config`) |
| Task record (earned trust) | finished tasks per named account, each naming its task or DAO proposal (`get_record`); trust counts the *different* posters on it, and the DAO for voted bounties (`get_trust_sources`); decides which tier pays (`contract/src/tasks.rs`) |
| Task payout | a Transfer proposal from the DAO treasury, filed and approved by the contract in its DAO role `tasks` (`transfer:AddProposal`, `transfer:VoteApprove`, nothing else); `get_payout_proposal(task)` names it |
| Contribution points | awarded by vote for by-law or tool work (`award_points`) or earned by tasks; halve at each profit share, so recent work counts most |
| Audit | `get_audit`: paid jobs net of the 5% market fee vs. what the steward passed on |
| Profit share | `ft_transfer_call(msg "share")` from the DAO: reserve back to the DAO, the rest credited per member (`claim_share`) |
| Changing the contract | a NEAR global contract (immutable, addressed by its sha256) the members switch to by vote (`upgrade`); wasm is too large for a proposal's arguments (~48 Mgas a byte), a 32-byte hash is not |

Contract: `contract/src/lib.rs`. Agent: `agent/runtime.mjs`. Deploy: `scripts/deploy.mjs`. Demo: `scripts/demo.mjs`.
Rules in plain words: [`RULES.md`](RULES.md).

## Tracks and evidence

| Track | What the brief asks | Where it is here |
|---|---|---|
| **Social Money** | collective ownership, shared budgets, programmable rewards, reputation-based access, on Sputnik DAO and Trezu, without rebuilding the multisig | The DAO owns and steers the agent; membership is the DAO role; the profit share is a programmable reward by savings and contribution; contribution points trace to the proposal that awarded them; members are paid for tasks with **earned trust**, from the Sputnik treasury itself: the contract holds a DAO role that can only file and approve transfer proposals, so small payouts to contributors trusted by other members are paid when the poster accepts (within a daily limit per poster), mid-size ones need one other member, large ones are normal Sputnik bounties voted by all; every point of a record names the task or proposal it came from, and a member's finished task adds contribution points to their profit share (section 06 of the page); Trezu forms for these proposals in `trezu/`; even the contract's code changes only by vote; all money sits in the Sputnik treasury (demo steps 1, 2, 6) |
| **Autonomous Business** | treasury, sales, procurement, revenue sharing; humans only set the constraints; no plaintext full-access key; public ledger; a short testnet loop | The agent sells work on Agent Market and buys its inference; the by-laws hold price, caps and kill switch (`pause`); the agent account has only a function-call key; receipts + audit are the public ledger (demo steps 3, 5, 7) |
| **Agent Economy** | agents that earn, spend, pay for compute; a receipt per task | Bid → deliver → paid; the runtime books each job's inference cost from NEAR AI Cloud billing (no real job yet: the demo receipts carry 0); one on-chain receipt per job (demo step 3) |

## Sustainability and the path to mainnet

**Who pays for what.** The co-op does not run on a token or a grant:

| Cost | Who pays | Bounded by |
|---|---|---|
| The agent's inference | NEAR AI credits from the members' staking yield (Staking for Inference, mainnet), so the principal stays theirs | the by-laws: at most $0.50 a job and $3 a day (v4) |
| A job's margin | the buyer: 4 USDC a job (by-laws v4), minus Agent Market's 5% fee and the inference, leaves at least 3.30 USDC for the treasury | the audit nets out the fee and checks every payout reached the DAO |
| Task payouts | the treasury, within the task budget the members voted (`set_task_budget`) | the trust tiers and the daily limit per poster |
| Members' gas | the co-op's relayer account (`api/relay.mjs`) for contract and DAO calls without a deposit; the keeper reads stakes twice a day (`api/keeper.mjs`) | members and joiners only; refills by vote like any transfer |
| Code changes | whoever publishes the global contract (about 33 NEAR for 330 KB); the switch is a vote | members only; nobody holds a full-access key |

**What the members do, and what nobody has to.** Members vote on the by-laws, tasks above the trust limit, profit
shares and code. Small tasks pay on earned trust without a quorum. Stakes are read by the keeper, and the agent works
and records receipts by itself. The one human role left is the steward, because Agent Market pays a person. That role is bonded,
audited every job, and replaceable by vote (`set_steward`).

**To mainnet, in order.** The scripts take the network from `NEAR_NETWORK`, and on mainnet the DAO factory is
`sputnik-dao.near`. Only the demo's account faucet is testnet-only.

1. Create the DAO on `sputnik-dao.near` with the founding members and Koperasi's policy (`createDao` in `scripts/lib.mjs`).
2. Deploy the contract, let the members vote the by-laws and Circle's mainnet USDC, then delete the contract's
   full-access key (`scripts/upgrade.mjs --lock`).
3. Members stake with the pool the DAO chose. The co-op's NEAR AI organization earns credits, and the agent's pre-flight
   check (a 1-token call) starts passing.
4. List the agent for hire on Agent Market. It is already registered, with a pricing plan.
5. Add the forms in [`trezu/`](trezu/README.md) to the treasury in Trezu, which shows mainnet Sputnik treasuries.
   Members then file trust rules, budgets, points and profit shares from Trezu.

What still needs work: the agent runtime is not in a TEE (only the model is), and Agent Market's payout to one
person is why the steward exists. Both are listed under *Trust assumptions*.

## Trust assumptions (read before you rely on it)

1. **The steward.** Agent Market pays one human account, and only a signed-in person can withdraw. Koperasi does
   not remove that: it bonds the steward, reconciles every paid receipt against deposits on-chain, and lets the
   members slash the bond. The steward is trusted for at most what they owe minus their bond.
2. **The runtime.** The config check runs in the runtime the steward operates. The contract refuses receipts under
   any other hash, so a runtime that lies must also lie in public receipts; it cannot quietly run unapproved by-laws
   and still record work. The *inference* is provable (TEE attestation and signed responses, see [`docs/DETAILS.md`](docs/DETAILS.md)); the runtime
   itself is not in a TEE. OutLayer runs WASI WASM in Intel TDX, which would need the runtime rewritten for WASI.
3. **Savings.** Members stake in a staking pool the DAO chose (`stakely_v2.pool.f863973.m0` on testnet, proposal
   #11) and `sync_savings` reads each stake from the pool on-chain. On testnet the stake earns testnet rewards, not
   NEAR AI credits: NEAR AI's Staking for Inference turns stake into credits on mainnet, for an organization.
4. **The contract's code.** It runs a global contract the members approved, now proposal #53. `upgrade` obeys only the
   DAO, and the contract account has no full-access key left, so nobody can deploy code without a vote, the builder
   included. The live page shows the key count from the chain. Every upgrade and what it fixed:
   [`docs/DETAILS.md`](docs/DETAILS.md#code-upgrades-each-by-a-members-vote). Each upgrade publishes a global contract
   (about 33 NEAR for this 330 KB contract).
5. **Demand.** Agent Market pays in USDC on NEAR mainnet and has no testnet. The demo uses a local stand-in with the
   same API; the agent is registered on the real market (pricing plan live) and talks to the real API with the same
   code. It is not listed for hire until the co-op's NEAR AI organization has credits, so no buyer can hire an agent
   that cannot deliver.
6. **The contract's DAO role.** Role `tasks` may file *and* approve `transfer` proposals, nothing else. It must file
   them: a small payout to a trusted contributor is paid when the poster accepts, with no member left to file it, which
   is the point of the tier. A role with only `VoteApprove` (members file, the contract adds a vote) would keep every
   payout waiting on a human. What bounds it is the contract's code, which only a vote can change: it files only for an
   accepted task, within the voted budget, the tier limits and each poster's daily limit, to the task's contributor.
   `npm run verify` checks that every Transfer the contract filed matches a paid task.

## Built with

near-sdk 5 (Rust), Sputnik DAO v2, a NEAR testnet staking pool, NEAR AI Agent Market REST API, NEAR AI Cloud
(OpenAI-compatible, TEE attestation and response signatures, billing), `@phala/dcap-qvl` (Intel TDX quotes), ESLint, TypeScript (checkJs), Playwright with axe-core,
NVIDIA NRAS, NEAR Connect (`@hot-labs/near-connect`, wallets on the page), near-api-js 7, GitHub Actions. AI help: Claude Code wrote much of the code with the builder; every step above
was run on testnet.

## License

MIT
