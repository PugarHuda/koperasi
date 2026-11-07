// End-to-end checks of the live co-op page. Everything it asserts is read from NEAR testnet, GitHub and NEAR AI.
import { expect, test } from "@playwright/test";

// the browser logs a public RPC's rate limit (429 without CORS headers) as an error, and WebKit raises it from the
// wallet library too; the page then uses the next RPC. Chromium, Firefox and WebKit word it differently.
const network = (t) => /blocked by CORS policy|Failed to load resource|Cross-Origin Request Blocked|due to access control checks|Access-Control-Allow-Origin|NetworkError when attempting to fetch/.test(t);

const ready = async (page) => {
  const errors = [];
  page.on("pageerror", (e) => { if (!network(e.message)) errors.push(e.message); });
  page.on("console", (m) => { if (m.type() === "error" && !network(m.text())) errors.push(m.text()); });
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
  // the repo stays private until just before judging; its links are checked once it is public
  const repoPublic = (await request.get("https://api.github.com/repos/PugarHuda/koperasi")).ok();
  for (const url of links.filter((u) => repoPublic && /github\.com/.test(u))) {
    let r = await request.get(url, { maxRedirects: 5 });
    for (let i = 1; r.status() === 429 && i <= 3; i++) { // GitHub rate-limits repeated runs
      await new Promise((ok) => setTimeout(ok, 5000 * i));
      r = await request.get(url, { maxRedirects: 5 });
    }
    expect(r.status(), url).toBeLessThan(400);
  }
  // nearblocks answers bots with 403; what makes its link right is that the account exists on-chain
  for (const url of links.filter((u) => /nearblocks\.io\/address\//.test(u))) {
    const id = url.split("/address/")[1];
    let amount;
    for (const rpc of ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org", "https://rpc.testnet.fastnear.com"]) {
      const r = await request.post(rpc, { data: { jsonrpc: "2.0", id: 1, method: "query",
        params: { request_type: "view_account", finality: "final", account_id: id } } }).catch(() => null);
      amount = (await r?.json().catch(() => null))?.result?.amount;
      if (amount) break;
    }
    expect(amount, url).toBeTruthy();
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

test("the page says who can change the contract's code, from the chain", async ({ page }) => {
  await ready(page);
  const box = page.locator("#codegov");
  await expect(box).toContainText("Who can change the contract's code?");
  await expect(box).toContainText(/approved in proposal #\d+/);
  await expect(box.locator(".match")).toHaveText(/full-access key/);
});

test("receipts carry a proof column and the treasury is read from the token", async ({ page }) => {
  await ready(page);
  await expect(page.locator("#receipts thead")).toContainText("Proof");
  await expect(page.locator("#receipts tbody tr").first().locator('td[data-label="Proof"]')).toBeVisible();
  await expect(page.locator("#treasury")).toContainText(/holds \d+\.\d\d USDC/);
});

// the wallet panel in each state, previewed with ?as= (localhost only, no wallet needed)
const local = (testInfo) => /localhost|127\.0\.0\.1/.test(testInfo.project.use.baseURL ?? process.env.BASE_URL ?? "");

test("a newcomer is walked through joining", async ({ page }, testInfo) => {
  test.skip(!local(testInfo), "?as= previews run on localhost only");
  const errors = [];
  page.on("pageerror", (e) => { if (!network(e.message)) errors.push(e.message); });
  await page.goto("/?as=nobody-koperasi-e2e.testnet");
  const panel = page.locator("#joinapp");
  await expect(panel).toContainText("Signed in as nobody-koperasi-e2e.testnet");
  await expect(panel.locator("#w-join")).toHaveText(/Pay 0\.5 NEAR/);
  await expect(panel.locator(".jsteps li")).toHaveCount(4);
  expect(errors).toEqual([]);
});

test("a member sees their vote, savings and open proposals", async ({ page }, testInfo) => {
  test.skip(!local(testInfo), "?as= previews run on localhost only");
  await page.goto("/?as=kop-bob-mw4i3w8f.testnet");
  const panel = page.locator("#joinapp");
  await expect(panel.locator(".me-card").first()).toContainText(/Your vote\s*1 of \d+/);
  await expect(panel).toContainText("Open proposals");
  await expect(panel.locator("#w-stake")).toBeVisible();
  // a share waiting means one button (claim it, or register for USDC first); none waiting, none shown
  const share = await panel.locator(".me-card div", { hasText: "Share to claim" }).locator("strong").textContent();
  await expect(panel.locator("#w-claim, #w-usdc")).toHaveCount(Number.parseFloat(share) > 0 ? 1 : 0);
});

test("a stake outside 1..1000 NEAR is refused before the wallet opens", async ({ page }, testInfo) => {
  test.skip(!local(testInfo), "?as= previews run on localhost only");
  await page.goto("/?as=kop-bob-mw4i3w8f.testnet");
  for (const bad of ["0", "2.5", "5000"]) {
    await page.locator("#w-amt").fill(bad);
    await page.locator("#w-stake").click();
    await expect(page.locator("#joinapp .note-line")).toContainText(`enter a whole number of NEAR, 1 to 1000 (got "${bad}")`);
  }
});

test("the amount typed is the amount staked", async ({ page }, testInfo) => {
  test.skip(!local(testInfo), "?as= previews run on localhost only");
  await page.goto("/?as=kop-bob-mw4i3w8f.testnet");
  await page.locator("#w-amt").fill("7");
  await page.locator("#w-stake").click();
  await expect(page.locator("#joinapp .note-line")).toContainText("Stake 7 NEAR");
});

test("the tasks the co-op pays for are listed from the DAO's bounties", async ({ page }) => {
  await ready(page);
  const row = page.locator("#bounties tbody tr").first();
  await expect(row).toContainText("Bahasa Indonesia");
  // the co-op's own USDC reads as USDC; a task funded in another token names that token
  await expect(row.locator('td[data-label="Pays"]')).toHaveText(/\d+\.\d\d USDC|of [a-z0-9.-]+ \(not the co-op's USDC\)/);
});

test("a member can take a task from the wallet panel", async ({ page }, testInfo) => {
  test.skip(!local(testInfo), "?as= previews run on localhost only");
  await page.goto("/?as=kop-bob-mw4i3w8f.testnet");
  const panel = page.locator("#joinapp");
  await expect(panel).toContainText("Tasks the co-op pays for");
  await expect(panel.locator("[data-claim]").first()).toHaveText(/Take this task \(0\.1 NEAR bond\)/);
});
