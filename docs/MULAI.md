# Koperasi: start here

**An AI agent owned and governed by its members on NEAR. One member, one vote.**

A short quick start drawn from the opening of the [README](../README.md). Where they differ, the README and, above
all, the on-chain data prevail. (This file was first written in Bahasa Indonesia as task #2; its path is kept so the
links recorded on-chain still work.)

## Check it in 2 minutes (no wallet, no keys)

| Do | What you see |
|---|---|
| Open **https://koperasi-kohl.vercel.app** | Under the headline, *Don't trust us*: the by-laws file is hashed and matches the one the members voted, the contract has no full-access key and runs the code approved by vote, and the audit. Click *Verify deepseek/deepseek-v3.2 with your own nonce* to check that model's Intel TDX + GPU attestation with a nonce your own browser made |
| Scroll to **06 Tasks & trust** | The three tiers the members voted: no vote up to 0.1 NEAR for a contributor already trusted, at most 0.2 NEAR a day per task poster; one other member up to 0.5 NEAR; above that a DAO bounty. Each task is paid from the DAO treasury by a Transfer proposal linked in the table |
| `curl -sO https://koperasi-kohl.vercel.app/verify.mjs && node verify.mjs` | Every README claim read from testnet, read only: by-laws = the vote, code = the vote, 0 full-access keys, the agent's key can only `record_receipt`, members = the DAO role, the contract's `tasks` role may only file and approve transfers, every point on a work record points to a real payment. It ends with `every claim checks out` |

## How it works, briefly

- **Savings are never spent.** Members stake NEAR; the staking yield pays for the agent's inference. The principal
  stays the members' own.
- **The members hold the agent's "mind".** The agent's prompt, model, tools, prices and spending limits are its
  by-laws. They change only by a vote in the Sputnik DAO, and both the agent and the contract refuse to work with any
  other configuration (sha256 on-chain).
- **Tasks are paid on earned trust.** The money stays in the DAO treasury. The contract holds a DAO role, `tasks`, that
  can only file and approve transfer proposals, under the rules the members voted. Trust counts *different* task
  posters, so two friends cannot make each other "trusted". A member who finishes a task earns contribution points,
  which count toward their profit share.
- **The money is audited.** A public audit compares the agent's earnings with what actually reached the co-op's
  treasury; the members can slash the steward's bond by vote.

## Honest about the limits

There is no real job from Agent Market yet: every receipt on the showcase comes from a demo market. The members' demo
accounts are held by the builder. The details are in the README, under *Trust assumptions*.
