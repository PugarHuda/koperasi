// Read-only: checks the README's claims about the showcase co-op against NEAR testnet. No keys, no transactions.
// Usage: npm run verify   (exit code 1 if any claim fails)
import fs from "node:fs";
import path from "node:path";
import { baseEncode } from "near-api-js";
import { DEPLOYMENT, ROOT, rawQuery, sha256, accountUrl } from "./lib.mjs";
import { SIGNER, PATH, SEPOLIA, daoAddress, rawTx, recover, signerOf, statement, txHash } from "./chainsig.mjs";

// KOP_PAGE (set by web/verify.mjs, the one-file build anyone downloads from the page): the deployment, the by-laws
// file and the gate program are read from the live page instead of a checkout. Everything else comes from the chain.
const PAGE = process.env.KOP_PAGE;
/** A file of the checkout (`rel`), or what the page serves at `served`. */
async function file(rel, served) {
  if (!PAGE) return fs.readFileSync(path.join(ROOT, rel));
  const res = await fetch(`${PAGE}/${served}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${PAGE}/${served}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
const d = JSON.parse(String(await file(path.relative(ROOT, DEPLOYMENT), "deployment.json")));
if (PAGE) console.log(`reading the deployment, the by-laws and the gate program from ${PAGE}; every claim from the chain\n`);
// ponytail: rawQuery (plain fetch with a timeout, RPC failover) for every read, so a hung RPC fails instead of hanging
const view = async (account_id, method_name, args = {}) => {
  const r = await rawQuery({ request_type: "call_function", account_id, method_name, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  return JSON.parse(Buffer.from(r.result).toString());
};
const argsOf = (p) => p.kind.FunctionCall?.actions.map((a) => ({ method: a.method_name, args: JSON.parse(Buffer.from(a.args, "base64").toString()) })) ?? [];

const near = (y) => Number(BigInt(y) / 10n ** 18n) / 1e6;
const usd = (u) => (Number(u) / 1e6).toFixed(2);
let failed = 0;
/**
 * A JSON-RPC call to another chain's (or NEAR's archival) RPC: 15 s timeout, tried on each URL twice. Public RPCs rate-limit
 * in bursts, and a claim must not read FAIL because one answer was a 429.
 * @param {string[]} urls @param {string} method @param {any} params
 */
async function rpcCall(urls, method, params) {
  for (let k = 0; k < 2; k++) {
    for (const url of urls) {
      try {
        const j = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15_000),
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((q) => q.json());
        if (j.result !== undefined) return j.result;
      } catch { /* the next URL, or the next round */ }
    }
    await new Promise((ok) => setTimeout(ok, 2000));
  }
  return null;
}
const SEPOLIA_RPCS = ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.gateway.tenderly.co"];
const BASE_SEPOLIA_RPCS = ["https://base-sepolia-rpc.publicnode.com", "https://sepolia.base.org"];
/** Each chain a member can route payouts to, read on that chain. */
const EVM_RPCS = { base: BASE_SEPOLIA_RPCS, arb: ["https://arbitrum-sepolia-rpc.publicnode.com", "https://sepolia-rollup.arbitrum.io/rpc"],
  eth: ["https://ethereum-sepolia-rpc.publicnode.com", "https://rpc.sepolia.org"] };
const CHAIN_NAME = { near: "NEAR (Intents)", base: "Base Sepolia", arb: "Arbitrum Sepolia", eth: "Ethereum Sepolia" };
const NEAR_TX_RPCS = ["https://rpc.testnet.fastnear.com", "https://archival-rpc.testnet.fastnear.com", "https://rpc.testnet.near.org"];

const check = (ok, claim, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${claim}\n      ${detail}`);
};

console.log(`Koperasi showcase co-op, ${d.network}: contract ${d.contract}, DAO ${d.dao}\n`);
const [info, policy, board, contributors, audit] = await Promise.all([
  view(d.contract, "get_info"), view(d.dao, "get_policy"), view(d.contract, "get_board"),
  view(d.contract, "get_contributors"), view(d.contract, "get_audit"),
]);
const proposal = (id) => view(d.dao, "get_proposal", { id });
// every DAO proposal, to find the vote behind each claim instead of trusting a number in the README
const last = await view(d.dao, "get_last_proposal_id");
const proposals = [];
for (let from = 0; from < last; from += 100) proposals.push(...await view(d.dao, "get_proposals", { from_index: from, limit: 100 }));
const approvedCall = (method, ok) => proposals.find((p) => p.status === "Approved" && argsOf(p).some((a) => a.method === method && ok(a.args)));

// 1. by-laws
const fileHash = sha256(await file(d.configUri, d.configUri));
const byLaws = approvedCall("set_config", (a) => a.hash === info.config.hash);
check(fileHash === info.config.hash && byLaws, `the agent's by-laws ${d.configUri} are the ones the members voted`,
  `file sha256 ${fileHash.slice(0, 16)}…, contract ${info.config.hash.slice(0, 16)}… v${info.config.version}, voted in proposal #${byLaws?.id}`);

// 2. contract code: the global contract the members voted, no full-access key
const acct = await rawQuery({ request_type: "view_account", account_id: d.contract });
const code = acct.global_contract_hash ?? acct.code_hash;
const want = baseEncode(Buffer.from(d.codeSha256, "hex"));
const upgraded = approvedCall("upgrade", (a) => a.code_hash === code);
check(code === want && upgraded, "the contract runs the global contract the members voted",
  `on-chain ${code}, deployment.testnet.json ${want}, voted in proposal #${upgraded?.id}`);
const keys = (await rawQuery({ request_type: "view_access_key_list", account_id: d.contract })).keys;
const full = keys.filter((k) => k.access_key.permission === "FullAccess").length;
check(full === 0, "nobody holds a full-access key to the contract, the builder included", `${keys.length} keys, ${full} full-access`);

// 3. the agent can only record receipts
const agentKeys = (await rawQuery({ request_type: "view_access_key_list", account_id: d.agent })).keys;
const scoped = agentKeys.length > 0 && agentKeys.every((k) => {
  const fc = k.access_key.permission.FunctionCall;
  return fc && fc.receiver_id === d.contract && fc.method_names.length > 0 && fc.method_names.every((m) => ["record_receipt", "update_receipt"].includes(m));
});
check(scoped, "the agent account has only function-call keys for record_receipt / update_receipt",
  agentKeys.map((k) => JSON.stringify(k.access_key.permission)).join("; "));

// 4. membership comes from the DAO policy
const role = policy.roles.find((r) => r.name === "member");
const daoMembers = new Set(role?.kind.Group ?? []);
const members = await view(d.contract, "get_members", { from: 0, limit: 200 });
const outside = members.filter(([a]) => !daoMembers.has(a)).map(([a]) => a);
check(outside.length === 0 && members.length === info.members, "every member in the contract holds role `member` in the Sputnik DAO",
  `${members.length} in the contract, ${daoMembers.size} in the DAO role${outside.length ? `; not in the DAO: ${outside.join(", ")}` : ""}`);
const vp = role?.vote_policy?.["*"] ?? policy.default_vote_policy;
check(vp.weight_kind === "RoleWeight" && JSON.stringify(vp.threshold) === "[1,2]", "one member, one vote: RoleWeight, threshold 1/2",
  `${vp.weight_kind}, threshold ${JSON.stringify(vp.threshold)}`);

const wide = policy.roles.filter((x) => x.permissions.some((perm) => perm === "*:*" || (x.kind === "Everyone" && !perm.endsWith(":AddProposal"))));
check(wide.length === 0 && BigInt(policy.proposal_bond) > 0n, "no role can act alone: nobody holds *:*, outsiders may only file proposals (with a bond)",
  `${policy.roles.map((x) => `${x.name}: ${x.permissions.join(",")}`).join("; ")}; proposal bond ${near(policy.proposal_bond)} NEAR`);

// 5. earned trust: the contract pays only through its own DAO role, and every point of a record traces to a payout
const tasksRole = policy.roles.find((x) => x.name === "tasks");
check(JSON.stringify(tasksRole?.kind) === JSON.stringify({ Group: [d.contract] })
  && [...tasksRole.permissions].sort().join() === "transfer:AddProposal,transfer:VoteApprove",
  "the contract's DAO role `tasks` may only file and approve transfer proposals", JSON.stringify(tasksRole && [tasksRole.kind, tasksRole.permissions]));
const r = board.rule;
const ruleVote = approvedCall("set_trust", (a) => JSON.stringify(a.rule) === JSON.stringify(r));
check(r && ruleVote && BigInt(r.auto_max) <= BigInt(r.one_vote_max) && r.trusted_after >= 1, "the trust tiers were voted and trust must be earned",
  r ? `no vote ≤ ${near(r.auto_max)} NEAR once trusted by ${r.trusted_after} different source(s), ≤ ${near(r.poster_daily_auto)} NEAR a day per poster; one other member ≤ ${near(r.one_vote_max)} NEAR; above: DAO bounty; ${r.points} points a task; the contract may pay ${near(board.budget)} NEAR more; voted in proposal #${ruleVote?.id}` : "no rule");
const vetoVote = approvedCall("set_veto_window", (a) => a.minutes === board.veto_minutes);
check(!board.veto_minutes || vetoVote, "a payout on trust waits out the veto window the members voted",
  `${board.veto_minutes ?? 0} minutes, voted in proposal #${vetoVote?.id}; a member's veto sends it to one other member's approval`);
const tasks = await view(d.contract, "get_tasks", { from: 0, limit: 200 });
for (const t of tasks.filter((x) => x.status === "Paid")) {
  const pid = await view(d.contract, "get_payout_proposal", { id: t.id });
  const how = t.approved_by ? `approved by ${t.approved_by}` : "earned trust, no vote";
  if (pid === null) {
    console.log(`INFO  task #${t.id}: ${near(t.amount)} NEAR to ${t.contributor}, ${how}; paid by the contract itself, before payouts moved into the DAO`);
    continue;
  }
  const p = await proposal(pid);
  const tr = p.kind.Transfer;
  check(p.status === "Approved" && p.proposer === d.contract && tr?.token_id === "" && tr.receiver_id === t.contributor && tr.amount === t.amount,
    `task #${t.id} was paid from the treasury by DAO proposal #${pid}, filed by the contract`,
    `${near(t.amount)} NEAR to ${t.contributor}, ${how}; proposal ${p.status}, proposer ${p.proposer}, ${JSON.stringify(tr)}`);
}
for (const [who, rec] of contributors) {
  const bad = [];
  for (const ref of rec.refs) {
    const [kind, id] = ref.split(":");
    if (kind === "task") {
      const t = tasks.find((x) => x.id === Number(id));
      if (!(t?.status === "Paid" && t.contributor === who)) bad.push(ref);
    } else if (kind === "dao-proposal") {
      const p = await proposal(Number(id));
      if (!(p.status === "Approved" && p.kind.BountyDone?.receiver_id === who)) bad.push(ref);
    } else bad.push(ref);
  }
  const sources = await view(d.contract, "get_trust_sources", { account_id: who });
  check(bad.length === 0 && rec.refs.length === rec.done, `${who}'s record: ${rec.done} finished, each traced to its source`,
    `${rec.refs.join(", ")}; trusted by ${sources} different source(s)${bad.length ? `; does not check out: ${bad.join(", ")}` : ""}`);
}

// the person in the middle: bonded, and appointed under the code where anyone can slash a late payout
const steward = await view(d.contract, "get_info");
const overdue = await view(d.contract, "get_overdue");
check(steward.steward && BigInt(steward.steward_bond) > 0n && approvedCall("set_steward", (a) => a.steward === steward.steward),
  "the steward was appointed by a vote and is bonded; anyone can slash the bond once a paid job's earnings are 7 days late",
  `${steward.steward}, bond ${near(steward.steward_bond)} NEAR, overdue now ${usd(overdue)} USDC`);

// the steward's term (after Hats Protocol): voted by the members, and anyone ends it once it runs out
const [termDays, termEnds] = await view(d.contract, "get_steward_term");
check(termDays > 0 && approvedCall("set_steward_term", (a) => a.days === termDays),
  "the steward serves a term the members voted; once it runs out anyone ends it",
  `${termDays} days${termEnds ? `, the current term ends ${new Date(Number(BigInt(termEnds) / 1_000_000n)).toISOString().slice(0, 10)}` : ""}`);

// the co-op court: every upheld case was refunded by a DAO proposal the contract filed, at most the job's price
const cases = await view(d.contract, "get_cases", { from: 0, limit: 200 });
const allReceipts = await view(d.contract, "get_receipts", { from: 0, limit: 500 });
for (const c of cases.filter((x) => x.status === "Upheld")) {
  const p = c.refund_proposal === null ? null : await proposal(c.refund_proposal);
  const tr = p?.kind.Transfer;
  const price = allReceipts.find((r) => r.job_id === c.job_id)?.price ?? "0";
  check(p?.status === "Approved" && p.proposer === d.contract && tr?.token_id === info.usdc_id && tr.receiver_id === c.refund_to
    && tr.amount === c.amount && BigInt(c.amount) <= BigInt(price),
    `court case #${c.id}: the jury upheld it and the contract refunded the buyer from the treasury`,
    `${usd(c.amount)} USDC (job ${c.job_id}, price ${usd(price)}) to ${c.refund_to}; jurors ${c.votes.map(([j, v]) => `${j} ${v ? "upheld" : "rejected"}`).join(", ")}; DAO proposal #${c.refund_proposal} ${p?.status}`);
}
// appeals (0.2.7): a dismissed case taken to every member; the contract filed the refund and did not vote on it, and the
// appeal settled as the DAO decided
for (const c of cases.filter((x) => x.status === "Dismissed")) {
  const a = await view(d.contract, "get_appeal", { id: c.id }).catch(() => null);
  if (!a || a.status === "Open") continue;
  const p = proposals.find((q) => q.id === a.proposal);
  const tr = p?.kind?.Transfer;
  const votes = Object.entries(p?.votes ?? {});
  check(p?.proposer === d.contract && tr?.receiver_id === c.refund_to && tr.amount === c.amount && !votes.some(([m]) => m === d.contract)
    && (a.status === "Upheld" ? p.status === "Approved" : ["Rejected", "Removed", "Expired"].includes(p.status)),
  `court case #${c.id}: the jury dismissed it, the claimant appealed to every member, and the members ${a.status === "Upheld" ? "overturned it: the buyer was refunded" : "kept the jury's ruling"}`,
  `DAO proposal #${a.proposal} filed by the contract (which did not vote): refund ${usd(c.amount)} USDC to ${c.refund_to}; ${p?.status}, ${votes.map(([m, v]) => `${m.split(".")[0]} ${v}`).join(", ")}`);
}
// payout routes (0.2.7) and the agent wallet's policy: the members' routes are exactly its withdrawal destinations
const routes = await view(d.contract, "get_payout_routes").catch(() => null);
if (routes && d.intents?.policy) {
  const dests = d.intents.policy.routes ?? [];
  check(routes.length === dests.length && routes.every(([a, c, x]) => dests.some(([b, e, y]) => a === b && c === e && x === y)),
    "the agent's Intents wallet pays each member on the route they set on the contract, and the policy listing them was voted",
    `${routes.map(([a, c, x]) => `${a.split(".")[0]} on ${c} ${x}`).join("; ")}; policy revision ${d.intents.policy.revision} by vote #${d.intents.policy.proposal}`);
}
// work records as tokens (0.2.7, NEP-171): each token reads the record and the standing live
const tokens = await view(d.contract, "nft_tokens", {}).catch(() => []);
for (const t of tokens) {
  const extra = JSON.parse(t.metadata.extra);
  const rec = await view(d.contract, "get_record", { account_id: t.owner_id });
  const [st, good] = await view(d.contract, "get_standing", { account_id: t.owner_id });
  check(t.token_id === t.owner_id && extra.done === (rec?.done ?? 0) && JSON.stringify(extra.standing) === JSON.stringify(st) && extra.good_standing === good,
    `${t.owner_id}'s work record is a NEP-171 token that reads the record live`, t.metadata.description.slice(0, 160));
}
const pledges = await view(d.contract, "get_pledges", { from: 0, limit: 200 });
const pclaims = await view(d.contract, "get_pledge_claims", { from: 0, limit: 200 });
console.log(`INFO  pledges: ${pledges.length}, called in ${pclaims.length} times, kept ${pclaims.filter((c) => c.status === "Honored").length}, broken ${pclaims.filter((c) => c.status === "Broken").length}; court cases: ${cases.length}`);

// a multichain treasury: the DAO's Ethereum address (NEAR Chain Signatures) signed, by a vote, a statement naming it
if (d.chainSignatures) {
  const c = d.chainSignatures;
  const derived = await daoAddress(d.dao);
  const signed = proposals.find((p) => p.id === c.proposal);
  const action = signed?.kind.FunctionCall?.actions[0];
  check(c.signer === SIGNER && c.path === PATH && derived === c.address && signerOf(statement(d.dao, derived), c.signature) === derived
    && signed?.status === "Approved" && signed.kind.FunctionCall.receiver_id === SIGNER && action?.method_name === "sign",
    "the DAO holds an Ethereum address with no private key, and signs with it only by a members' vote (Chain Signatures)",
    `${derived} (MPC ${SIGNER}, path ${PATH}); proposal #${c.proposal} ${signed?.status} asked ${SIGNER} to sign; the signature recovers ${signerOf(statement(d.dao, derived), c.signature)}`);

  // a payment on Ethereum, by vote: the members approved signing exactly this transaction, and the MPC signature is the DAO's
  const x = c.transfer;
  if (x) {
    const p = proposals.find((q) => q.id === x.proposal);
    const a = p?.kind.FunctionCall?.actions[0];
    const asked = a ? JSON.parse(Buffer.from(a.args, "base64").toString()).request?.payload_v2?.Ecdsa : null;
    const t = { chainId: SEPOLIA.chainId, nonce: BigInt(x.nonce), maxPriorityFeePerGas: BigInt(x.maxPriorityFeePerGas), maxFeePerGas: BigInt(x.maxFeePerGas),
      gas: BigInt(x.gas), to: x.to, value: BigInt(Math.round(x.eth * 1e6)) * 10n ** 12n };
    const hash = Buffer.from(txHash(t)).toString("hex");
    let sent = "not broadcast yet: the DAO's address needs Sepolia ETH for it; anyone can send it (`npm run chainsig -- --broadcast`)";
    const r = { result: await rpcCall([SEPOLIA.rpc, ...SEPOLIA_RPCS], "eth_getTransactionReceipt", [x.hash]) };
    if (r?.result) sent = `on Sepolia, status ${r.result.status === "0x1" ? "success" : "failed"}: ${SEPOLIA.explorer}${x.hash}`;
    check(p?.status === "Approved" && p.kind.FunctionCall.receiver_id === SIGNER && asked === hash && recover(txHash(t), x.signature) === derived
      && rawTx(t, x.signature) === x.raw && (!r?.result || r.result.status === "0x1"),
      "a payment from the DAO's Ethereum address was signed only after the members voted for exactly that transaction",
      `${x.eth} Sepolia ETH to ${x.to}; proposal #${x.proposal} ${p?.status} asked ${SIGNER} to sign ${hash.slice(0, 16)}…; the signature recovers ${recover(txHash(t), x.signature)}; ${sent}`);
  }
}

// the agent's NEAR Intents wallet (Tidepool's testnet Agent API): its owner is the DAO's Chain Signatures address, so
// each owner intent was a sign request the members voted, naming the sha256 of the exact intent text
if (d.intents) {
  const i = d.intents;
  const voted = [["create the wallet", i.created], ["issue the agent's grant", i.grant], ["pay members on their own routes", i.policy]].filter(([, x]) => x).map(([what, x]) => {
    const p = proposals.find((q) => q.id === x.proposal);
    const ok = p?.status === "Approved" && p.kind.FunctionCall?.receiver_id === SIGNER && p.kind.FunctionCall.actions[0]?.method_name === "sign"
      && p.description.includes(x.intent_sha256);
    return { ok, line: `${what}: proposal #${x.proposal} ${p?.status}` };
  });
  // what the agent paid from it, inside the policy: a payout on another chain is read on that chain
  const landedOn = async (p) => {
    let landed = p.status === "SUCCESS";
    let where = p.tx ? `NEAR tx ${p.tx}` : "";
    const chain = p.destination_chain ?? (p.chain !== "near" ? p.chain : null);
    if (chain && EVM_RPCS[chain]) {
      const r = p.destination_tx ? await rpcCall(EVM_RPCS[chain], "eth_getTransactionReceipt", [p.destination_tx]) : null;
      landed = landed && r?.status === "0x1";
      where = `${CHAIN_NAME[chain]} tx ${p.destination_tx ?? "none"}, status ${r?.status ?? "unread"}`;
    }
    return { landed, where };
  };
  for (const p of i.payouts ?? []) {
    const { landed, where } = await landedOn(p);
    check(landed, `the agent paid ${p.amount} USDC to ${p.to} from the wallet, on ${CHAIN_NAME[p.chain] ?? p.chain}${p.chain !== "near" ? " (read on that chain)" : ""}`, `${p.status}; ${where}`);
  }
  // profit shares from the wallet: split by the contract's voted rule, each part on the route the member set on-chain
  for (const sh of i.shares ?? []) {
    if (sh.pending) { // cut short and not resumed yet (`intents.mjs share` resumes it): what landed so far, not a claim
      console.log(`INFO  a share of ${sh.amount} USDC is in progress: ${sh.payouts.filter((p) => p.status === "SUCCESS").length} of ${sh.payouts.length} payouts done; \`node scripts/intents.mjs share ${sh.amount}\` finishes it`);
      continue;
    }
    const res = await Promise.all(sh.payouts.map(landedOn));
    check(res.every((r) => r.landed), `the agent shared ${sh.amount} USDC from its wallet by the voted rule, each member paid on their own route`,
      sh.payouts.map((p, k) => `${p.to.split(".")[0]} ${p.amount} on ${CHAIN_NAME[p.chain] ?? p.chain}: ${res[k].landed ? "landed" : "FAILED"} (${res[k].where})`).join("; ")
      + `; ${sh.reserve} USDC kept as the reserve`);
  }
  check(voted.length > 0 && voted.every((x) => x.ok) && i.owner === (await daoAddress(d.dao)),
    "the agent's NEAR Intents wallet is owned by the DAO: every owner intent was signed only after a members' vote",
    `${i.agent_id} on ${i.provider}, owner ${i.owner} (the DAO's Chain Signatures address); ${voted.map((x) => x.line).join("; ")}`);
}

// the by-laws gate, run inside an Intel TDX enclave by OutLayer: the tx ran this repo's wasm, and resumed with a match
const GATE_WASM = sha256(await file("web/outlayer/bylaws-check.wasm", "outlayer/bylaws-check.wasm"));
// earlier builds of the same program (git history of web/outlayer/bylaws-check.wasm): gates already on-chain ran them
const GATE_WASMS = [GATE_WASM, "725254a197b432cdb366ee6f3e4086d9ff9099ed350d114fcf6fb87d2e984fa0"];
/**
 * Reads an OutLayer gate transaction: this repo's program, a NEAR RPC, and a match with `voted`. With `jobId`, the
 * enclave must also have judged that job allowed by the by-laws, when it ran a build that judges jobs.
 */
async function gate(tx, sender, voted, jobId) {
  const t = await rpcCall(NEAR_TX_RPCS, "EXPERIMENTAL_tx_status", { tx_hash: tx, sender_account_id: sender, wait_until: "FINAL" });
  const action = t?.transaction.actions[0]?.FunctionCall;
  const args = action ? JSON.parse(Buffer.from(action.args, "base64").toString()) : {};
  const out = t?.status.SuccessValue ? JSON.parse(Buffer.from(t.status.SuccessValue, "base64").toString()) : {};
  const judged = out.job === undefined || out.job === null || (out.job.allowed === true && out.job.id === jobId);
  const ok = t?.transaction.receiver_id === "outlayer.testnet" && action?.method_name === "request_execution" && GATE_WASMS.includes(args.source?.WasmUrl?.hash)
    && judged && out.match === true && out.voted_sha256 === voted && out.file_sha256 === voted && out.contract === d.contract
    && ["https://rpc.testnet.fastnear.com", "https://rpc.testnet.near.org"].includes(out.rpc);
  const job = out.job ? `; job ${String(out.job.id).slice(0, 14)}… ${out.job.allowed ? "allowed" : "REFUSED"} by the by-laws (${out.job.reason})` : "";
  return { ok, out, line: `tx ${tx} by ${sender}: read v${out.version} from ${out.rpc}: file ${String(out.file_sha256).slice(0, 12)}… = voted ${String(out.voted_sha256).slice(0, 12)}…${job}` };
}
if (d.outlayer) {
  const o = d.outlayer;
  const g = await gate(o.tx, o.sender, d.configHash);
  check(g.ok, "the by-laws were also checked inside an Intel TDX enclave (OutLayer), by this repo's program, on-chain",
    `wasm ${GATE_WASM.slice(0, 12)}… (web/outlayer/bylaws-check.wasm, source outlayer/bylaws-check), ${g.line}`);
}

// the passport (0.2.8): a sister co-op the members voted, running Koperasi code, whose token for the account still
// holds (finished work, good standing), and the stamp here that counts it as a trust source
if (d.passport) {
  const { sister, account: who } = d.passport;
  const [sisters, stamps, sources, token, code, ours] = await Promise.all([view(d.contract, "get_sister_coops"),
    view(d.contract, "get_passport", { account_id: who }), view(d.contract, "get_trust_sources", { account_id: who }),
    view(sister, "nft_token", { token_id: who }), rawQuery({ request_type: "view_account", account_id: sister }),
    rawQuery({ request_type: "view_account", account_id: d.contract })]);
  const extra = token ? JSON.parse(token.metadata.extra) : {};
  const stamp = stamps.find((s) => s.coop === sister);
  check(sisters.includes(sister) && stamp && token?.owner_id === who && extra.good_standing === true && extra.done >= stamp.done && stamp.done > 0
    && (code.global_contract_hash ?? code.code_hash) === (ours.global_contract_hash ?? ours.code_hash) && sources >= 1,
    "a work record from a sister co-op the members voted counts here as a trust source, read by the contract from that co-op's token",
    `${who}: ${stamp?.done} finished at ${sister} (now ${extra.done}, ${extra.good_standing ? "good standing" : "NOT in good standing"}), `
    + `same code as this co-op (${String(code.global_contract_hash ?? code.code_hash).slice(0, 10)}…); trust sources here: ${sources}`);
  if (d.passport.back) { // and the other way: the sister recognises this co-op and counts a record from here
    const b = d.passport.back;
    const [theirs, back] = await Promise.all([view(sister, "get_sister_coops"), view(sister, "get_passport", { account_id: b.account })]);
    const st = back.find((s) => s.coop === d.contract);
    check(theirs.includes(d.contract) && st?.done > 0, "the recognition is mutual: the sister co-op voted this one a sister and counts a record from here",
      `${sister} recognises ${d.contract} (its vote #${b.vote}); ${b.account}: ${st?.done} finished here, stamped there`);
  }
}

// both sides heard (0.2.8): every piece of evidence in a case came from its claimant or the steward, at most 3 each
{
  const cs = await view(d.contract, "get_cases", { from: 0, limit: 100 });
  const ev = await Promise.all(cs.map((c) => view(d.contract, "get_evidence", { id: c.id }).catch(() => [])));
  const heard = cs.map((c, i) => [c, ev[i]]).filter(([, e]) => e.length);
  if (heard.length) {
    const steward = (await view(d.contract, "get_info")).steward;
    const ok = heard.every(([c, e]) => e.every(([by]) => by === c.claimant || by === steward)
      && [c.claimant, steward].every((who) => e.filter(([by]) => by === who).length <= 3));
    check(ok, "in court both sides are heard: evidence came only from the claimant and the steward who answers for the agent",
      heard.map(([c, e]) => `case #${c.id}: ${e.length} piece(s), ${e.filter(([by]) => by === c.claimant).length} from the claimant, `
        + `${e.filter(([by]) => by !== c.claimant).length} from the steward; ${c.status}`).join("; "));
  }
}

// the annual members' meeting (scripts/rat.mjs): the members approved, by a DAO vote, exactly the report and facts files
// served next to the page (their sha256 are in the proposal), and the report was written by a TEE-verified model
for (const r of d.rat ?? []) {
  const [report, facts] = await Promise.all([file(`web/${r.report}`, r.report), file(`web/${r.facts}`, r.facts)]);
  const p = await view(d.dao, "get_proposal", { id: r.proposal });
  // since 0.2.9 the vote calls record_annual_meeting with both sha256, and the contract keeps the record; before, a poll
  const call = argsOf(p).find((x) => x.method === "record_annual_meeting");
  const held = call ? (await view(d.contract, "get_annual_meetings")).find((m) => m.year === r.year) : null;
  const bound = call
    ? call.args.report_sha256 === sha256(report) && call.args.facts_sha256 === sha256(facts) && held?.report_sha256 === sha256(report) && held?.facts_sha256 === sha256(facts)
    : p.kind === "Vote" && p.description.includes(`sha256 ${sha256(report)}`) && p.description.includes(`sha256 ${sha256(facts)}`);
  const ok = p.status === "Approved" && bound && Boolean(r.proof?.model && r.proof?.tee_signer);
  check(ok, `the members approved the ${r.year} annual report by vote, and the report is the one the co-op's agent wrote in a TEE from the chain's facts`,
    `proposal #${r.proposal} ${p.status}${held ? ", recorded by the contract" : ""}${call && argsOf(p).length > 1 ? ` with the meeting's decisions (${argsOf(p).slice(1).map((x) => x.method).join(", ")})` : ""}: report sha256 ${sha256(report).slice(0, 12)}…, facts ${sha256(facts).slice(0, 12)}…; model ${r.proof?.model}, TEE key ${r.proof?.tee_signer}`);
}

// 0.2.9: mandatory dues the members voted, and who is up to date; the agent's strikes are exactly its upheld cases
{
  const dues = await view(d.contract, "get_dues").catch(() => null);
  if (dues && BigInt(dues.amount) > 0n) {
    const ms = (await view(d.contract, "get_members", { from: 0, limit: 100 })).map(([a]) => a);
    const st = await Promise.all(ms.map((m) => view(d.contract, "get_dues_status", { account_id: m })));
    const voted = approvedCall("set_dues", (a) => a.amount === dues.amount && a.every_days === dues.every_days);
    check(Boolean(voted), "mandatory dues were set by a members' vote, and each member's standing reads them",
      `${near(dues.amount)} NEAR every ${dues.every_days} days by #${voted?.id}; `
      + ms.map((m, i) => `${m.split(".")[0]} ${st[i]?.[1] ? "up to date" : "BEHIND"}`).join(", "));
  }
  const agent = await view(d.contract, "get_agent_standing").catch(() => null);
  if (agent) {
    const cs = await view(d.contract, "get_cases", { from: 0, limit: 100 });
    const ok = agent.strikes.every(([id]) => cs.find((c) => c.id === id)?.status === "Upheld") && agent.suspended === (agent.strikes.length >= 3);
    check(ok, "the agent answers to the court: each strike is a case upheld against its job; 3 in 90 days suspend it",
      `${agent.strikes.length} strike(s) (${agent.strikes.map(([id]) => `case #${id}`).join(", ") || "none"}); ${agent.suspended ? "SUSPENDED" : "not suspended"}; the runtime's daily inference budget is divided by ${2 ** agent.strikes.length}`);
  }
}

// how often OutLayer's enclave answered: every gate the steward (before jobs) or alice (by hand) asked for, from the
// explorer's list, each read on NEAR. Information, not a claim: a gate with no answer starts no job (fail closed).
{
  const runs = [];
  for (const who of [d.steward, "kop-alice-mw4i3w8f.testnet"]) {
    const list = await fetch(`https://api-testnet.nearblocks.io/v3/accounts/${who}/txns?receiver=outlayer.testnet&limit=100`, { signal: AbortSignal.timeout(30_000) })
      .then((r) => r.json()).then((j) => j.data ?? []).catch(() => []);
    runs.push(...list.map((x) => ({ hash: x.transaction_hash, who })));
  }
  const outs = await Promise.all(runs.map(async (r) => {
    const t = await rpcCall(NEAR_TX_RPCS, "EXPERIMENTAL_tx_status", { tx_hash: r.hash, sender_account_id: r.who, wait_until: "FINAL" }).catch(() => null);
    const v = t?.status?.SuccessValue ? Buffer.from(t.status.SuccessValue, "base64").toString() : null;
    return v && v !== "null" ? (JSON.parse(v).match === true ? "match" : "other") : t ? "none" : "unread";
  }));
  const n = (k) => outs.filter((o) => o === k).length;
  if (runs.length) console.log(`INFO  OutLayer gate: ${runs.length} runs on-chain, ${n("match")} answered with a match (${Math.round((100 * n("match")) / runs.length)}%), `
    + `${n("none")} with no answer (the worker failed; the deposit came back), ${n("other")} other, ${n("unread")} unread`);
}

// a meeting that said no: the sister co-op's members rejected the first draft (nothing recorded), then approved a second
if (d.sister_meeting) {
  const m = d.sister_meeting;
  const [no, yes, held, report] = await Promise.all([view(m.dao, "get_proposal", { id: m.rejected }), view(m.dao, "get_proposal", { id: m.approved }),
    view(m.contract, "get_annual_meetings"), file(`web/${m.report}`, m.report)]);
  const rec = held.find((x) => x.year === m.year);
  const ok = no.status === "Rejected" && argsOf(no).some((a) => a.method === "record_annual_meeting") && yes.status === "Approved"
    && argsOf(yes).some((a) => a.method === "record_annual_meeting" && a.args.report_sha256 === sha256(report)) && rec?.report_sha256 === sha256(report);
  check(ok, "an annual meeting can say no: the members rejected a draft report (nothing was recorded), then approved the next one",
    `${m.contract}: draft #${m.rejected} ${no.status}; #${m.approved} ${yes.status}, recorded with sha256 ${String(rec?.report_sha256).slice(0, 12)}…`);
}

// the full cycle: three upheld cases suspended the agent, the contract refused its receipt, the members reinstated it
if (d.suspension) {
  const sp = d.suspension;
  const [t, p, cs] = await Promise.all([rpcCall(NEAR_TX_RPCS, "EXPERIMENTAL_tx_status", { tx_hash: sp.refused.tx, sender_account_id: sp.refused.by, wait_until: "FINAL" }),
    view(d.dao, "get_proposal", { id: sp.reinstated_by }), view(d.contract, "get_cases", { from: 0, limit: 100 })]);
  const failed = JSON.stringify(t?.status?.Failure ?? t?.receipts_outcome?.map((o) => o.outcome.status.Failure).find(Boolean) ?? null).includes("suspended by the co-op court");
  const ok = failed && sp.strikes.length >= 3 && sp.strikes.every((id) => cs.find((c) => c.id === id)?.status === "Upheld")
    && p.status === "Approved" && argsOf(p).some((a) => a.method === "reinstate_agent");
  check(ok, "the court suspended the agent after three upheld cases, the contract refused its receipt, and the members reinstated it by vote",
    `strikes: ${sp.strikes.map((c) => `case #${c}`).join(", ")}; refused ${sp.refused.tx.slice(0, 10)}… ("${sp.refused.error.slice(0, 50)}…"); reinstated by #${sp.reinstated_by} (${p.status})`);
}

// the federation (scripts/federation.mjs): a DAO whose only members are co-ops' DAOs; its resolution passed by both,
// and each co-op's vote was cast by a proposal its own members approved
if (d.federation) {
  const f = d.federation;
  const [policy, res] = await Promise.all([view(f.dao, "get_policy"), view(f.dao, "get_proposal", { id: f.resolution.id })]);
  const members = policy.roles.find((r) => r.name === "member")?.kind?.Group ?? [];
  const behind = await Promise.all(f.resolution.votes.map(async (v) => {
    const p = await view(v.dao, "get_proposal", { id: v.proposal });
    return p.status === "Approved" && argsOf(p).some((a) => a.method === "act_proposal" && a.args.id === f.resolution.id && a.args.action === "VoteApprove")
      && p.kind.FunctionCall.receiver_id === f.dao && res.votes[v.dao] === "Approve";
  }));
  const onlyCoops = members.length === f.members.length && f.members.every((m) => members.includes(m))
    && policy.roles.every((r) => r.name !== "member" ? !(r.permissions ?? []).some((x) => /Vote/.test(x)) : true);
  check(onlyCoops && res.status === "Approved" && behind.every(Boolean),
    "a secondary co-op: a federation whose members are co-ops, and each co-op voted only by its own members' decision",
    `${f.dao}: members ${members.join(", ")}; resolution #${f.resolution.id} ${res.status}; `
    + f.resolution.votes.map((v, i) => `${v.dao.split(".")[0]} voted by its proposal #${v.proposal} (${behind[i] ? "approved by its members" : "NOT FOUND"})`).join("; "));
}

// the federation's shared reserve moves money: each co-op paid in by its own vote, and a grant passed by both co-ops' votes
if (d.federation?.reserve) {
  const f = d.federation, r = f.reserve;
  const ins = await Promise.all(r.paid_in.map((x) => view(x.dao, "get_proposal", { id: x.proposal })));
  const g = await view(f.dao, "get_proposal", { id: r.grant.id });
  const ok = ins.every((p) => p.status === "Approved" && p.kind.Transfer?.receiver_id === f.dao)
    && g.status === "Approved" && g.kind.Transfer?.receiver_id === r.grant.to && r.grant.votes.every((v) => g.votes[v.dao] === "Approve");
  check(ok, "the federation runs a shared reserve: each co-op paid in by its own vote, and a grant from it passed by both co-ops' votes",
    `${r.paid_in.map((x, i) => `${x.dao.split(".")[0]} paid ${x.near} NEAR by #${x.proposal} (${ins[i].status})`).join("; ")}; grant #${r.grant.id} of ${r.grant.near} NEAR to ${r.grant.to.split(".")[0]}: ${g.status}`);
}

// 0.3.0 (scripts/lending.mjs): funds paid from a profit share's reserve, and loans the contract filed under the voted rule
if (d.lending?.funds) {
  const f = d.lending.funds;
  const [onChain, got] = await Promise.all([view(d.contract, "get_share_funds"), Promise.all(f.funds.map((x) => view(d.usdc, "ft_balance_of", { account_id: x.to })))]);
  const ok = f.funds.every((x, i) => onChain.some((y) => y.to === x.to && y.bps === x.bps) && BigInt(got[i]) > 0n)
    && Boolean(approvedCall("set_share_funds", (a) => a.funds?.length === f.funds.length));
  check(ok, "funds from the surplus (education, social) were voted and are paid from a profit share's reserve",
    f.funds.map((x, i) => `${x.name} ${x.bps / 100}% to ${x.to}: holds ${usd(got[i])} USDC`).join("; ") + `; voted by #${f.set}, first paid by the share #${f.share}`);
}
if (d.lending?.loans) {
  const l = d.lending.loans;
  const res = await Promise.all(l.loans.map(async (x) => {
    const [loan, p, gs] = await Promise.all([view(d.contract, "get_loan", { account_id: x.who }), view(d.dao, "get_proposal", { id: x.proposal }),
      view(d.contract, "get_guarantors", { account_id: x.who })]);
    const ok = p.status === "Approved" && p.kind.Transfer?.receiver_id === x.who && p.proposer === d.contract && gs.includes(l.guarantor)
      && (x.repaid ? loan.status === "Repaid" : loan.status !== "Repaid");
    return { ok, line: `${x.who.split(".")[0]} ${x.near} NEAR by #${x.proposal} (filed and approved by the contract), guaranteed by ${l.guarantor.split(".")[0]}: ${loan.status}` };
  }));
  check(res.every((r) => r.ok) && Boolean(approvedCall("set_loan_rule", () => true)),
    "savings and loans: members with a guarantor borrowed from the fund the members voted, and repaid into the treasury", res.map((r) => r.line).join("; "));
}

// 0.3.1: a second agent the members voted, with its tags, holding only a function-call key; its receipt names it
if (d.agents?.translator) {
  const t = d.agents.translator;
  const [agents, keys, who, proof] = await Promise.all([view(d.contract, "get_agents"), rawQuery({ request_type: "view_access_key_list", account_id: t }),
    view(d.contract, "get_receipt_agent", { job_id: d.agents.receipt }), view(d.contract, "get_proof", { job_id: d.agents.receipt })]);
  const mine = agents.find((a) => a.account === t);
  const fcOnly = keys.keys.every((k) => k.access_key.permission !== "FullAccess"
    && k.access_key.permission.FunctionCall?.receiver_id === d.contract);
  const ok = Boolean(mine?.tags.length) && fcOnly && who === t && Boolean(JSON.parse(proof ?? "{}").model);
  check(ok, "a second agent the members voted takes only its jobs (translation, localization), holds only a function-call key, and its receipt names it",
    `${t}: tags ${mine?.tags.join(", ")} by #${d.agents.vote}; keys: ${keys.keys.length} function-call only; receipt ${d.agents.receipt.slice(0, 14)}… recorded by it, TEE proof ${JSON.parse(proof ?? "{}").model}`);
}

// attacks sent as real transactions (scripts/redteam.mjs): each one failed on-chain with the refusal it was saved with
if (d.redteam?.length) {
  const res = await Promise.all(d.redteam.map(async (r) => {
    const t = await rpcCall(NEAR_TX_RPCS, "EXPERIMENTAL_tx_status", { tx_hash: r.tx, sender_account_id: r.by, wait_until: "FINAL" });
    const failure = JSON.stringify(t?.status?.Failure ?? t?.receipts_outcome?.map((o) => o.outcome.status.Failure).find(Boolean) ?? null);
    return failure !== "null" && failure.includes(JSON.stringify(r.error.slice(0, 60)).slice(1, -1)) && t.transaction.receiver_id === r.contract;
  }));
  check(res.every(Boolean), `every attack sent to the live co-op was refused on-chain (${d.redteam.length} transactions)`,
    d.redteam.map((r, i) => `${r.what}: ${res[i] ? "refused" : "NOT REFUSED"} ("${r.error.slice(0, 50)}")`).join("; "));
}

// 6. profit shares: USDC left the treasury only by a members' vote, through the contract's split
const shares = proposals.filter((p) => p.status === "Approved" && argsOf(p).some((a) => a.method === "ft_transfer_call" && a.args.receiver_id === d.contract && a.args.msg === "share"));
check(shares.length > 0, "the members voted every profit share out of the treasury, split by the contract",
  shares.map((p) => `#${p.id}: ${usd(argsOf(p)[0].args.amount)} USDC, approved by ${Object.keys(p.votes).length} members`).join("; ") || "none");

// 7. what the README admits: no real jobs yet, audit red on purpose, treasury empty
const receipts = await view(d.contract, "get_receipts", { from: 0, limit: 200 });
const proofs = await Promise.all(receipts.map((x) => view(d.contract, "get_proof", { job_id: x.job_id })));
const parsedProofs = proofs.map((p) => { try { return p ? JSON.parse(p) : null; } catch { return null; } });
const proven = receipts.filter((x, i) => parsedProofs[i]?.model);
// every job since the agent runs the gate: its by-laws were checked in the enclave, on-chain, before it started
const gated = receipts.map((x, i) => [x, parsedProofs[i]?.gate]).filter(([, g]) => g?.tx);
if (gated.length) {
  const res = await Promise.all(gated.map(([x, g]) => gate(g.tx, g.by, x.config_hash, x.job_id)));
  check(res.every((r) => r.ok), "every job that names a by-laws gate had its by-laws checked inside an Intel TDX enclave first, against the hash its receipt carries",
    gated.map(([x], i) => `${x.job_id.slice(0, 14)}…: ${res[i].ok ? "match" : "FAILED"} (${res[i].line})`).join("; "));
}
// jobs from a third-party testnet market (scripts/taskbond.mjs): posted by an account that is not a member, guarded,
// reviewed and paid by that market's own operator and escrow; the co-op's receipt names the job
for (const t of d.taskbond ?? []) {
  const [job, agent, member] = await Promise.all([view(t.escrow, "get_job", { job_id: t.job }), view(t.escrow, "get_agent", { agent_id: t.agent_id }),
    view(d.contract, "get_member", { account_id: t.poster })]);
  const i = receipts.findIndex((x) => x.job_id === t.receipt);
  const proof = parsedProofs[i];
  const ok = job.status === "Paid" && job.winner_agent_id === t.agent_id && agent.owner === t.owner && agent.review === "Accepted" && member === null
    && proof?.model && proof?.market?.escrow === t.escrow && proof.market.job === t.job;
  check(ok, "the agent won a job on a third-party testnet market (Taskbond): posted by a non-member, judged and paid by that market's own AIs and escrow",
    `${t.escrow} job #${t.job} posted by ${t.poster} (not a member): ${job.status}, winner agent #${job.winner_agent_id} (ours, run by ${agent.owner}), `
    + `score ${job.score}: "${agent.review_reason.slice(0, 90)}"; receipt ${t.receipt} with the TEE proof (${proof?.model})`);
}
const third = proven.filter((x) => x.job_id.startsWith("taskbond-")).length;
const market = proven.filter((x) => !x.job_id.startsWith("demo-") && !x.job_id.startsWith("taskbond-")).length;
console.log(`INFO  receipts: ${receipts.length}, ${proven.length} with a TEE inference proof (${proven.length - market - third} for a demo buyer, ${third} from a third-party testnet market, ${market} from Agent Market: 0 = no real Agent Market job yet, as the README says)`);
console.log(`INFO  audit: expected ${usd(audit.expected)} USDC, deposited ${usd(audit.deposited)}, owed ${usd(audit.owed)} (red on purpose: the demo's last step has the steward keep a payout)`);
const usdc = await view(info.usdc_id, "ft_balance_of", { account_id: d.dao });
console.log(`INFO  DAO treasury: ${usd(usdc)} USDC (${info.usdc_id.slice(0, 12)}…)`);

console.log(`\n${failed ? `${failed} claim(s) FAILED` : "every claim checks out"}. Explorer: ${accountUrl(d.contract)}`);
process.exit(failed ? 1 : 0);
