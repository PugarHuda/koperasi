// node --env-file=.env scripts/jobs-paid.mjs [n]   n more jobs for the agent, paid in full, so its record has something
// to reason from (by-laws proposals) and the audit stays square.
//
// Each job runs as `scripts/job.mjs` does (the stand-in market: by-laws checked in the OutLayer enclave, the work on a
// TEE-verified model, a receipt on-chain). The stand-in market never pays, so a demo buyer pays the steward each job's
// net (price less the market's 5% fee) in Circle's testnet USDC, and the steward deposits it as the co-op's earnings:
// the agent saves its voted share into the risk fund, and the audit counts it.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEPLOYMENT, ROOT, account, callRaw, txUrl, view } from "./lib.mjs";

const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const n = Number(process.argv[2] ?? 3);
const BUYERS = ["kop-bob-mw4i3w8f.testnet", "kop-guest-984702.testnet"];
const before = (await view(dep.contract, "get_info")).receipts;
for (let i = 0; i < n; i++) {
  const r = spawnSync(process.execPath, ["--env-file=.env", path.join(ROOT, "scripts/job.mjs"), String(i % 2)], { encoding: "utf8", timeout: 600_000, env: { ...process.env, KOP_NO_PROPOSE: "1", KOP_NO_SHARE: "1" } });
  console.log(`${r.stdout}${r.stderr}`.trim().split("\n").filter((l) => /delivered|Paid|gate|refus|not starting/.test(l)).join("\n"));
}
const fresh = (await view(dep.contract, "get_receipts", { from: before, limit: 50 })).filter((r) => r.status === "Paid");
const net = fresh.reduce((s, r) => s + BigInt(r.price) * 95n / 100n, 0n);
console.log(`${fresh.length} job(s) paid on the stand-in market: ${Number(net) / 1e6} USDC net to pass on`);
let left = net;
for (const b of BUYERS) {
  if (!left) break;
  const has = BigInt(await view(dep.usdc, "ft_balance_of", { account_id: b }));
  const x = has < left ? has : left;
  if (!x) continue;
  const t = await callRaw(account(b), dep.usdc, "ft_transfer", { receiver_id: dep.steward, amount: String(x), memo: "demo buyer pays the jobs" }, { deposit: 1n, tgas: 30 });
  console.log(`${b} paid the steward ${Number(x) / 1e6} USDC: ${txUrl(t.transaction.hash)}`);
  left -= x;
}
const paid = net - left;
const fund0 = BigInt((await view(dep.contract, "get_risk_fund"))[0]);
const d = await callRaw(account(dep.steward), dep.usdc, "ft_transfer_call", { receiver_id: dep.contract, amount: String(paid), msg: "earnings" }, { deposit: 1n, tgas: 150 });
await new Promise((ok) => setTimeout(ok, 4000));
const fund1 = BigInt((await view(dep.contract, "get_risk_fund"))[0]);
console.log(`the steward deposited ${Number(paid) / 1e6} USDC as earnings (${txUrl(d.transaction.hash)}); the agent saved ${Number(fund1 - fund0) / 1e6} into the risk fund${left ? `; ${Number(left) / 1e6} USDC still to pass on` : ""}`);
console.log("audit:", JSON.stringify(await view(dep.contract, "get_audit")));
