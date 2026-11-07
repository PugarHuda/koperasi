// npm run demo: the whole Koperasi story on NEAR testnet against a local stand-in for Agent Market. No funds, no keys:
// it deploys its own co-op with its own testnet accounts (faucet, or KOP_FUNDER_KEYS when the faucet is rate-limited),
// so it never touches the showcase co-op the web page reads.
// Each step prints what to look for ("see:").
import fs from "node:fs";
import path from "node:path";
import { startMockMarket } from "../agent/mock-market.mjs";
import { ConfigMismatch, runOnce } from "../agent/runtime.mjs";
import {
  ROOT, LOCAL_DEPLOYMENT, NEAR, account, hasKey, accountUrl, call, decide, ensureAccount, fnCall, sha256, sleep, view,
} from "./lib.mjs";

const mine = () => fs.existsSync(LOCAL_DEPLOYMENT) && JSON.parse(fs.readFileSync(LOCAL_DEPLOYMENT, "utf8"));
if (!mine() || !hasKey(mine().steward)) {
  console.log("deploying your own co-op on testnet first (scripts/deploy.mjs)");
  await import("./deploy.mjs");
}
const dep = mine();
const { contract: K, dao: DAO, usdc: USDC } = dep;
const steward = account(dep.steward);
const usd = (u) => `${(Number(u) / 1e6).toFixed(2)} USDC`;
let n = 0;
const step = (title) => console.log(`\n${++n}. ${title}`);
const see = (s) => console.log(`   see: ${s}`);

process.env.KOP_MARKET_URL = "http://localhost:8787";
process.env.KOP_MARKET_TOKEN = "aat_mock";
const mock = await startMockMarket();
const quiet = () => {};

console.log(`Koperasi ${accountUrl(K)}\nDAO      ${accountUrl(DAO)}`);

// ---------------------------------------------------------------------------------------------------------------
step("Two people join: they pay the join deposit and the members vote them in (one member, one vote)");
const tag = Date.now().toString(36);
const alice = await ensureAccount(`kop-alice-${tag}.testnet`, 3n);
const bob = await ensureAccount(`kop-bob-${tag}.testnet`, 3n);
// everyone already holding the member role votes (a re-run finds the members of the last run)
const role = (await view(DAO, "get_policy")).roles.find((r) => r.name === "member")?.kind?.Group ?? [];
const members = role.filter(hasKey).map(account);
if (!members.some((m) => m.accountId === steward.accountId)) members.unshift(steward);
for (const who of [alice, bob]) {
  await call(who, K, "join", {}, { deposit: NEAR / 2n });
  await decide(steward, members, DAO, `Accept ${who.accountId} as a member`,
    { AddMemberToRole: { member_id: who.accountId, role: "member" } });
  await call(who, K, "sync_member", { account_id: who.accountId }, { tgas: 60 });
  await call(who, USDC, "storage_deposit", { account_id: who.accountId }, { deposit: NEAR / 100n });
  members.push(who);
}
see(`${(await view(K, "get_info")).members} members; bob needed 2 of 2 votes, not just the founder's`);

// ---------------------------------------------------------------------------------------------------------------
step("A member rewrites the agent's by-laws (config v2); the members approve it and she earns contribution points");
const v2 = "config/config.v2.yaml";
const v2hash = sha256(fs.readFileSync(path.join(ROOT, v2)));
const next = (await view(K, "get_config")).version + 1; // 2 on a fresh co-op; higher if you re-run the demo on it
await decide(alice, members, DAO, `By-laws v${next}: take documentation jobs, bid 4 USDC`,
  fnCall(K, "set_config", { version: next, hash: v2hash, uri: v2, contributor: alice.accountId, points: 10 }));
dep.configUri = v2;
see(`by-laws v${(await view(K, "get_config")).version} ${v2hash.slice(0, 12)}…, alice has ${(await view(K, "get_member", { account_id: alice.accountId })).points} points`);

// ---------------------------------------------------------------------------------------------------------------
step("The agent works on Agent Market (local stand-in): bids, delivers, gets paid, records a receipt on-chain");
mock.addJob({ title: "Document the NEAR Intents 1Click API in Bahasa Indonesia", description: "A 1-page guide.", tags: ["documentation"], budgetAmount: "6" });
mock.addJob({ title: "Market research: stablecoin remittances to Indonesia", description: "2 pages, cite sources.", tags: ["research"], budgetAmount: "8" });
await runOnce({ dep });
await sleep(2000);
await runOnce({ dep, log: quiet });
const receipts = await view(K, "get_receipts", { from: 0, limit: 500 });
const v2receipts = receipts.filter((r) => r.config_version === next);
see(`${v2receipts.length} receipts under by-laws v${next}, status ${v2receipts.map((r) => r.status).join(", ")}`);

// ---------------------------------------------------------------------------------------------------------------
step("Attack: someone edits the agent's config without a vote");
const tampered = path.join(ROOT, "config", ".tampered.yaml");
fs.writeFileSync(tampered, fs.readFileSync(path.join(ROOT, v2), "utf8").replace("price_usdc: 4", "price_usdc: 0.01"));
try {
  await runOnce({ dep, configFile: "config/.tampered.yaml" });
  throw new Error("the runtime accepted a tampered config");
} catch (e) {
  if (!(e instanceof ConfigMismatch)) throw e;
  see(`the runtime refused: ${e.message}`);
}
try {
  await call(account(dep.agent), K, "record_receipt", {
    job_id: `forged-${tag}`, price: "1", inference_cost: "0", config_hash: sha256(fs.readFileSync(tampered)), deliverable_hash: "x",
  });
  throw new Error("the contract accepted a receipt under unapproved by-laws");
} catch (e) {
  if (!String(e.message).includes("config_mismatch")) throw e;
  see("the contract refused the receipt too: config_mismatch");
}
fs.rmSync(tampered);

// ---------------------------------------------------------------------------------------------------------------
step("The steward passes the earnings on to the co-op; the audit reconciles");
let audit = await view(K, "get_audit");
console.log(`   before: owed ${usd(audit.expected)}, deposited ${usd(audit.deposited)}, missing ${usd(audit.owed)}`);
await call(steward, USDC, "mint", { account_id: dep.steward, amount: audit.owed });
await call(steward, USDC, "ft_transfer_call", { receiver_id: K, amount: audit.owed, msg: "earnings" }, { deposit: 1n, tgas: 150 });
audit = await view(K, "get_audit");
see(`missing ${usd(audit.owed)}; the DAO treasury holds ${usd(await view(USDC, "ft_balance_of", { account_id: DAO }))}`);

// ---------------------------------------------------------------------------------------------------------------
step("The members vote a profit share: 20% reserve, 40% by savings (stake for inference), 40% by contribution");
const treasury = await view(USDC, "ft_balance_of", { account_id: DAO });
await decide(bob, members, DAO, "Savings for this period (NEAR staked for inference)", fnCall(K, "set_savings", {
  entries: [[dep.steward, (100n * NEAR).toString()], [alice.accountId, (50n * NEAR).toString()], [bob.accountId, (50n * NEAR).toString()]],
}));
await decide(steward, members, DAO, `Share ${usd(treasury)} with the members`,
  fnCall(USDC, "ft_transfer_call", { receiver_id: K, amount: treasury, msg: "share" }, { deposit: 1, tgas: 200 }));
for (const a of members) {
  const c = await view(K, "get_claimable", { account_id: a.accountId });
  console.log(`   ${a.accountId.padEnd(34)} share ${usd(c)}`);
}
await call(alice, K, "claim_share", {}, { tgas: 60 });
see(`alice claimed: wallet ${usd(await view(USDC, "ft_balance_of", { account_id: alice.accountId }))}; reserve back in the DAO ${usd(await view(USDC, "ft_balance_of", { account_id: DAO }))}`);

// ---------------------------------------------------------------------------------------------------------------
step("The steward keeps the next payout: the audit turns red and the members slash the bond");
mock.addJob({ title: "Research: NEAR AI Cloud pricing vs. closed APIs", description: "1 page.", tags: ["research"], budgetAmount: "5" });
await runOnce({ dep, log: quiet });
await sleep(2000);
await runOnce({ dep, log: quiet });
audit = await view(K, "get_audit");
console.log(`   missing ${usd(audit.owed)} (not passed on) → audit: RED`);
if (BigInt((await view(K, "get_info")).steward_bond) === 0n) await call(steward, K, "bond_steward", {}, { deposit: NEAR });
const bondBefore = BigInt((await view(K, "get_info")).steward_bond);
await decide(alice, members, DAO, "Slash the steward's bond: earnings were not passed on", fnCall(K, "slash_steward", {}));
see(`bond ${Number(bondBefore / 10n ** 21n) / 1000} NEAR → ${(await view(K, "get_info")).steward_bond} (moved to the DAO)`);

mock.server.close();
console.log(`\nALL STEPS PASSED\nKoperasi ${accountUrl(K)}\nDAO      ${accountUrl(DAO)}`);
