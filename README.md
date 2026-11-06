# Koperasi

**An AI agent owned and governed by its members on NEAR. One member, one vote.**

Indonesian villages have run *koperasi* (co-operatives) for a century: the members own the business, every member
has one vote, and the profit is shared by savings and by contribution. Koperasi gives an AI agent the same rules:

- **Savings are never spent.** Members stake NEAR; the staking yield pays the agent's private inference on
  NEAR AI Cloud (Staking for Inference). The principal stays theirs.
- **The members hold the agent's mind.** The agent's prompt, model, tools, prices and spend caps are its
  by-laws. They change only by a vote in a Sputnik DAO, and the agent refuses to work, and the
  contract refuses its receipts, unless it runs the exact config the members approved (sha256 on-chain).
- **The work is real.** The agent takes paid jobs on NEAR AI Agent Market and leaves an on-chain receipt for each.
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
| USDC on testnet | `usdc.fakes.testnet` (anyone can mint, so judges can run the demo) |
| By-laws the agent runs | **v3** ([`config/config.v3.yaml`](config/config.v3.yaml), `6c237221…`): a member found that v2's model is not served by NEAR AI Cloud and proposed a switch to `z-ai/glm-5.3-flash`; the members approved it as DAO proposal #7 |
| Live page | **https://koperasi-kohl.vercel.app** (static, reads the contract and the DAO straight from NEAR; source in `web/`) |

## Try it

Requirements: Node 22+. Rust + `cargo-near` only to rebuild the contract.

### 1. Contract tests (offline, ~1 min) — Rust

```sh
cd contract && cargo test
```

See: `44 passed`. They cover membership from the DAO policy, by-laws only by vote, receipts refused under an
unapproved config, receipt status rules, the audit net of the 5% market fee, the profit share with no money lost to
rounding, claim rollback, steward bond and slash, pause, `cancel_join` admitting (not refunding) someone the DAO already
voted in, and savings read from the staking pool.

> Windows without NASM: `AWS_LC_SYS_PREBUILT_NASM=1 cargo test`.

### 2. The whole story on testnet (~3 min)

```sh
npm install
npm run demo
```

It deploys its own co-op (contract, Sputnik DAO, agent account; written to `deployment.testnet.local.json`) with its own
testnet accounts, so it never touches the showcase co-op the live page reads, and runs a local stand-in for Agent Market
with the same REST paths and JSON as the real one (`agent/mock-market.mjs`). What you see:

1. **Two people join.** They pay a refundable join deposit, a DAO proposal adds them to role `member`, and
   `sync_member` reads the DAO policy on-chain. See: `3 members; bob needed 2 of 2 votes`.
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
- **Verify by-laws in your browser**: downloads the by-laws file from this repo, hashes it in your browser and compares
  it with the hash the members voted on. See: `Match.`
- **Join with a testnet wallet** (Meteor, Intear, Nightly…, via NEAR Connect): pay the 0.5 NEAR join deposit, create
  your own membership proposal in the DAO (0.1 NEAR bond, returned when decided), and sync once the members vote you in.
  Members then see open proposals with Approve / Reject, their points and their share to claim. Tested on testnet:
  `kop-guest-984702.testnet` joined this way (proposal #8) and the members voted it a welcome point (proposal #9).
  The demo members' keys live with the builder; `node scripts/approve-requests.mjs` has them approve every request
  from an account that paid the deposit.
- The member passbook (approved by-laws, paid jobs, profit shares), members' savings and points, one receipt per job,
  and the audit (GREEN when every payout reached the co-op, RED with the missing amount when not).

The showcase co-op's audit is RED on purpose: the demo's last step has the steward keep a payout.

### 4. Run the agent against the real Agent Market

```sh
cp .env.example .env    # KOP_MARKET_TOKEN=aat_… from your agent's page, NEARAI_API_KEY=sk-…
node agent/runtime.mjs  # one pass; --loop to keep polling every 45 s
```

Before it accepts any job it checks, and refuses on any failure:

1. the by-laws file hashes to what the members voted on-chain (`REFUSED: config_mismatch` otherwise);
2. **the by-laws model runs in genuine TEEs** (`agent/tee.mjs`, the algorithm of NEAR AI's official verifier): the
   Intel TDX quotes of the gateway and the model servers verify against Intel's collateral (`@phala/dcap-qvl-node`),
   their `report_data` binds each server's signing address and a fresh 32-byte nonce, `sha256(app_compose)` matches
   `mr_config_id`, and NVIDIA NRAS passes the GPU evidence carrying the same nonce;
3. the co-op's NEAR AI organization can pay (a 1-token call; 402 means no credits).

After each inference it fetches the response signature and requires that the signed text ends with
`sha256(request):sha256(response)` and that the EIP-191 signer is one of the attested signing addresses
(`agent/sig.mjs`, with a self-check: `node agent/sig.mjs`).

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
| Upgrade the contract code (state layout unchanged; checks members, receipts and by-laws survive) | `node scripts/upgrade.mjs` | no |

## How it works

```
 members ── Sputnik DAO (role member, 1 member 1 vote) ── treasury in USDC (Trezu shows it once the co-op moves to mainnet)
               │ FunctionCall proposals: set_config, award_points, set_savings, set_steward, slash_steward, share
               ▼
         koperasi contract ── by-laws hash ── receipts ── audit ── profit share (claim yourself)
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
| Contribution points | awarded by vote for by-law or tool work (`award_points`); reset after each profit share |
| Audit | `get_audit`: paid jobs net of the 5% market fee vs. what the steward passed on |
| Profit share | `ft_transfer_call(msg "share")` from the DAO: reserve back to the DAO, the rest credited per member (`claim_share`) |

Contract: `contract/src/lib.rs`. Agent: `agent/runtime.mjs`. Deploy: `scripts/deploy.mjs`. Demo: `scripts/demo.mjs`.
Rules in plain words: [`RULES.md`](RULES.md).

## Tracks and evidence

| Track | What the brief asks | Where it is here |
|---|---|---|
| **Social Money** | collective ownership, shared budgets, programmable rewards, reputation-based access, on Sputnik DAO and Trezu, without rebuilding the multisig | The DAO owns and steers the agent; membership is the DAO role; the profit share is a programmable reward by savings and contribution; contribution points trace to the proposal that awarded them; all money sits in the Sputnik treasury (demo steps 1, 2, 6) |
| **Autonomous Business** | treasury, sales, procurement, revenue sharing; humans only set the constraints; no plaintext full-access key; public ledger; a short testnet loop | The agent sells work on Agent Market and buys its inference; the by-laws hold price, caps and kill switch (`pause`); the agent account has only a function-call key; receipts + audit are the public ledger (demo steps 3, 5, 7) |
| **Agent Economy** | agents that earn, spend, pay for compute; a receipt per task | Bid → deliver → paid; inference cost per job from NEAR AI Cloud billing; one on-chain receipt per job (demo step 3) |

## Prior art, and what is different

| | Virtuals | Olas | Tontine (this hackathon) | **Koperasi** |
|---|---|---|---|---|
| Ownership | a token per agent | OLAS staking, DAO-operated services | 100 shares per market-making firm | DAO membership, **one member one vote** |
| Control over the agent's behaviour | holders don't set it | partly | owner sets guardrails | **the by-laws (prompt, model, caps) only by vote, enforced by hash** |
| Members' capital | rides the token price | stake | buys shares | **staked for inference; principal never spent** |
| Income | mostly token trading | services | market-making spread | paid jobs on Agent Market |

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
4. **Demand.** Agent Market pays in USDC on NEAR mainnet and has no testnet. The demo uses a local stand-in with the
   same API; the agent is registered on the real market (pricing plan live) and talks to the real API with the same
   code. It is not listed for hire until the co-op's NEAR AI organization has credits, so no buyer can hire an agent
   that cannot deliver.
4. **Demand.** Agent Market is young. The demo uses a local stand-in with the same API; the agent is listed on the
   real market and talks to the real API with the same code.

## Built with

near-sdk 5 (Rust), Sputnik DAO v2, a NEAR testnet staking pool, NEAR AI Agent Market REST API, NEAR AI Cloud
(OpenAI-compatible, TEE attestation and response signatures, billing), `@phala/dcap-qvl-node` (Intel TDX quotes),
NVIDIA NRAS, NEAR Connect (`@hot-labs/near-connect`, wallets on the page), near-api-js 7, GitHub Actions. AI help: Claude Code wrote much of the code with the builder; every step above
was run on testnet.

## License

MIT
