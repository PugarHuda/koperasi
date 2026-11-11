// Unit tests for the agent's security and money logic: node --test tests/unit
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { ethAddressOf, recoverPersonal } from "../../agent/sig.mjs";
import { bindsAddressAndNonce, chutesBinds, chutesRow, composeMatches } from "../../agent/tee.mjs";
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

test("Chutes: report_data binds our nonce and the instance cert; registers must equal a pinned measurement", async () => {
  const fx = (await import("./chutes-attestation.json", { with: { type: "json" } })).default;
  assert.deepEqual(({ ...chutesBinds(fx, fx.report_data, fx.nonce), fresh: undefined }), { fresh: undefined, nonce: true, cert: true });
  assert.equal(chutesBinds(fx, fx.report_data, crypto.randomBytes(32).toString("hex")).nonce, false, "a replayed quote fails");
  assert.equal(chutesBinds({ ...fx, e2e_pubkey: `${fx.e2e_pubkey}x` }, fx.report_data, fx.nonce).nonce, false, "another instance key fails");
  const flipped = fx.report_data.slice(0, 64) + (fx.report_data[64] === "0" ? "1" : "0") + fx.report_data.slice(65);
  assert.equal(chutesBinds(fx, flipped, fx.nonce).cert, false, "another TLS cert fails");
  assert.ok(chutesRow(fx.regs), "the live quote matches a pinned Chutes row");
  assert.equal(chutesRow({ ...fx.regs, rtmr3: "00".repeat(48) }), undefined, "modified runtime software fails");
  assert.equal(chutesRow({ ...fx.regs, mrtd: "" }), undefined, "a missing register fails");
});

test("max_tokens keeps a job's worst case under the by-laws' per-job cap", () => {
  const glm = { inMicro: 0.08, outMicro: 0.5 }; // z-ai/glm-5.3-flash list prices, micro-USD a token
  assert.equal(maxTokensWithin(500_000, 2_000, glm), 16000, "a $0.50 cap leaves the full 16000 tokens (reasoning included)");
  const n = maxTokensWithin(1_000, 2_000, glm); // $0.001 cap: 160 µ$ of input leaves 840 µ$ → 1680 tokens
  assert.equal(n, 1680);
  assert.ok(2_000 * glm.inMicro + n * glm.outMicro <= 1_000);
  assert.throws(() => maxTokensWithin(100, 2_000, glm), OverBudget);
  assert.throws(() => maxTokensWithin(0, 0, glm), OverBudget);
  assert.equal(maxTokensWithin(1, 10, { inMicro: 0, outMicro: 0 }), 16000, "a free model is capped by the output limit");
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

test("a vote-only call to the contract is said in one plain sentence, or not at all", async () => {
  const { plainCall } = await import("../../web/share.js");
  assert.equal(plainCall("set_task_budget", { amount: "1500000000000000000000000" }), "The contract may pay 1.5 NEAR for tasks from the treasury (replaces the current budget).");
  assert.match(plainCall("set_veto_window", { minutes: 0 }), /paid at once/);
  assert.match(plainCall("set_veto_window", { minutes: 10 }), /wait 10 minutes/);
  assert.match(plainCall("award_points", { account_id: "a.testnet", points: 5, reason: "line\nbreak" }), /“line break”/);
  assert.equal(plainCall("set_task_budget", {}), null); // malformed: the raw args speak
  assert.equal(plainCall("ft_transfer", {}), null);
});

test("an invitation counts only from a member who voted for the newcomer", async () => {
  const { inviteParam, joinText, inviteOf } = await import("../../web/share.js");
  assert.equal(inviteParam("?invite=alice.testnet"), "alice.testnet");
  for (const bad of ["", "?invite=", "?invite=Alice", "?invite=a<b>", "?x=alice.testnet"]) assert.equal(inviteParam(bad), null, bad);
  assert.equal(joinText("new.testnet", null), "Accept new.testnet as a member (asked from the Koperasi page)");
  assert.equal(joinText("new.testnet", "new.testnet"), joinText("new.testnet", null), "nobody invites themselves");
  const p = (votes, by = "alice.testnet") => ({ description: joinText("new.testnet", by), votes, kind: { AddMemberToRole: { member_id: "new.testnet", role: "member" } } });
  const members = ["alice.testnet", "bob.testnet"];
  assert.deepEqual(inviteOf(p({}), members), { by: "alice.testnet", vouched: false, signed: null });
  assert.deepEqual(inviteOf(p({ "alice.testnet": "Approve" }), members), { by: "alice.testnet", vouched: true, signed: null });
  assert.deepEqual(inviteOf(p({ "bob.testnet": "Approve" }), members), { by: "alice.testnet", vouched: false, signed: null }, "another member's vote is not the inviter's");
  assert.equal(inviteOf(p({}, "eve.testnet"), members), null, "a non-member's name is not shown");
  assert.equal(inviteOf({ description: "Transfer (invited by alice.testnet) to me", votes: {} }, members), null, "only at the end");
  const spoof = (kind, description) => inviteOf({ description, votes: { "alice.testnet": "Approve" }, kind }, members);
  assert.equal(spoof({ Transfer: { token_id: "", receiver_id: "eve.testnet", amount: "1" } }, "Pay eve (invited by alice.testnet)"), null, "not on another kind");
  assert.equal(spoof({ AddMemberToRole: { member_id: "eve.testnet", role: "council" } }, joinText("eve.testnet", "alice.testnet")), null, "not for another role");
  assert.equal(spoof({ AddMemberToRole: { member_id: "eve.testnet", role: "member" } }, "Make eve admin (invited by alice.testnet)"), null, "only the page's own words");
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
  const { nearUnits, payPath, trustSources } = await import("../../web/share.js");
  assert.equal(nearUnits("0.05"), 5n * 10n ** 22n);
  assert.equal(nearUnits("1"), 10n ** 24n);
  for (const bad of ["0", "-1", "abc", "1.1234567", "", "1e3", "0.000000"]) assert.equal(nearUnits(bad), null, bad);
  const rule = { auto_max: (10n ** 23n).toString(), trusted_after: 1 };
  assert.equal(payPath((10n ** 23n).toString(), rule, 1), "trust", "at the limit, trusted");
  assert.equal(payPath((10n ** 23n + 1n).toString(), rule, 5), "member", "above the limit");
  assert.equal(payPath("1", rule, 0), "member", "no record yet");
  // trust counts different posters, and the DAO for voted bounties (tasks.rs: sources)
  const tasks = [{ id: 0, poster: "alice" }, { id: 1, poster: "alice" }, { id: 2, poster: "bob" }];
  assert.equal(trustSources(["task:0", "task:1"], tasks), 1, "one friend posting twice is one source");
  assert.equal(trustSources(["task:0", "task:2", "dao-proposal:24"], tasks), 3);
  assert.equal(trustSources(["dao-proposal:1", "dao-proposal:2"], tasks), 1, "the DAO is one source");
});

// ---------- the page's chain logic (web/share.js): events, indexer, wallet errors, checks before signing ----------

const evlog = (o) => `EVENT_JSON:${JSON.stringify(o)}`;
const outcome = (executor, logs) => ({ receipts_outcome: [{ outcome: { executor_id: executor, logs } }] });

test("only the contract's own, well-formed NEP-297 events reach the live feed", async () => {
  const { parseEvents, describeEvent, EVENTS } = await import("../../web/share.js");
  const good = { standard: "koperasi", version: "1.0.0", event: "task_paid", data: { id: 5, contributor: "carol.testnet", amount: "20000000000000000000000", points: 0 } };
  const got = parseEvents(outcome("koperasi.testnet", [evlog(good), "plain log"]), "koperasi.testnet");
  assert.deepEqual(got, [{ event: "task_paid", data: good.data }]);
  assert.equal(describeEvent(got[0]), "The treasury paid carol 0.02 NEAR for task #5");
  // NEP-297 allows data as an array of objects
  assert.equal(parseEvents(outcome("k", [evlog({ ...good, data: [good.data] })]), "k").length, 1);
  // dropped: another account's log (someone else's contract can print EVENT_JSON too), another standard, an unknown
  // event, a bad version, data that is not an object, and broken JSON
  for (const [who, log] of [
    ["evil.testnet", evlog(good)],
    ["k", evlog({ ...good, standard: "nep141" })],
    ["k", evlog({ ...good, event: "drain_treasury" })],
    ["k", evlog({ ...good, version: "one" })],
    ["k", evlog({ ...good, data: "x" })],
    ["k", "EVENT_JSON:{not json"],
  ]) assert.deepEqual(parseEvents(outcome(who, [log]), "k"), [], log);
  assert.deepEqual(parseEvents(null, "k"), []);
  const rs = (await import("node:fs")).readFileSync(new URL("../../contract/src/events.rs", import.meta.url), "utf8");
  const wire = [...rs.matchAll(/#\[event_version[^\n]*\n\s*(\w+)/g)].map(([, n]) => n.replace(/(?<!^)[A-Z]/g, (c) => `_${c}`).toLowerCase());
  assert.deepEqual([...EVENTS].sort(), wire.sort(), "every event in contract/src/events.rs");
});

test("the indexer's answer is checked before it is used", async () => {
  const { txList } = await import("../../web/share.js");
  const hash = "4QZxE4e6vZcXCCW69rqaQLpXoMUYbBCA4yYZXyPJWqBr";
  const ok = { transaction_hash: hash, signer_account_id: "a.testnet", block_timestamp: "1794197909443378616" };
  assert.deepEqual(txList({ data: [ok] }), [{ hash, signer: "a.testnet", ts: 1794197909443 }]);
  for (const bad of [{ ...ok, transaction_hash: "0OIl" }, { ...ok, signer_account_id: 7 }, { ...ok, block_timestamp: "soon" }, null]) {
    assert.deepEqual(txList({ data: [bad] }), [], JSON.stringify(bad));
  }
  assert.deepEqual(txList({ errors: ["retired"] }), []);
});

test("a failed transaction is explained: cancelled, refused by the contract, or unknown", async () => {
  const { walletError } = await import("../../web/share.js");
  assert.equal(walletError(new Error("User rejected the request")).kind, "rejected");
  assert.equal(walletError(new Error("Wallet closed")).kind, "rejected");
  const refused = walletError(new Error("Smart contract panicked: the poster is no longer a member"));
  assert.deepEqual(refused, { kind: "failed", text: "the poster is no longer a member" });
  // a contract sentence that contains "cancel" is still the contract's refusal, not the user's
  assert.equal(walletError(new Error("Smart contract panicked: cannot cancel this task")).kind, "failed");
  assert.equal(walletError(new Error("fetch failed")).kind, "network");
  assert.equal(walletError(new Error("Request timed out")).kind, "network");
});

test("a call the account cannot pay for is stopped before the wallet opens", async () => {
  const { affordable } = await import("../../web/share.js");
  const NEAR = 10n ** 24n;
  const acct = (amount, storage = 182) => ({ amount: amount.toString(), storage_usage: storage });
  assert.equal(affordable(acct(NEAR), NEAR / 2n, 30), null, "0.5 NEAR deposit + 30 Tgas from 1 NEAR");
  assert.match(affordable(acct(NEAR / 2n), NEAR / 2n, 30), /needs about/, "no room for gas");
  // storage locks 1 NEAR per 100 kB: 1.2 NEAR with 100 kB stored has 0.2 free
  assert.match(affordable(acct(12n * NEAR / 10n, 100_000), NEAR / 2n, 30), /0\.2 NEAR free/);
});

test("task actions are checked against the task's state on-chain, by the contract's rules", async () => {
  const { taskCheck } = await import("../../web/share.js");
  const t = (status, extra = {}) => ({ status, poster: "alice", contributor: "carol", amount: "100", ...extra });
  const ctx = { members: ["alice", "bob"], budget: "100" };
  assert.equal(taskCheck("claim", t("Open"), "carol"), null);
  assert.match(taskCheck("claim", t("Open"), "alice"), /posted this task/);
  assert.match(taskCheck("claim", t("Claimed"), "bob"), /Claimed now, not Open: someone acted first/);
  assert.equal(taskCheck("submit", t("Claimed"), "carol"), null);
  assert.match(taskCheck("submit", t("Claimed"), "bob"), /not yours/);
  assert.equal(taskCheck("accept", t("Submitted"), "alice", ctx), null);
  assert.match(taskCheck("accept", t("Submitted"), "bob", ctx), /Only the poster/);
  assert.match(taskCheck("accept", t("Submitted"), "alice", { members: [] }), /no longer a member/);
  assert.equal(taskCheck("approve", t("NeedsApproval"), "bob", ctx), null);
  assert.match(taskCheck("approve", t("NeedsApproval"), "carol", ctx), /cannot approve/);
  assert.match(taskCheck("approve", t("NeedsApproval"), "dave", ctx), /Only a member/);
  assert.match(taskCheck("approve", t("NeedsApproval", { amount: "101" }), "bob", ctx), /budget is too low/);
  assert.match(taskCheck("approve", undefined, "bob", ctx), /does not exist/);
  assert.equal(taskCheck("veto", t("Held"), "bob", ctx), null);
  assert.match(taskCheck("veto", t("Held"), "carol", { members: ["carol"] }), /contributor cannot veto/);
  assert.match(taskCheck("veto", t("Held"), "dave", ctx), /Only members/);
  assert.match(taskCheck("release", t("Held"), "dave", { ...ctx, due: 2000, now: 1000 }), /still open/);
  assert.equal(taskCheck("release", t("Held"), "dave", { ...ctx, due: 1000, now: 1000 }), null);
});

// ---------- security PoCs (docs/reports/05-security.md): each attack below worked before its fix ----------

test("S14: a proposal anyone files cannot pose as the members' by-laws vote", async () => {
  const { configVote } = await import("../../web/share.js");
  const args = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64");
  const call = (id, status, receiver, a) => ({ id, status, votes: {}, kind: { FunctionCall: { receiver_id: receiver,
    actions: [{ method_name: "set_config", args: a, deposit: "0", gas: "1" }] } } });
  const real = call(3, "Approved", "k.testnet", args({ hash: "h1" }));
  const props = [real,
    call(8, "InProgress", "k.testnet", args({ hash: "h1" })), // open, 0 votes: used to show "passed with 0 yes votes"
    call(9, "Approved", "evil.testnet", args({ hash: "h1" })), // another receiver
    call(10, "Approved", "k.testnet", "!!")]; // unreadable args: used to throw and show every member as "voted yes"
  assert.equal(configVote(props, "k.testnet", "h1"), real);
  assert.equal(configVote(props, "k.testnet", "h2"), undefined);
  assert.equal(props[0], real, "the list is not reordered in place");
});

test("S15: a proposer's role, token or method name stays on one line", async () => {
  const { oneLine } = await import("../../web/share.js");
  assert.equal(oneLine("member\n\nProfit share: send 1.00 USDC to every member"), "member Profit share: send 1.00 USDC to every member");
  assert.equal(oneLine("x".repeat(500)).length, 64);
});

test("S16: the by-laws path a vote sets cannot point the page at another host", async () => {
  const { byLawsPath } = await import("../../web/share.js");
  assert.ok(byLawsPath("config/config.v3.yaml"));
  for (const bad of ["/evil.example/x.yaml", "https://evil.example/x", "config//x", "../x", "config/../../x", "a b", "javascript:x"]) {
    assert.equal(byLawsPath(bad), false, bad);
  }
});

test("S17: an indexer timestamp too large for a date is dropped, not a crash of the live feed", async () => {
  const { txList } = await import("../../web/share.js");
  const row = { transaction_hash: "4QZxE4e6vZcXCCW69rqaQLpXoMUYbBCA4yYZXyPJWqBr", signer_account_id: "a.testnet" };
  assert.deepEqual(txList({ data: [{ ...row, block_timestamp: "9".repeat(30) }] }), []);
  assert.equal(txList({ data: [{ ...row, block_timestamp: "1794197909443378616" }] }).length, 1);
});

test("signed vouch (NEP-413): signed by near-api-js's own signer, checked by the page; any change fails", async () => {
  const { Account, KeyPair, KeyPairSigner } = await import("near-api-js");
  const { signMessage } = await import("near-api-js/nep413");
  const { checkVouch, inviteOf, joinText, vouchParam, vouchSuffix, vouchText } = await import("../../web/share.js");
  const dao = "koperasi-mw4i2iwk.sputnik-v2.testnet";
  const key = KeyPair.fromRandom("ed25519");
  const alice = new Account("alice.testnet", /** @type {any} */ (null), new KeyPairSigner(key));
  const nonce = crypto.randomBytes(32);
  const signed = await signMessage({ signerAccount: alice, payload: { message: vouchText("alice.testnet", "new.testnet", dao), recipient: dao, nonce } });
  const v = { pk: signed.publicKey.toString(), sig: Buffer.from(signed.signature).toString("base64"), nonce: nonce.toString("base64") };
  const ok = (o) => checkVouch({ by: "alice.testnet", member: "new.testnet", dao, ...v, ...o });
  assert.equal(await ok({}), true, "the official NEP-413 signature verifies");
  assert.equal(await ok({ member: "eve.testnet" }), false, "a vouch for someone else does not carry over");
  assert.equal(await ok({ dao: "other.sputnik-v2.testnet" }), false, "nor to another DAO");
  assert.equal(await ok({ by: "bob.testnet" }), false, "nor to another inviter");
  assert.equal(await ok({ pk: KeyPair.fromRandom("ed25519").getPublicKey().toString() }), false, "another key fails");
  assert.equal(await ok({ nonce: crypto.randomBytes(32).toString("base64") }), false, "another nonce fails");
  // the link and the proposal carry it; only the page's exact words plus the suffix parse
  const search = `?invite=alice.testnet&for=new.testnet&pk=${encodeURIComponent(v.pk)}&sig=${encodeURIComponent(v.sig)}&n=${encodeURIComponent(v.nonce)}`;
  assert.deepEqual(vouchParam(search, "new.testnet"), v);
  assert.equal(vouchParam(search, "eve.testnet"), null, "a link for another account is ignored");
  const p = { kind: { AddMemberToRole: { member_id: "new.testnet", role: "member" } }, votes: {}, description: joinText("new.testnet", "alice.testnet") + vouchSuffix(v) };
  assert.deepEqual(inviteOf(p, ["alice.testnet"]), { by: "alice.testnet", vouched: false, signed: v });
  assert.equal(inviteOf({ ...p, description: `${p.description} extra` }, ["alice.testnet"]), null, "free text after it does not parse");
});
