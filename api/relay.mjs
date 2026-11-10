// Gasless calls (NEP-366): a member's wallet signs a delegate action, this relayer wraps it in a transaction and pays
// the gas. Only calls with no deposit: under NEP-366 the relayer pays the inner actions' deposits (nearcore
// fees.rs total_deposit: "here Relayer pays the deposit"), so a relayed `join` with a large deposit would drain it.
// Calls that carry a deposit go from the member's wallet. Only calls to the co-op's contract and DAO, only function
// calls, only by a member (or someone joining), and a few per account an hour.
// Env: RELAYER_ID, RELAYER_KEY (ed25519:… of a testnet account that only holds gas money).
import { deserialize } from "borsh";
import { Account, JsonRpcProvider, PublicKey, SCHEMA, actions, baseEncode, encodeDelegateAction } from "near-api-js";
import { sha256 } from "@noble/hashes/sha2.js";
import dep from "../deployment.testnet.json" with { type: "json" };

const RPC = "https://rpc.testnet.fastnear.com";
const MAX_GAS = 300n * 10n ** 12n;
const PER_HOUR = 20;
// methods a non-member may call: asking to join, and what follows the vote
const OPEN = new Set(["join", "cancel_join", "sync_member"]);
const DAO = new Set(["act_proposal", "add_proposal", "bounty_claim", "bounty_giveup", "bounty_done"]);
// ponytail: per-instance memory, so the limit is per warm instance; a shared store (KV) if someone farms it
const seen = new Map();

const provider = new JsonRpcProvider({ url: RPC });
const view = (contractId, method, args = {}) => provider.callFunction({ contractId, method, args, blockQuery: { finality: "final" } });
const rpc = (method, params) => fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
  .then((r) => r.json());
/** The chain's view of a delegate: the signing key's nonce (null: not a key of the sender) and the block height. */
async function onChain(senderId, publicKey) {
  const [k, b] = await Promise.all([
    rpc("query", { request_type: "view_access_key", finality: "final", account_id: senderId, public_key: publicKey }),
    rpc("block", { finality: "final" }),
  ]);
  return { nonce: k.result ? BigInt(k.result.nonce) : null, height: BigInt(b.result.header.height) };
}
// ponytail: per-instance memory, like the rate limit; a replay that reaches the chain fails on the key's nonce anyway
const relayed = new Set();

/**
 * Why this signed delegate is refused, or null. Exported for the unit test.
 * @param {any} sd a SignedDelegate as borsh decodes it
 * @param {{ members?: string[], chain?: typeof onChain }} [opts]
 */
export async function refuse(sd, { members, chain = onChain } = {}) {
  const d = sd?.delegateAction;
  if (!d) return "not a signed delegate action";
  if (d.receiverId !== dep.contract && d.receiverId !== dep.dao) return `only calls to ${dep.contract} or ${dep.dao} are relayed`;
  if (!d.actions.length || d.actions.length > 4) return "1 to 4 actions";
  let gas = 0n;
  for (const a of d.actions) {
    const f = a.functionCall;
    if (!f) return "only function calls are relayed";
    if (d.receiverId === dep.dao && !DAO.has(f.methodName)) return `${f.methodName} on the DAO is not relayed`;
    if (BigInt(f.deposit) !== 0n) return "calls with a deposit are not relayed (the relayer would pay it): send it from your wallet";
    gas += BigInt(f.gas);
  }
  if (gas > MAX_GAS) return "more than 300 Tgas";
  const pk = PublicKey.fromString(`ed25519:${baseEncode(new Uint8Array(d.publicKey.ed25519Key?.data ?? []))}`);
  if (!sd.signature?.ed25519Signature) return "only ed25519 signatures";
  const hash = sha256(encodeDelegateAction(d));
  if (!pk.verify(hash, new Uint8Array(sd.signature.ed25519Signature.data))) return "bad signature";
  // the chain would refuse these too, but only after the relayer paid the gas
  const { nonce, height } = await chain(d.senderId, pk.toString());
  if (nonce === null) return `the signing key is not a key of ${d.senderId}`;
  if (BigInt(d.nonce) <= nonce) return "nonce already used";
  if (BigInt(d.maxBlockHeight) <= height) return "expired";
  const open = d.receiverId === dep.contract && d.actions.every((a) => OPEN.has(a.functionCall.methodName));
  if (!open) {
    const list = members ?? /** @type {any} */ (await view(dep.dao, "get_policy")).roles.find((r) => r.name === "member")?.kind?.Group ?? [];
    if (!list.includes(d.senderId)) return `${d.senderId} is not a member`;
  }
  return null;
}

/** Whether the page should offer gasless calls. */
export const GET = () => Response.json({ on: !!(process.env.RELAYER_ID && process.env.RELAYER_KEY) });

export async function POST(request) {
  const json = (body, status = 200) => Response.json(body, { status });
  if (!process.env.RELAYER_ID || !process.env.RELAYER_KEY) return json({ error: "the relayer is off" }, 503);
  /** @type {any} */
  let sd;
  try {
    const { signedDelegate } = await request.json();
    sd = deserialize(SCHEMA.SignedDelegate, Buffer.from(String(signedDelegate), "base64"));
  } catch {
    return json({ error: "send { signedDelegate: base64 borsh }" }, 400);
  }
  // reserved before any await, so two copies of one delegate sent at once cannot both pass the check
  const id = (() => { try { return baseEncode(sha256(encodeDelegateAction(sd.delegateAction))); } catch { return null; } })();
  if (!id) return json({ error: "not a signed delegate action" }, 400);
  if (relayed.has(id)) return json({ error: "already relayed" }, 403);
  relayed.add(id);
  const why = await refuse(sd).catch((e) => `could not check: ${e.message}`);
  if (why) { relayed.delete(id); return json({ error: why }, 403); }
  const now = Date.now();
  const hits = (seen.get(sd.delegateAction.senderId) ?? []).filter((t) => now - t < 3_600_000);
  if (hits.length >= PER_HOUR) return relayed.delete(id), json({ error: `at most ${PER_HOUR} gasless calls an hour; send it from your wallet instead` }, 429);
  seen.set(sd.delegateAction.senderId, [...hits, now]);
  const relayer = new Account(process.env.RELAYER_ID, provider, /** @type {any} */ (process.env.RELAYER_KEY));
  try {
    const out = await relayer.signAndSendTransaction({ receiverId: sd.delegateAction.senderId, actions: [actions.signedDelegate(sd)] });
    return json({ hash: out.transaction.hash, outcome: out });
  } catch (e) {
    return json({ error: e.message, hash: e.txHash || undefined }, 502);
  }
}
