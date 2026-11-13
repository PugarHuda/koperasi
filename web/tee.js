// Verify, in the visitor's own browser and with the visitor's own nonce, that the model in the by-laws is served from
// genuine TEEs. The same checks as agent/tee.mjs (the algorithm of NEAR AI's official verifier), minus NVIDIA's verdict:
//   1. the Intel TDX quote of the gateway and of every model server verifies against Intel's collateral
//      (dcap-qvl, collateral from Phala's public PCCS mirror of Intel's PCS), status UpToDate or OutOfDate;
//   2. its report_data binds the server's signing address and the 32-byte nonce this browser just made up;
//   3. sha256(app_compose) matches mr_config_id: the docker compose the server attests to;
//   4. model servers: the NVIDIA GPU evidence carries the same nonce. NVIDIA's attestation service (NRAS) does not
//      allow browser calls, so its verdict comes from the agent's own check and the daily CI run, and is labelled so.
// Model servers NEAR AI runs through Chutes (by-laws v6: deepseek-v3.2) have Chutes' own bindings, as in agent/tee.mjs:
// the TDX quote verifies as in 1; report_data[0:32] = sha256(your nonce ‖ e2e_pubkey) and report_data[32:64] =
// sha256(SPKI of the instance certificate); MRTD and RTMR0-3 equal a row of Chutes' published measurements, pinned in
// chutes-measurements.json (the same file the agent reads; a unit test keeps the two equal).
const API = "https://cloud-api.near.ai/v1";
const TDX_OK = new Set(["UpToDate", "OutOfDate"]);
const hexOf = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
const bytes = (hex) => new Uint8Array((hex.replace(/^0x/, "").match(/../g) ?? []).map((x) => parseInt(x, 16)));
const sha256 = async (data) => new Uint8Array(await crypto.subtle.digest("SHA-256", data));

let qvl; // loaded on first use: ~150 KB that most visitors never need
const lib = () => (qvl ??= import("./vendor/dcap-qvl-0.7.1.mjs"));

async function bindsAddressAndNonce(att, reportData, nonce) {
  const addr = bytes(att.signing_address); // 0x-prefixed (ecdsa) or bare hex
  let first;
  if (att.tls_cert_fingerprint) {
    const both = new Uint8Array([...addr, ...bytes(att.tls_cert_fingerprint)]);
    first = await sha256(both);
  } else {
    first = new Uint8Array(32);
    first.set(addr);
  }
  return { address: hexOf(reportData.slice(0, 32)) === hexOf(first), nonce: hexOf(reportData.slice(32, 64)) === nonce };
}

/** One DER element at `i`: its tag, where its body starts and where it ends. */
function der(b, i) {
  let len = b[i + 1], body = i + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let k = 0; k < n; k++) len = len * 256 + b[body + k];
    body += n;
  }
  return { tag: b[i], start: i, body, end: body + len };
}

/** The SubjectPublicKeyInfo of an X.509 certificate (DER): tbs → [version], serial, signature, issuer, validity, subject, SPKI. */
export function spkiOf(cert) {
  const tbs = der(cert, der(cert, 0).body);
  let i = tbs.body;
  if (der(cert, i).tag === 0xa0) i = der(cert, i).end; // explicit version
  for (let k = 0; k < 5; k++) i = der(cert, i).end;
  const spki = der(cert, i);
  return cert.slice(spki.start, spki.end);
}

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
let rows; // Chutes' measurements, pinned next to the page
const chutesRows = async () => (rows ??= fetch(new URL("./chutes-measurements.json", import.meta.url)).then((r) => r.json()).then((j) => j.rows));

/** Chutes' bindings over the verified quote's report_data (exported for the unit test). */
export async function chutesBinds(att, reportData, nonce) {
  const fresh = await sha256(new TextEncoder().encode(`${nonce}${att.e2e_pubkey}`));
  const certHash = await sha256(spkiOf(b64(att.certificate_b64)));
  return { nonce: hexOf(reportData.slice(0, 32)) === hexOf(fresh), cert: hexOf(reportData.slice(32, 64)) === hexOf(certHash) };
}

async function checkChutes(att, nonce, q) {
  const quote = b64(att.quote_b64);
  const collateral = await Promise.race([q.getCollateral(q.PHALA_PCCS_URL, quote),
    new Promise((_, no) => setTimeout(() => no(new Error("Intel collateral (Phala PCCS) did not answer in 30 s")), 30_000))]);
  const v = q.verify(quote, collateral, Math.floor(Date.now() / 1000));
  const td = v.report.asTd10?.() ?? v.report.asTd15?.()?.base ?? v.report.asTd15Ex?.()?.base;
  if (!td) return { ok: false, reason: "not a TDX quote" };
  const bind = await chutesBinds(att, td.reportData, nonce);
  const regs = { mrtd: hexOf(td.mrTd), rtmr0: hexOf(td.rtMr0), rtmr1: hexOf(td.rtMr1), rtmr2: hexOf(td.rtMr2), rtmr3: hexOf(td.rtMr3) };
  const row = (await chutesRows()).find((x) => ["mrtd", "rtmr0", "rtmr1", "rtmr2", "rtmr3"].every((k) => x[k] === regs[k]));
  const ok = TDX_OK.has(v.status) && bind.nonce && bind.cert && Boolean(row);
  // the table's columns: signing key = the instance's certificate, attested code = a pinned measurement row
  return { ok, tdx: v.status, nonce: bind.nonce, address: bind.cert, compose: Boolean(row), gpuNonce: null, provider: "chutes", measurement: row?.name ?? null };
}

async function checkOne(att, nonce, gpu, q) {
  // only model servers may come from Chutes; the gateway signs every response, so it must bind its own address
  if (att.provider === "chutes" && gpu) return checkChutes(att, nonce, q);
  if (att.provider) return { ok: false, tdx: `${att.provider}: not verified here` };
  const quote = bytes(att.intel_quote);
  // Intel's collateral through Phala's PCCS: bounded, so the TEE button cannot spin forever
  const collateral = await Promise.race([q.getCollateral(q.PHALA_PCCS_URL, quote),
    new Promise((_, no) => setTimeout(() => no(new Error("Intel collateral (Phala PCCS) did not answer in 30 s")), 30_000))]);
  const v = q.verify(quote, collateral, Math.floor(Date.now() / 1000));
  const td = v.report.asTd10?.() ?? v.report.asTd15?.()?.base ?? v.report.asTd15Ex?.()?.base;
  if (!td) return { ok: false, reason: "not a TDX quote" };
  const bind = await bindsAddressAndNonce(att, td.reportData, nonce);
  const tcb = typeof att.info?.tcb_info === "string" ? JSON.parse(att.info.tcb_info) : att.info?.tcb_info;
  const composeHash = tcb?.app_compose ? hexOf(await sha256(new TextEncoder().encode(tcb.app_compose))) : null;
  const compose = !!composeHash && hexOf(td.mrConfigId).startsWith(`01${composeHash}`);
  let gpuNonce = null;
  if (gpu) {
    try { gpuNonce = JSON.parse(att.nvidia_payload ?? "{}").nonce?.toLowerCase() === nonce; } catch { gpuNonce = false; }
  }
  const ok = TDX_OK.has(v.status) && bind.address && bind.nonce && compose && (!gpu || gpuNonce === true);
  return { ok, tdx: v.status, address: bind.address, nonce: bind.nonce, compose, gpuNonce, signer: att.signing_address };
}

/**
 * Runs every check for `model`; `onStep(text)` reports progress. Resolves to { ok, nonce, gateway, models, ms } or
 * { ok: false, reason }. Never throws.
 */
export async function verifyInBrowser(model, onStep = () => {}) {
  const t0 = performance.now();
  const nonce = hexOf(crypto.getRandomValues(new Uint8Array(32)));
  try {
    onStep("Loading Intel's quote verifier…");
    const q = await lib();
    onStep(`Asking NEAR AI Cloud for fresh attestations bound to your nonce ${nonce.slice(0, 10)}…`);
    const r = await fetch(`${API}/attestation/report?model=${encodeURIComponent(model)}&nonce=${nonce}&signing_algo=ecdsa`,
      { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`NEAR AI Cloud answered HTTP ${r.status}`);
    const report = await r.json();
    if (!report.gateway_attestation || !report.model_attestations?.length) throw new Error("no attestations: this model is not served in a TEE");
    onStep("Verifying the gateway's Intel TDX quote…");
    const gateway = await checkOne(report.gateway_attestation, nonce, false, q);
    const models = [];
    for (const [i, m] of report.model_attestations.entries()) {
      onStep(`Verifying model server ${i + 1} of ${report.model_attestations.length}…`);
      models.push(await checkOne(m, nonce, true, q));
    }
    const ok = gateway.ok && models.every((m) => m.ok);
    return { ok, nonce, gateway, models, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { ok: false, nonce, reason: e.name === "TimeoutError" ? "NEAR AI Cloud did not answer in 30 s" : e.message };
  }
}
