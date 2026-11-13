// node scripts/v032.mjs [vote] [share] [card] [propose]   contract 0.3.2 on the showcase co-op, by vote
//   vote:    one proposal, three actions: the agent saves 10% of what it earns into the risk fund; 10% of every profit
//            share (out of the reserve) is split by each member's record; the translator agent gets its own by-laws v1
//   share:   a 2 USDC profit share from the treasury: the education and social funds and the reputation dividend are paid
//   card:    alice's work-record token, read live: credit score, dues and loan on the card
//   propose: the agent reads its own record, writes by-laws v7 (a new price) and signs the proposal; the relayer submits
//            it (the agent's key opens only its receipts); the contract files the DAO proposal; the members vote it
// The result is saved in the deployment files (`v032`); `npm run verify` reads every step back.
import fs from "node:fs";
import path from "node:path";
import { KeyPair } from "near-api-js";
import { DEPLOYMENT, ROOT, account, all, b64, callRaw, decide, sha256, txUrl, view, vote } from "./lib.mjs";

const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const K = dep.contract, D = dep.dao, USDC = dep.usdc;
const A = "kop-alice-mw4i3w8f.testnet", B = "kop-bob-mw4i3w8f.testnet", S = dep.steward;
const TRANSLATOR = "kop-translator-mwepareu.testnet", RELAYER = `kop-relayer-${dep.tag}.testnet`;
const voters = [A, B, S].map(account);
const want = process.argv.slice(2);
const run = (part) => !want.length || want.includes(part);
const say = (what, out) => console.log(`${what}${out?.transaction ? `: ${txUrl(out.transaction.hash)}` : ""}`);
const saved = (patch) => {
  for (const f of [DEPLOYMENT, path.join(ROOT, "web/deployment.json")]) {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    d.v032 = { ...d.v032, ...patch };
    fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
  }
};
const action = (method_name, args) => ({ method_name, args: b64(args), deposit: "0", gas: String(30n * 10n ** 12n) });
const usdc = (x) => Number(x) / 1e6;

if (run("vote")) {
  const uri = "config/translator/config.v1.yaml";
  const hash = sha256(fs.readFileSync(path.join(ROOT, uri)));
  const { id } = await decide(account(A), voters, D,
    "Contract 0.3.2 by-laws: the agent saves 10% of its earnings into the risk fund; 10% of every profit share (out of the reserve) is split by each member's record; the translator agent runs its own by-laws v1",
    { FunctionCall: { receiver_id: K, actions: [
      action("set_agent_saves", { bps: 1000 }),
      action("set_reputation_share", { bps: 1000 }),
      action("set_agent_config", { account_id: TRANSLATOR, version: 1, hash, uri }),
    ] } });
  console.log(`proposal #${id} approved: agent saves ${(await view(K, "get_risk_fund"))[1] / 100}%, reputation share ${(await view(K, "get_reputation_share")) / 100}%`);
  saved({ vote: { proposal: id, agentSavesBps: 1000, reputationBps: 1000, translatorConfig: { uri, hash } } });
}

if (run("share")) {
  const members = (await view(K, "get_members", {})).map(([a]) => a);
  const before = await Promise.all(members.map((a) => view(K, "get_claimable", { account_id: a })));
  const { id } = await decide(account(A), voters, D, "Profit share of 2 USDC from the treasury (the first with a reputation dividend)",
    { FunctionCall: { receiver_id: USDC, actions: [{ method_name: "ft_transfer_call", args: b64({ receiver_id: K, amount: "2000000", msg: "share" }),
      deposit: "1", gas: String(200n * 10n ** 12n) }] } });
  console.log(`proposal #${id} approved: profit share of 2 USDC`);
  await new Promise((ok) => setTimeout(ok, 5000));
  const after = await Promise.all(members.map((a) => view(K, "get_claimable", { account_id: a })));
  const credited = members.map((a, i) => ({ account: a, credited: String(BigInt(after[i]) - BigInt(before[i])) }));
  for (const c of credited) console.log(`  ${c.account}: +${usdc(c.credited)} USDC`);
  saved({ share: { proposal: id, credited } });
}

if (run("card")) {
  const t = await view(K, "nft_token", { token_id: A });
  if (!t) say("alice minted her work record", await callRaw(account(A), K, "mint_work_record", {}, { deposit: 10n ** 22n, tgas: 30 }));
  const tok = await view(K, "nft_token", { token_id: A });
  console.log(tok.metadata.description);
  saved({ card: { token: A, extra: JSON.parse(tok.metadata.extra) } });
}

if (run("propose")) {
  // the agent's record, read from the chain: what happened to the jobs it settled
  const receipts = await all(K, "get_receipts");
  const mine = receipts.filter((r) => r.config_version >= 1);
  const settled = mine.filter((r) => r.status !== "Submitted");
  const bad = settled.filter((r) => r.status === "Refunded" || r.status === "Disputed").length;
  const paid = settled.filter((r) => r.status === "Paid");
  const cost = paid.reduce((s, r) => s + Number(r.inference_cost), 0) / Math.max(1, paid.length) / 1e6;
  const cfg = await view(K, "get_config");
  const text = fs.readFileSync(path.join(ROOT, cfg.uri), "utf8");
  const price = Number(text.match(/^\s+price_usdc:\s*([\d.]+)/m)?.[1]);
  // ponytail: one pricing rule, written down: at least 10 settled jobs; refunds and disputes at most 20% → price +25%,
  // above 35% → price −25%; in between, nothing to propose. The members decide either way.
  const rate = bad / Math.max(1, settled.length);
  const next = settled.length < 10 ? price : rate <= 0.2 ? Math.ceil(price * 1.25 * 2) / 2 : rate > 0.35 ? Math.max(1, Math.floor(price * 0.75 * 2) / 2) : price;
  if (next === price) { console.log(`nothing to propose: ${settled.length} settled jobs, ${(rate * 100).toFixed(0)}% refunded or disputed`); process.exit(0); }
  const reason = `${settled.length} jobs settled, ${bad} refunded or disputed (${(rate * 100).toFixed(0)}%), ${paid.length} paid at an average inference cost of $${cost.toFixed(4)}: the price can go from ${price} to ${next} USDC`;
  const version = cfg.version + 1;
  const uri = `config/config.v${version}.yaml`;
  const body = text
    .replace(/^# By-laws v\d+[^\n]*\n/, `# By-laws v${version} (proposed by the co-op's agent from its own record, scripts/v032.mjs propose: ${reason}): the only config the Koperasi agent may run.\n`)
    .replace(/^version:\s*\d+/m, `version: ${version}`)
    .replace(/^(\s+price_usdc:\s*)[\d.]+/m, `$1${next}`);
  fs.writeFileSync(path.join(ROOT, uri), body);
  fs.mkdirSync(path.join(ROOT, "web/config"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "web", uri), body);
  const hash = sha256(Buffer.from(body));
  // the agent signs; its key is the one the contract saw on its last receipt
  const { private_key } = JSON.parse(fs.readFileSync(path.join(ROOT, ".keys", `${dep.agent}.json`), "utf8"));
  const msg = await view(K, "get_agent_proposal_message", { version, hash, uri, reason });
  const signature = Buffer.from(KeyPair.fromString(private_key).sign(Buffer.from(msg)).signature).toString("base64");
  const r = await callRaw(account(RELAYER), K, "agent_propose_bylaws", { version, hash, uri, reason, signature }, { tgas: 100 });
  say(`the agent proposed by-laws v${version} (signed by the agent, submitted by ${RELAYER})`, r);
  await new Promise((ok) => setTimeout(ok, 4000));
  const p = (await view(K, "get_agent_proposals")).at(-1);
  if (p?.version !== version || p.proposal == null) throw new Error("the DAO did not file the agent's proposal");
  console.log(`   DAO proposal #${p.proposal}: ${(await view(D, "get_proposal", { id: p.proposal })).description}`);
  for (const v of voters) {
    if ((await view(D, "get_proposal", { id: p.proposal })).status !== "InProgress") break;
    await vote(v, D, p.proposal);
  }
  const status = (await view(D, "get_proposal", { id: p.proposal })).status;
  const now = await view(K, "get_config");
  console.log(`   the members' vote: ${status}; the contract holds by-laws v${now.version}`);
  if (now.hash !== hash) throw new Error("the by-laws did not change");
  for (const f of [DEPLOYMENT, path.join(ROOT, "web/deployment.json")]) {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    fs.writeFileSync(f, JSON.stringify({ ...d, configUri: uri, configHash: hash }, null, 2) + "\n");
  }
  saved({ agentProposal: { version, uri, hash, reason, price: { from: price, to: next }, proposal: p.proposal, submitted: r.transaction.hash, relayer: RELAYER, status } });
}
