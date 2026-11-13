// node scripts/agents.mjs [account] [vote]   a second agent for the showcase co-op (contract 0.3.1, `set_agents`)
//   account: opens kop-translator-<tag>.testnet, gives it one function-call key that may only call record_receipt and
//            update_receipt on the co-op's contract, and deletes its full-access key: like the founding agent, it can
//            do nothing else, not even move its own NEAR
//   vote:    the members vote it an agent for translation and localization jobs
// Then: KOP_AGENT=<it> node --env-file=.env scripts/job.mjs 1   (a localization job, which it alone takes)
import fs from "node:fs";
import path from "node:path";
import { KeyPair } from "near-api-js";
import { DEPLOYMENT, NEAR, ROOT, account, decide, faucetAccount, fnCall, rawQuery, saveKey, view } from "./lib.mjs";

const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const want = process.argv.slice(2);
const run = (p) => !want.length || want.includes(p);
let id = dep.agents?.translator;

if (run("account") && !id) {
  id = `kop-translator-${Date.now().toString(36)}.testnet`;
  const a = await faucetAccount(id);
  const full = (await rawQuery({ request_type: "view_access_key_list", account_id: id })).keys.map((k) => k.public_key);
  const fc = KeyPair.fromRandom("ed25519");
  await a.addFunctionCallAccessKey({ publicKey: fc.getPublicKey(), contractId: dep.contract, methodNames: ["record_receipt", "update_receipt"],
    allowance: NEAR / 4n });
  saveKey(id, fc); // from now on the account is used only through this key
  for (const k of full) await a.deleteKey(k); // signed with the full-access key itself, its last act
  console.log(`${id}: one function-call key (record_receipt, update_receipt on ${dep.contract}), full-access keys deleted`);
  for (const f of [DEPLOYMENT, path.join(ROOT, "web/deployment.json")]) {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    fs.writeFileSync(f, JSON.stringify({ ...d, agents: { ...d.agents, translator: id } }, null, 2) + "\n");
  }
}

if (run("vote")) {
  const voters = ["kop-alice-mw4i3w8f.testnet", "kop-bob-mw4i3w8f.testnet", dep.steward].map(account);
  const { id: pid } = await decide(voters[0], voters, dep.dao, `A second agent: ${id} takes translation and localization jobs, under the same by-laws and court`,
    fnCall(dep.contract, "set_agents", { agents: [{ account: id, tags: ["translation", "localization"] }] }, { tgas: 30 }));
  console.log(`proposal #${pid} approved:`, JSON.stringify(await view(dep.contract, "get_agents")));
  for (const f of [DEPLOYMENT, path.join(ROOT, "web/deployment.json")]) {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    fs.writeFileSync(f, JSON.stringify({ ...d, agents: { ...d.agents, vote: pid } }, null, 2) + "\n");
  }
}
