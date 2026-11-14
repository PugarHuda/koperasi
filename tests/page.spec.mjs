// End-to-end checks of the live co-op page. Everything it asserts is read from NEAR testnet, GitHub and NEAR AI.
import { expect } from "@playwright/test";
import { test } from "./helpers.mjs";

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
  // late content (the DAO's bounties, members' free text) is what overflowed before: measure once it is in
  await expect(page.locator("#bounties tbody td").first()).toBeVisible();
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

test("each line of the track's brief is proven from the chain, under the co-op's activity", async ({ page }) => {
  await page.goto("/#brief");
  await expect(page.locator("#brief-list li.pass")).toHaveCount(5);
  await expect(page.locator("#br-own")).toContainText(/\d+ members hold the DAO's role member.*a decision needs \d+ of \d+/s);
  await expect(page.locator("#br-sputnik")).toContainText("transfer:AddProposal");
  await expect(page.locator("#counts")).toContainText(/DAO proposals\s*\d{2,}/);
  // the first screen says what is on-chain now, and leads to the proof
  await expect(page.locator("#proofline")).toContainText(/\d+ members, \d+ DAO votes, \d+ tasks paid, and payouts that landed on NEAR/);
  await expect(page.locator(".hero-cta a").first()).toHaveAttribute("href", "#brief");
});

test("the page shows how to rebuild the contract's code, from its NEP-330 metadata", async ({ page }) => {
  await page.goto("/#bylaws");
  const card = page.locator("#src-card");
  await expect(card).toContainText("Rebuild it yourself", { timeout: 30_000 });
  await expect(card.locator("a")).toHaveAttribute("href", /github\.com\/PugarHuda\/koperasi\/tree\/[0-9a-f]{40}/);
  await expect(card.locator("pre")).toContainText("cargo near build reproducible-wasm");
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
  // an existing testnet account that never joined
  await page.goto("/?as=kop-publisher-mw5tkpfo.testnet");
  const panel = page.locator("#joinapp");
  await expect(panel).toContainText("Signed in as kop-publisher-mw5tkpfo.testnet");
  await expect(panel.locator("#w-join")).toHaveText(/Pay 0\.5 NEAR/);
  await expect(panel.locator(".jsteps li")).toHaveCount(5);
  expect(errors).toEqual([]);
});

test("an account from another network is told to switch, not offered a join", async ({ page }, testInfo) => {
  test.skip(!local(testInfo), "?as= previews run on localhost only");
  await page.goto("/?as=nobody-koperasi-e2e.testnet");
  const panel = page.locator("#joinapp");
  await expect(panel.locator("#w-network")).toContainText("does not exist on NEAR testnet");
  await expect(panel.locator("#w-switch")).toBeVisible();
  await expect(panel.locator("#w-join")).toHaveCount(0);
});

test("the live feed shows the co-op's on-chain events, each with its transaction", async ({ page }) => {
  await page.goto("/#live");
  const items = page.locator("#live-list li");
  const state = page.locator("#live-state");
  // NearBlocks' free API rate-limits (429) when many browsers poll at once: then the page must say so, not show nothing
  await expect(items.first().or(state.filter({ hasText: /Could not read the indexer \(indexer 429\)/ }))).toBeVisible({ timeout: 45_000 });
  if (await items.count()) await expect(items.first().locator("a")).toHaveAttribute("href", /nearblocks\.io\/txns\//);
  await expect(state).toContainText(/Updated|No co-op events|Could not read/);
});

test("a member sees their vote, savings and open proposals", async ({ page }, testInfo) => {
  test.skip(!local(testInfo), "?as= previews run on localhost only");
  await page.goto("/?as=kop-bob-mw4i3w8f.testnet");
  const panel = page.locator("#joinapp");
  await expect(panel.locator(".me-card").first()).toContainText(/Your vote\s*1 of \d+/);
  await expect(panel).toContainText("Open proposals");
  await expect(panel.locator("#w-stake")).toBeVisible();
  // leaving is a DAO proposal to remove yourself; the deposit comes back by sync_member once it passes
  await expect(panel.locator("#w-leave")).toHaveText("Ask to leave");
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

test("the page reads in Bahasa Indonesia, and back in English", async ({ page }) => {
  await page.goto("/");
  const toggle = page.getByRole("button", { name: /Bahasa Indonesia/ });
  await toggle.click();
  await expect(page.locator(".hero .lede")).toContainText("Desa-desa di Indonesia");
  await expect(page.locator("#panel-q")).toHaveText("Siapa yang mengendalikan agen AI ini?");
  await expect(page.locator("html")).toHaveAttribute("lang", "id");
  await expect(page.locator("#commons-sub")).toContainText("diundi menurut bobot reputasi (pilihan anggota, #150)");
  await expect(page.locator("#versus tbody")).toContainText("Siapa yang memutuskan apa yang dikerjakan agen");
  await expect(page.locator("#members .pick")).toContainText("Pilih anggota");
  await expect(page.locator("#member-pick")).toHaveCount(1); // the label's text changed, not its select
  await expect(page.locator("#join .cli > summary")).toHaveText("Lebih suka baris perintah?");
  await page.reload();
  await expect(page.locator("#panel-q")).toHaveText("Siapa yang mengendalikan agen AI ini?"); // remembered
  await page.getByRole("button", { name: /English/ }).click();
  await expect(page.locator("#panel-q")).toHaveText("Who controls this AI agent?");
});

test("the sentences read from the chain follow the language switch",async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => { if (!network(e.message)) errors.push(e.message); });
  await page.goto("/#brief");
  await expect(page.locator("#proofline")).toContainText(/Right now on NEAR testnet: \d+ members/);
  await expect(page.locator("#status")).toContainText(/Allowed to work|Paused by vote/);
  await expect(page.locator("#treasury")).toContainText(/holds \d+\.\d\d USDC/);
  await page.locator(".lang-btn").click();
  await expect(page.locator("#proofline")).toContainText(/Saat ini di testnet NEAR: \d+ anggota, \d+ pemungutan suara DAO/);
  await expect(page.locator("#br-own")).toContainText(/\d+ anggota memegang peran DAO member.*keputusan perlu \d+ dari \d+/s);
  await expect(page.locator("#counts")).toContainText("Usulan DAO");
  await expect(page.locator("#status")).toContainText(/Boleh bekerja|Dihentikan lewat suara/);
  await expect(page.locator("#treasury")).toContainText(/Kas DAO saat ini berisi \d+\.\d\d USDC/);
  await expect(page.locator("#ck-money .ck-out")).toContainText(/pekerjaan yang dibayar|belum sampai di koperasi/);
  await page.locator(".lang-btn").click();
  await expect(page.locator("#proofline")).toContainText("Right now on NEAR testnet");
  expect(errors).toEqual([]);
});

test("a work record reads in Bahasa Indonesia", async ({ page }) => {
  await page.goto("/cert.html?who=kop-bob-mw4i3w8f.testnet");
  await expect(page.locator("#cert-sum")).toContainText(/yes, since/);
  await page.getByRole("button", { name: /Bahasa Indonesia/ }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "id");
  await expect(page.locator("#cert-sum")).toContainText(/ya, sejak/);
  await expect(page.locator("#cert-sum th").first()).toHaveText("Anggota");
  await expect(page.locator("#cert-who")).toContainText("Catatan kerja kop-bob-mw4i3w8f.testnet");
  await expect(page.locator("#cert-sub")).toContainText("Setiap baris di bawah dibaca");
  await expect(page.locator("#cert-input")).toHaveValue("kop-bob-mw4i3w8f.testnet"); // the form survives the switch
});

test("the co-ops page reads in Bahasa Indonesia", async ({ page }) => {
  await page.goto("/coops.html");
  await expect(page.locator("#coops tbody")).toContainText("showcase");
  await page.getByRole("button", { name: /Bahasa Indonesia/ }).click();
  await expect(page.locator("#coops-title")).toHaveText("Koperasi dengan kode ini");
  await expect(page.locator("#coops tbody")).toContainText("unggulan");
  await expect(page.locator("#coops tbody")).toContainText(/hanya pemungutan suara anggota|kunci full-access/);
  await expect(page.locator("#fed")).toContainText("tidak ada pihak lain yang bisa memilih");
});

test("the co-ops page scores credit between co-ops from each co-op's loans", async ({ page }) => {
  await page.goto("/coops.html");
  // koperasi-mw4i2iwk lent the sister two loans, both repaid on time (#0 failed and does not count)
  const row = page.locator("#credit-table tbody tr").filter({ hasText: "koperasi-mw80aczw.testnet" });
  await expect(row.locator("td").nth(1)).toHaveText(/^\d+$/);
  await expect(row.locator("td").nth(2)).toHaveText("2");
  await expect(row).toContainText("0.05 USDC");
  await expect(page.locator("#credit-table tbody")).toContainText("no record");
  await page.getByRole("button", { name: /Bahasa Indonesia/ }).click();
  await expect(page.locator("#credit-title")).toHaveText("Kredit antarkoperasi");
});

test("the wallet panel follows the language switch", async ({ page }, testInfo) => {
  test.skip(!local(testInfo), "?as= previews run on localhost only");
  const errors = [];
  page.on("pageerror", (e) => { if (!network(e.message)) errors.push(e.message); });
  await page.addInitScript(() => { if (!sessionStorage.getItem("set")) { localStorage.setItem("kop-lang", "id"); sessionStorage.setItem("set", "1"); } });
  await page.goto("/?as=kop-publisher-mw5tkpfo.testnet");
  const panel = page.locator("#joinapp");
  await expect(panel).toContainText("Masuk sebagai kop-publisher-mw5tkpfo.testnet");
  await expect(panel.locator("#w-join")).toHaveText(/Bayar 0\.5 NEAR/);
  await expect(panel.locator(".jsteps li").first()).toContainText("simpanan pokok");
  await page.locator(".lang-btn").click();
  await expect(panel).toContainText("Signed in as kop-publisher-mw5tkpfo.testnet");
  await expect(panel.locator("#w-join")).toHaveText(/Pay 0\.5 NEAR/);
  expect(errors).toEqual([]);
});

test("juries are drawn by reputation (#150), never described as drawn at random, on the docs and the landing page", async ({ page }) => {
  for (const path of ["/docs.html", "/"]) {
    await page.goto(path);
    const text = await page.locator("body").textContent();
    expect(text, path).not.toMatch(/drawn at random|random jury|juri acak/i);
    expect(text, path).toMatch(/drawn (by|from members in good standing, weighted by) reputation|weighted by reputation/);
  }
});

test("the docs page loads, its contents link to its sections, and it reads in Bahasa Indonesia", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => { if (!network(e.message)) errors.push(e.message); });
  page.on("console", (m) => { if (m.type() === "error" && !network(m.text())) errors.push(m.text()); });
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/docs.html");
  // innerText: what shows (each heading holds both languages; CSS shows one, in capitals)
  await expect(page.locator("#how")).toHaveText(/^How it works$/i, { useInnerText: true });
  const hrefs = await page.locator(".toc a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  expect(hrefs).toHaveLength(8);
  for (const href of hrefs) expect(await page.locator(href).count(), href).toBe(1);
  // folded on a phone; one tap opens it
  await expect(page.locator(".toc a").first()).toBeHidden();
  await page.locator(".toc summary").click();
  await expect(page.locator(".toc a").first()).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: /Bahasa Indonesia/ }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "id");
  await expect(page.locator("#how")).toHaveText(/^Cara kerjanya$/i, { useInnerText: true });
  await expect(page.locator("#glossary")).toHaveText(/^Istilah$/i, { useInnerText: true });
  await expect(page.locator(".flow text", { hasText: "Pekerjaan masuk" })).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: /English/ }).click();
  await expect(page.locator("#how")).toHaveText(/^How it works$/i, { useInnerText: true });
  expect(errors).toEqual([]);
});
