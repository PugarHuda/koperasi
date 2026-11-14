// api/inbox.mjs: the member's feed lists only what waits on them, and nothing in it can break the XML.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
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

test("the ntfy topic: per co-op and member, not the bare account id, same in the browser and the script", async () => {
  const { ntfyTopic } = await import("../../web/share.js");
  const topic = await ntfyTopic("c.testnet", "a.testnet");
  assert.equal(topic, `koperasi-${createHash("sha256").update("c.testnet:a.testnet").digest("hex").slice(0, 16)}`);
  assert.notEqual(topic, await ntfyTopic("d.testnet", "a.testnet"));
  assert.ok(!topic.includes("a.testnet"));
});
