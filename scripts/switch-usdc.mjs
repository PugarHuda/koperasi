// node scripts/switch-usdc.mjs [token id] [deployment file]
// Moves a co-op to another USDC contract by a members' vote (default: Circle's USDC on NEAR testnet).
//  1. every member with a profit share still to claim claims it in the current token (keys in .keys/), so nothing is
//     left behind (the contract refuses the move otherwise); USDC owed to the DAO is flushed;
//  2. the DAO and the contract are registered with the new token (storage_deposit), so payouts and earnings can move;
//  3. the members vote set_usdc; the deployment files the scripts and the page read are updated.
import fs from "node:fs";
import path from "node:path";
import { ROOT, DEPLOYMENT, NEAR, account, call, decide, fnCall, hasKey, view } from "./lib.mjs";

const CIRCLE_TESTNET = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const args = process.argv.slice(2);
const token = args.find((a) => !a.endsWith(".json")) ?? CIRCLE_TESTNET;
const file = args.find((a) => a.endsWith(".json")) ? path.resolve(args.find((a) => a.endsWith(".json"))) : DEPLOYMENT;
const dep = JSON.parse(fs.readFileSync(file, "utf8"));
const info = await view(dep.contract, "get_info");
if (info.usdc_id === token) { console.log(`${dep.contract} already uses ${token}`); process.exit(0); }
const meta = await view(token, "ft_metadata");
if (meta.decimals !== 6) throw new Error(`${token} has ${meta.decimals} decimals; receipts and shares are in 6-decimal USDC units`);

const voters = (await view(dep.dao, "get_policy")).roles.find((r) => r.name === "member")?.kind?.Group.filter(hasKey).map(account) ?? [];
if (!voters.length) throw new Error("no member keys in .keys/");

// 0. a co-op from before the owed-shares counters starts them once, by vote (exact when the DAO never removed a member
//    who still had a share to claim: checked here against the DAO's proposals)
if ((await view(dep.contract, "get_ledger")) === null) {
  const last = await view(dep.dao, "get_last_proposal_id");
  const removed = [];
  for (let from = 0; from < last; from += 100) {
    for (const p of await view(dep.dao, "get_proposals", { from_index: from, limit: 100 })) {
      if (p.status === "Approved" && p.kind.RemoveMemberFromRole) removed.push(p.kind.RemoveMemberFromRole.member_id);
    }
  }
  for (const who of removed) {
    const c = BigInt(await view(dep.contract, "get_claimable", { account_id: who }));
    if (c > 0n) throw new Error(`former member ${who} still has ${Number(c) / 1e6} to claim; init_ledger would not count it`);
  }
  const { id } = await decide(voters[0], voters, dep.dao, "Start the ledger of owed profit shares (init_ledger)", fnCall(dep.contract, "init_ledger", {}));
  console.log(`proposal #${id}: ledger started ${JSON.stringify(await view(dep.contract, "get_ledger"))}`);
}

// 1. nothing owed in the old token
for (const [who] of await view(dep.contract, "get_members", { from: 0, limit: 500 })) {
  const c = BigInt(await view(dep.contract, "get_claimable", { account_id: who }));
  if (c === 0n) continue;
  if (!hasKey(who)) throw new Error(`${who} has ${Number(c) / 1e6} ${info.usdc_id} to claim; they must claim it before the move`);
  if (!(await view(info.usdc_id, "storage_balance_of", { account_id: who }))) {
    await call(account(who), info.usdc_id, "storage_deposit", { account_id: who }, { deposit: NEAR / 80n });
  }
  await call(account(who), dep.contract, "claim_share", {}, { tgas: 60 });
  console.log(`${who} claimed ${Number(c) / 1e6} in ${info.usdc_id}`);
}
if (BigInt(info.unforwarded) > 0n) await call(voters[0], dep.contract, "flush_to_dao", {}, { tgas: 60 });

// 2. the DAO and the contract can hold the new token
const bounds = await view(token, "storage_balance_bounds");
for (const who of [dep.dao, dep.contract]) {
  if (await view(token, "storage_balance_of", { account_id: who })) continue;
  await call(voters[0], token, "storage_deposit", { account_id: who, registration_only: true }, { deposit: BigInt(bounds.min) });
  console.log(`registered ${who} with ${meta.symbol} (${token.slice(0, 12)}…)`);
}

// 3. the vote
const { id } = await decide(voters[0], voters, dep.dao, `Move the co-op to ${meta.name} ${token}`, fnCall(dep.contract, "set_usdc", { usdc_id: token }));
const now = (await view(dep.contract, "get_info")).usdc_id;
if (now !== token) throw new Error(`set_usdc did not take: ${now}`);
for (const f of [file, path.join(ROOT, "web/deployment.json")]) {
  if (!fs.existsSync(f)) continue;
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  if (d.contract !== dep.contract) continue;
  d.usdc = token;
  fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
}
console.log(`proposal #${id}: ${dep.contract} now uses ${meta.name} ${token}. Fund the DAO (${dep.dao}) at https://faucet.circle.com (NEAR testnet).`);
