// EIP-191 ("personal_sign") signer recovery, used to check NEAR AI Cloud response signatures.
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

const hex = (b) => Buffer.from(b).toString("hex");

export function ethAddressOf(uncompressedPub) {
  return `0x${hex(keccak_256(uncompressedPub.slice(1))).slice(-40)}`;
}

/** Address that signed `message` (a string) with an Ethereum-style 65-byte r||s||v signature (0x hex). */
export function recoverPersonal(message, signatureHex) {
  const sig = Buffer.from(signatureHex.replace(/^0x/, ""), "hex");
  if (sig.length !== 65) throw new Error(`signature must be 65 bytes, got ${sig.length}`);
  const v = sig[64] >= 27 ? sig[64] - 27 : sig[64];
  const msg = Buffer.from(message, "utf8");
  const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`), msg]));
  const recovered = Buffer.concat([Buffer.from([v]), sig.subarray(0, 64)]);
  const pub = secp256k1.recoverPublicKey(recovered, digest, { prehash: false });
  return ethAddressOf(secp256k1.Point.fromBytes(pub).toBytes(false));
}

if (process.argv[1]?.endsWith("sig.mjs")) {
  // self-check: sign with a random key, recover the same address; a changed message recovers a different one
  const priv = secp256k1.utils.randomSecretKey();
  const addr = ethAddressOf(secp256k1.getPublicKey(priv, false));
  const m = "model:abc:def";
  const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${m.length}`), Buffer.from(m)]));
  const rec = secp256k1.sign(digest, priv, { prehash: false, format: "recovered" });
  const eth = `0x${hex(rec.subarray(1))}${(rec[0] + 27).toString(16)}`;
  assert.equal(recoverPersonal(m, eth), addr, "recovers the signer");
  assert.notEqual(recoverPersonal(`${m}x`, eth), addr, "a changed message does not recover the signer");
  console.log("sig self-check passed", addr);
}
