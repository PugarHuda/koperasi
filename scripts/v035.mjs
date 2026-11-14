// node scripts/v035.mjs [refer] [quality]   contract 0.3.5 on the showcase co-op
//   refer:   the referral board on-chain: the agent signs a referral of the job it passed to the sister co-op (the one
//            its runtime routed by price, receipt demo-c7a66c9f… there), and a relayer submits it (the agent's key opens
//            only its receipts); the contract checks the signature against the agent's key and that the co-op is a sister
//   quality: task quality in the reputation weight: bob hands back task #17, which he took and never delivered; the
//            contract counts it against him (get_task_quality), and his reputation weight falls by the factor
// The result is saved in the deployment files (`v035`); `npm run verify` reads it back.
import fs from "node:fs";
import path from "node:path";
import { KeyPair } from "near-api-js";
import { DEPLOYMENT, ROOT, account, callRaw, txUrl, view } from "./lib.mjs";

const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const K = dep.contract, RELAYER = `kop-relayer-${dep.tag}.testnet`, B = "kop-bob-mw4i3w8f.testnet";
const want = process.argv.slice(2);
const run = (p) => !want.length || want.includes(p);
const saved = (patch) => {
  for (const f of [DEPLOYMENT, path.join(ROOT, "web/deployment.json")]) {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    d.v035 = { ...d.v035, ...patch };
    fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
  }
};

if (run("refer")) {
  const trade = (dep.federation.trades ?? []).at(-1); // the job the runtime passed on by itself
  const args = { job_id: trade.job, to_coop: trade.coop, budget_usdc: "4500000",
    reason: "Budget 4.5 USDC is below our voted price (5); the sister co-op's voted by-laws take localization at 4" };
  const msg = await view(K, "get_referral_message", args);
  const { private_key } = JSON.parse(fs.readFileSync(path.join(ROOT, ".keys", `${dep.agent}.json`), "utf8"));
  const signature = Buffer.from(KeyPair.fromString(private_key).sign(Buffer.from(msg)).signature).toString("base64");
  const r = await callRaw(account(RELAYER), K, "post_referral", { ...args, signature }, { tgas: 50 });
  const id = JSON.parse(Buffer.from(r.status.SuccessValue, "base64").toString());
  console.log(`referral #${id} on the board, signed by the agent, submitted by ${RELAYER}: ${txUrl(r.transaction.hash)}`);
  console.log(JSON.stringify((await view(K, "get_referrals", {})).at(-1)));
  saved({ referral: { id, job: trade.job, to_coop: trade.coop, tx: r.transaction.hash, relayer: RELAYER } });
}

if (run("quality")) {
  const before = { q: await view(K, "get_task_quality", { account_id: B }), w: (await view(K, "get_reputation_weights")).find(([a]) => a === B)?.[1] ?? "0" };
  const tasks = await view(K, "get_tasks", { from: 0, limit: 100 });
  const t = [...tasks].reverse().find((x) => x.status === "Claimed" && x.contributor === B);
  if (!t) throw new Error("bob holds no task to hand back");
  const r = await callRaw(account(B), K, "give_up_task", { id: t.id }, { tgas: 30 });
  const after = { q: await view(K, "get_task_quality", { account_id: B }), w: (await view(K, "get_reputation_weights")).find(([a]) => a === B)?.[1] ?? "0" };
  console.log(`bob handed back task #${t.id} (${txUrl(r.transaction.hash)}): quality ${JSON.stringify(before.q)} → ${JSON.stringify(after.q)}; weight ${before.w} → ${after.w}`);
  saved({ quality: { account: B, task: t.id, tx: r.transaction.hash, before, after } });
}
