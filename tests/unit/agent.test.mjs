// Unit tests for the agent's security and money logic: node --test tests/unit
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { ethAddressOf, recoverPersonal } from "../../agent/sig.mjs";
import { bindsAddressAndNonce, composeMatches } from "../../agent/tee.mjs";
import { OverBudget, isLocal, maxTokensWithin } from "../../agent/runtime.mjs";

const personalSign = (msg, priv) => {
  const m = Buffer.from(msg);
  const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${m.length}`), m]));
  const rec = secp256k1.sign(digest, priv, { prehash: false, format: "recovered" });
  return `0x${Buffer.from(rec.subarray(1)).toString("hex")}${(rec[0] + 27).toString(16)}`;
};

test("response signatures: the signer is recovered, a changed text is not", () => {
  const priv = secp256k1.utils.randomSecretKey();
  const addr = ethAddressOf(secp256k1.getPublicKey(priv, false));
  const text = "z-ai/glm-5.3-flash:aa:bb";
  const sig = personalSign(text, priv);
  assert.equal(recoverPersonal(text, sig), addr);
  assert.notEqual(recoverPersonal(`${text}c`, sig), addr);
  assert.throws(() => recoverPersonal(text, "0x1234"), /65 bytes/);
});

test("TDX report_data must bind the signing address and our nonce", () => {
  const address = crypto.randomBytes(20).toString("hex");
  const nonce = crypto.randomBytes(32).toString("hex");
  const att = { signing_algo: "ecdsa", signing_address: `0x${address}` };
  const rd = Buffer.concat([Buffer.from(address, "hex"), Buffer.alloc(12), Buffer.from(nonce, "hex")]).toString("hex");
  assert.deepEqual(bindsAddressAndNonce(att, rd, nonce), { address: true, nonce: true });
  assert.equal(bindsAddressAndNonce(att, rd, crypto.randomBytes(32).toString("hex")).nonce, false, "a replayed quote fails");
  const other = { ...att, signing_address: `0x${crypto.randomBytes(20).toString("hex")}` };
  assert.equal(bindsAddressAndNonce(other, rd, nonce).address, false, "another server's key fails");
  // with a TLS fingerprint the first half is sha256(address || fingerprint)
  const fp = crypto.randomBytes(32).toString("hex");
  const h = crypto.createHash("sha256").update(Buffer.from(address, "hex")).update(Buffer.from(fp, "hex")).digest("hex");
  assert.equal(bindsAddressAndNonce({ ...att, tls_cert_fingerprint: fp }, h + nonce, nonce).address, true);
});

test("the attested docker compose must match mr_config_id", () => {
  const compose = '{"services":{"vllm":{}}}';
  const hash = crypto.createHash("sha256").update(compose).digest("hex");
  const att = { info: { tcb_info: JSON.stringify({ app_compose: compose }) } };
  assert.equal(composeMatches(att, `01${hash}${"0".repeat(30)}`).ok, true);
  assert.equal(composeMatches(att, `01${"f".repeat(64)}`).ok, false);
  assert.equal(composeMatches({ info: {} }, `01${hash}`).ok, false, "no compose, no pass");
});

test("max_tokens keeps a job's worst case under the by-laws' per-job cap", () => {
  const glm = { inMicro: 0.08, outMicro: 0.5 }; // z-ai/glm-5.3-flash list prices, micro-USD a token
  assert.equal(maxTokensWithin(500_000, 2_000, glm), 4000, "a $0.50 cap leaves the full 4000 tokens");
  const n = maxTokensWithin(1_000, 2_000, glm); // $0.001 cap: 160 µ$ of input leaves 840 µ$ → 1680 tokens
  assert.equal(n, 1680);
  assert.ok(2_000 * glm.inMicro + n * glm.outMicro <= 1_000);
  assert.throws(() => maxTokensWithin(100, 2_000, glm), OverBudget);
  assert.throws(() => maxTokensWithin(0, 0, glm), OverBudget);
  assert.equal(maxTokensWithin(1, 10, { inMicro: 0, outMicro: 0 }), 4000, "a free model is capped by the output limit");
});

test("only a local market counts as the demo stand-in", () => {
  for (const u of ["http://localhost:8787", "http://127.0.0.1:8787/v1", "http://localhost"]) assert.equal(isLocal(u), true, u);
  for (const u of ["https://market.near.ai", "http://localhost.evil.com", "http://127.0.0.1.nip.io", "https://evil.com/?localhost"]) {
    assert.equal(isLocal(u), false, u);
  }
});
