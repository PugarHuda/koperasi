// Runs Trezu's own manifest validator and proposal builder (NEAR-DevHub/trezu, cloned to trezu/.trezu-src, not vendored)
// over every template here. With --submit, files the proposal Trezu compiles from kop-profit-share (0.1 USDC) on the
// showcase DAO and has the demo members approve it, so a Trezu-built proposal moves real treasury USDC through the contract.
// Usage (see trezu/README.md): npx tsx --tsconfig trezu/tsconfig.json trezu/check.mjs [--submit]
import fs from "node:fs";
import path from "node:path";
import { parseManifest } from "./.trezu-src/nt-fe/features/proposal-templates/manifest.ts";
import { buildTemplateProposal } from "./.trezu-src/nt-fe/features/proposal-templates/build-proposal.ts";

const dir = path.join(import.meta.dirname, "testnet");
const YOCTO = 10n ** 24n;
// what a member might type into each Trezu form
const samples = {
  "kop-profit-share": { amount: "100000" },
  "kop-trust-rule": { auto_max: String(YOCTO / 10n), one_vote_max: String(YOCTO / 2n), trusted_after: 2, poster_daily_auto: String(YOCTO / 5n), points: 5 },
  "kop-task-budget": { amount: String(YOCTO) },
  "kop-award-points": { account_id: "kop-alice-mw4i2iwk.testnet", points: 1, reason: "filed from a Trezu template" },
};

const compiled = {};
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const parsed = parseManifest(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
  if (!parsed.success) {
    console.error(`✗ ${f}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    process.exitCode = 1;
    continue;
  }
  const p = buildTemplateProposal(parsed.data, samples[parsed.data.id] ?? {});
  const a = p.kind.FunctionCall.actions[0];
  compiled[parsed.data.id] = p;
  console.log(`✓ ${f} → ${p.kind.FunctionCall.receiver_id.slice(0, 24)}.${a.method_name}(${Buffer.from(a.args, "base64").toString()}) deposit=${a.deposit} gas=${a.gas}`);
}

if (process.argv.includes("--submit") && !process.exitCode) {
  const { account, view, propose, vote, txUrl } = await import("../scripts/lib.mjs");
  const dep = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "deployment.testnet.json"), "utf8"));
  const members = (await view(dep.dao, "get_policy")).roles.find((r) => r.name === "member").kind.Group;
  const tag = (id) => members.find((m) => m.startsWith(`kop-${id}-`));
  const { kind, description } = compiled["kop-profit-share"];
  const before = BigInt(await view(dep.usdc, "ft_balance_of", { account_id: dep.dao }));
  const id = await propose(account(tag("alice")), dep.dao, description, kind);
  console.log(`filed DAO proposal #${id} from the Trezu template kop-profit-share`);
  for (const m of ["bob", "steward", "carol"].map(tag).filter(Boolean)) {
    if ((await view(dep.dao, "get_proposal", { id })).status !== "InProgress") break;
    const r = await vote(account(m), dep.dao, id);
    if (r?.transaction) console.log(`  ${m} approved: ${txUrl(r.transaction.hash)}`);
  }
  const p = await view(dep.dao, "get_proposal", { id });
  const after = BigInt(await view(dep.usdc, "ft_balance_of", { account_id: dep.dao }));
  console.log(`proposal #${id}: ${p.status}; treasury ${before} → ${after} USDC base units (the reserve part returns to it)`);
  if (p.status !== "Approved" || after >= before) process.exitCode = 1;
}
