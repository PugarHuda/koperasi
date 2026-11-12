# Trezu forms for the co-op

[Trezu](https://trezu.org), NEAR DevHub's treasury app for Sputnik DAOs, turns a contract call into a form that members
fill in. This is done with a *custom proposal template*, a JSON manifest that Trezu compiles into a Sputnik `FunctionCall` proposal.
These manifests make the co-op's own decisions available as Trezu forms. Trezu needs no changes, and neither does the DAO.

| Template | The form files | Contract call |
|---|---|---|
| `kop-profit-share` | share USDC from the treasury with the members | `ft_transfer_call` on USDC → Koperasi, `msg "share"` |
| `kop-trust-rule` | the earned-trust tiers for task payouts | `set_trust({rule})` |
| `kop-task-budget` | how much the contract may still pay for tasks | `set_task_budget({amount})` |
| `kop-award-points` | contribution points for a member | `award_points` |
| `kop-slash-steward` | move the steward's bond to the treasury after a red audit | `slash_steward` |
| `kop-pause` | stop the agent (kill switch) | `pause` |
| `kop-pay-ethereum` | pay from the co-op's Ethereum address (NEAR Chain Signatures) | `sign` on `v1.signer-prod.testnet`, with the transaction's fields in the description |

Each one is a normal DAO proposal voted by the members. The manifests in `testnet/` name the showcase contract and
Circle's testnet USDC. For mainnet, change `receiver_id` to the mainnet contract and USDC.

## Install in Trezu

1. In Trezu, open the treasury → **Custom** → enable Custom Requests. This needs the DAO's `ChangePolicy` permission, so it takes a vote.
2. Go to **New template → Code**, paste a file from `testnet/` (or its mainnet copy), and **Save**.

Trezu's hosted backend indexes mainnet treasuries, so on testnet use `check.mjs` below.

## Check with Trezu's own engine

`check.mjs` validates every manifest with Trezu's own validator (`parseManifest`) and compiles it with Trezu's own
proposal builder (`buildTemplateProposal`), both from the Trezu repository and not vendored here. With `--submit`, it files the
compiled `kop-profit-share` proposal (0.1 USDC) on the showcase DAO, and the demo members approve it. That needs their keys in `.keys/`.

```sh
git clone --depth 1 https://github.com/NEAR-DevHub/trezu trezu/.trezu-src
npm i --no-save zod@4 clsx date-fns tailwind-merge big.js tsx
npx tsx --tsconfig trezu/tsconfig.json trezu/check.mjs            # one ✓ line per template
npx tsx --tsconfig trezu/tsconfig.json trezu/check.mjs --submit   # file + approve on testnet
npx tsx --tsconfig trezu/tsconfig.json trezu/check.mjs --submit-eth [0x… ETH]   # pay on Sepolia by vote
```

`kop-pay-ethereum` asks NEAR's MPC network to sign a 32-byte hash, which a member cannot read. So its two fields come
from the page's *Pay from the co-op's Ethereum address* form: the transaction's fields (nonce and gas read from Sepolia)
and the hash they make. They go into the proposal's description, and the page rebuilds the hash from them before
anyone votes: a mismatch shows a warning not to approve. `check.mjs` checks the same on the description Trezu compiles.
With `--submit-eth`, it fills the form from Sepolia, has the demo members approve it, and sends the transaction the
deciding vote signed: proposal **#81** on 13 Nov 2026, [0x8cbfea39…](https://sepolia.etherscan.io/tx/0x8cbfea39832739c8ef053c8c567ddce05c97dd5e9f0a6a8945a52fd288fbb740).

Done on testnet (10 Nov 2026). Trezu compiled the `kop-profit-share` form into DAO proposal **#51**, with the
`[trezu-tmpl:kop-profit-share]` tag in its description. Bob ([5ZJtXu1D…](https://testnet.nearblocks.io/txns/5ZJtXu1DsMkaVFrDskUhExNmf7CGkoxdTV83cmaH1Txx)),
the steward ([BejGeRtT…](https://testnet.nearblocks.io/txns/BejGeRtTib7heo7Dd9iRMB8UC7reei7kpY1qheWo6zNf)) and Alice
([CWtub2GV…](https://testnet.nearblocks.io/txns/CWtub2GVvFreiceKwRGM5S6Q9e8WjirqZcgc38oobPgq)) approved it. 0.1 USDC left
the treasury through the contract's split, and the reserve came back: 11.600005 → 11.560007 USDC.
