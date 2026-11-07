// Tasks the co-op pays for, with Sputnik DAO v2 bounties (keys in .keys/; testnet demo accounts).
//   node scripts/bounty.mjs post "<task>" <usdc> [times=1] [days=7] [deployment file]   members vote the bounty in
//   node scripts/bounty.mjs claim <id> <account> [days=3]                               take the task (bounty bond)
//   node scripts/bounty.mjs done <id> <account> "<what you delivered>"                  ask to be paid (a proposal)
//   node scripts/bounty.mjs vote <proposal id>                                         members approve the payout
//   node scripts/bounty.mjs list
// Paying out is a BountyDone proposal the members vote on, from the web page or here with `vote <proposal id>`;
// the DAO then sends the USDC from its treasury. The receiver must be registered with the token (storage_deposit).
import fs from "node:fs";
import path from "node:path";
import { DEPLOYMENT, account, call, decide, hasKey, propose, view, vote } from "./lib.mjs";

const [cmd, ...a] = process.argv.slice(2);
const depFile = a.find((x) => x.endsWith(".json"));
const dep = JSON.parse(fs.readFileSync(depFile ? path.resolve(depFile) : DEPLOYMENT, "utf8"));
const args = a.filter((x) => !x.endsWith(".json"));
const DAY = 24n * 3600n * 10n ** 9n;
const policy = await view(dep.dao, "get_policy");
const voters = () => (policy.roles.find((r) => r.name === "member")?.kind?.Group ?? []).filter(hasKey).map(account);
const usd = (u) => (Number(u) / 1e6).toFixed(2);

if (cmd === "post") {
  const [task, amount, times = "1", days = "7"] = args;
  if (!task || !(Number(amount) > 0)) throw new Error('usage: post "<task>" <usdc> [times] [days]');
  const bounty = { description: task, token: dep.usdc, amount: String(Math.round(Number(amount) * 1e6)),
    times: Number(times), max_deadline: String(BigInt(days) * DAY) };
  const treasury = BigInt(await view(dep.usdc, "ft_balance_of", { account_id: dep.dao }));
  if (treasury < BigInt(bounty.amount) * BigInt(bounty.times)) {
    console.log(`note: the treasury holds ${usd(treasury)} USDC, less than ${usd(BigInt(bounty.amount) * BigInt(bounty.times))} for every payout`);
  }
  const v = voters();
  const { id } = await decide(v[0], v, dep.dao, `Bounty: ${task} (${amount} USDC × ${times})`, { AddBounty: { bounty } });
  console.log(`proposal #${id} approved: bounty #${(await view(dep.dao, "get_last_bounty_id")) - 1} "${task}", ${amount} USDC × ${times}`);
} else if (cmd === "claim") {
  const [id, who, days = "3"] = args;
  await call(account(who), dep.dao, "bounty_claim", { id: Number(id), deadline: String(BigInt(days) * DAY) },
    { deposit: BigInt(policy.bounty_bond), tgas: 50 });
  console.log(`${who} claimed bounty #${id} for ${days} days (bond ${Number(BigInt(policy.bounty_bond) / 10n ** 21n) / 1000} NEAR)`);
} else if (cmd === "done") {
  const [id, who, what] = args;
  if (!what) throw new Error('usage: done <id> <account> "<what you delivered>"');
  // Sputnik v2's own `bounty_done` cannot succeed (it takes no deposit, then demands the proposal bond: ERR_MIN_BOND),
  // so the claimer files the same BountyDone proposal with add_proposal; paying out checks their claim either way.
  const pid = await propose(account(who), dep.dao, what, { BountyDone: { bounty_id: Number(id), receiver_id: who } });
  console.log(`${who} asked to be paid for bounty #${id}: proposal #${pid}`);
} else if (cmd === "vote") {
  const id = Number(args[0]);
  for (const v of voters()) {
    const p = await view(dep.dao, "get_proposal", { id });
    if (p.status !== "InProgress") break;
    if (!p.votes[v.accountId]) await vote(v, dep.dao, id);
  }
  console.log(`proposal #${id}: ${(await view(dep.dao, "get_proposal", { id })).status}`);
} else {
  const last = await view(dep.dao, "get_last_bounty_id");
  const bounties = await view(dep.dao, "get_bounties", { from_index: 0, limit: Math.max(1, last) });
  for (const b of bounties) {
    const taken = await view(dep.dao, "get_bounty_number_of_claims", { id: b.id });
    console.log(`#${b.id} ${b.description}: ${usd(b.amount)} ${b.token || "NEAR"}, ${b.times} left, ${taken} claimed`);
  }
  if (!bounties.length) console.log("no bounties");
}
