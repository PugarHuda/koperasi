// api/inbox.mjs: the member's feed lists only what waits on them, and nothing in it can break the XML.
import assert from "node:assert/strict";
import { test } from "node:test";
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
