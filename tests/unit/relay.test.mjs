// The gasless relayer's checks (api/relay.mjs), offline: delegate actions built and signed here, round-tripped through
// the same base64 borsh the wallet sends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deserialize } from "borsh";
import { KeyPair, KeyPairSigner, SCHEMA, actions, buildDelegateAction, encodeSignedDelegate } from "near-api-js";
import { refuse } from "../../api/relay.mjs";
import dep from "../../deployment.testnet.json" with { type: "json" };

const key = KeyPair.fromRandom("ed25519");
const signer = new KeyPairSigner(key);
/** @param {string} receiverId @param {string} method @param {{ senderId?: string, tgas?: number }} [o] */
async function signed(receiverId, method, { senderId = "alice.testnet", tgas = 30 } = {}) {
  const d = buildDelegateAction({
    senderId, receiverId, nonce: 1n, maxBlockHeight: 1000n, publicKey: key.getPublicKey(),
    actions: [actions.functionCall(method, {}, BigInt(tgas) * 10n ** 12n, 0n)],
  });
  const { signedDelegate } = await signer.signDelegateAction(d);
  return /** @type {any} */ (deserialize(SCHEMA.SignedDelegate, encodeSignedDelegate(signedDelegate))); // what the relayer decodes
}
// the chain as the relayer reads it: the key belongs to the sender, nonce 0, block 500 (the delegates expire at 1000)
const chain = async () => ({ nonce: 0n, height: 500n });
const members = { members: ["alice.testnet"], chain };

test("the relayer pays only for co-op calls by members, or someone joining", async () => {
  assert.equal(await refuse(await signed(dep.contract, "claim_share"), members), null);
  assert.equal(await refuse(await signed(dep.dao, "act_proposal"), members), null);
  assert.equal(await refuse(await signed(dep.contract, "join", { senderId: "new.testnet" }), members), null, "joining is open");
  assert.match(await refuse(await signed(dep.contract, "claim_share", { senderId: "eve.testnet" }), members), /not a member/);
  assert.match(await refuse(await signed("usdc.testnet", "ft_transfer"), members), /only calls to/);
  assert.match(await refuse(await signed(dep.dao, "remove_blob"), members), /not relayed/);
  assert.match(await refuse(await signed(dep.contract, "claim_share", { tgas: 301 }), members), /300 Tgas/);
});

test("a key that is not the sender's, a used nonce or an expired delegate costs the relayer nothing", async () => {
  const sd = await signed(dep.contract, "join", { senderId: "new.testnet" });
  assert.match(await refuse(sd, { ...members, chain: async () => ({ nonce: null, height: 500n }) }), /not a key of new.testnet/);
  assert.equal(await refuse(sd, { ...members, chain: async () => ({ nonce: 1n, height: 500n }) }), "nonce already used");
  assert.equal(await refuse(sd, { ...members, chain: async () => ({ nonce: 0n, height: 1000n }) }), "expired");
});

test("a delegate changed after signing is refused", async () => {
  const sd = await signed(dep.contract, "claim_share");
  sd.delegateAction.receiverId = dep.dao; // same signer, different call
  sd.delegateAction.actions[0].functionCall.methodName = "act_proposal";
  assert.equal(await refuse(sd, members), "bad signature");
  const other = await signed(dep.contract, "join", { senderId: "new.testnet" });
  other.signature.ed25519Signature.data[0] ^= 1;
  assert.equal(await refuse(other, members), "bad signature");
});
