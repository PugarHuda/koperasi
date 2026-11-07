// "Don't trust us. Your browser checks.": the four checks a visitor runs, including the in-browser TEE verification,
// and what they say when someone lies (a replayed attestation, a tampered by-laws file) or a service is down.
import { expect, test } from "@playwright/test";
import { answerViews, onlyLocal } from "./helpers.mjs";

const go = async (page) => {
  await page.goto("/");
  await page.locator("#checks").scrollIntoViewIfNeeded();
};

test("the automatic checks reach a verdict from the chain and the repo", async ({ page }) => {
  await go(page);
  await expect(page.locator("#ck-bylaws")).toHaveClass(/pass/);
  await expect(page.locator("#ck-bylaws .ck-out")).toContainText("Your browser hashed");
  await expect(page.locator("#ck-code")).toHaveClass(/pass/);
  await expect(page.locator("#ck-code .ck-out")).toContainText("no full-access key");
  await expect(page.locator("#ck-code .ck-out")).toContainText(/proposal #\d+/);
  // the showcase's audit is red on purpose (the demo's steward keeps a payout); either way the card says which
  await expect(page.locator("#ck-money")).toHaveClass(/pass|fail/);
  await expect(page.locator("#ck-money .ck-out")).toContainText(/reached the co-op|has not reached the co-op/);
});

test("the visitor verifies the model's TEEs with their own nonce", async ({ page }) => {
  await go(page);
  const run = page.locator("#ck-tee-run");
  await expect(run).toBeEnabled();
  await expect(run).toContainText(/Verify .+ with your own nonce/);
  await run.click();
  const out = page.locator("#ck-tee-out");
  await expect(out).toContainText("Verified", { timeout: 60_000 });
  await expect(page.locator("#ck-tee")).toHaveClass(/pass/);
  const rows = out.locator("tbody tr");
  expect(await rows.count()).toBeGreaterThanOrEqual(2); // the gateway and at least one model server
  for (const cell of await out.locator("tbody td").allTextContents()) expect(cell).not.toBe("NO");
  await expect(out.locator("tbody tr").first()).toContainText(/UpToDate|OutOfDate/);
  await expect(run).toHaveText("Verify again with a new nonce");
});

test("a replayed attestation (someone else's nonce) is caught", async ({ page }) => {
  // serve a genuine, signed report, but one made for a different nonce: as a lying middleman would
  await page.route(/cloud-api\.near\.ai\/v1\/attestation\/report/, async (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set("nonce", "ab".repeat(32));
    return route.fulfill({ response: await route.fetch({ url: url.toString() }) });
  });
  await go(page);
  await page.locator("#ck-tee-run").click();
  const out = page.locator("#ck-tee-out");
  await expect(out).toContainText("Not verified", { timeout: 60_000 });
  await expect(page.locator("#ck-tee")).toHaveClass(/fail/);
  await expect(out.locator("tbody tr").first().locator("td").nth(1)).toHaveText("NO"); // "Your nonce" column
});

test("NEAR AI Cloud down: the TEE check says so and does not pass", async ({ page }) => {
  await page.route(/cloud-api\.near\.ai\/v1\/attestation\/report/, (route) => route.fulfill({ status: 503, body: "unavailable" }));
  await go(page);
  await page.locator("#ck-tee-run").click();
  await expect(page.locator("#ck-tee-out")).toContainText("Not verified: NEAR AI Cloud answered HTTP 503");
  await expect(page.locator("#ck-tee")).toHaveClass(/fail/);
});

test("a tampered by-laws file fails its check, and the TEE check cannot start from it", async ({ page }) => {
  await page.route(/raw\.githubusercontent\.com\/.*config\/.*\.yaml/, (route) =>
    route.fulfill({ contentType: "text/plain", body: 'version: 3\nmodel: "attacker/model"\n' }));
  await go(page);
  await expect(page.locator("#ck-bylaws")).toHaveClass(/fail/);
  await expect(page.locator("#ck-bylaws .ck-out")).toContainText("not the approved");
  await expect(page.locator("#ck-tee-run")).toBeDisabled();
});

// ---------- members' meeting: a profit share previewed per member before the vote ----------

test("with an empty treasury there is nothing to propose", async ({ page }, testInfo) => {
  onlyLocal(testInfo);
  await answerViews(page, { ft_balance_of: "0" });
  await page.goto("/?as=kop-bob-mw4i3w8f.testnet");
  await expect(page.locator("#joinapp")).toContainText("there is nothing to share yet");
  await expect(page.locator("#w-share")).toHaveCount(0);
});

test("a member sees each member's part before proposing a share; bad amounts are refused", async ({ page }, testInfo) => {
  onlyLocal(testInfo);
  await answerViews(page, { ft_balance_of: "10000000" }); // the treasury holds 10 USDC
  await page.goto("/?as=kop-bob-mw4i3w8f.testnet");
  const amt = page.locator("#w-share-amt");
  const pre = page.locator("#w-share-preview");
  await expect(amt).toBeVisible();
  for (const [bad, why] of [["0", "a positive USDC amount"], ["-3", "a positive USDC amount"], ["1.1234567", "at most 6 decimals"],
    ["abc", "a positive USDC amount"], ["10.000001", "at most the 10.00 USDC the treasury holds"], ["99999999999", "at most the 10.00 USDC"]]) {
    await amt.fill(bad);
    await expect(pre).toContainText(why);
    await page.locator("#w-share").click();
    await expect(page.locator("#joinapp .note-line .err")).toContainText(why);
  }
  await amt.fill("4");
  await expect(pre).toContainText("If the members approve:");
  await expect(pre).toContainText("reserve back to the DAO:");
  // the parts and the reserve add up to exactly what was typed
  const units = (x) => { const [w, f = ""] = x.split("."); return BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, "0")); };
  const parts = (await pre.textContent()).match(/\d+\.\d+(?= USDC)/g);
  expect(parts.map(units).reduce((a, b) => a + b, 0n)).toBe(4_000_000n);
  await page.locator("#w-share").click(); // no wallet in a preview: the transaction is refused, with a message
  await expect(page.locator("#joinapp .note-line")).toContainText("Propose a 4.00 USDC profit share");
});

test("an open profit-share proposal shows what each member would receive", async ({ page }, testInfo) => {
  onlyLocal(testInfo);
  const { usdc, contract } = await (await page.request.get("/deployment.json")).json();
  const args = Buffer.from(JSON.stringify({ receiver_id: contract, amount: "5000000", msg: "share" })).toString("base64");
  await answerViews(page, {
    get_last_proposal_id: 1,
    get_proposals: [{ id: 0, proposer: "x.testnet", description: "share", status: "InProgress", votes: {}, submission_time: "0", vote_counts: {},
      kind: { FunctionCall: { receiver_id: usdc, actions: [{ method_name: "ft_transfer_call", args, deposit: "1", gas: "150000000000000" }] } } }],
  });
  await page.goto("/?as=kop-bob-mw4i3w8f.testnet");
  const does = page.locator("#joinapp .props:not(.tasks) pre.does").first();
  await expect(does).toContainText("Profit share: send 5.00 USDC");
  await expect(does).toContainText("If approved now:");
  await expect(does).toContainText("reserve back to the DAO:");
});

test("the comparison with other ways to own an agent is on the page, readable on a phone", async ({ page }) => {
  await go(page);
  const t = page.locator("#versus");
  await expect(t.locator("tbody tr")).toHaveCount(4);
  await expect(t).toContainText("with your own nonce");
  // the wide table scrolls inside its box; the page itself never scrolls sideways
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
