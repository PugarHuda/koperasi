// The newest features in the Commons section, each card read live from the chain (web/app.js, "Newest, read from the chain").
import { expect } from "@playwright/test";
import { test } from "./helpers.mjs";

test("the Shade Agent card shows the worker, its attestation and the votes that admitted it", async ({ page }) => {
  await page.goto("/#commons");
  const c = page.locator("#card-tee");
  await expect(c).toBeVisible({ timeout: 30_000 });
  await expect(c).toContainText("c4ebe4db");
  await expect(c).toContainText("owned by the co-op's DAO");
  await expect(c).toContainText(/compose hash\) 000bd9f2d8/);
  await expect(c).toContainText(/Attestation (holds until|ran out on) \d+ \w+ \d{4}/);
  await expect(c).toContainText(/#137[\s\S]*TEE-only by #138/);
  await expect(c).toContainText("receipt demo-33693");
  await expect(c.locator("a", { hasText: "agent/phala-compose.yml" })).toHaveAttribute("href", /github\.com\/.*agent\/phala-compose\.yml$/);
});

test("the agent's proposal card shows its evaluation, the diff, the DAO vote and the facts it read", async ({ page }) => {
  await page.goto("/#commons");
  const c = page.locator("#card-proposal");
  await expect(c).toBeVisible({ timeout: 30_000 });
  await expect(c.locator("blockquote")).toContainText(/^“.{10,}”$/); // the agent's own evaluation, quoted
  await expect(c.locator("li", { hasText: "→" }).first()).toContainText(/^[\w.]+: .+ → .+$/); // e.g. v8: job_filter.min_price_usdc: 2 → 3
  await expect(c).toContainText(/DAO proposal #\d+: Approved/);
  await expect(c.locator("a", { hasText: /^sha256 [0-9a-f]{12}…$/ })).toHaveAttribute("href", /agent-proposals\/v\d+\.facts\.json$/);
  await expect(c).toContainText(/\d+ earlier proposal/);
});

test("the credit bureau card shows the federation's ceiling, the refused vote and a sister co-op's credit", async ({ page }) => {
  await page.goto("/#commons");
  const c = page.locator("#card-credit");
  await expect(c).toBeVisible({ timeout: 30_000 });
  await expect(c).toContainText(/caps loans at\s+2% for 30 days/);
  await expect(c).toContainText(/voted 4% loans \(DAO proposal #130\);\s+the contract refused it, and the loan rule is still 2%/);
  await expect(c).toContainText(/1 sister co-op/);
  await expect(c).toContainText(/kop-carol-mw80aczw\.testnet has credit score 2 here\s+from a stamp by koperasi-mw80aczw\.testnet/);
  await expect(c).toContainText("credit is 0");
});
