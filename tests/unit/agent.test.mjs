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

test("the page's profit-share preview matches the contract's split", async () => {
  const { splitShare } = await import("../../web/share.js");
  const NEAR = 10n ** 24n;
  // the same co-op as the contract test share_splits_by_savings_and_points_and_nothing_is_lost
  /** @type {Array<[string, { savings: string, points: number }]>} */
  const members = [
    ["alice.testnet", { savings: String(300n * NEAR), points: 0 }],
    ["bob.testnet", { savings: String(100n * NEAR), points: 10 }],
    ["carol.testnet", { savings: "0", points: 30 }],
  ];
  const { shares, reserve } = splitShare(100_000_000n, { reserve_bps: 2000, savings_bps: 4000, points_bps: 4000 }, members);
  assert.deepEqual(shares.map((s) => s.share), [30_000_000n, 20_000_000n, 30_000_000n]);
  assert.equal(reserve, 20_000_000n);
  // rounding goes to the reserve, never lost: three equal members, 1 unit
  const three = ["a", "b", "c"].map((a) => /** @type {[string, { savings: string, points: number }]} */ ([a, { savings: "0", points: 1 }]));
  const r = splitShare(1n, { reserve_bps: 0, savings_bps: 0, points_bps: 10000 }, three);
  assert.equal(r.shares.reduce((x, s) => x + s.share, 0n) + r.reserve, 1n);
  // nobody with savings or points: everything stays in the DAO
  assert.equal(splitShare(5_000_000n, { reserve_bps: 2000, savings_bps: 4000, points_bps: 4000 }, [["a", { savings: "0", points: 0 }]]).reserve, 5_000_000n);
});

test("USDC amounts typed by a member are parsed exactly, or refused", async () => {
  const { usdcUnits } = await import("../../web/share.js");
  assert.equal(usdcUnits("12.5"), 12_500_000n);
  assert.equal(usdcUnits("0.000001"), 1n);
  assert.equal(usdcUnits(" 3 "), 3_000_000n);
  for (const bad of ["", "0", "0.0", "-1", "1.1234567", "1e3", "abc", "1,5", "1.", ".5", "9999999999999"]) assert.equal(usdcUnits(bad), null, bad);
});

test("exact USDC display keeps every unit", async () => {
  const { usdcExact } = await import("../../web/share.js");
  assert.equal(usdcExact(4_000_000n), "4.00");
  assert.equal(usdcExact(1_333_333n), "1.333333");
  assert.equal(usdcExact(1_500_000n), "1.50");
  assert.equal(usdcExact(10n), "0.00001");
});

test("views move to the next RPC on rate limits and network failures, never on a contract's own answer", async () => {
  const { transient } = await import("../../scripts/lib.mjs");
  for (const m of ["Rate limits exceeded", "fetch failed", "Request timed out", "HTTP 502"]) assert.ok(transient(new Error(m)), m);
  assert.ok(transient(Object.assign(new Error("ProviderError"), { cause: 429 })));
  for (const m of ["Smart contract panicked: not a member", "MethodNotFound", "account does not exist"]) assert.ok(!transient(new Error(m)), m);
});

test("the page's task amounts and pay path follow the contract (tasks.rs: accept_task)", async () => {
  const { nearUnits, payPath } = await import("../../web/share.js");
  assert.equal(nearUnits("0.05"), 5n * 10n ** 22n);
  assert.equal(nearUnits("1"), 10n ** 24n);
  for (const bad of ["0", "-1", "abc", "1.1234567", "", "1e3", "0.000000"]) assert.equal(nearUnits(bad), null, bad);
  const rule = { auto_max: (10n ** 23n).toString(), trusted_after: 1 };
  assert.equal(payPath((10n ** 23n).toString(), rule, 1), "trust", "at the limit, trusted");
  assert.equal(payPath((10n ** 23n + 1n).toString(), rule, 5), "member", "above the limit");
  assert.equal(payPath("1", rule, 0), "member", "no record yet");
});
