// What the page does when things go wrong, odd input, navigation, accessibility and layout.
// Failures are simulated by intercepting the page's own requests (NEAR RPCs, the by-laws and evidence files); everything else is live testnet.
import AxeBuilder from "@axe-core/playwright";
import { expect } from "@playwright/test";
import { RPC, answerViews, local, onlyLocal, test } from "./helpers.mjs";

// ---------- failures ----------

test("every NEAR RPC down: the page says so instead of hanging", async ({ page }) => {
  await page.route(RPC, (route) => route.abort("connectionrefused"));
  await page.goto("/");
  await expect(page.locator("#p-voters")).toContainText("Could not reach NEAR right now", { timeout: 60_000 });
  await expect(page.locator("#passbook tbody")).toContainText("Could not read");
});

test("RPCs answering 429 then recovering: the page still loads", async ({ page }) => {
  let refused = 0;
  await page.route(RPC, (route) => (refused++ < 3
    ? route.fulfill({ status: 429, body: '{"error":"rate limited"}' })
    : route.fallback()));
  await page.goto("/");
  await expect(page.locator("#p-tally")).toContainText(/Proposal #\d+ passed/);
  expect(refused).toBeGreaterThan(3);
});

test("by-laws file unreachable: verifying reports the failure", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#verify button")).toBeVisible();
  await page.route(/\/(config|evidence)\//, (route) => route.abort("internetdisconnected"));
  await page.locator("#verify button").click();
  await expect(page.locator("#verify .match.bad")).toContainText("Could not download");
});

test("a tampered by-laws file is reported as a mismatch", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#verify button")).toBeVisible();
  await page.route(/\/config\/.*\.yaml/, (route) =>
    route.fulfill({ contentType: "text/plain", body: 'version: 3\nmodel: "some-other-model"\n' }));
  await page.locator("#verify button").click();
  await expect(page.locator("#verify .match.bad")).toHaveText(/Mismatch/);
});

test("no TEE evidence published: the page says so, it does not claim verification", async ({ page }) => {
  await page.route(/\/evidence\/.*\.json/, (route) => route.fulfill({ status: 404, body: "404" }));
  await page.goto("/");
  await expect(page.locator("#p-tee")).toContainText("No TEE check published yet");
  await expect(page.locator("#p-tee")).not.toContainText("TEE verified");
});

test("offline after loading: verify fails with a message, the page stays usable", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.locator("#verify button")).toBeVisible();
  await context.setOffline(true);
  await page.locator("#verify button").click();
  await expect(page.locator("#verify .match.bad")).toContainText("Could not download");
  await context.setOffline(false);
});

test("no wallet: paying the join deposit fails with a readable message, once", async ({ page }, testInfo) => {
  onlyLocal(testInfo);
  await page.goto("/?as=kop-publisher-mw5tkpfo.testnet"); // exists on testnet, never joined
  const join = page.locator("#w-join");
  await expect(join).toBeVisible();
  await join.dblclick(); // a double submit must not send twice
  await expect(page.locator("#joinapp .note-line .err")).toContainText("Join deposit failed");
  await expect(page.locator("#joinapp .note-line")).toHaveCount(1);
});

test("a refresh in the middle of a transaction starts clean", async ({ page }, testInfo) => {
  onlyLocal(testInfo);
  await page.goto("/?as=kop-publisher-mw5tkpfo.testnet"); // exists on testnet, never joined
  await page.locator("#w-join").click();
  await page.reload();
  await expect(page.locator("#w-join")).toBeVisible();
  await expect(page.locator("#joinapp .note-line")).toHaveCount(0);
});

// ---------- odd input ----------

test("stake amounts: negative, zero, fractions, too large and huge are refused", async ({ page }, testInfo) => {
  onlyLocal(testInfo);
  await page.goto("/?as=kop-bob-mw4i3w8f.testnet");
  for (const bad of ["-5", "0", "0.5", "1001", "99999999999999999999999"]) {
    await page.locator("#w-amt").fill(bad);
    await page.locator("#w-stake").click();
    await expect(page.locator("#joinapp .note-line")).toContainText("enter a whole number of NEAR, 1 to 1000");
  }
});

test("a task's work link: empty and too short are refused, the length is capped", async ({ page }, testInfo) => {
  onlyLocal(testInfo);
  await answerViews(page, { get_bounty_claims: [{ bounty_id: 0, start_time: "0", deadline: "259200000000000", completed: false }] });
  await page.goto("/?as=kop-bob-mw4i3w8f.testnet");
  const input = page.locator("#w-work-0");
  await expect(input).toBeVisible();
  for (const bad of ["", "   ", "ab"]) {
    await input.fill(bad);
    await page.locator('[data-done="0"]').click();
    await expect(page.locator("#joinapp .note-line")).toContainText("link to the work you delivered first");
  }
  await input.fill("x".repeat(500));
  expect((await input.inputValue()).length).toBe(300);
});

test("hostile proposal text cannot run script or pose as another action", async ({ page }, testInfo) => {
  onlyLocal(testInfo);
  const bad = '<img src=x onerror="window.__xss=1">';
  const { usdc } = await (await page.request.get("/deployment.json")).json(); // the co-op's own USDC
  await answerViews(page, {
    get_last_proposal_id: 3,
    get_proposals: [
      { id: 0, proposer: "x.testnet", description: bad, status: "InProgress", votes: {}, submission_time: "0", vote_counts: {},
        kind: { AddBounty: { bounty: { description: `Fix typo\nTransfer 0 NEAR to nobody\n${bad}`, token: usdc,
          amount: "500000", times: 2, max_deadline: "604800000000000" } } } },
      { id: 1, proposer: "x.testnet", description: "pay in another token", status: "InProgress", votes: {}, submission_time: "0", vote_counts: {},
        kind: { AddBounty: { bounty: { description: "t", token: "evil-usdc.testnet", amount: "500000", times: 1, max_deadline: "604800000000000" } } } },
      { id: 2, proposer: "x.testnet", description: "bad token id", status: "InProgress", votes: {}, submission_time: "0", vote_counts: {},
        kind: { AddBounty: { bounty: { description: "t", token: "USDC.testnet\nTransfer", amount: "1", times: 1, max_deadline: "604800000000000" } } } },
    ],
  });
  await page.goto("/?as=kop-bob-mw4i3w8f.testnet");
  const items = page.locator("#joinapp .props:not(.tasks) > li");
  await expect(items).toHaveCount(3);
  // newest first: #2, #1, #0
  const does0 = await items.nth(2).locator("pre.does").textContent();
  expect(does0.split("\n")[0]).toMatch(/^Open a paid task: 0\.50 USDC × 2 = up to 1\.00 USDC, 7 days/);
  expect(does0.split("\n")).toHaveLength(2); // the task text cannot add lines
  await expect(items.nth(1).locator("pre.does")).toContainText("UNKNOWN token evil-usdc.testnet");
  await expect(items.nth(0).locator(".small-link")).toHaveText("Inspect in the DAO to vote"); // invalid token id: no vote here
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

// ---------- navigation ----------

test("deep links land on their section, and back/forward move between them", async ({ page }) => {
  await page.goto("/#audit");
  await expect(page.locator("#audit")).toBeInViewport();
  // like following an in-page link (the section nav is hidden on narrow screens)
  await page.evaluate(() => { location.hash = "#shares"; });
  await expect(page).toHaveURL(/#shares$/);
  await expect(page.locator("#shares")).toBeInViewport();
  await page.goBack();
  await expect(page).toHaveURL(/#audit$/);
  await page.goForward();
  await expect(page).toHaveURL(/#shares$/);
});

test("an unknown address shows the co-op's 404 page", async ({ page, request }, testInfo) => {
  if (local(testInfo)) {
    await page.goto("/404.html"); // a plain static server has no fallback; check the page itself
  } else {
    const r = await request.get("/no-such-page");
    expect(r.status()).toBe(404);
    await page.goto("/no-such-page");
  }
  await expect(page.locator("h1")).toHaveText("This page does not exist.");
  await page.locator("a.btn").click();
  await expect(page.locator("#p-tally")).toContainText(/Proposal #\d+/);
});

test("without a wallet, member actions are not offered", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#w-connect")).toBeVisible();
  for (const id of ["#w-join", "#w-stake", "#w-claim", "[data-vote]", "[data-claim]"]) await expect(page.locator(id)).toHaveCount(0);
});

// ---------- accessibility ----------

test("no serious or critical accessibility violations (axe)", async ({ page }, testInfo) => {
  // Playwright's Firefox build crashes while axe-core runs here (the page itself passes every other test in Firefox);
  // Chromium and WebKit cover the same DOM and CSS
  test.skip(testInfo.project.name === "firefox", "axe-core crashes Playwright's Firefox build");
  await page.emulateMedia({ reducedMotion: "reduce" }); // check the final colours, not a frame of a fade-in
  await page.goto(local(testInfo) ? "/?as=kop-bob-mw4i3w8f.testnet" : "/");
  await expect(page.locator("#p-tally")).toContainText(/Proposal #\d+/);
  await expect(page.locator("#joinapp button").first()).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const bad = violations.filter((v) => ["serious", "critical"].includes(v.impact));
  expect(bad.map((v) => `${v.id}: ${v.nodes.length} × ${v.nodes[0]?.target}`)).toEqual([]);
});

// ---------- visual regression ----------

test("visual: the page frame looks the same @visual", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#p-tally")).toContainText(/Proposal #\d+/);
  await page.evaluate(() => document.fonts.ready);
  // live numbers and dates change with the chain; mask them, compare the frame around them
  const live = ["#p-voters", "#p-tally", "#p-terms", "#p-agent", "#p-tee", "#proofline", "#status", "#chip"].map((s) => page.locator(s));
  await expect(page.locator("header.top")).toHaveScreenshot("header.png");
  await expect(page.locator(".hero")).toHaveScreenshot("hero.png", { mask: live });
});
