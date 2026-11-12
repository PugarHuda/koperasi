// Koperasi agent runtime. One pass (or --loop):
//   1. load the by-laws (config) and refuse to work unless its sha256 equals the hash the DAO approved on-chain
//   2. bid on board jobs that match the config's filter
//   3. for each awarded assignment: start, do the work on NEAR AI Cloud (TEE), check the spend caps, submit,
//      record a receipt on-chain with the config hash, the inference cost and the deliverable hash
//   4. mirror accepted / cancelled / disputed assignments into the on-chain receipt status
//
// env: KOP_MARKET_URL (default https://market.near.ai), KOP_MARKET_TOKEN (aat_…), NEARAI_API_KEY (sk-…).
// Without NEARAI_API_KEY the agent takes no work on the real market. Only against the local stand-in
// (agent/mock-market.mjs, used by `npm run demo`) does it deliver a draft that says plainly no model wrote it.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ROOT, DEPLOYMENT, account, call, sha256, view } from "../scripts/lib.mjs";
import { market } from "./market.mjs";
import { recoverPersonal } from "./sig.mjs";
import { verifyModel } from "./tee.mjs";

const NEARAI = "https://cloud-api.near.ai/v1";
// ponytail: fixed output and brief limits keep one job's cost bounded before the call; tune with the model's price.
// Reasoning models spend their thinking out of the same budget before they answer (GLM 5.3 used 1 800 tokens on a
// three-bullet brief): 4000 left real briefs with no answer at all. 16000 costs at most $0.008 on GLM 5.3 Flash; the
// by-laws' per-job cap still bounds it for pricier models.
const MAX_OUTPUT_TOKENS = 16000;
const MAX_BRIEF_CHARS = 12000;
const STATE = process.env.KOP_STATE ?? path.join(ROOT, "agent", ".state.json");

export class ConfigMismatch extends Error {}
/** The model's servers did not prove they are genuine TEEs, or a response was not signed by one: no job is sent. */
export class NotVerified extends Error {}
/** Even the cheapest answer would break the by-laws' per-job inference cap at the model's published prices. */
export class OverBudget extends Error {}

const MIN_OUTPUT_TOKENS = 256;
/** The agent's market fee assumption; the contract's audit nets paid jobs by the same 5%. */
const MARKET_FEE_BPS = 500;
export const isLocal = (url) => /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url);

/**
 * The model as NEAR AI Cloud publishes it: it must be marked verifiable (served from TEEs), and its per-token prices
 * (USD, amount × 10^-scale) give the worst case of a job before it is sent.
 */
export async function modelCard(model) {
  const r = await fetch(`${NEARAI}/model/list`, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new NotVerified(`model list: HTTP ${r.status}`);
  const card = (await r.json()).models?.find((m) => m.modelId === model);
  if (!card) throw new NotVerified(`${model} is not served by NEAR AI Cloud`);
  if (card.metadata?.verifiable !== true) throw new NotVerified(`${model} is not marked verifiable by NEAR AI Cloud`);
  const micro = (p) => (p ? (p.amount * 10 ** 6) / 10 ** p.scale : 0); // micro-USD per token
  return { inMicro: micro(card.inputCostPerToken), outMicro: micro(card.outputCostPerToken) };
}

/** Output tokens that keep the worst case (every input byte a token, every output token used) within the cap. */
export function maxTokensWithin(capMicroUsd, inputBytes, { inMicro, outMicro }) {
  const left = capMicroUsd - inputBytes * inMicro;
  const n = outMicro > 0 ? Math.min(MAX_OUTPUT_TOKENS, Math.floor(left / outMicro)) : MAX_OUTPUT_TOKENS;
  if (!(n >= MIN_OUTPUT_TOKENS)) throw new OverBudget(`a ${inputBytes}-byte brief cannot be answered within the $${capMicroUsd / 1e6} per-job cap`);
  return n;
}

/** NEAR AI Cloud bills a request a few seconds after it ends: ask a few times before booking the cap instead. */
async function billedMicroUsd(inferenceId, key, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const c = await fetch(`${NEARAI}/billing/costs`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ requestIds: [inferenceId] }),
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const nano = JSON.stringify(c ?? {}).match(/"costNanoUsd":\s*(\d+)/);
    if (nano) return Math.ceil(Number(nano[1]) / 1000);
    await new Promise((ok) => setTimeout(ok, 2000 * (i + 1)));
  }
  return null;
}

/**
 * Can the co-op's NEAR AI organization pay for inference right now? A 1-token call: 402 means no credits (it costs
 * nothing then), otherwise it costs well under a millionth of a dollar. The balance API takes only web sessions.
 */
export async function canPay(model, key = process.env.NEARAI_API_KEY) {
  const r = await fetch(`${NEARAI}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "ok" }], max_tokens: 1 }),
  });
  if (r.status === 402) return { ok: false, reason: (await r.json().catch(() => ({})))?.error?.message ?? "no credits" };
  return r.ok ? { ok: true } : { ok: false, reason: `HTTP ${r.status}` };
}

const teeCache = new Map(); // model → verification, re-checked every hour
export async function verifiedTee(model) {
  const hit = teeCache.get(model);
  if (hit && Date.now() - Date.parse(hit.at) < 3_600_000) return hit;
  const r = await verifyModel(model);
  if (!r.ok) throw new NotVerified(`${model} is not verified as running in a TEE: ${r.reason}`);
  teeCache.set(model, r);
  return r;
}

/** Reads the config file and checks it against the hash on-chain. Throws ConfigMismatch if they differ. */
export async function loadApprovedConfig(dep, file = dep.configUri) {
  const raw = fs.readFileSync(path.join(ROOT, file));
  const local = sha256(raw);
  const onchain = await view(dep.contract, "get_config");
  if (local !== onchain.hash) {
    throw new ConfigMismatch(`config_mismatch: local ${local.slice(0, 12)}… ≠ approved v${onchain.version} ${onchain.hash.slice(0, 12)}…`);
  }
  return { config: YAML.parse(raw.toString()), hash: local, version: onchain.version };
}

function loadState() {
  const today = new Date().toISOString().slice(0, 10);
  const s = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
  // pending: work already paid for but not yet delivered or receipted; it survives the daily reset
  return s.day === today ? { pending: {}, ...s } : { day: today, spentMicroUsd: 0, pending: s.pending ?? {} };
}
const saveState = (s) => fs.writeFileSync(STATE, JSON.stringify(s));

export async function infer(config, job, capMicroUsd, { local = false } = {}) {
  const key = process.env.NEARAI_API_KEY;
  if (!key) {
    if (!local) throw new NotVerified("no NEARAI_API_KEY: the agent does not deliver work no model did");
    return {
      text: `# ${job.title}\n\n_Draft from the local demo market: no NEARAI_API_KEY was set, so no model wrote this._\n\n> ${job.description}`,
      costMicroUsd: 0,
      proof: null,
    };
  }
  const tee = await verifiedTee(config.model); // no job leaves this machine for an unverified model
  const prices = await modelCard(config.model);
  const messages = [
    { role: "system", content: config.system_prompt },
    { role: "user", content: `Job: ${String(job.title).slice(0, 300)}\n\n${String(job.description)}`.slice(0, MAX_BRIEF_CHARS) },
  ];
  const max_tokens = maxTokensWithin(capMicroUsd, Buffer.byteLength(JSON.stringify(messages)), prices);
  const body = JSON.stringify({ model: config.model, messages, max_tokens });
  try {
    const res = await fetch(`${NEARAI}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(180_000), // a reasoning model writing a long answer; the per-job cap still bounds the cost
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "accept-encoding": "identity" },
      body,
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`NEAR AI Cloud ${res.status}: ${raw.slice(0, 200)}`);
    const inferenceId = res.headers.get("inference-id");
    const out = JSON.parse(raw);
    const signature = await checkSignature(out.id, config.model, body, raw, tee, key);
    // Fail closed: a cost we cannot read is booked at the per-job cap, never as free.
    const billed = inferenceId ? await billedMicroUsd(inferenceId, key) : null;
    const costMicroUsd = billed ?? capMicroUsd;
    const proof = {
      model: config.model, inference_id: inferenceId, chat_id: signature.chat_id, tee_signer: signature.signer,
      tee_checked_at: tee.at, billed: billed !== null,
    };
    const text = out.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text) {
      throw new Error(`NEAR AI Cloud returned no text for ${out.id} (finish: ${out.choices?.[0]?.finish_reason}, `
        + `reasoning tokens: ${out.usage?.reasoning_tokens ?? "?"} of ${max_tokens})`);
    }
    return { text, costMicroUsd, proof };
  } catch (e) {
    // the request went out, so it may be billed: the caller books the per-job cap, never zero
    throw Object.assign(e, { spentMicroUsd: capMicroUsd });
  }
}

/**
 * The response must be signed by a server whose TEE we verified: the signed text ends with
 * sha256(request body):sha256(response body), and the EIP-191 signer is an attested signing address.
 */
async function checkSignature(chatId, model, reqBody, respBody, tee, key) {
  const s = await fetch(`${NEARAI}/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(30_000),
  }).then((r) => (r.ok ? r.json() : Promise.reject(new NotVerified(`signature for ${chatId}: HTTP ${r.status}`))));
  const hashes = `${sha256(Buffer.from(reqBody))}:${sha256(Buffer.from(respBody))}`;
  const signer = recoverPersonal(s.text, s.signature).toLowerCase();
  const attested = [tee.gateway, ...tee.models].map((x) => x?.signing_address?.toLowerCase()).filter(Boolean);
  if (!s.text.endsWith(hashes)) throw new NotVerified(`response ${chatId}: signed hashes do not match what was sent and received`);
  if (signer !== s.signing_address.toLowerCase() || !attested.includes(signer)) {
    throw new NotVerified(`response ${chatId}: signed by ${signer}, which is not an attested TEE signing address`);
  }
  return { chat_id: chatId, signer, kind: s.signature_kind ?? null };
}

/** "6.5" → 6500000n; null for anything that is not a positive amount (the receipt's price comes from the market). */
const usdcUnits = (s) => {
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 1e6)) : null;
};

/**
 * One pass of the agent.
 * @param {{ dep?: any, log?: (msg: string) => void, configFile?: string }} [opts]
 */
export async function runOnce({ dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8")), log = console.log, configFile } = {}) {
  const { config, hash, version } = await loadApprovedConfig(dep, configFile);
  const info = await view(dep.contract, "get_info");
  if (info.paused) {
    log("koperasi is paused by the DAO: not working");
    return;
  }
  log(`running by-laws v${version} (${hash.slice(0, 12)}…)`);
  const marketUrl = process.env.KOP_MARKET_URL ?? "https://market.near.ai";
  const local = isLocal(marketUrl);
  const m = market(marketUrl, process.env.KOP_MARKET_TOKEN);
  if (!local) {
    // the audit nets paid jobs by the market's fee; if the market changes it, the members must vote first
    const fee = (await m.platformConfig())?.platform_fee_bps;
    if (fee !== MARKET_FEE_BPS) {
      log(`Agent Market fee is ${fee} bps, the co-op's audit assumes ${MARKET_FEE_BPS}: not working until the members update it`);
      return;
    }
  }
  const agent = account(dep.agent);

  // bid
  const { bids = [] } = (await m.myBids()) ?? {};
  const bidOn = new Set(bids.map((b) => b.jobId));
  const { jobs = [] } = await m.board();
  const want = new Set(config.job_filter.tags_any.map((t) => t.toLowerCase()));
  for (const job of jobs) {
    if (bidOn.has(job.jobId)) continue;
    const tagged = (job.tags ?? []).some((t) => want.has(t.toLowerCase()));
    if (!tagged || Number(job.budgetAmount) < config.job_filter.min_price_usdc) continue;
    await m.bid(job.jobId, {
      amount: String(config.bid.price_usdc),
      proposal: `Koperasi agent (config v${version}). ${config.vertical}. Sources cited, gaps stated.`,
      slaSeconds: config.bid.sla_seconds,
    });
    log(`bid ${config.bid.price_usdc} USDC on "${job.title}"`);
  }

  // work + mirror status
  const receipts = [];
  for (let from = 0; ; from += 500) {
    const page = await view(dep.contract, "get_receipts", { from, limit: 500 });
    receipts.push(...page);
    if (page.length < 500) break;
  }
  const byJob = new Map(receipts.map((r) => [r.job_id, r]));
  const state = loadState();
  const capJob = Math.round(config.limits.max_inference_per_job_usd * 1e6);
  const capDay = Math.round(config.limits.max_inference_per_day_usd * 1e6);
  let halted = false;
  const receipt = async (a, { text, costMicroUsd, proof }) => {
    await call(agent, dep.contract, "record_receipt", {
      job_id: a.assignmentId,
      price: String(usdcUnits(a.escrowAmount) ?? 0n),
      inference_cost: String(costMicroUsd),
      config_hash: hash,
      deliverable_hash: sha256(text),
      proof: proof ? JSON.stringify(proof) : null,
    });
    delete state.pending[a.assignmentId];
    saveState(state);
  };
  const deliver = async (a, job, done) => {
    await m.submit(a.assignmentId, done.text);
    await receipt(a, done);
    log(`delivered "${job.title}" for ${a.escrowAmount} USDC (inference ${done.costMicroUsd / 1e6} USD), receipt on-chain`);
  };
  const { assignments = [] } = await m.assignments();
  for (const { assignment: a, job } of assignments) {
    const r = byJob.get(a.assignmentId);
    const pending = state.pending[a.assignmentId];
    if (!r && pending && a.status !== "in_progress") {
      // delivered on an earlier pass, but the receipt did not land: record it now
      await receipt(a, pending);
      log(`"${job.title}": receipt recorded for an earlier delivery`);
    } else if (a.status === "in_progress" && !r && pending) {
      // paid for on an earlier pass, but not delivered: deliver that work, do not pay for it twice
      await deliver(a, job, pending);
    } else if (a.status === "in_progress" && !r) {
      if (usdcUnits(a.escrowAmount) === null) {
        log(`"${job.title}": the market reports an escrow of ${JSON.stringify(a.escrowAmount)}; not starting it`);
        continue;
      }
      // a job may only start if even its worst case fits in today's budget
      if (halted || state.spentMicroUsd + capJob > capDay) {
        log(`inference budget left today: ${(capDay - state.spentMicroUsd) / 1e6} USD; not starting "${job.title}"`);
        continue;
      }
      if (process.env.NEARAI_API_KEY || !local) {
        try {
          if (!process.env.NEARAI_API_KEY) throw new NotVerified("no NEARAI_API_KEY");
          await modelCard(config.model); // the model is published as verifiable,
          await verifiedTee(config.model); // its servers prove they are TEEs,
          const pay = await canPay(config.model); // and the co-op can pay for it
          if (!pay.ok) throw new NotVerified(`NEAR AI credits: ${pay.reason}`);
        } catch (e) {
          if (!(e instanceof NotVerified)) throw e;
          log(`not starting "${job.title}": ${e.message}`);
          halted = true;
          continue;
        }
      }
      await m.start(a.assignmentId);
      let done;
      try {
        done = await infer(config, job, capJob, { local });
      } catch (e) {
        if (e.spentMicroUsd) {
          state.spentMicroUsd += e.spentMicroUsd;
          saveState(state);
        }
        // started but cannot deliver: tell the buyer and hand the job back instead of leaving it to time out
        log(`could not deliver "${job.title}": ${e.message}`);
        await m.message(a.assignmentId, "The Koperasi agent cannot deliver this job (its checks failed); handing it back.").catch(() => {});
        await m.decline(a.assignmentId).catch((x) => log(`decline failed: ${x.message}`));
        halted = true;
        continue;
      }
      state.spentMicroUsd += done.costMicroUsd;
      state.pending[a.assignmentId] = done; // booked and kept before anything else can fail
      saveState(state);
      if (done.costMicroUsd > capJob) {
        halted = true; // the money is spent; deliver this job, start no other until the members look at it
        log(`job cost ${done.costMicroUsd / 1e6} USD is over the per-job cap of ${capJob / 1e6} USD: no more jobs this run`);
      }
      await deliver(a, job, done);
    } else if (r?.status === "Submitted" || r?.status === "Disputed") {
      const next = { accepted: "Paid", cancelled: "Refunded", disputed: "Disputed" }[a.status];
      if (next && next !== r.status) {
        await call(agent, dep.contract, "update_receipt", { job_id: a.assignmentId, status: next });
        log(`"${job.title}": ${r.status} → ${next}`);
      }
    }
  }
}

if (process.argv[1]?.endsWith("runtime.mjs")) {
  const loop = process.argv.includes("--loop");
  do {
    try {
      await runOnce();
    } catch (e) {
      console.error(e instanceof ConfigMismatch ? `REFUSED: ${e.message}` : e);
      if (e instanceof ConfigMismatch) process.exit(2);
    }
    if (loop) await new Promise((r) => setTimeout(r, 45_000));
  } while (loop);
}
