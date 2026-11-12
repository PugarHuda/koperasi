// What the DAO signs through Chain Signatures: Ethereum transactions built by hand, and owner intents read before signing.
import assert from "node:assert/strict";
import test from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { rawTx, recover, rlp, txHash } from "../../scripts/chainsig.mjs";
import { CHAIN_USDC, policyFor, refuseUnlessAsked } from "../../scripts/intents.mjs";

const hex = (b) => Buffer.from(b).toString("hex");
/** The items of one RLP list (strings only, as in a signed transfer): enough to read a transaction back. */
function unrlp(buf) {
  const len = (at, base) => {
    const p = buf[at] - base;
    return p < 56 ? [at + 1, p] : [at + 1 + (p - 55), Number(BigInt("0x" + hex(buf.subarray(at + 1, at + 1 + (p - 55)))))];
  };
  const [start, size] = len(0, 0xc0);
  const out = [];
  for (let i = start; i < start + size;) {
    const b = buf[i];
    if (b < 0x80) { out.push(buf.subarray(i, i + 1)); i += 1; continue; }
    if (b >= 0xc0) { const [s, n] = len(i, 0xc0); out.push(buf.subarray(s, s + n)); i = s + n; continue; } // the access list: kept whole
    const [s, n] = len(i, 0x80);
    out.push(buf.subarray(s, s + n));
    i = s + n;
  }
  return out;
}

test("RLP matches the Ethereum spec's vectors", () => {
  assert.equal(hex(rlp("0x")), "80");
  assert.equal(hex(rlp(0n)), "80");
  assert.equal(hex(rlp(15n)), "0f");
  assert.equal(hex(rlp(1024n)), "820400");
  assert.equal(hex(rlp([])), "c0");
  assert.equal(hex(rlp([[], [[]], [[], [[]]]])), "c7c0c1c0c3c0c1c0");
  assert.equal(hex(rlp("0x" + "61".repeat(56))).slice(0, 4), "b838"); // a long string: 0xb7 + length of length
});

test("a signed EIP-1559 transfer recovers its signer, with s in the low half (EIP-2), whatever the signer returned", () => {
  const N = secp256k1.Point.CURVE().n;
  const t = { chainId: 11155111n, nonce: 1n, maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 5_000_000_000n, gas: 245_000n,
    to: "0x89b70a44dc6ebf5f9015de6f7077561a0d927138", value: 10n ** 15n };
  for (let k = 0; k < 300; k++) { // enough to meet r or s with leading zero bytes (1 in 128 each)
    const sk = secp256k1.utils.randomSecretKey();
    const who = "0x" + hex(keccak_256(secp256k1.getPublicKey(sk, false).subarray(1))).slice(24);
    const sig = secp256k1.sign(txHash(t), sk, { prehash: false, format: "recovered", lowS: false });
    // the shape the MPC network answers with
    const mpc = { big_r: { affine_point: "02" + hex(sig.slice(1, 33)) }, s: { scalar: hex(sig.slice(33)) }, recovery_id: sig[0] };
    assert.equal(recover(txHash(t), mpc), who);
    // decode the signed list (after 0x02): r and s are minimal integers, shorter than 32 bytes when they start with zeros
    const items = unrlp(Buffer.from(rawTx(t, mpc).slice(2), "hex").subarray(1));
    const [y, r, s] = items.slice(-3).map((b) => BigInt(b.length ? "0x" + hex(b) : 0));
    assert.ok(s <= N / 2n, "high s left in the transaction");
    const pad = (n) => Buffer.from(n.toString(16).padStart(64, "0"), "hex");
    const pub = secp256k1.recoverPublicKey(Uint8Array.from([Number(y), ...pad(r), ...pad(s)]), txHash(t), { prehash: false });
    assert.equal("0x" + hex(keccak_256(secp256k1.Point.fromBytes(pub).toBytes(false).subarray(1))).slice(24), who);
  }
});

test("an owner intent is signed only if it says exactly what was asked", () => {
  const owner = "0xb3dc0128b4a9804de94796480bef8ba014dfca7d";
  const body = { agent_id: "agent_1", label: "runtime", credential: "a".repeat(64) };
  const text = (over = {}) => JSON.stringify({ domain: "tidepool-agent-api.v1", network: "testnet", type: "grant_issue", agent_id: "agent_1",
    owner: "0xB3dC0128b4A9804DE94796480bef8Ba014dfcA7D", nonce: "x", details: { label: "runtime", credential: "a".repeat(64) }, ...over });
  assert.doesNotThrow(() => refuseUnlessAsked(text(), "grant_issue", body, owner));
  assert.throws(() => refuseUnlessAsked(text({ details: { label: "runtime", credential: "b".repeat(64) } }), "grant_issue", body, owner), /credential/);
  assert.throws(() => refuseUnlessAsked(text({ owner: "0x0000000000000000000000000000000000000001" }), "grant_issue", body, owner), /owner/);
  assert.throws(() => refuseUnlessAsked(text({ type: "policy_update" }), "grant_issue", body, owner), /type/);
  assert.throws(() => refuseUnlessAsked(text({ network: "mainnet" }), "grant_issue", body, owner), /domain/);
  assert.throws(() => refuseUnlessAsked(text({ agent_id: "agent_2" }), "grant_issue", body, owner), /agent/);
  assert.throws(() => refuseUnlessAsked("not json", "grant_issue", body, owner), /not JSON/);
  // what a hostile API could slip in: more than was asked, or less (a grant with no expiry)
  assert.throws(() => refuseUnlessAsked(text({ scopes: ["*"] }), "grant_issue", body, owner), /unexpected fields scopes/);
  assert.throws(() => refuseUnlessAsked(text({ details: { label: "runtime", credential: "a".repeat(64), allow_withdraw_any: true } }), "grant_issue", body, owner), /unexpected details allow_withdraw_any/);
  const expiring = { ...body, expires_at: "2026-12-12T00:00:00.000Z" };
  assert.throws(() => refuseUnlessAsked(text(), "grant_issue", expiring, owner), /expires_at missing/);
  assert.doesNotThrow(() => refuseUnlessAsked(text({ details: { label: "runtime", credential: "a".repeat(64), expires_at: "2026-12-12T00:00:00.000Z" } }), "grant_issue", expiring, owner));
  assert.throws(() => refuseUnlessAsked(text({ type: "grant_revoke" }), "grant_revoke", body, owner), /no rule/);
  const policy = { actions: ["transfer"], destinations: { mode: "only", list: [{ action: "transfer", address: "bob.testnet" }] } };
  const create = (p) => JSON.stringify({ domain: "tidepool-agent-api.v1", network: "testnet", type: "agent_create", owner, details: { policy: p } });
  assert.doesNotThrow(() => refuseUnlessAsked(create(policy), "agent_create", { policy }, owner));
  assert.throws(() => refuseUnlessAsked(create({ ...policy, destinations: { mode: "any", list: [] } }), "agent_create", { policy }, owner), /policy/);
  assert.throws(() => refuseUnlessAsked(JSON.stringify({ domain: "tidepool-agent-api.v1", network: "testnet", type: "agent_create", owner }), "agent_create", { policy }, owner), /policy/);
});

test("the wallet's policy lists only the members, on NEAR or on the route each set, and a policy update must carry it unchanged", () => {
  const members = ["alice.testnet", "bob.testnet"];
  /** @type {[string, string, string][]} */
  const routes = [["bob.testnet", "base", "0x00000000000000000000000000000000000000b0"], ["left.testnet", "arb", "0x00000000000000000000000000000000000000c0"]];
  const p = policyFor(members, routes);
  assert.deepEqual(p.destinations.list, [
    { action: "transfer", address: "alice.testnet", confidential: false },
    { action: "transfer", address: "bob.testnet", confidential: false },
    { action: "withdraw", chain: "base", address: "0x00000000000000000000000000000000000000b0", memo: null },
  ], "a former member's route is not listed");
  assert.deepEqual(p.assets, [CHAIN_USDC.near, CHAIN_USDC.base]);
  assert.ok(Object.values(p.limits.per_transaction).every((x) => x === "5000000"));

  const owner = "0xb3dc0128b4a9804de94796480bef8ba014dfca7d";
  const body = { agent_id: "agent_1", policy: p, expected_revision: 1 };
  const text = (details) => JSON.stringify({ domain: "tidepool-agent-api.v1", network: "testnet", type: "policy_update", agent_id: "agent_1",
    owner, nonce: "x", expires_at: "2026-11-13T00:00:00Z", details });
  assert.doesNotThrow(() => refuseUnlessAsked(text({ expected_revision: 1, policy_hash: "h", policy: p }), "policy_update", body, owner));
  const wider = { ...p, destinations: { mode: "any", list: [] } };
  assert.throws(() => refuseUnlessAsked(text({ expected_revision: 1, policy_hash: "h", policy: wider }), "policy_update", body, owner), /policy/);
  assert.throws(() => refuseUnlessAsked(text({ expected_revision: 2, policy_hash: "h", policy: p }), "policy_update", body, owner), /expected_revision/);
  assert.throws(() => refuseUnlessAsked(text({ expected_revision: 1, policy: p, owner_approval: true }), "policy_update", body, owner), /unexpected details/);
});
