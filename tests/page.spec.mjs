// End-to-end checks of the live co-op page. Everything it asserts is read from NEAR testnet, GitHub and NEAR AI.
import { expect, test } from "@playwright/test";

const ready = async (page) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto("/");
  await expect(page.locator("#p-voters li").first()).not.toHaveText("Reading the DAO…");
  return errors;
};

test("loads live data with no errors", async ({ page }) => {
  const errors = await ready(page);
  await expect(page.locator("#p-tally")).toContainText(/Proposal #\d+ passed with \d+ yes vote/);
  await expect(page.locator("#p-terms")).toContainText(/by-laws v\d+/);
  await expect(page.locator("#p-terms")).toContainText("Model");
  await expect(page.locator("#status dd")).toHaveCount(4);
  await expect(page.locator("#receipts tbody tr").first()).toContainText(/USDC|\.\d\d/);
  await expect(page.locator("#versions li.current")).toHaveCount(1);
  await page.waitForTimeout(2000);
  expect(errors).toEqual([]);
});

test("the running model is shown as TEE verified, with evidence", async ({ page }) => {
  await ready(page);
  await expect(page.locator("#p-tee")).toContainText("TEE verified");
  await expect(page.locator("#p-tee")).toContainText(/Intel TDX (UpToDate|OutOfDate)/);
  await expect(page.locator("#p-tee")).toContainText("NVIDIA GPU pass");
  const href = await page.locator("#p-tee a").getAttribute("href");
  expect(href).toMatch(/evidence\/tee-.*\.json$/);
});

test("anyone can verify the by-laws hash in the browser", async ({ page }) => {
  await ready(page);
  await page.locator("#verify button").click();
  await expect(page.locator("#verify .match")).toHaveText("Match. The file is exactly what the members approved.");
  const [mine, chain] = await page.locator("#verify .hashes dd").allTextContents();
  expect(mine).toBe(chain);
});

test("savings come from the staking pool the members chose", async ({ page }) => {
  await ready(page);
  await expect(page.locator("#pool-line a")).toHaveText(/\.pool\./);
  await page.locator("#member-pick").selectOption({ index: 0 });
  await expect(page.locator("#meters .val").first()).not.toHaveText("0");
});

test("the wallet panel opens the NEAR wallet selector", async ({ page }) => {
  await ready(page);
  await page.locator("#w-connect").scrollIntoViewIfNeeded();
  await page.locator("#w-connect").click();
  await expect(page.getByText("Meteor Wallet")).toBeVisible();
});

test("copy buttons copy this co-op's real join command", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await ready(page);
  await page.locator("details.cli summary").click();
  await page.locator('[data-copy="join-cmd"]').click();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toMatch(/^near call koperasi-[a-z0-9]+\.testnet join '\{\}' --deposit 0\.5 /);
});

test("no horizontal scrolling and every section anchor exists", async ({ page }) => {
  await ready(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  for (const href of await page.locator('a[href^="#"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")))) {
    if (href.length > 1) expect(await page.locator(href).count(), href).toBe(1);
  }
});

test("outbound links resolve", async ({ page, request }) => {
  await ready(page);
  const links = await page.locator('a[href^="https://"]').evaluateAll((as) => [...new Set(as.map((a) => a.href))]);
  for (const url of links.filter((u) => /github\.com|nearblocks\.io|raw\.githubusercontent/.test(u))) {
    const r = await request.get(url, { maxRedirects: 5 });
    expect(r.status(), url).toBeLessThan(400);
  }
});

test("with reduced motion everything is visible at once", async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.locator(".hero .big")).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.querySelector(".hero .big > span")).animationName)).toBe("none");
  await ctx.close();
});

test("keyboard users see where focus is", async ({ page, isMobile }) => {
  test.skip(isMobile);
  await ready(page);
  await page.keyboard.press("Tab");
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  expect(outline).not.toBe("none");
});
