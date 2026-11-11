// What members owe each other (contract/src/commons.rs): the public section read from the live showcase, the work
// record page, and what each role can do from the wallet panel (?as= previews on localhost).
import { expect, test } from "@playwright/test";
import { answerViews, onlyLocal } from "./helpers.mjs";

const ALICE = "kop-alice-mw4i3w8f.testnet";
const BOB = "kop-bob-mw4i3w8f.testnet";
const GUEST = "kop-guest-984702.testnet";
const DAY = 86_400_000_000_000n;
const now = () => BigInt(Date.now()) * 1_000_000n;
const good = [{ pledges_honored: 0, pledges_broken: 0, juries_served: 0, juries_missed: 0, slashed: 0 }, true];
const pledge = (id, issuer, units = 2, called = 0) => ({ id, issuer, what: `pledge ${id}`, units, called, ts: "0" });
const kase = (extra = {}) => ({ id: 0, job_id: "job-1", claimant: BOB, refund_to: "buyer.testnet", amount: "500000", reason: "half missing",
  jurors: [ALICE, GUEST, "x.testnet"], votes: [], opened: String(now() - DAY), status: "Open", refund_proposal: null, ...extra });

test("the commons section shows the court case, its jurors and the refund, each member's standing, and the Ethereum address", async ({ page }) => {
  await page.goto("/#commons");
  const c = page.locator("#cases tbody tr", { hasText: "demo-court-mwag2r51" });
  await expect(c).toContainText("upheld: refunded");
  await expect(c.locator("a", { hasText: "DAO proposal #60" })).toBeVisible();
  // scripts/scenarios.mjs: two cases the jurors did not uphold, a pledge nobody called in yet
  await expect(page.locator("#cases tbody tr", { hasText: "not upheld" })).toHaveCount(2);
  await expect(page.locator("#pledges tbody tr", { hasText: "onboarding call" })).toContainText("0 of 2");
  await expect(page.locator("#pledges tbody tr", { hasText: "Review one pull request" })).toContainText(/2 of 2\s*2 \/ 0/);
  await expect(page.locator("#standing li", { hasText: ALICE })).toContainText("good standing");
  await expect(page.locator("#multichain")).toContainText("0xb3dc0128b4a9804de94796480bef8ba014dfca7d");
  await expect(page.locator("#audit-term")).toContainText(/serves 90 days/);
});

test("the work record reads a member's pledges and jury duty from the chain, and refuses what is not an account id", async ({ page }) => {
  await page.goto(`/cert.html?who=${ALICE}`);
  await expect(page.locator("#cert-sum")).toContainText(/good: \d+ pledge\(s\) kept, 0 broken/);
  await expect(page.locator("#cert-pledges tbody")).toContainText(`${BOB}`);
  await expect(page.locator("#cert-juries tbody")).toContainText("job demo-court-");
  await page.goto(`/cert.html?who=${encodeURIComponent('"><img src=x onerror=alert(1)>')}`);
  await expect(page.locator("#cert-who")).toHaveText("That is not a NEAR account id.");
  await expect(page.locator("img")).toHaveCount(0);
});

test("a juror is offered uphold and reject; someone else is not", async ({ page }, testInfo) => {
  onlyLocal(testInfo);
  await answerViews(page, { get_pledges: [], get_pledge_claims: [], get_cases: [kase()], get_standing: good });
  await page.goto(`/?as=${ALICE}`);
  const box = page.locator("#joinapp");
  await expect(box.locator("[data-crule='0'][data-up='1']")).toContainText("Uphold: refund");
  await expect(box.locator("[data-crule='0'][data-up='0']")).toContainText("Reject");
  await page.goto(`/?as=${BOB}`);
  await expect(box).toContainText("Pledges and the co-op court");
  await expect(box.locator("[data-crule]")).toHaveCount(0);
});

test("after 3 days anyone may close the case; a juror who already ruled is not asked again", async ({ page }, testInfo) => {
  onlyLocal(testInfo);
  await answerViews(page, { get_pledges: [], get_pledge_claims: [], get_standing: good,
    get_cases: [kase({ opened: String(now() - 4n * DAY), votes: [[ALICE, true]] }), kase({ id: 1, votes: [[ALICE, false]] })] });
  await page.goto(`/?as=${BOB}`);
  await expect(page.locator("[data-cclose='0']")).toContainText("Close (3 days passed)");
  await page.goto(`/?as=${ALICE}`);
  await expect(page.locator("[data-cclose='0']")).toBeVisible();
  await expect(page.locator("[data-crule='1']")).toHaveCount(0);
});

test("a member calls in another's pledge, never their own; the holder says kept, and broken only after 14 days", async ({ page }, testInfo) => {
  onlyLocal(testInfo);
  await answerViews(page, { get_cases: [], get_standing: good,
    get_pledges: [pledge(0, ALICE), pledge(1, BOB), pledge(2, ALICE, 1, 1)],
    get_pledge_claims: [{ id: 0, pledge: 0, holder: BOB, status: "Open", ts: String(now() - 15n * DAY) },
      { id: 1, pledge: 0, holder: BOB, status: "Open", ts: String(now() - DAY) }] });
  await page.goto(`/?as=${BOB}`);
  const box = page.locator("#joinapp");
  await expect(box.locator("[data-predeem='0']")).toBeVisible();
  await expect(box.locator("[data-predeem='1']")).toHaveCount(0); // bob's own
  await expect(box.locator("[data-predeem='2']")).toHaveCount(0); // every unit called in
  await expect(box.locator("[data-pkept]")).toHaveCount(2);
  await expect(box.locator("[data-pbroken='0']")).toBeVisible();
  await expect(box.locator("[data-pbroken='1']")).toHaveCount(0);
  await box.locator("#w-pl-post").click();
  await expect(box.locator(".note-line .err")).toContainText("say what you promise");
});

test("out of good standing: told so, and offered no court case", async ({ page }, testInfo) => {
  onlyLocal(testInfo);
  await answerViews(page, { get_pledges: [], get_pledge_claims: [], get_cases: [],
    get_standing: [{ pledges_honored: 0, pledges_broken: 1, juries_served: 0, juries_missed: 0, slashed: 0 }, false] });
  await page.goto(`/?as=${BOB}`);
  await expect(page.locator("#joinapp")).toContainText("not good");
  await expect(page.locator("#joinapp")).toContainText("you are not drawn as a juror");
  await expect(page.locator("#w-c-open")).toHaveCount(0);
});
