// Tasks with earned trust (contract/src/tasks.rs): the public board, read from the chain, and what each role can do
// from the wallet panel. The board tests read the live showcase; panel states use ?as= previews on localhost.
import { expect, test } from "@playwright/test";
import { answerViews, onlyLocal } from "./helpers.mjs";

const CAROL = "kop-carol-mw4i2iwk.testnet";
const ALICE = "kop-alice-mw4i3w8f.testnet";
const BOB = "kop-bob-mw4i3w8f.testnet";
const N = (n) => (BigInt(Math.round(n * 1e6)) * 10n ** 18n).toString();
const rule = { auto_max: N(0.1), one_vote_max: N(0.5), trusted_after: 1, poster_daily_auto: N(0.2), points: 5 };
const task = (id, status, extra = {}) => ({ id, poster: ALICE, description: `task ${id}`, amount: N(0.05), contributor: CAROL,
  deliverable: null, approved_by: null, status, created: "0", paid_at: null, ...extra });

test("the board shows the members' tiers and veto window, every task and where each point came from", async ({ page }) => {
  await page.goto("/#trust");
  const tiers = page.locator("#tiers li");
  // the showcase's members voted a 10-minute veto window (#62), shown as the second tier
  await expect(tiers).toHaveCount(4);
  await expect(tiers.nth(0)).toContainText(/Paid on acceptance.*up to [\d.]+ NEAR.*different member.*[\d.]+ NEAR a day/s);
  await expect(tiers.nth(1)).toContainText(/Veto window.*10 minutes/s);
  await expect(tiers.nth(2)).toContainText("Never the poster or the contributor");
  await expect(tiers.nth(3)).toContainText("Sputnik DAO bounty");
  // scripts/scenarios.mjs: tasks in other states (cancelled #12, waiting for a member #13, approved above the no-vote limit #14)
  await expect(page.locator("#task-12")).toContainText("Cancelled");
  await expect(page.locator("#task-13")).toContainText("Waiting for one member");
  await expect(page.locator("#task-14")).toContainText("approved by kop-steward-mw4i2iwk.testnet");
  await expect(page.locator("#trust-rule")).toContainText(/Transfer proposal the contract files and approves with its own DAO role tasks.*[\d.]+ NEAR more.*contribution points/s);
  // since the move into the DAO, a paid task links the Transfer proposal that paid it
  await expect(page.locator("#tasks tbody")).toContainText(/DAO proposal #\d+/);
  // on the showcase: task #0 paid with one member's approval, #1 paid on earned trust, a DAO bounty on the record
  await expect(page.locator("#task-0")).toContainText(`approved by ${BOB}`);
  await expect(page.locator("#task-1")).toContainText("on earned trust, no vote");
  const carol = page.locator("#records tbody tr", { hasText: CAROL });
  await expect(carol).toContainText(/yes, up to/);
  await expect(carol.getByRole("link", { name: "task #1", exact: true })).toHaveAttribute("href", "#task-1");
  await expect(carol).toContainText(/DAO proposal #\d+/);
});

test("the board says plainly when the chain cannot be read", async ({ page }) => {
  await page.route(/./, (route) => (/get_board|get_tasks|get_contributors/.test(route.request().postData() ?? "")
    ? route.fulfill({ status: 503, body: "down" }) : route.fallback()));
  await page.goto("/#trust");
  await expect(page.locator("#trust-rule")).toContainText("Could not read the task board");
});

test("no rule voted yet: the board and the panel say so, and nothing can be posted", async ({ page }, testInfo) => {
  onlyLocal(testInfo);
  await answerViews(page, { get_board: { rule: null, budget: "0", tasks: 0 }, get_tasks: [], get_contributors: [] });
  await page.goto(`/?as=${ALICE}`);
  await expect(page.locator("#trust-rule")).toContainText("have not voted a trust rule");
  await expect(page.locator("#tiers li")).toHaveCount(0);
  await expect(page.locator("#joinapp")).toContainText("no task can be posted");
  await expect(page.locator("#w-task-post")).toHaveCount(0);
});

test("a contributor takes an open task and must link the work to deliver it", async ({ page }, testInfo) => {
  onlyLocal(testInfo);
  await answerViews(page, { get_board: { rule, budget: N(1), tasks: 2 },
    get_tasks: [task(0, "Open", { contributor: null }), task(1, "Claimed")], get_contributors: [] });
  await page.goto(`/?as=${CAROL}`);
  const box = page.locator("#joinapp");
  await expect(box).toContainText("Your record: 0 finished");
  await expect(box.locator("[data-ttake='0']")).toBeVisible();
  await box.locator("[data-tsubmit='1']").click();
  await expect(box.locator(".note-line .err")).toContainText("link to the work");
  await page.locator("#w-tw-1").fill("https://example.org/work");
  await box.locator("[data-tsubmit='1']").click(); // no wallet in a preview: the transaction is refused, with a message
  await expect(box.locator(".note-line")).toContainText("Deliver task #1");
});

test("the poster sees how acceptance will pay: at once for a trusted contributor, else one member", async ({ page }, testInfo) => {
  onlyLocal(testInfo);
  await answerViews(page, { get_board: { rule, budget: N(1), tasks: 2 },
    get_tasks: [task(0, "Submitted", { deliverable: "https://example.org/a" }), task(1, "Submitted", { amount: N(0.3) })],
    get_contributors: [[CAROL, { done: 1, earned: N(0.05), refs: ["task:9"] }]] });
  await page.goto(`/?as=${ALICE}`);
  await expect(page.locator("[data-taccept='0']")).toContainText("pays at once if you are within your daily limit");
  await expect(page.locator("[data-taccept='1']")).toContainText("then one other member approves");
});

test("another member approves; the poster and the contributor are never offered it", async ({ page }, testInfo) => {
  onlyLocal(testInfo);
  await answerViews(page, { get_board: { rule, budget: N(1), tasks: 1 }, get_tasks: [task(0, "NeedsApproval")], get_contributors: [] });
  await page.goto(`/?as=${BOB}`);
  await expect(page.locator("[data-tapprove='0']")).toContainText(`Approve paying ${CAROL}`);
  await page.goto(`/?as=${ALICE}`);
  await expect(page.locator("#joinapp")).toContainText("Tasks with earned trust");
  await expect(page.locator("[data-tapprove='0']")).toHaveCount(0);
});

test("a member's task post refuses amounts the contract would refuse", async ({ page }, testInfo) => {
  onlyLocal(testInfo);
  await answerViews(page, { get_board: { rule, budget: N(1), tasks: 0 }, get_tasks: [], get_contributors: [] });
  await page.goto(`/?as=${ALICE}`);
  const post = page.locator("#w-task-post");
  await post.click();
  await expect(page.locator("#joinapp .note-line .err")).toContainText("describe the task");
  await page.locator("#w-task-desc").fill("Write the onboarding guide");
  for (const bad of ["0", "-1", "abc", "0.6", "0.1234567"]) {
    await page.locator("#w-task-amt").fill(bad);
    await post.click();
    await expect(page.locator("#joinapp .note-line .err")).toContainText("at most 0.5 NEAR");
  }
  await page.locator("#w-task-amt").fill("0.05");
  await post.click();
  await expect(page.locator("#joinapp .note-line")).toContainText("Post a 0.05 NEAR task");
});
