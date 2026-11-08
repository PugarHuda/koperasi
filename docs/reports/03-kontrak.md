# 03 · Smart contract (Smart Contract Engineer), 8 Nov 2026

Builds on [02-strategi](02-strategi.md). This round adds a new module, [`contract/src/tasks.rs`](../contract/src/tasks.rs),
for tasks with earned trust.

## Design

- **Separate storage keys.** State lives under its own keys (`trust`, `task_budget`, `task_count`, `task:<id>`,
  `record:<account>`, `contributors`, `credited:<proposal>`), not in struct fields. The upgrade therefore needs no
  migration, and the old state is untouched.
  - The upgrade script checked that members, receipts, periods and the by-laws stayed the same: 4 members, 4 receipts, by-laws v3.
- **Access control:**
  - DAO only: `set_trust`, `fund_tasks`, `return_budget`; it can also cancel any unpaid task.
  - Members of the contract: `post_task`.
  - Anyone except the poster: `claim_task`.
  - The contributor: `submit_task`, `give_up_task`.
  - The poster: `accept_task`.
  - A member according to the DAO policy, read at that moment, who is neither the poster nor the contributor: `approve_task`.
- **Checks-effects-interactions:** `pay` reduces the budget and sets the status to `Paying` before the transfer. The
  `on_task_paid` callback is `#[private]`. If the transfer bounces, the money returns to the budget and the task goes back to `Submitted`.
- **Races:** `on_approve_policy` and `on_dao_proposal` check the status and the `credited:` key again inside the callback.
  Two concurrent approvals, or two concurrent credits, cannot pay or count twice.
- **Events:** `log!` for `task #N posted`, `trust: +1 for X from SOURCE` and failed payouts.
- **Pausable:** tasks do not follow `pause` (that switch stops the agent). The DAO can cancel any task and take the budget back.

## Test results

```
cd contract && cargo test
test result: ok. 69 passed; 0 failed     (56 existing + 13 for tasks)
```

The task tests cover:
- a newcomer needing one other member and then earning payment on acceptance;
- the trust tier still needing a vote above `auto_max`;
- a large task being refused (it must be a DAO bounty);
- the poster being refused as approver, and a non-member (by the DAO policy) being refused;
- only members posting;
- payouts stopping at the voted budget;
- a bounced payout going back to the budget without a record;
- out-of-turn steps being refused (claiming your own task, submitting before claiming, accepting by a non-poster, a non-DAO setting the rule or funding);
- cancellation rights;
- an approved DAO bounty being counted once, while an unfinished proposal or another kind is refused;
- a poster the members removed being unable to accept (S10);
- `trusted_after = 0` being refused (S11).

**Not done:**
- **Fuzz and invariant tests, and a coverage number.** The NEAR unit-test tooling has no fuzzer, and `cargo-llvm-cov` is
  not installed. The amount cases are covered by explicit boundary tests (`auto_max` exactly, +1, 0, budget minus 1).
- **A sandbox or fork test.** Instead, the three flows were run for real on testnet, as recorded below.

## Deploy (by DAO vote, contract locked)

1. **Global code published.** `wCzwa8LM9TG6VES1JRuXMtUAMe5hFS97iRmsXfAHyTS` (305 KB, about 31 NEAR burned for storage).
   It was funded from 4 faucet accounts, e.g. [9KH6mfeq…](https://testnet.nearblocks.io/txns/9KH6mfeqNbusHSV3kQ8jJjxjf68u4dYZc6b9yLVXQnKs).
2. **Upgrade vote.**
   - DAO proposal **#19** approved by alice, bob and guest; the contract switched to that code.
   - #20 re-ran the same upgrade, because the script stopped early on a lagging RPC (fixed, A3).
3. **Security fixes (S10, S11, from [05-keamanan](05-keamanan.md)).** Code `3wCdocCi3UyfoBLmKTNFfveH1mDcxskR4Nk3zvde8nhX`,
   proposal **#25**. The script waited for the new code and filed no duplicate proposal, which confirms the A3 fix.
   Tasks, records and the budget were intact after the upgrade.
4. **Source equals chain.** Rebuilding `contract/` gives the same hash as `global_contract_hash` (`3wCdocCi…` after #25).
   - Checked on 8 Nov.
   - Note: even a doc comment changes the wasm, so the source on `main` is kept identical to what runs.

## The main flow on testnet (real transactions)

| Step | Who | Tx / proposal |
|---|---|---|
| Members vote the rule: trust ≤ 0.1 NEAR after 1 task; one member ≤ 0.5 NEAR | DAO | proposal #21 |
| Members vote a 1 NEAR budget | DAO | proposal #22 |
| Task #0 posted (0.05 NEAR) | alice | [3dV31DFW…](https://testnet.nearblocks.io/txns/3dV31DFW11DLWiWKimVAVJJkD3DNymSrYkG7JDN3Dgjd) |
| Taken and delivered | carol | [8ikh76md…](https://testnet.nearblocks.io/txns/8ikh76mdLxLC2wKW7LRdCBUTSbchQMfBfwY58Rq8rqoo), [H6fY4tab…](https://testnet.nearblocks.io/txns/H6fY4tabmhk7R7RGAr4jhKaELxR9CxWWdg1CNxQj7GAu) |
| Accepted: carol has no record yet, so it needs one member | alice | [76j4nLbJ…](https://testnet.nearblocks.io/txns/76j4nLbJeXzXPGCf2sNWzKqUT6Q5xvkE5SBXWDC8GEdh) |
| **Tier 2:** bob approves, 0.05 NEAR paid, `trust: +1 … from task:0` | bob | [CUkTGkh4…](https://testnet.nearblocks.io/txns/CUkTGkh4oRazcc6XshUEoBKjzMcCaiEaVu8PB5cCNTC9) |
| Task #1 (0.08 NEAR, check the by-laws hash) posted, taken, delivered | alice, carol | [DjNniyWo…](https://testnet.nearblocks.io/txns/DjNniyWoiFvz2tzxxUpjxxiQk19Qv84tgw9UYqf7B63V), [3smWfqb3…](https://testnet.nearblocks.io/txns/3smWfqb3TZmC8HUjBUabLiEbJCxvTzKZYz2fAoyDJVkX), [3n71ZNxM…](https://testnet.nearblocks.io/txns/3n71ZNxMGH9krXyUL6APPmxqZDhYT63RAvsH7x4Zc46c) |
| **Tier 1:** alice accepts and it is paid at once, with no vote | alice | [AVExx89C…](https://testnet.nearblocks.io/txns/AVExx89CuGs1PkG3zk5ARdELQMFv3NS9Pdau2E9boFTA) |
| **Tier 3:** bounty #1 of 0.6 NEAR (above the limit), voted by all | DAO | proposal #23 |
| carol takes it, files `BountyDone`, the members vote the payout | carol, DAO | proposal #24 (Approved) |
| `credit_dao_bounty(24)`: `trust: +1 … from dao-proposal:24` | carol | [68LWnW2G…](https://testnet.nearblocks.io/txns/68LWnW2GYqRxZHFBhrz7MNmsx3sCPVLxfYuG3x1Q8Dvp) |

- **End state** (`node scripts/tasks.mjs list`): budget 0.87 NEAR; carol: 3 done (`task:0, task:1, dao-proposal:24`).
- **Honest note.** Task #0's deliverable is a link to the by-laws file, which holds no translation. That was my mistake
  while seeding, and records are immutable. Tasks #1 and #24 carry work that can be checked.

## Gas (measured: total gas burnt per transaction, from RPC `tx`)

| Call | Gas burnt |
|---|---|
| `post_task` | 2.5 Tgas |
| `claim_task` | 2.3 Tgas |
| `submit_task` | 2.3 Tgas |
| `accept_task` (to the vote) | 2.4 Tgas |
| `accept_task` (pays on trust, with the transfer and callback) | 6.1 Tgas |
| `approve_task` (`get_policy` from the DAO, the transfer and the callback) | 10.8 Tgas |
| `credit_dao_bounty` (`get_proposal` from the DAO) | 7.1 Tgas |

Everything is far below the 100 Tgas the page and the scripts attach (unused gas is refunded).
