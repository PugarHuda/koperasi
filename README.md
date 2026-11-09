# Koperasi

**An AI agent owned and governed by its members on NEAR. One member, one vote.**

Indonesian villages have run *koperasi* (co-operatives) for a century: the members own the business, every member
has one vote, and the profit is shared by savings and by contribution. Koperasi gives an AI agent the same rules:

- **Savings are never spent.** Members stake NEAR; the staking yield pays the agent's private inference on
  NEAR AI Cloud (Staking for Inference). The principal stays theirs.
- **The members hold the agent's mind.** The agent's prompt, model, tools, prices and spend caps are its
  by-laws. They change only by a vote in a Sputnik DAO, and the agent refuses to work, and the
  contract refuses its receipts, unless it runs the exact config the members approved (sha256 on-chain).
- **The work leaves a receipt.** The agent is registered on NEAR AI Agent Market and leaves an on-chain receipt for each
  paid job. So far there are no real jobs: the 4 receipts on the showcase come from `npm run demo`, where a local stand-in
  plays Agent Market (it has no testnet) and no model runs. Real jobs wait for NEAR AI credits for the co-op (see Trust assumptions).
- **The money is checked.** A public audit compares what the agent earned with what reached the co-op's treasury;
  the members can slash the steward's bond. Earnings are shared as a profit share: reserve, savings, contribution.

Built at NEAR HACKATHON (Nov 2026). Tracks: **Social Money**, **Autonomous Business**, **Agent Economy**.
Sister project by the same builder, independent of this one: [Pusaka](https://github.com/PugarHuda/pusaka)
(NFTs that hold real Bitcoin, track NFTs).

| | |
|---|---|
| Contract | [`koperasi-mw4i2iwk.testnet`](https://testnet.nearblocks.io/address/koperasi-mw4i2iwk.testnet) |
| The co-op's DAO | [`koperasi-mw4i2iwk.sputnik-v2.testnet`](https://testnet.nearblocks.io/address/koperasi-mw4i2iwk.sputnik-v2.testnet) (Sputnik v2, role `member`, RoleWeight, threshold 1/2) |
| Agent account | `agent.koperasi-mw4i2iwk.testnet`: one function-call key, only `record_receipt` / `update_receipt` on the contract |
| Agent Market listing | [@koperasi](https://market.near.ai) (self-hosted) |
| USDC | Circle's USDC on NEAR testnet, `3e2210e1…afcb8af` (moved by vote, proposal #18; the treasury holds 0 USDC until someone funds it from faucet.circle.com, which needs a captcha). The demo deploys its own co-op on the mintable `usdc.fakes.testnet`, so anyone can run it without a faucet |
| By-laws the agent runs | **v3** ([`config/config.v3.yaml`](config/config.v3.yaml), `6c237221…`): a member found that v2's model is not served by NEAR AI Cloud and proposed a switch to `z-ai/glm-5.3-flash`; the members approved it as DAO proposal #7 |
| Live page | **https://koperasi-kohl.vercel.app** (static, reads the contract and the DAO straight from NEAR; source in `web/`) |

## Check it in 2 minutes (no wallet, no keys)

| Do | See |
|---|---|
| Open **https://koperasi-kohl.vercel.app** | Under the headline, *Don't trust us*: the by-laws file hashes to what the members voted, the contract has 0 full-access keys and runs the code a vote approved, the audit. Click *Verify z-ai/glm-5.3-flash with your own nonce* for the model's Intel TDX + GPU attestation checked with your browser's own nonce |
| Scroll to **06 Tasks & trust** | The three tiers the members voted (no vote ≤ 0.1 NEAR for a contributor trusted by another member, at most 0.2 NEAR a day per poster; one other member ≤ 0.5 NEAR; above that a DAO bounty), every task with who approved it and the DAO Transfer proposal that paid it from the treasury, each contributor's record linked to its sources |
| `npm install && npm run verify` | Every claim in this README read from testnet, read-only: by-laws = proposal #7, code = proposal #25, 0 full-access keys, the agent's key scoped to `record_receipt`, members = the DAO role, the contract's DAO role `tasks` limited to transfer proposals, the trust rule = its vote, each task payout = an approved Transfer proposal the contract filed, each record point traced to a paid task or an approved DAO bounty. Ends `every claim checks out`. CI runs it on every push and daily |

## Try it

Requirements: Node 22+. Rust + `cargo-near` only to rebuild the contract (`cargo near build non-reproducible-wasm --no-abi`;
plain `cargo build` stops with "use cargo near build", and on Windows the ABI step does not link, hence `--no-abi`): without a local build, `npm run demo` deploys the
code the showcase members voted, already published on-chain as a global contract (`codeSha256` in `deployment.testnet.json`).

### 1. Tests (offline, ~2 min)

```sh
npm install
npm test     # lint (ESLint), typecheck (tsc --checkJs), agent unit tests (node:test), contract tests (cargo test)
```

See: `76 passed` for the contract and `pass 14` for the agent, scripts and page logic: response-signature recovery, the TDX quote
binding the server's signing address and our nonce, the attested docker compose, the per-job spend cap, the demo-market
check, the page's profit-share preview matching the contract's split to the last USDC unit, views that move past a
rate-limited RPC, and the agent's money path when a job fails half-way (a billed inference that then fails is booked at
the cap; a failed delivery or receipt is finished on the next pass without paying for the inference twice), and the
page's task amounts and pay path matching the contract.
The contract tests cover membership from the DAO policy, by-laws only by vote, receipts refused under an
unapproved config, receipt status rules, the audit net of the 5% market fee, the profit share with no money lost to
rounding, claim rollback, steward bond and slash, pause, `cancel_join` admitting (not refunding) someone the DAO already
voted in, savings read from the staking pool, code upgrades only by the DAO, the task tiers (a newcomer needs one other
member, then earns payment on acceptance; trust needs different posters, so two friends cannot make each other trusted;
a poster pays with no vote only up to a daily limit; a member who finishes a task earns contribution points in proportion to its pay; large tasks are
refused as DAO bounties; the poster, the contributor and non-members cannot approve; payouts stop at the voted budget; a
payout the DAO rejected or removed, or whose transfer bounced, returns to the budget, earns nothing and is not filed again; one still open waits and settles once;
an approved DAO bounty counts once; a poster the members removed cannot accept; trust needs at least one finished task), the inference proof kept with each
receipt, and moving to another USDC contract only when no share is unclaimed and no transfer is in flight. (On Windows, `contract/.cargo/config.toml` uses aws-lc-sys's prebuilt NASM objects.)

### 2. The whole story on testnet (~3 min)

```sh
npm install
npm run demo
```

It deploys its own co-op (contract, Sputnik DAO, agent account; written to `deployment.testnet.local.json`) with its own
testnet accounts, so it never touches the showcase co-op the live page reads, and runs a local stand-in for Agent Market
with the same REST paths and JSON as the real one (`agent/mock-market.mjs`). What you see:

1. **Two people join.** They pay a refundable join deposit, a DAO proposal adds them to role `member`, and
   `sync_member` reads the DAO policy on-chain. See: `3 members; each was voted in by a majority of the members before them`.
2. **A member rewrites the agent's by-laws.** Alice proposes `config/config.v2.yaml`; the members approve; she earns
   10 contribution points. See: `by-laws v2 5eee1b31…, alice has 10 points`.
3. **The agent works.** It bids on the jobs its by-laws allow, delivers, gets paid, records receipts on-chain.
   See: `2 receipts under by-laws v2, status Paid, Paid`.
4. **Attack: someone edits the config without a vote.** See: `the runtime refused: config_mismatch` and
   `the contract refused the receipt too: config_mismatch`.
5. **The steward passes the earnings on** (`ft_transfer_call … msg "earnings"`). See: `missing 0.00 USDC`.
6. **The members vote a profit share:** 20% reserve, 40% by savings, 40% by contribution points. Alice claims hers.
   See each member's share, then `alice claimed`.
7. **The steward keeps the next payout.** The audit turns red; the members vote to slash the bond.
   See: `bond 1 NEAR → 0 (moved to the DAO)`, then `ALL STEPS PASSED`.

If the NEAR testnet faucet rate-limits you (HTTP 429), put `{account_id, private_key}` json files of funded testnet
accounts in a folder and run with `KOP_FUNDER_KEYS=<folder>`.

### 3. The web page (live data from the contract)

```sh
cd web && python -m http.server 5173     # or any static server
```

Open http://localhost:5173 (or the live page). See:

- **Who controls this AI agent?** next to the headline: which members voted yes on the by-laws the agent runs (read
  from the DAO proposal), the locked terms (price, AI spend caps), and whether the DAO allows the agent to work.
- **Don't trust us. Your browser checks.** Right under the headline, four checks run in your browser: the by-laws file
  hashes to what the members voted; the contract account has no full-access key and runs the code a vote approved; the
  audit (every paid job reached the treasury, or how much did not); and, on a click, **the model's TEEs verified with
  your own nonce** (Intel TDX quotes, signing keys, attested compose, GPU nonce), with a table per server. Next to it, a
  four-row comparison with token-launched agents and agent frameworks.
- **Members' meeting: propose a profit share** (wallet panel, members): type an amount up to the treasury and see, before
  anyone votes, what each member would receive and what stays as reserve, by the contract's own split. An open share
  proposal shows voters the same preview.
- **Verify by-laws in your browser**: downloads the by-laws file from this repo, hashes it in your browser and compares
  it with the hash the members voted on. See: `Match.`
- **Join with a testnet wallet** (Meteor, Intear, Nightly…, via NEAR Connect): pay the 0.5 NEAR join deposit, create
  your own membership proposal in the DAO (0.1 NEAR bond, returned when decided), and sync once the members vote you in.
  Members then see open proposals with Approve / Reject, their points and their share to claim. Tested on testnet:
  `kop-guest-984702.testnet` joined this way (proposal #8) and the members voted it a welcome point (proposal #9).
  The demo members' keys live with the builder; `node scripts/approve-requests.mjs` has them approve every request
  from an account that paid the deposit.
- The member passbook (approved by-laws, paid jobs, profit shares), members' savings and points, one receipt per job
  with its inference proof (TEE signer), and the audit (GREEN when every payout reached the co-op, RED with the missing
  amount when not), next to the DAO's USDC balance read from the token contract itself.
- **Tasks the co-op pays for** (Sputnik DAO bounties): the members vote a task in with its USDC pay; a member takes it
  from the wallet panel (0.1 NEAR bond), files a link to the work, and the members vote the payout from the treasury.
  Live: task #0, translate this quick start into Bahasa Indonesia, 0.50 USDC × 2 (proposal #13). Tested end to end on
  the demo co-op: taken, filed as proposal #22, approved, 0.50 USDC paid from its treasury.
- **Who can change the contract's code?** The code the contract runs (a NEAR global contract hash), the DAO proposal
  that approved it, and how many full-access keys the contract account still has, read from the chain.

**Browser tests** (Playwright, against live testnet data): Chromium, Firefox and WebKit on desktop, an iPad, an Android
phone and an iPhone.

```sh
npx playwright install chromium firefox webkit
npx playwright test                                   # the live page
BASE_URL=http://localhost:5173 npx playwright test    # web/ served locally; adds the wallet panel previews
npx playwright show-report                            # HTML report, traces of failures
```

They cover the happy paths (live data, TEE evidence, verify the by-laws, savings, tasks, the wallet panel as a newcomer
and as a member), failures simulated by intercepting the page's own requests (every RPC down, 429 then recovery,
GitHub down, a tampered by-laws file, no TEE evidence, offline, no wallet, a double submit, a refresh mid-transaction),
odd input (stake amounts negative, zero, fractional, huge; empty or oversized work links; hostile proposal text with
HTML and extra lines; bounties in an unknown or malformed token), deep links, back/forward, the 404 page,
accessibility with axe-core (WCAG 2.1 AA, serious and critical), and screenshots of the page frame (`@visual`,
compared on the builder's machine). CI (`.github/workflows/tests.yml`) runs lint, typecheck, unit, `npm audit
--audit-level=high`, contract tests and the browser tests on every push, and the browser tests daily against the live
page.

Receipts with no inference proof are labelled *Demo market, no model*: they come from `npm run demo`, where a local
stand-in plays Agent Market (it has no testnet) and no model runs. The page counts real, TEE-proven jobs separately.

The showcase co-op's audit is RED on purpose: the demo's last step has the steward keep a payout.

### 4. Run the agent against the real Agent Market

```sh
cp .env.example .env    # KOP_MARKET_TOKEN=aat_… from your agent's page, NEARAI_API_KEY=sk-…
node agent/runtime.mjs  # one pass; --loop to keep polling every 45 s
```

Before it accepts any job it checks, and refuses on any failure:

1. the by-laws file hashes to what the members voted on-chain (`REFUSED: config_mismatch` otherwise);
2. **the by-laws model runs in genuine TEEs** (`agent/tee.mjs`, the algorithm of NEAR AI's official verifier): the
   Intel TDX quotes of the gateway and the model servers verify against Intel's collateral (`@phala/dcap-qvl` 0.7, the version that also checks the QE identity, GHSA-796p-j2gh-9m2q),
   their `report_data` binds each server's signing address and a fresh 32-byte nonce, `sha256(app_compose)` matches
   `mr_config_id`, and NVIDIA NRAS passes the GPU evidence carrying the same nonce;
3. NEAR AI Cloud publishes the model as `verifiable` (`GET /v1/model/list`); non-verifiable models are refused;
4. the co-op's NEAR AI organization can pay (a 1-token call; 402 means no credits);
5. Agent Market's fee (`GET /v1/platform/config`) is the 5% the contract's audit nets out.

Each job's worst case (every brief byte a token, every output token used) is priced from the model's published
per-token prices and `max_tokens` is cut to fit the by-laws' per-job cap before anything is sent. The billed cost
(`POST /v1/billing/costs` by `inference-id`, polled while billing catches up) goes into the receipt, or the full cap if
billing never answers. If a started job cannot be delivered, the agent tells the buyer and declines it
(`POST /v1/assignments/{id}/decline`, a full refund) instead of letting it time out. Without `NEARAI_API_KEY` it takes no
work on the real market; only the demo's local stand-in gets a draft, which says no model wrote it.

After each inference it fetches the response signature and requires that the signed text ends with
`sha256(request):sha256(response)` and that the EIP-191 signer is one of the attested signing addresses
(`agent/sig.mjs`, with a self-check: `node agent/sig.mjs`). The receipt then carries the proof on-chain
(`get_proof(job_id)`: model, inference id, chat id, the attested TEE signer).

```sh
node agent/tee.mjs z-ai/glm-5.3-flash   # see: TDX UpToDate | binds address true | binds our nonce true | NVIDIA true → VERIFIED
```

The result is committed to [`evidence/`](evidence) and shown on the live page; a GitHub Action re-checks it daily.

### 5. Keep the co-op running

| What | Command | Automated |
|---|---|---|
| Members vote in people who paid the deposit and asked from the page (max 3 a run), sync them at once, vote out anyone in the role without a deposit | `node scripts/approve-requests.mjs` | `.github/workflows/members.yml`, every 30 min, once the `KOP_MEMBER_KEYS` secret holds the demo members' testnet keys |
| Refresh every member's savings from the staking pool | `node scripts/sync-savings.mjs` | same workflow |
| Re-prove the by-laws model runs in TEEs | `node agent/tee.mjs <model>` | `.github/workflows/tee.yml`, daily, commits `evidence/` |
| Propose new by-laws | `node scripts/propose-bylaws.mjs config/config.vN.yaml <member> <points> "why" [voters…]` | by vote only |
| Upgrade the contract code: publish the wasm as a NEAR global contract, the members vote `upgrade({code_hash})`; checks members, receipts and by-laws survive | `node scripts/upgrade.mjs [--publisher <account>]` | by vote only (showcase: proposals #12, #16, #19, #25, #27, #32, #33, #35) |
| One time: delete the contract account's full-access keys, so only a vote can change the code | `node scripts/upgrade.mjs --lock` | no (done on the demo co-op `koperasi-mw57ou3m.testnet`: 0 keys) |
| Tasks the co-op pays for: post by vote, take, file the work, vote the payout (USDC, or NEAR with `--near`) | `node scripts/bounty.mjs post\|claim\|done\|vote\|list …` | by vote only |
| Tasks with earned trust: vote the rule and how much the contract may pay from the treasury, post, take, deliver, accept, approve, count a DAO bounty on a record, settle a payout the members voted by hand | `node scripts/tasks.mjs rule\|budget\|post\|claim\|submit\|accept\|approve\|credit\|settle\|list …` | rule and budget by vote; each payout is a DAO Transfer proposal the contract files and approves in its role `tasks` |
| Check every claim above against the chain, read-only | `npm run verify` | CI, every push and daily |
| Move the co-op to another USDC contract (claims every member's share in the old token first, registers the DAO and the contract with the new one) | `node scripts/switch-usdc.mjs [token id]` | by vote only (showcase: proposal #18) |

## How it works

```
 members ── Sputnik DAO (role member, 1 member 1 vote) ── treasury in USDC (Trezu shows it once the co-op moves to mainnet)
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
| Contribution points | awarded by vote for by-law or tool work (`award_points`); reset after each profit share |
| Audit | `get_audit`: paid jobs net of the 5% market fee vs. what the steward passed on |
| Profit share | `ft_transfer_call(msg "share")` from the DAO: reserve back to the DAO, the rest credited per member (`claim_share`) |
| Changing the contract | a NEAR global contract (immutable, addressed by its sha256) the members switch to by vote (`upgrade`); wasm is too large for a proposal's arguments (~48 Mgas a byte), a 32-byte hash is not |

Contract: `contract/src/lib.rs`. Agent: `agent/runtime.mjs`. Deploy: `scripts/deploy.mjs`. Demo: `scripts/demo.mjs`.
Rules in plain words: [`RULES.md`](RULES.md).

## Tracks and evidence

| Track | What the brief asks | Where it is here |
|---|---|---|
| **Social Money** | collective ownership, shared budgets, programmable rewards, reputation-based access, on Sputnik DAO and Trezu, without rebuilding the multisig | The DAO owns and steers the agent; membership is the DAO role; the profit share is a programmable reward by savings and contribution; contribution points trace to the proposal that awarded them; members are paid for tasks with **earned trust**, from the Sputnik treasury itself: the contract holds a DAO role that can only file and approve transfer proposals, so small payouts to contributors trusted by other members are paid when the poster accepts (within a daily limit per poster), mid-size ones need one other member, large ones are normal Sputnik bounties voted by all; every point of a record names the task or proposal it came from, and a member's finished task adds contribution points to their profit share (section 06 of the page); even the contract's code changes only by vote; all money sits in the Sputnik treasury (demo steps 1, 2, 6) |
| **Autonomous Business** | treasury, sales, procurement, revenue sharing; humans only set the constraints; no plaintext full-access key; public ledger; a short testnet loop | The agent sells work on Agent Market and buys its inference; the by-laws hold price, caps and kill switch (`pause`); the agent account has only a function-call key; receipts + audit are the public ledger (demo steps 3, 5, 7) |
| **Agent Economy** | agents that earn, spend, pay for compute; a receipt per task | Bid → deliver → paid; inference cost per job from NEAR AI Cloud billing; one on-chain receipt per job (demo step 3) |

## Prior art, and what is different

**Positioning.** For small communities that want to own the AI agent working for them, but on today's agent platforms
get token speculation instead of control and profit, Koperasi is a member-owned AI co-op on NEAR where one member, one
vote pins the agent's prompt, model and prices by hash, the model's TEE is checked before every job (and by any visitor,
in their own browser), and members claim profit by rule. Token-launched agents such as Virtuals or ai16z leave control
with insiders or large holders, and pay holders only through the token price.

Competitor scan, 7 Nov 2026 (sources linked; "inferred" where we could not confirm from a primary source):

| | What it is | Who decides the agent's behaviour | Proof of what runs | Where the money goes | Weakness |
|---|---|---|---|---|---|
| [Virtuals](https://www.virtuals.io) (agent tokens, ACP) | one token per agent; agent-to-agent commerce | developers; token-weighted | none shown to holders | buyback/burn, token price | holdings concentrated in whales (Nansen, via press) |
| [ai16z / ElizaOS](https://decrypt.co/374958) | "AI-run VC DAO" | alleged insider control (lawsuit, settled) | none | token | founder, Aug 2026: "the token is dead" |
| [Olas](https://olas.network/mech-marketplace) (Pearl, Mech Marketplace) | run your own agent; agents hire agents | the operator; veOLAS governance | none per job | operator; OLAS staking | each user owns a copy, nobody co-owns one agent |
| [NEAR Verifiable AI DAO](https://docs.near.org/ai/shade-agents) (Shade tutorial) | a TEE agent votes on DAO proposals | the owner's manifesto | code hash registered on-chain | none | the agent governs the DAO, not the reverse; Shade is deprecated |
| [Botto](https://docs.botto.com/details/governance) | AI artist steered by stakers | stake-weighted votes, a human guardian | none | NFT sales to treasury and voters | no proof of which model or prompt ran (inferred) |
| [Agents With Benefits](https://devfolio.co/projects/agents-with-benefits-3569) (ETHDenver 2024) | DAOs co-own agents as NFTs, share revenue | the DAO | source code on the NFT | revenue share | prototype; no TEE, no audit of a human intermediary (inferred) |
| [NEAR AI Agent Market](https://near.ai/blog/introducing-near-ai-agent-market) | where agents sell work (our channel) | one owner per agent | deliverable hash | the owner | no collective ownership |

**What is the same** (parity, not a selling point): TEE inference and input hashes (NEAR AI, Shade), an agent that sells
work (Olas Mech, Virtuals ACP), a DAO treasury and revenue share (Botto, Agents With Benefits), Sputnik bounties.

**What others have that we do not:** agent-to-agent hiring (Olas, Virtuals: ours only sells); a liquid exit (tokens:
ours is deliberate, a member leaves and gets the join deposit back, as in a koperasi); volume and track record (we have
none on mainnet until the co-op's NEAR AI organization has credits).

**What nobody else does, and Koperasi does now:**

1. **Verify the AI yourself.** The page's *Don't trust us* strip asks NEAR AI Cloud for fresh attestations bound to a
   nonce the visitor's browser made up, and verifies the Intel TDX quotes (Intel's collateral via Phala's public PCCS,
   `@phala/dcap-qvl` in the browser), the signing-key binding, the attested docker compose and the GPU evidence's nonce.
   Critics call TEE attestation "a signed promise" unless anchored ([DEV](https://dev.to/adityasingh2824/tee-attestation-isnt-trust-its-just-a-receipt-4maf));
   here it is anchored to the visitor's own nonce and to by-laws the contract enforces. A replayed attestation is caught
   (tested). Hard to copy: token agents have no pinned config to check against.
2. **Rules no one can change alone.** The by-laws hash is checked by the agent and the contract; the contract's code
   changes only by a members' vote (global contract, no full-access key, not even the builder's); the page checks both.
3. **A members' meeting with the numbers in front of everyone.** A member proposes a profit share from the page and every
   member sees what each of them would receive before voting, computed with the contract's own integer split
   (`web/share.js`, tested against the contract's test). Open share proposals show the same preview to voters.
4. **The human in the middle is bonded and audited.** The steward who holds the Agent Market account must pass every
   payout on; the audit is on-chain and the bond is slashable by vote. We found no other project that audits its operator.
5. **Trust earned on-chain, inside an unmodified Sputnik DAO, and it pays into the profit share.** Sputnik votes per
   proposal *kind*, so a 5 USDC and a 5,000 USDC transfer need the same vote, and Trezu exposes one Finance threshold.
   Koperasi adds the tiers as a member of the DAO itself (`contract/src/tasks.rs`): the members gave the contract a role,
   `tasks`, that may only file and approve `transfer` proposals (proposal #29), so the money stays in the treasury and every
   payout is a Transfer proposal anyone can read. Payouts up to the members' `auto_max` are approved by the contract when
   the poster accepts, once `trusted_after` *different* sources (other members' tasks, or a voted bounty) back the
   contributor, and only up to `poster_daily_auto` a day per poster; up to `one_vote_max` one other member approves
   (membership read from the DAO policy at that moment); above that it is a normal Sputnik bounty voted by all, which
   `credit_dao_bounty` then counts. A member who finishes a task earns contribution points in proportion to its pay, so the
   same record raises their share of the co-op's profit, and points grow only as fast as the treasury pays out. Each point names the task or DAO proposal it came from, and nothing is paid
   beyond the budget the members voted. Others
   either rank contributors off-chain and still pay by hand ([Dework XP ranks at DIA DAO](https://forum.diadata.org/t/gdp-011-proposing-a-rank-system-for-dia-dao-contributors/450)),
   let trust unlock self-assignment but not payment ([Pocket PEP-42](https://forum.pokt.network/t/pep-42-reward-and-decentralise-rad/3397)),
   or give a fixed address an allowance ([Zodiac Roles, as voted by HAI](https://www.tally.xyz/gov/hai/proposal/71232920685128172221431433589301790868107413093536771388303049247330839170330)):
   the limit belongs to whoever holds the role, not to a record anyone can audit.
   On testnet, from the treasury: task #2 (the Bahasa Indonesia quick start, [`docs/MULAI.md`](docs/MULAI.md)) paid by
   DAO proposal #30 after another member's approval, and its contributor, a member, earned 5 contribution points (under #27's
   rule, a flat 5 a task; a security review then showed two members could farm points with tiny tasks, so #32 makes points
   follow the pay); task #3
   (`scripts/verify.mjs`) paid by #31 on earned trust with no vote; task #4 (report 09) paid by #34 on earned trust, its
   member contributor earning 1 point for 0.1 of the 0.5 NEAR a full point award takes. Before the move into the DAO (#26–#29), task #0 and #1
   were paid from a budget the contract held, and DAO bounty #1 (0.6 NEAR) was voted by all in proposal #24 and counted on
   the record. Our mistake while seeding: task #0's delivery link points to the by-laws file, which holds no translation;
   records are immutable, so it stays; task #2 delivered the translation. The demo accounts (alice, bob, carol, the
   steward) are held by the builder, so these show the mechanism working, not independent contributors.

## Trust assumptions (read before you rely on it)

1. **The steward.** Agent Market pays one human account, and only a signed-in person can withdraw. Koperasi does
   not remove that: it bonds the steward, reconciles every paid receipt against deposits on-chain, and lets the
   members slash the bond. The steward is trusted for at most what they owe minus their bond.
2. **The runtime.** The config check runs in the runtime the steward operates. The contract refuses receipts under
   any other hash, so a runtime that lies must also lie in public receipts; it cannot quietly run unapproved by-laws
   and still record work. The *inference* is provable (TEE attestation and signed responses, above); the runtime
   itself is not in a TEE. OutLayer runs WASI WASM in Intel TDX, which would need the runtime rewritten for WASI.
3. **Savings.** Members stake in a staking pool the DAO chose (`stakely_v2.pool.f863973.m0` on testnet, proposal
   #11) and `sync_savings` reads each stake from the pool on-chain. On testnet the stake earns testnet rewards, not
   NEAR AI credits: NEAR AI's Staking for Inference turns stake into credits on mainnet, for an organization.
4. **The contract's code.** It runs a global contract the members approved (first #12, then #16, #19 for the task tiers, #25 with two fixes from a security review, #27 for payouts from the treasury through role `tasks`, #32 with three fixes from a security review of #27 (points follow the pay; a transfer that bounces, which Sputnik leaves Approved, is not counted, as tested on testnet; a payout the members rejected is not filed again), #33 with two more from a second review (nobody can settle a payout while the contract's own vote is in flight; points never exceed the voted amount), now #35: a payout whose own callback failed (e.g. out of gas) no longer stays Paying for good, `settle_task` unsticks it after an hour; #20 re-ran #19's
   upgrade after a lagging RPC made the script stop early), and `upgrade` only obeys the
   DAO. Both the showcase and the demo co-op are locked: their contract accounts have no full-access key left, so no
   one, the builder included, can deploy code without a vote; the live page shows the key count from the chain. Each upgrade publishes a global contract, which burns ~10x normal storage
   (about 33 NEAR for this 330 KB contract).
5. **Demand.** Agent Market pays in USDC on NEAR mainnet and has no testnet. The demo uses a local stand-in with the
   same API; the agent is registered on the real market (pricing plan live) and talks to the real API with the same
   code. It is not listed for hire until the co-op's NEAR AI organization has credits, so no buyer can hire an agent
   that cannot deliver.

## Built with

near-sdk 5 (Rust), Sputnik DAO v2, a NEAR testnet staking pool, NEAR AI Agent Market REST API, NEAR AI Cloud
(OpenAI-compatible, TEE attestation and response signatures, billing), `@phala/dcap-qvl` (Intel TDX quotes), ESLint, TypeScript (checkJs), Playwright with axe-core,
NVIDIA NRAS, NEAR Connect (`@hot-labs/near-connect`, wallets on the page), near-api-js 7, GitHub Actions. AI help: Claude Code wrote much of the code with the builder; every step above
was run on testnet.

## License

MIT
