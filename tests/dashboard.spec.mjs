// The member dashboard (web/dashboard.html): the sidebar's views, read live from the showcase co-op, and the wallet
// panel inside it (?as= previews on localhost).
import { expect } from "@playwright/test";
import { RPC, onlyLocal, test } from "./helpers.mjs";

const BOB = "kop-bob-mw4i3w8f.testnet";
// on a narrow screen the sidebar is a menu: open it first
async function go(page, name) {
  const menu = page.locator("#menu-btn");
  const mobile = await menu.isVisible();
  if (mobile) await menu.click();
  await page.locator("#side-nav a", { hasText: name }).click();
  // on a phone the menu closes after the view changes: wait for it, or a check right after sees it still open
  if (mobile) await expect(menu).toHaveAttribute("aria-expanded", "false");
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
  // the dues the members voted, with the button to pay one period (not clicked: the specs never sign)
  await expect(box).toContainText(/Mandatory dues \(simpanan wajib\)\s*[\d.]+ NEAR every \d+ days/);
  await expect(box.locator("#w-dues")).toContainText(/Pay one period: [\d.]+ NEAR/);
  await expect(page.locator("#join-steps")).toBeHidden();
  await expect(page.locator("#who")).toContainText(BOB);
  await go(page, "Proposals");
  await expect(page.locator("#props li").first()).toBeVisible();
});

test("the agent's report card judges it as a member, from the chain", async ({ page }) => {
  await page.goto("/dashboard.html#/report");
  await expect(page.locator("#h-report")).toHaveText("Agent report");
  await expect(page.locator("#r-jobs .rc-verdict")).toContainText(/\d+ jobs on-chain/);
  await expect(page.locator("#r-taskbond")).toContainText("95/100");
  await expect(page.locator("#r-court .rc-verdict")).toContainText(/Court: \d+ of \d+ cases upheld/);
  await expect(page.locator("#r-money .rc-verdict")).toContainText(/risk fund holds \d+\.\d\d USDC/);
  // the agent's v9, undone by the members' v10 (#140); its review rejected (#141), the corrected one accepted (#142)
  await expect(page.locator("#r-props .rc-verdict")).toContainText("v9 → v10, #140");
  await expect(page.locator("#r-fixes")).toContainText("#141");
  await expect(page.locator("#r-fixes .rc-verdict")).toContainText("#142");
  await expect(page.locator("#r-tee .rc-verdict")).toContainText("Intel TDX");
});

test("My history shows a previewed member's votes, pledges and court record", async ({ page }, testInfo) => {
  onlyLocal(testInfo);
  test.setTimeout(120_000);
  await page.goto(`/dashboard.html?as=${BOB}#/membership`);
  const box = page.locator("#m-history");
  await expect(box).toContainText(/DAO votes\s*\d+ of the last \d+ proposals: \d+ approve/);
  await expect(box).toContainText(/Court, as juror\s*#\d+/);
  await expect(box).toContainText(/Credit\s*score \d+ of 10/);
  await box.locator("summary").click();
  await expect(box.locator(".timeline li").first()).toContainText(/You voted|You pledged|Juror on case|You called in|You brought/);
  await expect(page.locator("#notify")).toContainText("Notify me");
  await expect(page.locator('#notify a[href^="/api/inbox?who="]')).toHaveAttribute("href", `/api/inbox?who=${encodeURIComponent(BOB)}`);
  await expect(page.locator('#notify a[href^="https://ntfy.sh/"]')).toHaveAttribute("href", /^https:\/\/ntfy\.sh\/koperasi-[0-9a-f]{16}$/);
});

test("try it in 60 seconds: the overview's three steps and the landing page's link", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#try-link")).toHaveAttribute("href", "dashboard.html#/overview");
  await page.goto("/dashboard.html");
  const box = page.locator("#try60");
  await expect(box.locator(`a[href="dashboard.html?as=${BOB}#/membership"]`)).toBeVisible();
  await expect(box.locator('a[href="#/report"]')).toBeVisible();
  await expect(page.locator("#try-cmd")).toHaveText("curl -sO https://koperasi-kohl.vercel.app/verify.mjs && node verify.mjs");
  await expect(page.locator("#try-copy")).toBeVisible();
});

test("task quality: Bob's hand-back in his history and every member's factor in Commons", async ({ page }) => {
  test.setTimeout(120_000);
  // ?as= reads My history for any account, read-only, on any host
  await page.goto(`/dashboard.html?as=${BOB}#/membership`);
  const hist = page.locator("#m-history");
  await expect(hist).toContainText(/Task quality\s*\d+ paid, \d+ handed back, \d+ vetoed/);
  await expect(hist).toContainText(/multiplied by \(\d+\+2\)\/\(\d+\+2\) = ×\d\.\d\d/);
  await expect(hist).toContainText("task #17 took the weight 275 → 220");
  await go(page, "Commons");
  const q = page.locator("#c-quality");
  await expect(q).toContainText("(good + 2) / (bad + 2)");
  const bob = q.locator("tbody tr", { hasText: BOB });
  await expect(bob).toContainText(/×\d\.\d\d/);
  await expect(bob.locator("td").last()).toHaveText(/^(\d+|–)$/);
});

test("the federation lists the referral board, with the transaction that sent one", async ({ page }) => {
  await page.goto("/dashboard.html#/federation");
  const r = page.locator("#f-referrals");
  await expect(r).toContainText("koperasi-mw80aczw.testnet");
  await expect(r).toContainText("4.50 USDC");
  await expect(r.locator('a[href$="/txns/7oBAVZgnEoGP81A6XYTV6G1emicSYKXuFNsVhmdKkhSb"]')).toBeVisible();
});

test("0.3.6: the referral the sister co-op accepted, read on its contract, and the loans between co-ops", async ({ page }) => {
  await page.goto("/dashboard.html#/federation");
  const acc = page.locator("#f-accepted");
  await expect(acc).toContainText("koperasi-mw80aczw.testnet");
  await expect(acc).toContainText("The sister accepted referral #2");
  await expect(acc.locator('a[href$="/txns/3KguXhJxUUijdN5ZsaXtBgSe8nhTALKszGU4FswqmuSQ"]')).toBeVisible();
  const loans = page.locator("#f-loans");
  await expect(loans).toContainText("koperasi-mw80aczw.sputnik-v2.testnet");
  await expect(loans.locator("tbody tr").filter({ has: page.getByText("#0", { exact: true }) })).toContainText(/Failed[\s\S]*rolled back to the risk fund \(DAO proposal #146\)/);
  await expect(loans.locator("tbody tr").filter({ has: page.getByText("#1", { exact: true }) })).toContainText(/1\.00 \/ \d+\.\d\d USDC[\s\S]*Voted by DAO proposal #147/);
});

test("0.3.6: polls in Commons, technical ones weighed by reputation by the members' choice", async ({ page }) => {
  await page.goto("/dashboard.html#/commons");
  const polls = page.locator("#c-polls");
  await expect(polls).toContainText("Technical questions weigh each vote by the member's reputation weight, by the members' own choice (DAO proposal #145)");
  const p0 = polls.locator("tbody tr").filter({ has: page.getByText("#0", { exact: true }) });
  await expect(p0).toContainText("Which embedding model");
  await expect(p0).toContainText(/keep the current model: \d+/);
  await expect(p0).toContainText(/by reputation weight; \d+ voters/);
  await expect(p0).toContainText(/open until|voting ended|closed:/);
});

test("0.3.6: the agent report shows its recovery record and the ramp", async ({ page }) => {
  await page.goto("/dashboard.html#/report");
  const r = page.locator("#r-recovery");
  await expect(r.locator(".rc-verdict")).toContainText(/Recovery: (no recovery on record|a plan on record)/);
  await expect(r).toContainText(/from 25% back to all of it over \d+ days/);
});

test("join from zero: a visitor sees each step with what the chain asks for, and a wallet button", async ({ page }) => {
  await page.goto("/dashboard.html#/membership");
  const steps = page.locator("#join-steps");
  await expect(steps).toContainText(/join deposit \(simpanan pokok\): [\d.]+ NEAR/);
  await expect(steps).toContainText(/\d+ of \d+ approvals/);
  await expect(steps).toContainText("sync_member");
  await expect(steps).toContainText(/mandatory dues \(simpanan wajib\): [\d.]+ NEAR every \d+ days|the members voted none/);
  await expect(page.locator("#w-connect")).toBeVisible();
});

test("a view whose every block failed to read says so, not just its heading", async ({ page }) => {
  test.setTimeout(120_000);
  await page.route(RPC, (route) => route.abort("connectionrefused"));
  await page.goto("/dashboard.html#/money");
  await expect(page.locator("#v-money .view-err")).toContainText("Could not read NEAR right now", { timeout: 90_000 });
});

test("the dashboard's content turns Indonesian with the language button", async ({ page }) => {
  await page.goto("/dashboard.html#/report");
  await expect(page.locator("#r-court .rc-verdict")).toContainText("Court:");
  const lang = page.locator(".lang-btn");
  if (!(await lang.isVisible())) await page.locator("#menu-btn").click();
  await lang.click();
  await expect(page.locator("#h-report")).toHaveText("Rapor agen");
  await expect(page.locator("#r-court .rc-verdict")).toContainText(/Pengadilan: \d+ dari \d+ perkara dikabulkan/);
  await expect(page.locator("#r-taskbond .rc-verdict")).toContainText("Penilai luar");
  await go(page, "Ringkasan");
  await expect(page.locator("#kpis")).toContainText(/Anggota\s*\d+/);
  await expect(page.locator("#kpis")).toContainText("masing-masing satu suara");
  await page.evaluate(() => localStorage.removeItem("kop-lang"));
});
