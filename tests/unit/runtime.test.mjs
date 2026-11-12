// The agent's money path when things fail half-way: a billed inference that then fails, a delivery that does not go
// through, a receipt that does not land. The chain, the market and the TEE check are replaced; NEAR AI Cloud is
// answered by a fake fetch. node --test --experimental-test-module-mocks tests/unit
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { ethAddressOf } from "../../agent/sig.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dep = JSON.parse(fs.readFileSync(path.join(ROOT, "deployment.testnet.json"), "utf8"));
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const CAP_JOB = 500_000; // config v3: 0.50 USD per job

// ---- world ----
const w = { receipts: [], calls: [], completions: 0, signatureStatus: 200, submitFails: 0, receiptFails: 0, assignment: null, gateFails: false, gates: 0 };
const priv = secp256k1.utils.randomSecretKey();
const signer = ethAddressOf(secp256k1.getPublicKey(priv, false));
const personalSign = (msg) => {
  const m = Buffer.from(msg);
  const rec = secp256k1.sign(keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${m.length}`), m])), priv, { prehash: false, format: "recovered" });
  return `0x${Buffer.from(rec.subarray(1)).toString("hex")}${(rec[0] + 27).toString(16)}`;
};

mock.module(pathToFileURL(path.join(ROOT, "scripts/lib.mjs")).href, { namedExports: {
  ROOT, DEPLOYMENT: path.join(ROOT, "deployment.testnet.json"), sha256, account: () => ({}),
  view: async (_c, method) => ({
    get_config: { hash: sha256(fs.readFileSync(path.join(ROOT, dep.configUri))), version: 3 },
    get_info: { paused: false },
    get_receipts: w.receipts,
  })[method],
  call: async (_a, _c, method, args) => {
    if (method === "record_receipt" && w.receiptFails-- > 0) throw new Error("RPC timeout");
    w.calls.push({ method, args });
    if (method === "record_receipt") w.receipts.push({ job_id: args.job_id, status: "Submitted" });
  },
} });
mock.module(pathToFileURL(path.join(ROOT, "agent/tee.mjs")).href, { namedExports: {
  verifyModel: async () => ({ ok: true, at: new Date().toISOString(), gateway: { signing_address: signer }, models: [] }),
} });
// the OutLayer gate: matches the voted hash unless a test says otherwise
mock.module(pathToFileURL(path.join(ROOT, "agent/gate.mjs")).href, { namedExports: {
  bylawsGate: async () => { w.gates = (w.gates ?? 0) + 1; return { tx: "GateTx", sender: dep.steward,
    out: { match: !w.gateFails, voted_sha256: sha256(fs.readFileSync(path.join(ROOT, dep.configUri))) } }; },
} });
const market = {
  platformConfig: async () => ({ platform_fee_bps: 500 }),
  myBids: async () => ({ bids: [] }),
  board: async () => ({ jobs: [] }),
  assignments: async () => ({ assignments: [{ assignment: w.assignment, job: { title: "Research", description: "1 page" } }] }),
  start: async () => {},
  submit: async () => { if (w.submitFails-- > 0) throw new Error("market 502"); w.assignment.status = "submitted"; },
  message: async () => {},
  decline: async () => { w.assignment.status = "declined"; },
};
mock.module(pathToFileURL(path.join(ROOT, "agent/market.mjs")).href, { namedExports: { market: () => market } });

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
  if (u.endsWith("/model/list")) {
    return json({ models: [{ modelId: "z-ai/glm-5.3-flash", metadata: { verifiable: true },
      inputCostPerToken: { amount: 1, scale: 7 }, outputCostPerToken: { amount: 4, scale: 7 } }] });
  }
  if (u.endsWith("/chat/completions")) {
    if (JSON.parse(init.body).max_tokens === 1) return json({}); // canPay
    w.completions++;
    const raw = JSON.stringify({ id: `chat-${w.completions}`, choices: [{ message: { content: "the answer" } }] });
    w.last = { req: init.body, raw };
    return new Response(raw, { status: 200, headers: { "inference-id": `inf-${w.completions}` } });
  }
  if (u.includes("/signature/")) {
    if (w.signatureStatus !== 200) return json({}, w.signatureStatus);
    const text = `z-ai/glm-5.3-flash:${sha256(w.last.req)}:${sha256(w.last.raw)}`;
    return json({ text, signature: personalSign(text), signing_address: signer });
  }
  if (u.endsWith("/billing/costs")) return json({ costs: [{ costNanoUsd: 7_000_000 }] }); // 7000 micro-USD
  throw new Error(`unexpected fetch ${u}`);
};

process.env.NEARAI_API_KEY = "sk-test";
process.env.KOP_MARKET_URL = "https://market.example";
process.env.KOP_STATE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kop-")), "state.json"); // read once, at import
const { runOnce } = await import("../../agent/runtime.mjs");

const fresh = (t, setup = {}) => {
  fs.rmSync(process.env.KOP_STATE, { force: true });
  Object.assign(w, { receipts: [], calls: [], completions: 0, signatureStatus: 200, submitFails: 0, receiptFails: 0, gateFails: false, gates: 0,
    assignment: { assignmentId: `a-${t}`, status: "in_progress", escrowAmount: "6" } }, setup);
};
const state = () => JSON.parse(fs.readFileSync(process.env.KOP_STATE, "utf8"));
const run = () => runOnce({ dep, log: () => {} });

test("a billed inference that then fails is booked at the per-job cap, and the job is handed back", async () => {
  fresh(1, { signatureStatus: 404 });
  await run();
  assert.equal(w.completions, 1);
  assert.equal(state().spentMicroUsd, CAP_JOB);
  assert.equal(w.assignment.status, "declined");
  assert.equal(w.calls.length, 0); // no receipt for work that was not delivered
});

test("a delivery that fails is delivered on the next pass without paying for the inference again", async () => {
  fresh(2, { submitFails: 1 });
  await assert.rejects(run(), /market 502/);
  assert.equal(state().spentMicroUsd, 7000);
  assert.ok(state().pending["a-2"]);
  await run();
  assert.equal(w.completions, 1, "the model was not asked twice");
  assert.equal(state().spentMicroUsd, 7000, "the cost was not booked twice");
  assert.equal(w.calls.filter((c) => c.method === "record_receipt").length, 1);
  assert.equal(w.calls[0].args.inference_cost, "7000");
  assert.equal(w.calls[0].args.price, "6000000");
  assert.deepEqual(state().pending, {});
});

test("a receipt that does not land after delivery is recorded on the next pass", async () => {
  fresh(3, { receiptFails: 1 });
  await assert.rejects(run(), /RPC timeout/);
  assert.equal(w.assignment.status, "submitted");
  assert.equal(w.receipts.length, 0);
  await run();
  assert.equal(w.completions, 1);
  assert.equal(w.receipts.length, 1);
  assert.equal(w.calls[0].args.deliverable_hash, sha256("the answer"));
  assert.deepEqual(state().pending, {});
});

test("a market escrow that is not a positive amount is not started", async () => {
  fresh(4);
  w.assignment.escrowAmount = "abc";
  await run();
  assert.equal(w.completions, 0);
  assert.equal(w.assignment.status, "in_progress");
});

test("the by-laws gate runs before the job and its transaction goes into the receipt's proof", async () => {
  fresh(5);
  await run();
  assert.equal(w.gates, 1);
  const proof = JSON.parse(w.calls.find((c) => c.method === "record_receipt").args.proof);
  assert.deepEqual(proof.gate, { tx: "GateTx", by: dep.steward });
  assert.ok(proof.model, "the model's proof is still there");
});

test("a by-laws gate that does not match: the job is not started and nothing is spent", async () => {
  fresh(6, { gateFails: true });
  await run();
  assert.equal(w.completions, 0);
  assert.equal(w.assignment.status, "in_progress");
  assert.equal(w.calls.length, 0);
});
