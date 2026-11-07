// Verifies that a NEAR AI Cloud model runs in genuine TEEs before the agent sends it a job, following the official
// verifier (github.com/nearai/nearai-cloud-verifier, ts/model_verifier.ts). For the gateway and every model server:
//   1. the Intel TDX quote verifies against Intel's collateral (dcap-qvl), status UpToDate or OutOfDate;
//   2. report_data from the *verified* quote binds the server's signing address and our fresh 32-byte nonce;
//   3. sha256(app_compose) matches mr_config_id in the verified quote (the attested docker compose);
//   4. model servers only: the NVIDIA GPU evidence carries our nonce and NVIDIA NRAS says the GPUs pass.
// Any failure means "not verified" and the runtime refuses to send the job.
//
//   node agent/tee.mjs [model]      prints the checks and writes evidence/tee-<model>.json
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// pure-JS port of Phala's dcap-qvl, a version that verifies the QE identity (GHSA-796p-j2gh-9m2q: the -node binding
// <= 0.3.3 did not, and has no fix)
import { getCollateralFromPcs, verify as verifyQuote } from "@phala/dcap-qvl";

const API = "https://cloud-api.near.ai/v1";
const NRAS = "https://nras.attestation.nvidia.com/v3/attest/gpu";
const TDX_OK = new Set(["UpToDate", "OutOfDate"]);

async function getJson(url, init = {}, tries = 4) {
  for (let i = 0; ; i++) {
    const r = await fetch(url, init);
    if (r.status === 429 && i < tries) { await new Promise((ok) => setTimeout(ok, 1500 * (i + 1))); continue; }
    const text = await r.text();
    if (!r.ok) throw new Error(`${url.split("?")[0]} ${r.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }
}

async function checkTdx(att) {
  const quote = Buffer.from(att.intel_quote, "hex");
  const collateral = await getCollateralFromPcs(quote); // straight from Intel's PCS
  const res = verifyQuote(quote, collateral, Math.floor(Date.now() / 1000));
  const r = res?.report;
  /** @type {any} */
  const td = r?.asTd10?.() ?? r?.asTd15?.()?.base ?? r?.asTd15Ex?.()?.base ?? {};
  const hex = (b) => (b ? Buffer.from(b).toString("hex") : "");
  return { status: res?.status, ok: TDX_OK.has(res?.status), reportData: hex(td.reportData), mrConfig: hex(td.mrConfigId) };
}

export function bindsAddressAndNonce(att, reportDataHex, nonce) {
  const rd = Buffer.from(reportDataHex, "hex");
  const algo = (att.signing_algo ?? "ecdsa").toLowerCase();
  const addr = Buffer.from(algo === "ecdsa" ? att.signing_address.replace(/^0x/, "") : att.signing_address, "hex");
  const first = att.tls_cert_fingerprint
    ? crypto.createHash("sha256").update(addr).update(Buffer.from(att.tls_cert_fingerprint, "hex")).digest()
    : Buffer.concat([addr, Buffer.alloc(32 - addr.length)]);
  return { address: rd.subarray(0, 32).equals(first), nonce: rd.subarray(32, 64).equals(Buffer.from(nonce, "hex")) };
}

export function composeMatches(att, mrConfigHex) {
  const tcb = typeof att.info?.tcb_info === "string" ? JSON.parse(att.info.tcb_info) : att.info?.tcb_info;
  const compose = tcb?.app_compose;
  if (!compose) return { ok: false, hash: null };
  const hash = crypto.createHash("sha256").update(compose).digest("hex");
  return { ok: mrConfigHex.toLowerCase().startsWith(`01${hash}`), hash };
}

async function checkGpu(att, nonce) {
  if (!att.nvidia_payload) return { ok: false, verdict: "no GPU evidence" };
  const payload = JSON.parse(att.nvidia_payload);
  const body = await getJson(NRAS, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(payload) });
  const jwt = body?.[0]?.[1] ?? "";
  const claims = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString() || "{}");
  const verdict = claims["x-nvidia-overall-att-result"];
  return { ok: payload.nonce?.toLowerCase() === nonce && verdict === true, verdict, nonceMatches: payload.nonce?.toLowerCase() === nonce };
}

async function checkOne(att, nonce, gpu) {
  const tdx = await checkTdx(att);
  const bind = tdx.reportData ? bindsAddressAndNonce(att, tdx.reportData, nonce) : { address: false, nonce: false };
  const compose = composeMatches(att, tdx.mrConfig);
  const g = gpu ? await checkGpu(att, nonce) : null;
  const ok = tdx.ok && bind.address && bind.nonce && compose.ok && (!gpu || g.ok);
  return { signing_address: att.signing_address, signing_algo: att.signing_algo, tdx_status: tdx.status, binds_address: bind.address,
    binds_nonce: bind.nonce, compose_sha256: compose.hash, compose_matches: compose.ok, gpu: g, ok };
}

/** Verifies the gateway and the model servers for `model`. Returns { ok, ... }; never throws on a failed check. */
export async function verifyModel(model, { apiKey = process.env.NEARAI_API_KEY } = {}) {
  const nonce = crypto.randomBytes(32).toString("hex");
  const at = new Date().toISOString();
  try {
    const report = await getJson(`${API}/attestation/report?model=${encodeURIComponent(model)}&nonce=${nonce}&signing_algo=ecdsa`,
      { headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), "x-no-aliasing": "true" } });
    const gateway = report.gateway_attestation ? await checkOne(report.gateway_attestation, nonce, false) : { ok: false };
    const models = [];
    for (const m of report.model_attestations ?? []) models.push(await checkOne(m, nonce, true));
    const ok = gateway.ok && models.length > 0 && models.every((m) => m.ok);
    return { ok, model, at, nonce, gateway, models, reason: ok ? null : !models.length ? "no model attestations (model not served in a TEE?)" : "a check failed" };
  } catch (e) {
    return { ok: false, model, at, nonce, reason: e.message };
  }
}

if (process.argv[1]?.endsWith("tee.mjs")) {
  const model = process.argv[2] ?? "z-ai/glm-5.3-flash";
  const r = await verifyModel(model);
  const line = (n, x) => console.log(`${n.padEnd(10)} TDX ${x.tdx_status ?? "-"} | binds address ${x.binds_address} | binds our nonce ${x.binds_nonce} | compose ${x.compose_matches}${x.gpu ? ` | NVIDIA ${x.gpu.verdict} (nonce ${x.gpu.nonceMatches})` : ""} → ${x.ok ? "OK" : "FAIL"}`);
  if (r.gateway) line("gateway", r.gateway);
  (r.models ?? []).forEach((m, i) => line(`model #${i + 1}`, m));
  console.log(`${model}: ${r.ok ? "VERIFIED" : `NOT VERIFIED (${r.reason})`}`);
  const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "evidence", `tee-${model.replace(/[^a-z0-9.-]/gi, "_")}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(r, null, 2) + "\n");
  console.log(`wrote ${path.relative(process.cwd(), out)}`);
  process.exit(r.ok ? 0 : 1);
}
