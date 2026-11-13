// node agent/tee-worker.mjs   the co-op's agent as a Shade Agent: run inside an Intel TDX confidential VM (Phala Cloud)
//
// Its NEAR key is derived inside the TEE (shade-agent-js, with dstack's randomness), so its account is the implicit
// account of a key nobody outside the TEE has. It registers with the co-op's TEE registry (tee-registry/), which
// verifies the attestation on-chain: genuine up-to-date TDX, report data = this account, and the code (the compose
// file, which pins this repo at a commit) one the co-op's members approved. The registry tells the co-op's contract; an
// agent the members marked TEE-only records receipts only while that holds. Then it works like the founding agent:
// the voted by-laws checked in the OutLayer enclave, the job done on a TEE-verified model, a receipt on-chain.
//
// Env (Phala encrypted env vars): KOP_TEE_REGISTRY, KOP_SPONSOR_ID, KOP_SPONSOR_KEY (an account that funds the worker
// once, 1 NEAR), NEARAI_API_KEY. Outside a TEE it says so and stops: it never registers a fake attestation.
import fs from "node:fs";
import path from "node:path";
import { ShadeClient } from "@neardefi/shade-agent-js";
import { ROOT, sleep, view } from "../scripts/lib.mjs";

const REGISTRY = process.env.KOP_TEE_REGISTRY;
const dep = JSON.parse(fs.readFileSync(path.join(ROOT, "deployment.testnet.json"), "utf8"));
const log = (...a) => console.log(new Date().toISOString(), ...a);

if (!fs.existsSync("/var/run/dstack.sock")) {
  log("not in a dstack TEE (/var/run/dstack.sock missing): nothing to attest, stopping");
  process.exit(1);
}
const agent = await ShadeClient.create({
  networkId: "testnet",
  agentContractId: REGISTRY,
  sponsor: { accountId: process.env.KOP_SPONSOR_ID, privateKey: process.env.KOP_SPONSOR_KEY },
});
const me = agent.accountId();
log(`worker account ${me} (implicit: its key was made inside this TEE)`);

// what the members approve: printed from this VM's own TCB info, so they can compare it with the compose file
const att = await agent.getAttestation();
const ev = (name) => att.tcb_info.event_log.find((e) => e.event === name)?.digest;
log("measurements to approve:", JSON.stringify({
  rtmrs: { mrtd: att.tcb_info.mrtd, rtmr0: att.tcb_info.rtmr0, rtmr1: att.tcb_info.rtmr1, rtmr2: att.tcb_info.rtmr2 },
  key_provider_event_digest: ev("key-provider"), app_compose_hash_payload: att.tcb_info.compose_hash,
}));

if (BigInt((await agent.balance?.().catch(() => null)) ?? 0) < 5n * 10n ** 23n) {
  await agent.fund(1).then(() => log("funded with 1 NEAR by the sponsor"), (e) => log(`funding: ${e.message}`));
}

// register until the members have approved this code and machine (the refusal names the PPID or measurement found)
for (;;) {
  try {
    await agent.register();
    break;
  } catch (e) {
    log(`not registered yet: ${String(e.message).slice(0, 400)}`);
    await sleep(60_000);
  }
}
const reg = await view(REGISTRY, "get_agent", { account_id: me });
log(`registered: attestation verified on-chain by ${REGISTRY}, valid until ${new Date(Number(BigInt(reg.valid_until) / 1_000_000n)).toISOString()}`);

// work: the key stays in this VM (written to its own disk for the runtime's signer, never sent anywhere)
const [key] = agent.getPrivateKeys({ acknowledgeRisk: true });
fs.mkdirSync(path.join(ROOT, ".keys"), { recursive: true });
fs.writeFileSync(path.join(ROOT, ".keys", `${me}.json`), JSON.stringify({ account_id: me, private_key: key }));
process.env.KOP_AGENT = me;
process.env.KOP_GATE_PAYER = me;
for (;;) {
  const { tee } = await view(dep.contract, "get_agent_tee", { account_id: me }).then(([required, att2]) => ({ tee: { required, att2 } }));
  if (tee.required && tee.att2) break;
  log("waiting for the co-op to mark this agent TEE-only and note its attestation");
  await sleep(60_000);
}
const { startMockMarket } = await import("./mock-market.mjs");
const { runOnce } = await import("./runtime.mjs");
process.env.KOP_MARKET_URL = "http://localhost:8787";
process.env.KOP_MARKET_TOKEN = "aat_mock";
const mock = await startMockMarket();
mock.addJob({ title: "Localization: a co-op's notice, English to Indonesian", tags: ["localization", "translation"], budgetAmount: "5",
  description: "Translate into Indonesian, plainly, for village members: \"The members' meeting is on the first Saturday of the month. Every member has one vote. Bring your questions about the accounts.\" Under 50 words." });
for (let i = 0; i < 3; i++) {
  await runOnce({ dep, log });
  await sleep(2500);
}
mock.server.close();
log("done: the receipt above was recorded from inside this TEE");
for (;;) await sleep(3_600_000); // keep the VM up for its logs and attestation
