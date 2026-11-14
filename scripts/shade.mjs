// node scripts/shade.mjs <worker account> '<measurements json>' <ppid>   the members admit a Shade Agent, by two votes
//
// The worker (agent/tee-worker.mjs in a Phala TDX VM, compose agent/phala-compose.yml) printed its implicit account and
// its measurements, and its first registration was refused because its machine's PPID was not approved. The members:
//   1. tell the TEE registry (which their DAO owns) that this code and this machine are trusted;
//   2. add the worker as an agent of the co-op (translation and localization jobs) and mark it TEE-only, so its
//      receipts count only while the registry says its attestation holds.
// Then the worker registers on its own (the registry verifies the TDX quote on-chain and tells the co-op) and works.
import fs from "node:fs";
import path from "node:path";
import { DEPLOYMENT, ROOT, account, b64, decide, view } from "./lib.mjs";

const [worker, measurementsJson, ppid] = process.argv.slice(2);
const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const R = dep.tee.registry;
const voters = ["kop-alice-mw4i3w8f.testnet", "kop-bob-mw4i3w8f.testnet", dep.steward].map(account);
const act = (method_name, args, tgas = 30) => ({ method_name, args: b64(args), deposit: "0", gas: String(BigInt(tgas) * 10n ** 12n) });
const measurements = JSON.parse(measurementsJson);

const a = await decide(voters[0], voters, dep.dao,
  `Shade Agent: trust this code (compose hash ${measurements.app_compose_hash_payload.slice(0, 16)}…, agent/phala-compose.yml at a pinned commit) and this TDX machine (PPID ${ppid}) in our TEE registry`,
  { FunctionCall: { receiver_id: R, actions: [act("approve_measurements", { measurements }), act("approve_ppids", { ppids: [ppid] })] } });
console.log(`#${a.id}: registry ${R} approves the code and the machine`);
const agents = (await view(dep.contract, "get_agents")).filter((x) => x.account !== dep.agent && x.account !== worker);
const b = await decide(voters[0], voters, dep.dao,
  `Shade Agent ${worker.slice(0, 12)}…: a further agent for translation and localization, TEE-only (its receipts count only while its attestation holds)`,
  { FunctionCall: { receiver_id: dep.contract, actions: [
    act("set_agents", { agents: [...agents, { account: worker, tags: ["translation", "localization"] }] }),
    act("set_agent_tee", { account_id: worker, required: true }),
  ] } });
console.log(`#${b.id}: ${worker} is an agent, TEE-only:`, JSON.stringify(await view(dep.contract, "get_agent_tee", { account_id: worker })));
for (const f of [DEPLOYMENT, path.join(ROOT, "web/deployment.json")]) {
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  d.tee = { ...d.tee, worker, ppid, compose_hash: measurements.app_compose_hash_payload, approve: a.id, admit: b.id };
  fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
}
