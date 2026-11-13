// node --env-file=.env scripts/route-demo.mjs   the agent passes a job on to a sister co-op by itself (federation resolution 3)
//
// Two stand-in boards: the showcase's (8787) and the sister co-op's (8788, its "federation board" on testnet). A buyer
// posts a localization job with a 4.5 USDC budget to the showcase's board: the showcase's members voted 5 USDC
// (by-laws v7), so its agent does not bid; it reads the sister co-op's voted by-laws from the chain (sha256 checked),
// sees they take localization at 4 USDC, and passes the job on, naming the showcase. The sister's agent then takes it
// like any job (by-laws checked in the OutLayer enclave, a TEE-verified model) and its receipt names the showcase.
// Then `node scripts/trade.mjs` pays the sister and the 30% the federation set. Nothing here tells either agent which
// co-op to pick: each runtime decides from the chain.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, view } from "./lib.mjs";

const sis = JSON.parse(fs.readFileSync(path.join(ROOT, "deployment.testnet.local.json"), "utf8"));
const JOB = { title: "Localization: the co-op's dues reminder, English to Indonesian", tags: ["localization", "translation"], budgetAmount: "4.5",
  description: "Translate into Indonesian, plainly, for village members: \"Your monthly dues keep your vote and your place on the jury. Pay them by the 10th; ask the treasurer if you cannot.\" Under 50 words." };
// the boards run in their own process: the agents below are run one at a time and block this one
const boards = spawn(process.execPath, ["--input-type=module", "-e", `
  const { startMockMarket } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "agent/mock-market.mjs")).href)});
  const a = await startMockMarket({ port: 8787 });
  await startMockMarket({ port: 8788 });
  a.addJob(${JSON.stringify(JOB)});
  console.log("boards up");`], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((ok) => boards.stdout.on("data", (d) => String(d).includes("boards up") && ok()));
const run = (label, env) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "agent/runtime.mjs")], { encoding: "utf8", timeout: 600_000,
    env: { ...process.env, KOP_MARKET_TOKEN: "aat_mock", KOP_NO_SHARE: "1", KOP_NO_PROPOSE: "1", ...env } });
  for (const l of `${r.stdout}${r.stderr}`.trim().split("\n")) console.log(`[${label}] ${l}`);
};
const before = (await view(sis.contract, "get_info")).receipts;
run("showcase", { KOP_MARKET_URL: "http://localhost:8787", KOP_FEDERATION_INBOX: "http://localhost:8788/_mock/jobs" });
for (let i = 0; i < 3; i++) {
  run("sister", { KOP_DEPLOYMENT: "deployment.testnet.local.json", KOP_MARKET_URL: "http://localhost:8788", KOP_STATE: path.join(ROOT, "agent/.state.sister.json") });
  await new Promise((ok) => setTimeout(ok, 2500));
}
boards.kill();
const after = await view(sis.contract, "get_receipts", { from: before, limit: 10 });
for (const r of after) console.log(r.job_id, r.status, "proof:", await view(sis.contract, "get_proof", { job_id: r.job_id }));
process.exit(after.length ? 0 : 1);
