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
//   node scripts/intents.mjs policy          members vote: the wallet's destinations become the members' own payout routes
//                                            (set on the contract with set_payout_route: NEAR, Base, Arbitrum or Ethereum)
//   node scripts/intents.mjs share <USDC>    the agent shares USDC from its wallet with the members, split by the
//                                            contract's voted share rule, each part paid on the member's own route
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
import { splitShare } from "../web/share.js";
import { DEPLOYMENT, ROOT, view } from "./lib.mjs";
import { PATH, SIGNER, daoAddress, eip191, recover, signByVote } from "./chainsig.mjs";

const BASE = "https://www.usetidepool.tech/v1";
const KEY = process.env.TIDEPOOL_KEY;
const GRANT_FILE = path.join(ROOT, ".keys", "tidepool-grant.json"); // the agent's grant token (.keys/ is not committed)
const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
// only the intents part, over the files as they are now: a long payout must not undo what other scripts saved meanwhile
const save = () => {
  for (const f of [DEPLOYMENT, path.join(ROOT, "web/deployment.json")]) {
    const now = JSON.parse(fs.readFileSync(f, "utf8"));
    fs.writeFileSync(f, JSON.stringify({ ...now, intents: dep.intents }, null, 2) + "\n");
  }
};
const USDC = "nep141:usdc.tidepool-sandbox.testnet";
const BASE_USDC = "nep141:base-0x38d81431b9f76d9699af7517040d5221d9dea252.tp-omft.testnet";
const BOB = "kop-bob-mw4i3w8f.testnet";
/** Testnet USDC per chain a member can route payouts to (Tidepool's /v1/tokens, 13 Nov 2026). */
export const CHAIN_USDC = { near: USDC, base: BASE_USDC, arb: "nep141:arb-0x38d81431b9f76d9699af7517040d5221d9dea252.tp-omft.testnet",
  eth: "nep141:eth-0x2e6ad9e6d59bb4585ea0e6762c3b637dde29dad2.tp-omft.testnet" };
const CAP = "5000000"; // 5 USDC a payment, on every chain

/**
 * The wallet's policy from the members and their routes: pay a member only on NEAR or at the route they set on the
 * contract, at most 5 USDC a payment and $10 a day, each payout held 10 minutes (as the members' veto window, #62).
 * @param {string[]} members @param {[string, string, string][]} routes (account, chain, address)
 */
export function policyFor(members, routes) {
  const ok = routes.filter(([a, c]) => members.includes(a) && c !== "near" && CHAIN_USDC[c]);
  const assets = [USDC, ...[...new Set(ok.map(([, c]) => c))].sort().map((c) => CHAIN_USDC[c])];
  return {
    frozen: false, confidential: false, owner_approval: false, actions: ["transfer", "withdraw", "swap"], assets,
    limits: { per_transaction: Object.fromEntries(assets.map((a) => [a, CAP])) },
    max_actions_per_hour: 10,
    destinations: { mode: "only", list: [...members.map((m) => ({ action: "transfer", address: m, confidential: false })),
      ...ok.map(([, chain, address]) => ({ action: "withdraw", chain, address, memo: null }))] },
    budget: { daily_usd: "10", weekly_usd: null, monthly_usd: null },
    timelock_ms: 600_000,
  };
}

/** @param {string} method @param {string} p @param {{ body?: any, grant?: string }} [opts] */
async function api(method, p, { body, grant } = {}) {
  if (!KEY) throw new Error("set TIDEPOOL_KEY (free: POST https://www.usetidepool.tech/v1/keys)");
  const res = await fetch(BASE + p, { method, signal: AbortSignal.timeout(60_000), headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`,
    ...(grant ? { "x-grant-token": grant } : {}), ...(method === "POST" ? { "idempotency-key": `kop-${crypto.randomUUID()}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const status = async (id) => (await api("GET", `/status?correlation_id=${id}&wait_ms=30000`)).json;
/** Until the action is done: held work (the 10-minute timelock) is QUEUED first. */
async function done(id, what) {
  for (let i = 0; i < 40; i++) {
    const st = await status(id);
    // an unreadable answer is not a result: it must not be booked as a payout
    if (typeof st.status !== "string") throw new Error(`${what}: the Agent API gave no status (${JSON.stringify(st).slice(0, 200)})`);
    if (!["QUEUED", "PROCESSING", "PENDING", "PENDING_APPROVAL"].includes(st.status)) return st;
    if (i % 4 === 0) console.log(`${what}: ${st.status}${st.details?.execute_after ? ` until ${st.details.execute_after}` : ""}`);
  }
  throw new Error(`${what}: still not done after 20 minutes`);
}

/** The DAO as an EVM owner: its Chain Signatures address and public key (uncompressed). */
async function owner() {
  const pk = await view(SIGNER, "derived_public_key", { path: PATH, predecessor: dep.dao, domain_id: 0 });
  return { type: "evm", address: await daoAddress(dep.dao), chain_id: 11155111, public_key: `0x04${Buffer.from(baseDecode(pk.split(":")[1])).toString("hex")}` };
}

const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const sorted = (x) => (Array.isArray(x) ? x.map(sorted) : x && typeof x === "object"
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sorted(x[k])])) : x);
const TOP = new Set(["domain", "network", "type", "agent_id", "owner", "tenant_id", "expires_at", "nonce", "details"]);
/** What each owner intent's details may carry (read from the Agent API's own previews, 12 Nov 2026). */
const DETAILS = {
  agent_create: new Set(["name", "policy", "policy_hash"]),
  grant_issue: new Set(["label", "credential", "expires_at"]),
  agent_freeze: new Set(["expected_revision", "policy_hash"]),
  agent_unfreeze: new Set(["expected_revision", "policy_hash"]),
  policy_update: new Set(["expected_revision", "policy_hash", "policy"]),
};
/**
 * Throws unless the intent text the API returned is the one asked for: its domain and network, the type, the DAO as
 * owner, the agent, and every field asked for present and unchanged, and nothing else.
 * @param {string} message @param {string} type @param {any} body @param {string} owner
 */
export function refuseUnlessAsked(message, type, body, owner) {
  let t;
  try { t = JSON.parse(message); } catch { throw new Error(`refusing to sign: the ${type} intent is not JSON`); }
  const bad = [];
  if (t.domain !== "tidepool-agent-api.v1" || t.network !== "testnet") bad.push(`domain ${t.domain}/${t.network}`);
  if (t.type !== type) bad.push(`type ${t.type}`);
  if (String(t.owner).toLowerCase() !== owner.toLowerCase()) bad.push(`owner ${t.owner}`);
  if (body.agent_id && t.agent_id !== body.agent_id) bad.push(`agent ${t.agent_id}`);
  // nothing beyond what an intent of this type carries: an extra field could widen what the DAO grants
  const extra = Object.keys(t).filter((k) => !TOP.has(k));
  if (extra.length) bad.push(`unexpected fields ${extra.join(", ")}`);
  const d = t.details ?? {};
  const allowed = DETAILS[type];
  if (!allowed) bad.push(`no rule for a ${type} intent`);
  const unknown = Object.keys(d).filter((k) => !allowed?.has(k));
  if (unknown.length) bad.push(`unexpected details ${unknown.join(", ")}`);
  // every field asked for must be there, unchanged: a missing expiry or credential is a different grant
  for (const k of ["policy", "credential", "expires_at", "label", "name", "expected_revision"]) {
    if (body[k] !== undefined && !same(body[k], d[k])) bad.push(d[k] === undefined ? `${k} missing` : `${k} differs`);
  }
  if ((type === "agent_create" || type === "policy_update") && !same(d.policy, body.policy)) bad.push("the policy is not the one asked for");
  if (type === "grant_issue" && d.credential !== body.credential) bad.push("the grant credential is not ours");
  if (bad.length) throw new Error(`refusing to sign the ${type} intent: ${bad.join("; ")}`);
}

/** An owner intent, signed by the DAO only after the members vote for it; returns its final status. */
async function byVote(type, body, why) {
  const g = await api("POST", "/generate-intent", { body: { type, ...body } });
  if (g.status !== 201) throw new Error(`generate-intent ${type}: ${g.status} ${JSON.stringify(g.json).slice(0, 300)}`);
  const message = g.json.intent.payload.message.intent;
  const me = await daoAddress(dep.dao);
  // never sign what the API wrote without reading it: the text must say exactly what was asked, or nothing is proposed
  refuseUnlessAsked(message, type, body, me);
  const hash = eip191(message);
  const digest = crypto.createHash("sha256").update(message).digest("hex");
  // the whole text goes in the proposal, so the members vote on what is signed, not on a summary of it
  const { id, tx, sig } = await signByVote(hash, `NEAR Intents (Tidepool testnet): ${why}. The DAO signs, as owner of the agent's wallet, this ${type} intent (sha256 ${digest}): ${message}`);
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

/**
 * The agent pays `units` USDC from its wallet: a transfer on NEAR, or a swap to that chain's USDC and a withdrawal to
 * `address`. The policy refuses anything the members did not list. Returns what landed.
 * @param {bigint} units @param {string} chain @param {string} address
 */
async function payout(units, chain, address) {
  const { token } = JSON.parse(fs.readFileSync(GRANT_FILE, "utf8"));
  let r;
  if (chain !== "near") {
    const asset = CHAIN_USDC[chain];
    if (!asset) throw new Error(`no USDC on ${chain}`);
    const sw = await api("POST", `/agents/${w.agent_id}/swap`, { body: { origin_asset: USDC, destination_asset: asset, amount: String(units) }, grant: token });
    if (!sw.json.correlation_id) throw new Error(`swap: HTTP ${sw.status} ${JSON.stringify(sw.json).slice(0, 300)}`);
    const s1 = await done(sw.json.correlation_id, `swap to ${chain} USDC`);
    if (s1.status !== "SUCCESS" || !/^\d+$/.test(String(s1.details?.amount_out))) throw new Error(`swap: ${s1.status} ${s1.failure_code ?? ""}: nothing to withdraw`);
    console.log(`swap to ${chain} USDC:`, s1.status, s1.details.amount_out);
    r = await api("POST", `/agents/${w.agent_id}/withdraw`, { body: { asset, amount: s1.details.amount_out, chain, recipient: address }, grant: token });
  } else {
    r = await api("POST", `/agents/${w.agent_id}/transfer`, { body: { asset: USDC, amount: String(units), recipient: address }, grant: token });
  }
  console.log(`payout on ${chain} to ${address}: HTTP ${r.status}`, JSON.stringify(r.json).slice(0, 300));
  if (!r.json.correlation_id) throw new Error(`payout: HTTP ${r.status} ${JSON.stringify(r.json.errors ?? r.json).slice(0, 200)}`);
  const st = await done(r.json.correlation_id, "payout");
  console.log("payout:", st.status, JSON.stringify(st.details ?? {}).slice(0, 400));
  return { address, amount: Number(units) / 1e6, chain, status: st.status, tx: st.details?.tx_hash ?? null,
    destination_chain: st.details?.destination_chain ?? null, destination_tx: st.details?.destination_tx_hash ?? null, at: new Date().toISOString() };
}

const cmd = import.meta.main ? process.argv[2] : "imported"; // imported by the unit tests: no command runs
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
  const [to, amount, chain = "near"] = process.argv.slice(3);
  const address = to.startsWith("0x") ? to : chain === "near" ? to : await daoAddress(to);
  const p = await payout(BigInt(Math.round(Number(amount) * 1e6)), chain, address);
  (w.payouts ??= []).push({ ...p, to, amount: Number(amount) });
  save();
} else if (cmd === "policy") {
  const members = (await view(dep.dao, "get_policy")).roles.find((r) => r.name === "member").kind.Group;
  const routes = await view(dep.contract, "get_payout_routes");
  const policy = policyFor(members, routes);
  const cur = (await api("GET", `/agents/${w.agent_id}/policy`)).json;
  if (!Number.isInteger(cur.revision)) throw new Error(`policy: no revision (${JSON.stringify(cur).slice(0, 200)})`);
  const where = routes.map(([a, c, x]) => `${a.split(".")[0]} on ${c} (${x})`).join(", ") || "none";
  const r = await byVote("policy_update", { agent_id: w.agent_id, policy, expected_revision: cur.revision },
    `the agent's wallet pays the ${members.length} members on NEAR, or on the route each set on the contract (${where}), at most 5 USDC a payment and $10 a day, each payout held 10 minutes`);
  w.policy = { proposal: r.proposal, tx: r.tx, intent_sha256: r.digest, revision: cur.revision + 1, routes };
  save();
} else if (cmd === "share") {
  const units = BigInt(Math.round(Number(process.argv[3]) * 1e6));
  if (!(units > 0n)) throw new Error("share <USDC>: a positive amount");
  const info = await view(dep.contract, "get_info");
  const roster = await view(dep.contract, "get_members", { from: 0, limit: 100 });
  const routes = await view(dep.contract, "get_payout_routes");
  const { shares, reserve } = splitShare(units, info.share_rule, roster);
  console.log(`share ${process.argv[3]} USDC by the voted rule (${JSON.stringify(info.share_rule)}); ${Number(reserve) / 1e6} USDC stays in the wallet as the reserve`);
  const payouts = [];
  for (const { account, share } of shares.filter((x) => x.share > 0n)) {
    const [, chain = "near", address = account] = routes.find(([a]) => a === account) ?? [];
    try {
      payouts.push({ ...(await payout(share, chain, address)), to: account });
    } catch (e) {
      console.error(`${account}: ${e.message}`);
      payouts.push({ to: account, address, amount: Number(share) / 1e6, chain, status: "NOT_SENT", error: e.message.slice(0, 200), at: new Date().toISOString() });
    }
  }
  (w.shares ??= []).push({ amount: Number(units) / 1e6, rule: info.share_rule, reserve: Number(reserve) / 1e6, payouts, at: new Date().toISOString() });
  save();
} else if (cmd !== "imported") {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(0, 16).join("\n"));
}
