// The member dashboard (web/dashboard.html): the sidebar's views, read live from the showcase co-op, and the wallet
// panel inside it (?as= previews on localhost).
import { expect } from "@playwright/test";
import { onlyLocal, test } from "./helpers.mjs";

const BOB = "kop-bob-mw4i3w8f.testnet";
// on a narrow screen the sidebar is a menu: open it first
async function go(page, name) {
  const menu = page.locator("#menu-btn");
  if (await menu.isVisible()) await menu.click();
  await page.locator("#side-nav a", { hasText: name }).click();
}

test("the landing page opens the app", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#open-app")).toHaveAttribute("href", "dashboard.html");
  await page.locator("#open-app").click();
  await expect(page).toHaveURL(/dashboard\.html/);
  await expect(page.locator("#v-overview")).toBeVisible();
});

test("the sidebar moves between views and marks the current one", async ({ page }) => {
  test.setTimeout(180_000); // it walks four views, each reading the chain the first time it opens
  await page.goto("/dashboard.html");
  await expect(page.locator("#v-overview")).toBeVisible();
  await expect(page.locator('#side-nav a[href="#/overview"]')).toHaveAttribute("aria-current", "page");
  await go(page, "Money");
  await expect(page).toHaveURL(/#\/money$/);
  await expect(page.locator("#v-money")).toBeVisible();
  await expect(page.locator("#v-overview")).toBeHidden();
  await expect(page.locator('#side-nav a[href="#/money"]')).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#h-money")).toBeFocused();
  await expect(page.locator("#m-periods")).toContainText(/Share \d+/);
  await go(page, "Commons");
  await expect(page.locator("#c-cases")).toContainText("upheld: refunded");
  await go(page, "Federation");
  await expect(page.locator("#f-fed")).toContainText("kop-federation-");
  // the language switch turns the dashboard's own words
  await go(page, "Overview");
  const lang = page.locator(".lang-btn");
  if (!(await lang.isVisible())) await page.locator("#menu-btn").click();
  await lang.click();
  await expect(page.locator("#h-overview")).toHaveText("Ringkasan");
  await expect(page.locator('#side-nav a[href="#/membership"]')).toHaveText("Keanggotaan saya");
  await page.evaluate(() => localStorage.removeItem("kop-lang"));
});

test("the overview shows the co-op's numbers, read live", async ({ page }) => {
  await page.goto("/dashboard.html#/overview");
  const kpis = page.locator("#kpis");
  await expect(kpis).toContainText(/Members\s*\d+/);
  await expect(kpis).toContainText(/DAO proposals\s*\d{2,}/);
  await expect(kpis).toContainText(/Treasury\s*\d+\.\d\d/);
  await expect(kpis).toContainText(/Audit\s*(Red|Green)/);
  await expect(kpis).toContainText(/by-laws v\d+/);
  await expect(page.locator("#recent li").first()).toBeVisible();
});

test("the agent view shows the by-laws in force and the Shade Agent", async ({ page }) => {
  await page.goto("/dashboard.html#/agent");
  await expect(page.locator("#a-bylaws")).toContainText(/by-laws v\d+/);
  await expect(page.locator("#a-bylaws")).toContainText("exactly the file the members approved");
  await expect(page.locator("#a-tee")).toContainText("Intel TDX");
  await expect(page.locator("#a-tee")).toContainText(/Code \(compose hash\)/);
  await expect(page.locator("#a-props")).toContainText(/v\d+/);
  await expect(page.locator("#a-receipts tbody tr").first()).toBeVisible();
});

test("?as= on localhost shows that member's own panel in My membership", async ({ page }, testInfo) => {
  onlyLocal(testInfo);
  await page.goto(`/dashboard.html?as=${BOB}#/membership`);
  const box = page.locator("#v-membership #joinapp");
  await expect(box).toContainText(`Signed in as ${BOB}`);
  await expect(box).toContainText("Your vote");
  await expect(page.locator("#join-steps")).toBeHidden();
  await expect(page.locator("#who")).toContainText(BOB);
  await go(page, "Proposals");
  await expect(page.locator("#props li").first()).toBeVisible();
});
