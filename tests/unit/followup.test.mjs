import { test } from "node:test";
import assert from "node:assert/strict";
import { CHEAPER, cheaperBylaws, followup, pollMessage } from "../../agent/followup.mjs";

const poll = (o) => ({ id: 2, closed: true, result: 0, options: ["keep deepseek-v3.2", "try a cheaper model"], bylaws: null, ...o });
const cfg = { model: "deepseek/deepseek-v3.2" };

test("the agent acts on its own poll only once it is closed, and only to put a change to the members", () => {
  assert.equal(followup(poll({ closed: false }), cfg, new Set()), "wait");
  assert.equal(followup(poll(), cfg, new Set()), "kept", "the members kept the model");
  assert.equal(followup(poll({ result: 1 }), cfg, new Set()), "propose", "they chose a cheaper model");
  assert.equal(followup(poll({ result: 1 }), { model: CHEAPER }, new Set()), "kept", "already on the cheaper model");
  assert.equal(followup(poll({ result: null }), cfg, new Set()), "kept", "no winner: nothing to change");
  assert.equal(followup(poll({ result: 1 }), cfg, new Set([2])), "done", "never twice");
  assert.equal(followup(poll({ result: 1, bylaws: [null, { version: 12 }] }), cfg, new Set()), "kept", "a by-laws poll goes to poll_to_proposal");
});

test("the next by-laws change only the model and the version", () => {
  const v11 = '# By-laws v11, by the members\nversion: 11\nmodel: "deepseek/deepseek-v3.2"\nbid:\n  price_usdc: 5\n';
  const v12 = cheaperBylaws(v11, 12, 2);
  assert.match(v12, /^version: 12$/m);
  assert.match(v12, new RegExp(`^model: "${CHEAPER}"$`, "m"));
  assert.match(v12, /price_usdc: 5/);
  assert.match(v12, /poll #2/);
  assert.throws(() => cheaperBylaws("version: 11\n", 12, 2), /no model line/);
});

test("the poll message the agent signs is the contract's format", () => {
  const m = pollMessage("k.testnet", "3", 24, "q", ["a", "b"], null, "why");
  assert.match(m, /^koperasi-agent-poll\/1 k\.testnet #3 24 [0-9a-f]{64}\nwhy$/);
  assert.notEqual(m, pollMessage("k.testnet", "3", 24, "q", ["a", "c"], null, "why"), "the options are covered");
});
