// NEAR helpers for Koperasi scripts: accounts (testnet faucet), contract calls, Sputnik DAO proposals.
import { Account, FailoverRpcProvider, JsonRpcProvider, KeyPair, teraToGas } from "near-api-js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ROOT = path.join(import.meta.dirname, "..");
export const NETWORK = process.env.NEAR_NETWORK ?? "testnet";
const RPCS = {
  testnet: ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org", "https://rpc.testnet.near.org"],
  mainnet: ["https://free.rpc.fastnear.com", "https://near.drpc.org", "https://rpc.mainnet.near.org"],
};
export const RPC = process.env.NEAR_RPC ?? RPCS[NETWORK][0];
export const SPUTNIK_FACTORY = NETWORK === "mainnet" ? "sputnik-dao.near" : "sputnik-v2.testnet";
export const provider = new FailoverRpcProvider(
  [RPC, ...RPCS[NETWORK].filter((u) => u !== RPC)].map((url) => new JsonRpcProvider({ url })),
);
export const NEAR = 10n ** 24n;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEYS = path.join(ROOT, ".keys");
// the showcase co-op (the one the web page reads); the demo and fresh deploys use their own local file
export const DEPLOYMENT = path.join(ROOT, `deployment.${NETWORK}.json`);
export const LOCAL_DEPLOYMENT = path.join(ROOT, `deployment.${NETWORK}.local.json`);

export const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
export const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64");

// ---------- accounts ----------

const keyFile = (id) => path.join(KEYS, `${id}.json`);

export function saveKey(accountId, keyPair) {
  fs.mkdirSync(KEYS, { recursive: true });
  fs.writeFileSync(keyFile(accountId), JSON.stringify({ account_id: accountId, private_key: keyPair.toString() }, null, 2));
}

export const hasKey = (id) => fs.existsSync(keyFile(id));

export function account(accountId) {
  const { private_key } = JSON.parse(fs.readFileSync(keyFile(accountId), "utf8"));
  return new Account(accountId, provider, private_key);
}

/** Funded testnet account from the public faucet helper (the one near-cli uses). */
export async function faucetAccount(accountId) {
  if (NETWORK !== "testnet") throw new Error(`no faucet on ${NETWORK}: create and fund ${accountId} yourself`);
  const kp = KeyPair.fromRandom("ed25519");
  const res = await fetch("https://helper.nearprotocol.com/account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: kp.getPublicKey().toString() }),
  });
  if (!res.ok) throw new Error(`faucet ${res.status}: ${await res.text()}`);
  saveKey(accountId, kp);
  await sleep(1500);
  return account(accountId);
}

/**
 * Testnet funders for when the faucet rate-limits (429): set KOP_FUNDER_KEYS to a directory of
 * {account_id, private_key} json files. New accounts are created through the `testnet` registrar.
 */
function funders() {
  const dir = process.env.KOP_FUNDER_KEYS;
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
    const { account_id, private_key } = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    return new Account(account_id, provider, private_key);
  });
}

export async function registrarAccount(accountId, near = 8n) {
  const need = near * NEAR + NEAR / 2n;
  for (const f of funders()) {
    const { amount } = await provider.viewAccount({ accountId: f.accountId, blockQuery: { finality: "final" } });
    if (BigInt(amount) < need) continue;
    const kp = KeyPair.fromRandom("ed25519");
    await call(f, "testnet", "create_account", { new_account_id: accountId, new_public_key: kp.getPublicKey().toString() }, { deposit: near * NEAR });
    saveKey(accountId, kp);
    return account(accountId);
  }
  throw new Error("no funder with enough NEAR: set KOP_FUNDER_KEYS or wait for the faucet");
}

export async function ensureAccount(id, near = 8n) {
  if (hasKey(id)) return account(id);
  try {
    return await faucetAccount(id);
  } catch (e) {
    if (!String(e.message).includes("429")) throw e;
    return registrarAccount(id, near);
  }
}

// ---------- calls ----------

export async function view(contractId, method, args = {}) {
  return provider.callFunction({ contractId, method, args, blockQuery: { finality: "optimistic" } });
}

export async function call(acct, contractId, method, args = {}, { deposit = 0n, tgas = 100 } = {}) {
  return acct.callFunction({ contractId, methodName: method, args, deposit, gas: teraToGas(tgas) });
}

/** Full outcome, for logs and tx hashes. */
export async function callRaw(acct, contractId, method, args = {}, { deposit = 0n, tgas = 100 } = {}) {
  return acct.callFunctionRaw({ contractId, methodName: method, args, deposit, gas: teraToGas(tgas) });
}

export const txUrl = (hash) => `https://${NETWORK === "mainnet" ? "" : "testnet."}nearblocks.io/txns/${hash}`;
export const accountUrl = (id) => `https://${NETWORK === "mainnet" ? "" : "testnet."}nearblocks.io/address/${id}`;

// ---------- Sputnik DAO ----------

/** 1 member 1 vote: role `member` votes with RoleWeight, half + 1 decides; anyone may propose. */
export function koperasiPolicy(founders) {
  const voteAll = ["*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize", "*:AddProposal"];
  return {
    roles: [
      { name: "all", kind: "Everyone", permissions: ["*:AddProposal"], vote_policy: {} },
      { name: "member", kind: { Group: founders }, permissions: voteAll, vote_policy: {} },
    ],
    default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
    proposal_bond: (NEAR / 10n).toString(),
    proposal_period: (7n * 24n * 3600n * 10n ** 9n).toString(),
    bounty_bond: (NEAR / 10n).toString(),
    bounty_forgiveness_period: (24n * 3600n * 10n ** 9n).toString(),
  };
}

export async function createDao(founder, name, purpose, founders, deposit = 6n * NEAR) {
  await call(founder, SPUTNIK_FACTORY, "create", {
    name,
    args: b64({ config: { name, purpose, metadata: "" }, policy: koperasiPolicy(founders) }),
  }, { deposit, tgas: 150 });
  return `${name}.${SPUTNIK_FACTORY}`;
}

export const fnCall = (receiverId, methodName, args, { deposit = "0", tgas = 100 } = {}) => ({
  FunctionCall: {
    receiver_id: receiverId,
    actions: [{ method_name: methodName, args: b64(args), deposit: String(deposit), gas: String(BigInt(tgas) * 10n ** 12n) }],
  },
});

/** Adds a proposal and returns its id. */
export async function propose(acct, daoId, description, kind) {
  const policy = await view(daoId, "get_policy");
  const id = await call(acct, daoId, "add_proposal", { proposal: { description, kind } }, {
    deposit: BigInt(policy.proposal_bond),
    tgas: 50,
  });
  return Number(id);
}

export async function vote(acct, daoId, id, action = "VoteApprove") {
  const p = await view(daoId, "get_proposal", { id });
  return callRaw(acct, daoId, "act_proposal", { id, action, proposal: p.kind }, { tgas: 300 });
}

/** Propose and let each voter approve until it passes. Returns the proposal status. */
export async function decide(proposer, voters, daoId, description, kind) {
  const id = await propose(proposer, daoId, description, kind);
  for (const v of voters) {
    const p = await view(daoId, "get_proposal", { id });
    if (p.status !== "InProgress") break;
    await vote(v, daoId, id);
  }
  const p = await view(daoId, "get_proposal", { id });
  if (p.status !== "Approved") throw new Error(`proposal ${id} "${description}" ended ${p.status}`);
  return { id, status: p.status };
}
