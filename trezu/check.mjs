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
  "kop-award-points": { account_id: "kop-alice-mw4i3w8f.testnet", points: 1, reason: "filed from a Trezu template" },
  "kop-pay-ethereum": { tx: '{"chainId":"11155111","nonce":"3","maxPriorityFeePerGas":"1000000000","maxFeePerGas":"5000000000","gas":"25200","to":"0x89b70a44dc6ebf5f9015de6f7077561a0d927138","value":"1000000000000000"}',
    payload: "" },
};
// the hash the members are asked to sign is the transaction's own: the page rebuilds it from the description the same way
const { txFromText, txHash, toHex } = await import("../web/eth.js");
samples["kop-pay-ethereum"].payload = toHex(txHash(txFromText(`tx ${samples["kop-pay-ethereum"].tx}`)));

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
  if (parsed.data.id === "kop-pay-ethereum") {
    const t = txFromText(p.description);
    const asked = JSON.parse(Buffer.from(a.args, "base64").toString()).request.payload_v2.Ecdsa;
    if (!t || toHex(txHash(t)) !== asked) { console.error(`✗ ${f}: the description does not rebuild the hash it asks to sign`); process.exitCode = 1; }
    else console.log(`  the description rebuilds the signed hash ${asked.slice(0, 16)}…`);
  }
}

// --submit-eth [0x… ETH]: the kop-pay-ethereum form, filled from Sepolia, compiled by Trezu, voted by the demo members;
// the deciding vote's signature makes the raw transaction, which is sent to Sepolia and saved for `npm run verify`
if (process.argv.includes("--submit-eth") && !process.exitCode) {
  const { DEPLOYMENT } = await import("../scripts/lib.mjs");
  const { daoAddress, recover, signByVote } = await import("../scripts/chainsig.mjs");
  const { transfer, txText, rawTx, rawHash, eth, SEPOLIA } = await import("../web/eth.js");
  const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
  const i = process.argv.indexOf("--submit-eth");
  const from = await daoAddress(dep.dao);
  const to = process.argv[i + 1]?.startsWith("0x") ? process.argv[i + 1].toLowerCase() : await daoAddress("kop-bob-mw4i3w8f.testnet");
  const amount = Number(process.argv[i + 2]) || 0.001;
  const t = await transfer(from, to, BigInt(Math.round(amount * 1e6)) * 10n ** 12n);
  const tx = txText(t);
  const payload = toHex(txHash(t));
  const compiled = buildTemplateProposal(parseManifest(JSON.parse(fs.readFileSync(path.join(dir, "kop-pay-ethereum.json"), "utf8"))).data, { tx, payload });
  const { id, tx: vote, sig } = await signByVote(txHash(t), "", compiled);
  if (recover(txHash(t), sig) !== from) throw new Error(`the signature recovers ${recover(txHash(t), sig)}, not ${from}`);
  const raw = rawTx(t, sig);
  const hash = await eth("eth_sendRawTransaction", [raw]);
  console.log(`filed from the Trezu template kop-pay-ethereum: DAO proposal #${id}; signed in ${vote}; sent ${SEPOLIA.explorer}${hash}`);
  const c = dep.chainSignatures ?? {};
  const earlier = c.transfer;
  dep.chainSignatures = { ...c, ...(earlier ? { transfers_before: [...(c.transfers_before ?? []), earlier] } : {}), transfer: {
    network: "sepolia", from, to, eth: amount, nonce: Number(t.nonce), maxPriorityFeePerGas: String(t.maxPriorityFeePerGas),
    maxFeePerGas: String(t.maxFeePerGas), gas: String(t.gas), proposal: id, tx: vote, signature: sig, raw, hash: rawHash(raw), sent: true,
    trezu: "kop-pay-ethereum" } };
  for (const f of [DEPLOYMENT, path.join(import.meta.dirname, "..", "web", "deployment.json")]) {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    fs.writeFileSync(f, JSON.stringify({ ...d, chainSignatures: dep.chainSignatures }, null, 2) + "\n");
  }
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
  for (const m of ["alice", "bob", "steward", "carol"].map(tag).filter(Boolean)) {
    if ((await view(dep.dao, "get_proposal", { id })).status !== "InProgress") break;
    const r = await vote(account(m), dep.dao, id);
    if (r?.transaction) console.log(`  ${m} approved: ${txUrl(r.transaction.hash)}`);
  }
  const p = await view(dep.dao, "get_proposal", { id });
  const after = BigInt(await view(dep.usdc, "ft_balance_of", { account_id: dep.dao }));
  console.log(`proposal #${id}: ${p.status}; treasury ${before} → ${after} USDC base units (the reserve part returns to it)`);
  if (p.status !== "Approved" || after >= before) process.exitCode = 1;
}
