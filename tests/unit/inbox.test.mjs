// api/inbox.mjs: the member's feed lists only what waits on them, and nothing in it can break the XML.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { inboxItems, rss } from "../../api/inbox.mjs";

const NOW = Date.UTC(2026, 10, 13);
const ns = (ms) => String(BigInt(ms) * 1_000_000n);

test("the feed lists the votes, juries, pledges and dues that wait on this member, and nothing else", () => {
  const data = {
    member: true,
    proposals: [{ id: 5, status: "InProgress", votes: {}, description: "Raise the budget" }, { id: 6, status: "InProgress", votes: { "a.testnet": "Approve" }, description: "x" },
      { id: 7, status: "Approved", votes: {}, description: "done" }],
    cases: [{ id: 1, status: "Open", jurors: ["a.testnet"], votes: [], opened: ns(NOW), job_id: "j", amount: "500000" },
      { id: 2, status: "Open", jurors: ["a.testnet"], votes: [["a.testnet", true]], opened: ns(NOW), job_id: "j", amount: "1" }],
    claims: [{ id: 3, pledge: 9, holder: "a.testnet", status: "Open" }, { id: 4, pledge: 9, holder: "b.testnet", status: "Open" }],
    dues: [ns(NOW + 3 * 86_400_000), true],
  };
  const items = inboxItems("a.testnet", data, NOW).map((i) => i.id);
  assert.deepEqual(items, ["p5", "c1", "k3", `dues${ns(NOW + 3 * 86_400_000)}`]);
  assert.deepEqual(inboxItems("a.testnet", { ...data, member: false }, NOW).map((i) => i.id).filter((x) => x.startsWith("p")), [], "a non-member votes on nothing");
  assert.equal(inboxItems("a.testnet", { dues: [ns(NOW), false] }, NOW)[0].id, "dues-late");
});

test("what members wrote is escaped in the feed", () => {
  const out = rss("a.testnet", [{ id: "p1", title: "Vote <now>", text: `"x" & </description><script>` }], NOW);
  assert.ok(!out.includes("<script>") && out.includes("&lt;script&gt;") && out.includes("&amp;"));
});

test("0.3.3: shares to claim, a loan due or late here or at a sister co-op, and the agent's own proposal", () => {
  const loan = (status, dueMs) => ({ principal: String(3n * 10n ** 23n), interest: String(6n * 10n ** 21n), due: ns(dueMs), status });
  const agentP = { id: 9, status: "InProgress", votes: {}, proposer: "c.testnet", description: "By-laws v8, proposed by the co-op's agent from its record: x" };
  const items = inboxItems("a.testnet", { member: true, proposals: [agentP], claimable: "1500000", loan: loan("Open", NOW + 2 * 86_400_000),
    lateElsewhere: ["sister.testnet"], contract: "c.testnet" }, NOW);
  assert.deepEqual(items.map((i) => i.id), ["p9", "claim1500000", `loan${ns(NOW + 2 * 86_400_000)}`, "late-sister.testnet"]);
  assert.match(items[0].title, /agent proposes/);
  assert.match(items[2].text, /0\.306 NEAR/);
  assert.equal(inboxItems("a.testnet", { loan: loan("Late", NOW) }, NOW)[0].id, "loan-late");
  assert.deepEqual(inboxItems("a.testnet", { loan: loan("Repaid", NOW), claimable: "0" }, NOW), []);
});

test("push (scripts/notify.mjs): only items not told before, and a new due date counts as new", async () => {
  const { fresh } = await import("../../scripts/notify.mjs");
  const items = [{ id: "p5" }, { id: "c1" }, { id: "dues200" }];
  assert.deepEqual(fresh(items, ["p5", "dues100"]).map((i) => i.id), ["c1", "dues200"]);
  assert.deepEqual(fresh(items, ["p5", "c1", "dues200"]), []);
  assert.deepEqual(fresh(items).map((i) => i.id), ["p5", "c1", "dues200"], "a member with nothing told yet gets all");
});

test("the ntfy topic: an HMAC under the secret, per co-op and member; no secret, no topic", async () => {
  const { ntfyTopic } = await import("../../api/notify-topic.mjs");
  const topic = ntfyTopic("s3cret", "c.testnet", "a.testnet");
  assert.equal(topic, `koperasi-${createHmac("sha256", "s3cret").update("c.testnet:a.testnet").digest("hex").slice(0, 20)}`);
  assert.match(topic, /^koperasi-[0-9a-f]{20}$/);
  assert.notEqual(topic, ntfyTopic("other", "c.testnet", "a.testnet"), "another secret, another topic");
  assert.notEqual(topic, ntfyTopic("s3cret", "d.testnet", "a.testnet"));
  assert.notEqual(topic, `koperasi-${createHash("sha256").update("c.testnet:a.testnet").digest("hex").slice(0, 20)}`, "not the public hash");
  assert.throws(() => ntfyTopic("", "c.testnet", "a.testnet"), /NOTIFY_SECRET/);
  assert.throws(() => ntfyTopic(undefined, "c.testnet", "a.testnet"), /NOTIFY_SECRET/);
});

test("/api/notify-topic: a NEP-413 signature by a key of the account, within 10 minutes; anything else is refused", async () => {
  const { Account, KeyPair, KeyPairSigner } = await import("near-api-js");
  const { signMessage } = await import("near-api-js/nep413");
  const { notifyText } = await import("../../web/share.js");
  const { refuse } = await import("../../api/notify-topic.mjs");
  const contract = "c.testnet", NOW = 1_800_000_000_000;
  const key = KeyPair.fromRandom("ed25519");
  const alice = new Account("alice.testnet", /** @type {any} */ (null), new KeyPairSigner(key));
  const nonce = randomBytes(32);
  const ts = NOW - 60_000;
  const signed = await signMessage({ signerAccount: alice, payload: { message: notifyText(contract, "alice.testnet", ts), recipient: contract, nonce } });
  const body = { account: "alice.testnet", ts, pk: signed.publicKey.toString(), sig: Buffer.from(signed.signature).toString("base64"), nonce: nonce.toString("base64") };
  const keyOf = async (a, pk) => a === "alice.testnet" && pk === body.pk;
  const why = (o, opts = {}) => refuse({ ...body, ...o }, { now: NOW, keyOf, contract, ...opts });
  assert.equal(await why({}), null, "the official NEP-413 signature by a key of the account passes");
  assert.equal(await why({ account: "eve.testnet" }), "bad signature", "signed for alice, asked for eve");
  assert.equal(await why({ ts: ts + 1 }), "bad signature", "another time than the one signed");
  assert.equal(await why({}, { contract: "d.testnet" }), "bad signature", "signed for another co-op");
  const sig = Buffer.from(body.sig, "base64"); sig[0] ^= 1;
  assert.equal(await why({ sig: sig.toString("base64") }), "bad signature", "a tampered signature");
  assert.equal(await why({ nonce: randomBytes(32).toString("base64") }), "bad signature", "another nonce");
  assert.equal(await why({ pk: KeyPair.fromRandom("ed25519").getPublicKey().toString() }), "bad signature", "another key");
  assert.match(await why({}, { keyOf: async () => false }), /not a key of alice\.testnet/, "a valid signature by a key the account does not have");
  assert.equal(await why({}, { now: ts + 10 * 60_000 }), null, "10 minutes later still passes");
  assert.match(await why({}, { now: ts + 10 * 60_000 + 1 }), /10 minutes/, "later than 10 minutes is refused");
  assert.match(await why({}, { now: ts - 10 * 60_000 - 1 }), /10 minutes/, "a time far in the future is refused");
  assert.match(await why({ ts: "soon" }), /10 minutes/);
  assert.equal(await why({ account: "Not An Account" }), "bad account");
});
