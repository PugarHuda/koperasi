# 03 · Smart contract engineer (9 Nov 2026, upgrade #41)

Builds on [03-kontrak](03-kontrak.md) (the first contract report) and [01-tech-lead](01-tech-lead.md) (the audit).
Stack: NEAR, Rust, near-sdk 5.30. The EVM tools in the brief have NEAR equivalents, used below:

| EVM brief | Used here |
|---|---|
| OpenZeppelin / Solady | near-sdk 5.30: `store` collections, `#[near(event_json)]` (NEP-297), NEP-330 metadata, `#[private]` callbacks. Membership, voting and the treasury come from the real Sputnik DAO v2, not reimplemented. |
| Custom errors | `require!` / `panic_str` with one specific sentence per check, e.g. `the poster is no longer a member`. NEAR has no error selectors; the page shows this sentence to the user (`web/wallet.js`). |
| Events | NEP-297 `EVENT_JSON:{"standard":"koperasi","version":"1.0.0",...}`, 38 kinds (`contract/src/events.rs`) |
| NatSpec | rustdoc on every public method, struct and event |
| Foundry / forge coverage | `cargo test`, `proptest`, `cargo llvm-cov` |
| Fork test | near-sandbox 2.14 node running the real Sputnik DAO code taken from testnet |
| Etherscan verification | NEP-330 `contract_source_metadata` with a reproducible build pinned by Docker digest |

## Findings fixed

| Finding | Fix | Files |
|---|---|---|
| T6: a payout whose own callback failed stayed Paying forever | After 1 hour, `settle_task` unsticks it. Four more review fixes went in with #38. | `tasks.rs` |
| T13: three clippy warnings | 0 warnings on `cargo clippy --all-targets`. The fixes: `checked_div` for empty pools, and the generated init wrapper's `too_many_arguments` allowed with a reason. | `lib.rs`, `tests.rs` |
| No events: state changes were only plain `log!` text | NEP-297 events for every state change that matters: membership, votes, receipts, money, the task lifecycle | `events.rs`, `lib.rs`, `tasks.rs` |
| Explorers could not tie the deployed code to source | NEP-330: `repository`, `version` 0.2.0, and `build_info` from `cargo near build reproducible-wasm` (image digest, command, git rev) | `Cargo.toml` |
| Undocumented public methods | rustdoc on every public method, including the `#[private]` callbacks | `lib.rs`, `tasks.rs` |
| No integration test against Sputnik | Sandbox test with the real DAO wasm (below) | `tests/sputnik_sandbox.rs`, `tests/res/sputnik_dao_v2.wasm` |

Role 2's only BUILD feature, *tasks with earned trust*, was already on-chain (#19–#38). This round adds events, tests and verification to it.

## Contracts

| Contract | Account (NEAR testnet) | Code | Explorer |
|---|---|---|---|
| Koperasi (showcase) | `koperasi-mw4i2iwk.testnet` | global contract `7oEruJqfGSvwsf1NPXizFS3bcZShFaAQXineeqQ3RGSz`, sha256 `64fe82c0bf285f435c209b884f34a8643a32a1a1ccde2cfc5b3689aa4e2635bf`, 344,529 bytes, installed by members' vote **#41**, 0 full-access keys | [nearblocks](https://testnet.nearblocks.io/address/koperasi-mw4i2iwk.testnet) |
| Sputnik DAO v2 (treasury, votes, roles) | `koperasi-mw4i2iwk.sputnik-v2.testnet` | factory `sputnik-v2.testnet`, code hash `ZGdM2TFdQpcXrxPxvq25514EViyi9xBSboetDiB3Uiq` | [nearblocks](https://testnet.nearblocks.io/address/koperasi-mw4i2iwk.sputnik-v2.testnet) |
| Agent (function-call key only) | `agent.koperasi-mw4i2iwk.testnet` | – | [nearblocks](https://testnet.nearblocks.io/address/agent.koperasi-mw4i2iwk.testnet) |
| USDC (Circle, testnet) | `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af` | Circle's | [nearblocks](https://testnet.nearblocks.io/address/3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af) |

The addresses are kept in one file, `deployment.testnet.json` (`codeSha256` = the sha256 above). The page reads its copy,
`web/deployment.json`. `npm run verify` checks that the code on-chain is the hash in that file and finds the vote that
installed it.

**Source verification.** The contract answers `contract_source_metadata` with:

```json
{ "version": "0.2.0", "link": "https://github.com/PugarHuda/koperasi/tree/55ef1515308eda2c6039cad3259e5901aee2d594",
  "standards": [{ "standard": "nep330", "version": "1.3.0" }],
  "build_info": { "build_environment": "sourcescan/cargo-near:0.21.1-rust-1.96.0@sha256:ccb22bb4…",
    "build_command": ["cargo", "near", "build", "non-reproducible-wasm", "--locked", "--no-abi"],
    "contract_path": "contract", "source_code_snapshot": "git+https://github.com/PugarHuda/koperasi?rev=55ef1515…" } }
```

To check it, run `git checkout 55ef151 && cd contract && cargo near build reproducible-wasm`. It prints sha256
`64fe82c0…`, the same as the code on-chain. SourceScan or the explorer's "verified" badge needs the repository to be
public, and it stays private until 13 Nov (scheduled), so that badge is pending. Every input it would use is already on-chain.

**Repeatable deploy.**
- `node scripts/deploy.mjs`: a new co-op. It creates the DAO with role `tasks` and deploys from the global code the members voted.
- `node scripts/upgrade.mjs --publisher <account>`: publishes the wasm as a global contract, the members vote `upgrade({code_hash})`, then the script checks that members, receipts and by-laws survived.

## Tests

| Kind | What | Result |
|---|---|---|
| Unit, including every revert path | 82 tests. Each guard has a test that it refuses: only the DAO, only the agent, config mismatch, paused, out-of-turn task steps, the poster or contributor approving, budget, double counting, bounced transfer, stuck payout, and more | pass |
| Fuzz (proptest) | Profit share over random members, savings, points, rule and amount; share rule accepted iff it adds to 10000 bps; any valid **account id** can join and leave; config hash validation; task points never exceed the rule for any pay and `one_vote_max` | pass |
| Invariant (proptest, stateful) | Random sequences of shares, claims (succeeding or failing), points and savings: owed counter = Σ claimable, nothing stays in flight, claimed + owed + reserves = shared. Random task payouts with DAO outcomes (Approved, Rejected, InProgress, filing failed): budget left + paying + paid = budget voted, and no task is paid twice | pass |
| Events | NEP-297 shape (`standard`, `version`, `event`, `data`) and the events of join, member added, share, task approved / filed / paid / credited | pass |
| Integration against Sputnik (the "fork" test) | `tests/sputnik_sandbox.rs`: a near-sandbox **2.14.0** node (testnet runs 2.14.0-rc.5) with the **real Sputnik DAO code from testnet**. Membership is read from the DAO policy, the members vote the trust rule and budget as a FunctionCall proposal, and a task is approved. Then the contract files a Transfer proposal and approves it in role `tasks`, and the money leaves the DAO treasury (carol +0.2 NEAR, proposer = the contract, budget 1 → 0.8) | 1 passed (Docker, Linux); CI job `sandbox` |
| Coverage (`cargo llvm-cov`) | `lib.rs` 98.5% lines, 93.0% regions; `tasks.rs` 98.2% lines, 92.2% regions; **total 98.4% lines** | ≥ 90% |

`cargo test --lib`: **89 passed**. `cargo clippy --all-targets`: 0 warnings.

Not measured: coverage of the sandbox test (it runs in Wasm, outside `llvm-cov`).

A note on the sandbox: near-sdk 5.30 links host functions (gas keys, `universal_state_init`) that older sandbox nodes
lack ("Link Error: unknown or invalid import" on 2.13.4), so the test pins 2.14.0, the line testnet runs.

## Security properties (NEAR's form of checks-effects-interactions)

NEAR calls are asynchronous: a promise runs after the method's state is saved, so there is no reentrancy within one
call. The risk is a callback that fails or arrives late. Each money path writes its state before the promise and undoes
it in the callback:
- `claim_share` removes the claimable amount first; `on_claimed` restores it if the transfer failed.
- `slash_steward` and `set_steward` zero the bond before the transfer.
- `pay` deducts the budget and sets the `inflight` flag before filing. `on_payout_voted` records the transfer's result
  before reading the proposal. A stuck or unclear payout is settled only from that record, or by the members.
- Every `#[private]` callback can only be called by the contract itself.

Access control: the DAO for by-laws, points, savings, rules, budget, agent, steward, slash, unpause and upgrade; the
agent for receipts; the steward or the DAO for `pause`. Emergency stop: `pause` / `unpause` (proven below).
Loops: `distribute` and `get_audit` go over all members and receipts (marked `ponytail:` in the code, fine for a co-op
of hundreds). Views take `from` / `limit`.

## Main flows on testnet (after upgrade #41), with gas and events

`node scripts/flows.mjs` runs these with the member keys and prints one line per transaction. Gas is summed over all
receipts of the transaction, including the DAO and token calls it triggers.

| Flow / function | Gas burnt | Events | Transaction |
|---|---|---|---|
| `join` | 2.20 Tgas | join_requested | [HRh2JsLs…](https://testnet.nearblocks.io/txns/HRh2JsLs9MCuMEwXxv7F4np91A1BAkqDXQbgKwArVXQb) |
| DAO `add_proposal` (AddMemberToRole) | 2.46 Tgas | – | [4zREjJhh…](https://testnet.nearblocks.io/txns/4zREjJhhaoN3Nv1MArjUAHTAgeLkBpYZdM8R9fs9jNE3) |
| DAO `act_proposal` (vote) | 2.68 Tgas | – | [9vANzcW3…](https://testnet.nearblocks.io/txns/9vANzcW3LZCMezsQfdhoWLvnLuTvNanMu3F77g3XmkCo) |
| `sync_member` (admit) | 7.25 Tgas | member_added | [4M9YTnEj…](https://testnet.nearblocks.io/txns/4M9YTnEjav5L9HLgQjAkjh5ZuV5XodDyhGTchsK2Drr4) |
| DAO `add_proposal` (leave) | 2.48 Tgas | – | [29C8ShMb…](https://testnet.nearblocks.io/txns/29C8ShMbiBw9qAZce4TBbZ4HeVCyL2MQSSfSf97B56ps) |
| `sync_member` (leave, deposit back) | 7.82 Tgas | member_left | [5Z1BP5QY…](https://testnet.nearblocks.io/txns/5Z1BP5QYYDHZ5F3xX9Zgiv3UEtse2zrTwJ2zBnSSQAz7) |
| `post_task` | 2.45 Tgas | task_posted | [CxtfCS41…](https://testnet.nearblocks.io/txns/CxtfCS41qDcGWVcBYVzG4GXoNPtceL1WKo3u8Tti4Wo2) |
| `claim_task` | 2.16 Tgas | task_claimed | [7QoFa2K1…](https://testnet.nearblocks.io/txns/7QoFa2K1rZorA7gh5CG3S3zArtAYqcbhqXoCX8gjjqCD) |
| `submit_task` | 2.19 Tgas | task_submitted | [8PdBiXJu…](https://testnet.nearblocks.io/txns/8PdBiXJuxhXfNX4xXQFwA64fGjM9xsZvCoW4NiAGsRGf) |
| `accept_task` (paid on trust: files and approves DAO proposal #44, the treasury pays) | 20.85 Tgas | task_accepted, payout_filed, task_paid, record_credited | [8fjdq33v…](https://testnet.nearblocks.io/txns/8fjdq33vnaNXVVew6prdPhvMzHmoNUT38Ti2cbxKvX4o) |
| `accept_task` (newcomer: waits for a vote) | 2.45 Tgas | task_accepted | [DMUzwBCw…](https://testnet.nearblocks.io/txns/DMUzwBCwLwC3Cko4PQf7GV4zou23hao1gwjHfLpdLFvc) |
| `approve_task` (one member; DAO proposal #45, the treasury pays) | 25.25 Tgas | task_approved, payout_filed, task_paid, record_credited | [5HQXEikJ…](https://testnet.nearblocks.io/txns/5HQXEikJQs3NYjvcisERj5jciShwDu1SYaqRTX7D5c1K) |
| Profit share 1 USDC (DAO vote #46, `ft_transfer_call` → `ft_on_transfer`) | – | share_distributed | proposal #46 |
| USDC `storage_deposit` | 3.01 Tgas | – | [8EzBLgit…](https://testnet.nearblocks.io/txns/8EzBLgitRvBrHCp8s3E8xNz8tVoxw7UZ4ZhhLnHj92vh) |
| `claim_share` | 7.82 Tgas | share_claimed (+ the token's ft_transfer) | [ABbhRVXA…](https://testnet.nearblocks.io/txns/ABbhRVXAteP6r11cgH893v3W6h7A7L6WbvucL5WotATf) |
| `pause` (steward, kill switch) | 1.91 Tgas | paused | [4QZxE4e6…](https://testnet.nearblocks.io/txns/4QZxE4e6vZcXCCW69rqaQLpXoMUYbBCA4yYZXyPJWqBr) |
| `unpause` (DAO vote #47) | – | unpaused | proposal #47 |
| `upgrade` (DAO vote #41) | – | upgraded | proposal #41 |

At 100 Tgas per 0.01 NEAR (testnet gas price), the most expensive call costs about 0.0025 NEAR: a payout that files,
votes and settles a DAO proposal across 6 receipts. Contract storage is 7,699 bytes.

**Other flows, proven earlier:**
- By-laws by vote: #7.
- The agent's receipts under the approved config: 4 receipts from the demo market, labelled on the page. Real Agent
  Market jobs wait for NEAR AI credits.
- A large task as a Sputnik bounty, counted on the record: `dao-proposal:24`.
- A bounced payout cancelled, not counted: test co-op `koperasi-mw80aczw`, #5.
- Real profit share from Circle USDC: #36, claim [Cq25VUHM…](https://testnet.nearblocks.io/txns/Cq25VUHME68yfVZDM7ZxdKnjHttHtBhSUF6GXHhsCzxd).
- Leaving with the deposit back: #39, #40.

## Not done, and why

- **The explorer's "verified" badge:** needs the repository to be public (13 Nov). The NEP-330 metadata and the
  reproducible build are in place, so the badge needs no further change.
- **The sandbox test on Windows:** near-sandbox has no Windows binary. It runs in Docker and in CI.
- **Mainnet:** not deployed. This is a decision for the builder (rule 7).

## Pass 12 Nov: 0.2.6, and the integrations that sign by vote

**Findings fixed in the contract** (from the independent review, [05-security](05-security.md) round 7):

| ID | Fix | Test |
|---|---|---|
| S2 | `pledge` and `redeem_pledge` take `PLEDGE_FEE` (0.01 NEAR) for their storage | `a_pledge_pays_for_its_storage`, `calling_in_a_pledge_pays_for_the_claim` |
| S3 | `end_steward_term` waits 7 days after the term while the steward still holds earnings of a paid job | `a_term_ending_just_after_a_paid_job_gives_the_steward_seven_days` |

**Deployed** by the same path as every upgrade: a reproducible build in Docker, published as a global contract, then a
members' vote.

| | |
|---|---|
| Version | 0.2.6, `contract_source_metadata.build_info` names commit `8d0de11` and the pinned `sourcescan/cargo-near:0.21.1-rust-1.96.0` image |
| sha256 | `c50989e8c3522e2965548d2df8b2eed0f5b28b5c4bfbf56336a539cf0baa58ce` (413 347 bytes) |
| Global code | `EG9keYhsBTLMtk2ShbnN6HKg8oZFfikvFZkevxckww5F`, published by `kop-publisher-mw5tkpfo.testnet` |
| Vote | DAO proposal **#75**, `koperasi-mw4i2iwk.testnet.upgrade(EG9keYhs…)`; 5 members, 11 receipts and by-laws v4 intact, 0 full-access keys |
| Proof on chain | a pledge without the fee is refused; with it, pledge #4 ([BKB2kFQp…](https://testnet.nearblocks.io/txns/BKB2kFQp6JJ9uF25nyLsNR3bChsUoVEYUPvp69aDrGqb)) |
| Rebuild | CI `rebuild.yml` reads the commit from the chain, rebuilds in the same image and compares the sha256 (green for 0.2.5 on its first public run) |

**Tests:** 133 contract tests (`cargo test --lib`: 133 passed), plus the sandbox test against the real Sputnik DAO
wasm, green on CI (Linux).

**On-chain work by vote today, outside the contract** (each a DAO `FunctionCall` to the MPC signer, read back by
`npm run verify`):

| Proposal | What the members voted | Result |
|---|---|---|
| #71 | sign an EIP-1559 transfer of 0.001 Sepolia ETH from the DAO's Chain Signatures address to bob's | signed, but with 21 000 gas, too little to send to a new account on Sepolia today: it failed on chain and moved no ETH |
| #74 | the same transfer, gas from the node (+20%) | landed: [0x9f794e2d…](https://sepolia.etherscan.io/tx/0x9f794e2d81f016671cf49f5c5984371e1b9c33e6c58606c9dbb5ba0cb8bf1da9) |
| #72 | the DAO creates the agent's NEAR Intents wallet (Tidepool's testnet Agent API) with a members-only policy | wallet `agent_7faa1d7f6f2be9e778c9fd18`, owner = the DAO's address |
| #73 | the DAO issues the agent its grant (30 days) | the agent then paid bob 2 USDC on NEAR and 3 USDC on Base Sepolia ([0xba7491b2…](https://sepolia.basescan.org/tx/0xba7491b252fe172bcc30b75647bfed5d7baddfc87cdfb107ca3e0a3c2ac763d8)), each held 10 minutes |
| — | (not a vote) the by-laws gate run inside an Intel TDX enclave through OutLayer | `match: true` resumed into alice's transaction ([4EShvWPa…](https://testnet.nearblocks.io/txns/4EShvWPavQuFDZtNMfyEBgVGMuA7J2oy8h9VxgCsqFma)) |
