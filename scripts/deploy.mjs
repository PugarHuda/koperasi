// Deploys one Koperasi on testnet: Sputnik DAO (1 member 1 vote) + koperasi contract + an agent account that holds
// only a function-call key, then appoints the steward by a DAO vote. Writes deployment.testnet.local.json (your own co-op;
// the showcase co-op in deployment.testnet.json is left alone).
//
//   node scripts/deploy.mjs            (KOP_FUNDER_KEYS=.funders if the faucet is rate-limited)
import fs from "node:fs";
import path from "node:path";
import { KeyPair } from "near-api-js";
import {
  ROOT, NEAR, NETWORK, LOCAL_DEPLOYMENT, account, accountUrl, call, createDao, decide, ensureAccount, fnCall, saveKey,
  sha256, view,
} from "./lib.mjs";

const USDC = process.env.KOP_USDC ?? "usdc.fakes.testnet";
const tag = process.env.KOP_TAG ?? Date.now().toString(36);
const ids = {
  steward: `kop-steward-${tag}.testnet`,
  contract: `koperasi-${tag}.testnet`,
};
ids.agent = `agent.${ids.contract}`;

const step = (s) => console.log(`\n▸ ${s}`);

step("accounts");
const steward = await ensureAccount(ids.steward, 9n);
const kop = await ensureAccount(ids.contract, 6n);
console.log(`  steward  ${ids.steward}\n  contract ${ids.contract}`);

step("Sputnik DAO with role member, RoleWeight, threshold 1/2, and role tasks (the contract files and approves task payouts)");
const daoId = await createDao(steward, `koperasi-${tag}`, "Koperasi: an AI agent owned by its members", [ids.steward], ids.contract);
console.log(`  ${daoId}`);

step("deploy koperasi contract");
// a local build if there is one; otherwise the code the showcase co-op's members voted, already published on-chain as a
// global contract (its sha256 is in deployment.testnet.json), so the demo needs Node only
const wasmFile = path.join(ROOT, "contract/target/near/koperasi.wasm");
if (fs.existsSync(wasmFile)) {
  await kop.deployContract(new Uint8Array(fs.readFileSync(wasmFile)));
} else {
  const { codeSha256 } = JSON.parse(fs.readFileSync(path.join(ROOT, `deployment.${NETWORK}.json`), "utf8"));
  if (!codeSha256) throw new Error("no contract/target/near/koperasi.wasm and no published codeSha256: build with cargo near build");
  await kop.useGlobalContract({ codeHash: codeSha256 });
  console.log(`  global contract sha256 ${codeSha256}`);
}
const configFile = "config/config.v1.yaml";
const configHash = sha256(fs.readFileSync(path.join(ROOT, configFile)));
await call(kop, ids.contract, "new", {
  dao_id: daoId,
  usdc_id: USDC,
  agent_id: ids.agent,
  join_deposit: (NEAR / 2n).toString(),
  share_rule: { reserve_bps: 2000, savings_bps: 4000, points_bps: 4000 },
  config_hash: configHash,
  config_uri: configFile,
});
console.log(`  config v1 ${configHash}`);

step("agent account: function-call key only (record_receipt, update_receipt)");
const tmp = KeyPair.fromRandom("ed25519");
await kop.createSubAccount({ accountOrPrefix: ids.agent, publicKey: tmp.getPublicKey(), nearToTransfer: NEAR / 2n });
saveKey(ids.agent, tmp);
const agentFull = account(ids.agent);
const fc = KeyPair.fromRandom("ed25519");
await agentFull.addFunctionCallAccessKey({
  publicKey: fc.getPublicKey(),
  contractId: ids.contract,
  methodNames: ["record_receipt", "update_receipt"],
  allowance: NEAR / 4n,
});
await agentFull.deleteKey(tmp.getPublicKey());
saveKey(ids.agent, fc);
const keys = await account(ids.agent).getAccessKeyList();
console.log(`  ${ids.agent}: ${keys.keys.length} key, ${JSON.stringify(keys.keys[0].access_key.permission).slice(0, 90)}…`);

step("USDC storage for the DAO and the contract");
for (const who of [daoId, ids.contract, ids.steward]) {
  await call(steward, USDC, "storage_deposit", { account_id: who }, { deposit: NEAR / 100n });
}

step("the founder joins the co-op (already in role member) and syncs");
await call(steward, ids.contract, "join", {}, { deposit: NEAR / 2n });
await call(steward, ids.contract, "sync_member", { account_id: ids.steward }, { tgas: 60 });

step("members' vote #1: appoint the founder as the Agent Market steward");
await decide(steward, [steward], daoId, "Appoint the founder as the Agent Market steward",
  fnCall(ids.contract, "set_steward", { steward: ids.steward }));
await call(steward, ids.contract, "bond_steward", {}, { deposit: NEAR });

const info = await view(ids.contract, "get_info");
const deployment = { network: NETWORK, tag, usdc: USDC, dao: daoId, ...ids, configHash, configUri: configFile };
fs.writeFileSync(LOCAL_DEPLOYMENT, JSON.stringify(deployment, null, 2));
console.log(`\n✔ deployed\n  contract ${accountUrl(ids.contract)}\n  dao      ${accountUrl(daoId)}`);
console.log(`  members ${info.members}, steward ${info.steward}, bond ${info.steward_bond}`);
console.log(`  wrote ${path.relative(ROOT, LOCAL_DEPLOYMENT)}`);
