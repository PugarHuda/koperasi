// The agent's NEAR Intents wallet, owned by the co-op's DAO itself (testnet, through Tidepool's Agent API, which mirrors
// the NEAR Intents Agent API: https://www.usetidepool.tech/docs/guides/agent-api).
//
//   node scripts/intents.mjs create          members vote: the DAO creates the agent's wallet with the policy below
//   node scripts/intents.mjs grant           members vote: the DAO issues the agent its (revocable) grant
//   node scripts/intents.mjs freeze|unfreeze members vote: the DAO freezes or unfreezes the agent's wallet
//   node scripts/intents.mjs status          the wallet, its policy, balances and history (read only)
//   node scripts/intents.mjs refused         what the policy refuses, shown live (a non-member, over the limit)
//   node scripts/intents.mjs deposit         the address to fund the wallet (test tokens: https://app.usetidepool.tech/faucet)
//   node scripts/intents.mjs pay <member|0x…> <USDC> [base]   the agent pays a member (on NEAR, or on Base Sepolia)
//
// The owner is the DAO's Ethereum address from NEAR Chain Signatures: it has no private key, so every owner intent
// (create, grant, policy, freeze) is an ERC-191 message the MPC network signs only when the DAO calls it, by a members'
// vote (scripts/chainsig.mjs). The policy mirrors the by-laws: pay only members, a 10-minute timelock like the voted veto
// window, a daily USD budget and a per-payment cap. Env: TIDEPOOL_KEY (free: POST https://www.usetidepool.tech/v1/keys).
// Testnet only: Tidepool is community-built, not affiliated with NEAR; its tokens have no value.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { baseDecode } from "near-api-js";
import { DEPLOYMENT, ROOT, view } from "./lib.mjs";
import { PATH, SIGNER, daoAddress, eip191, recover, signByVote } from "./chainsig.mjs";

const BASE = "https://www.usetidepool.tech/v1";
const KEY = process.env.TIDEPOOL_KEY;
const GRANT_FILE = path.join(ROOT, ".keys", "tidepool-grant.json"); // the agent's grant token (.keys/ is not committed)
const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const save = () => fs.writeFileSync(DEPLOYMENT, JSON.stringify(dep, null, 2) + "\n");
const USDC = "nep141:usdc.tidepool-sandbox.testnet";
const BASE_USDC = "nep141:base-0x38d81431b9f76d9699af7517040d5221d9dea252.tp-omft.testnet";
const BOB = "kop-bob-mw4i3w8f.testnet";

/** @param {string} method @param {string} p @param {{ body?: any, grant?: string }} [opts] */
async function api(method, p, { body, grant } = {}) {
  if (!KEY) throw new Error("set TIDEPOOL_KEY (free: POST https://www.usetidepool.tech/v1/keys)");
  const res = await fetch(BASE + p, { method, headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`,
    ...(grant ? { "x-grant-token": grant } : {}), ...(method === "POST" ? { "idempotency-key": `kop-${crypto.randomUUID()}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const status = async (id) => (await api("GET", `/status?correlation_id=${id}&wait_ms=30000`)).json;

/** The DAO as an EVM owner: its Chain Signatures address and public key (uncompressed). */
async function owner() {
  const pk = await view(SIGNER, "derived_public_key", { path: PATH, predecessor: dep.dao, domain_id: 0 });
  return { type: "evm", address: await daoAddress(dep.dao), chain_id: 11155111, public_key: `0x04${Buffer.from(baseDecode(pk.split(":")[1])).toString("hex")}` };
}

/** An owner intent, signed by the DAO only after the members vote for it; returns its final status. */
async function byVote(type, body, why) {
  const g = await api("POST", "/generate-intent", { body: { type, ...body } });
  if (g.status !== 201) throw new Error(`generate-intent ${type}: ${g.status} ${JSON.stringify(g.json).slice(0, 300)}`);
  const message = g.json.intent.payload.message.intent;
  const hash = eip191(message);
  const digest = crypto.createHash("sha256").update(message).digest("hex");
  const { id, tx, sig } = await signByVote(hash, `NEAR Intents (Tidepool testnet): ${why}. The DAO signs, as owner of the agent's wallet, the ${type} intent whose text has sha256 ${digest}`);
  const me = await daoAddress(dep.dao);
  if (recover(hash, sig) !== me) throw new Error(`the signature recovers ${recover(hash, sig)}, not the DAO's ${me}`);
  // an Ethereum personal_sign signature: r ‖ s (low half) ‖ v
  const N = secp256k1.Point.CURVE().n;
  let s = BigInt(`0x${sig.s.scalar}`), v = sig.recovery_id;
  if (s > N / 2n) { s = N - s; v ^= 1; }
  const signature = `0x${sig.big_r.affine_point.slice(2)}${s.toString(16).padStart(64, "0")}${(27 + v).toString(16)}`;
  const sub = await api("POST", "/submit-intent", { body: { type, correlation_id: g.json.correlation_id, signed_data: { standard: "erc191", payload: { message }, signature } } });
  if (sub.status !== 202) throw new Error(`submit-intent ${type}: ${sub.status} ${JSON.stringify(sub.json).slice(0, 300)}`);
  const st = await status(g.json.correlation_id);
  if (st.status !== "SUCCESS") throw new Error(`${type}: ${st.status} ${st.failure_code ?? ""}`);
  console.log(`${type}: signed by vote #${id} (NEAR tx ${tx}), accepted by the Agent API`);
  return { st, proposal: id, tx, digest };
}

const cmd = process.argv[2];
const w = dep.intents;
if (cmd === "create") {
  if (w?.agent_id) throw new Error(`the wallet exists: ${w.agent_id}`);
  const policy = await view(dep.dao, "get_policy");
  const members = policy.roles.find((r) => r.name === "member").kind.Group;
  const bobEvm = await daoAddress(BOB); // bob's own Chain Signatures address, the same on every EVM chain
  const rule = {
    frozen: false, confidential: false, owner_approval: false, actions: ["transfer", "withdraw", "swap"],
    assets: [USDC, BASE_USDC],
    limits: { per_transaction: { [USDC]: "5000000", [BASE_USDC]: "5000000" } },
    max_actions_per_hour: 10,
    destinations: { mode: "only", list: [...members.map((m) => ({ action: "transfer", address: m, confidential: false })),
      { action: "withdraw", chain: "base", address: bobEvm, memo: null }] },
    budget: { daily_usd: "10", weekly_usd: null, monthly_usd: null },
    timelock_ms: 600_000, // as the members' veto window (#62): every payout waits 10 minutes, the DAO can freeze it meanwhile
  };
  const r = await byVote("agent_create", { name: "koperasi agent", owner: await owner(), policy: rule },
    `create the agent's wallet: pays only the ${members.length} members (and bob on Base Sepolia), at most 5 USDC a payment and $10 a day, each payout held 10 minutes`);
  dep.intents = { provider: "Tidepool (testnet mirror of the NEAR Intents Agent API)", api: BASE, agent_id: r.st.details?.agent_id ?? r.st.agent_id,
    owner: (await owner()).address, created: { proposal: r.proposal, tx: r.tx, intent_sha256: r.digest } };
  save();
  console.log(JSON.stringify(dep.intents, null, 1));
} else if (cmd === "grant") {
  const token = `ngt_${crypto.randomBytes(32).toString("base64url").slice(0, 43)}`;
  const r = await byVote("grant_issue", { agent_id: w.agent_id, label: "koperasi agent runtime", credential: crypto.createHash("sha256").update(token).digest("hex"),
    expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString() }, "let the agent act inside the wallet's policy for 30 days (revocable by another vote)");
  fs.writeFileSync(GRANT_FILE, JSON.stringify({ agent_id: w.agent_id, token }));
  w.grant = { proposal: r.proposal, tx: r.tx, intent_sha256: r.digest };
  save();
} else if (cmd === "freeze" || cmd === "unfreeze") {
  const r = await byVote(`agent_${cmd}`, { agent_id: w.agent_id }, `${cmd} the agent's wallet`);
  w[cmd] = { proposal: r.proposal, tx: r.tx };
  save();
} else if (cmd === "status") {
  for (const p of ["", "/policy", "/balances", "/grants", "/history"]) console.log(p || "/", JSON.stringify((await api("GET", `/agents/${w.agent_id}${p}`)).json).slice(0, 900));
} else if (cmd === "deposit") {
  const r = await api("POST", `/agents/${w.agent_id}/deposit`, { body: { origin_asset: USDC, amount: "10000000", dry: true } });
  console.log(JSON.stringify(r.json, null, 1));
} else if (cmd === "refused") {
  const { token } = JSON.parse(fs.readFileSync(GRANT_FILE, "utf8"));
  for (const [what, body] of [
    ["pay someone who is not a member", { asset: USDC, amount: "1000000", recipient: "stranger.testnet" }],
    ["pay a member more than 5 USDC at once", { asset: USDC, amount: "6000000", recipient: BOB }],
  ]) {
    const r = await api("POST", `/agents/${w.agent_id}/transfer`, { body, grant: token });
    console.log(`${what}: HTTP ${r.status} ${r.json.errors?.[0]?.code ?? r.json.status ?? ""}`);
  }
} else if (cmd === "pay") {
  const { token } = JSON.parse(fs.readFileSync(GRANT_FILE, "utf8"));
  const [to, amount, chain] = process.argv.slice(3);
  const units = String(Math.round(Number(amount) * 1e6));
  let r;
  if (chain === "base") {
    const sw = await api("POST", `/agents/${w.agent_id}/swap`, { body: { origin_asset: USDC, destination_asset: BASE_USDC, amount: units }, grant: token });
    const s1 = await status(sw.json.correlation_id);
    console.log("swap to Base Sepolia USDC:", s1.status, s1.details?.amount_out ?? s1.failure_code);
    r = await api("POST", `/agents/${w.agent_id}/withdraw`, { body: { asset: BASE_USDC, amount: s1.details.amount_out, chain: "base", recipient: to.startsWith("0x") ? to : await daoAddress(to) }, grant: token });
  } else {
    r = await api("POST", `/agents/${w.agent_id}/transfer`, { body: { asset: USDC, amount: units, recipient: to }, grant: token });
  }
  console.log(`payout: HTTP ${r.status}`, JSON.stringify(r.json).slice(0, 300));
  if (r.json.correlation_id) {
    (w.payouts ??= []).push({ to, amount, chain: chain ?? "near", correlation_id: r.json.correlation_id, at: new Date().toISOString() });
    save();
    console.log("held by the 10-minute timelock; then: node scripts/intents.mjs status");
  }
} else {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(0, 16).join("\n"));
}
