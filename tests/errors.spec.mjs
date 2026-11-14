// The Commons card where the agent's mistakes and the members' corrections are read from the chain (web/app.js, #card-errors).
import { expect } from "@playwright/test";
import { test } from "./helpers.mjs";

test("the errors card shows v9 undone by the members' v10 and the agent's review rejected, then accepted", async ({ page }) => {
  await page.goto("/#commons");
  const c = page.locator("#card-errors");
  await expect(c).toBeVisible({ timeout: 60_000 });
  await expect(c).toContainText(/by-laws v9 \(by agent\.koperasi-mw4i2iwk\.testnet\)/);
  await expect(c).toContainText("DAO proposal #139: Approved");
  await expect(c).toContainText("counted a Taskbond job, paid in testnet NEAR, as a 0 USDC sale");
  await expect(c).toContainText(/kop-alice-mw4i3w8f\.testnet, proposed v10 to restore v8/);
  await expect(c).toContainText("DAO proposal #140: Approved");
  await expect(c).toContainText("DAO proposal #141: Rejected");
  await expect(c).toContainText("DAO proposal #142: Approved");
  await expect(c).toContainText(/On \d+ \w+ \d{4} the agent proposed/);
  await expect(c.locator("a", { hasText: "The rejected draft" })).toHaveAttribute("href", "rat/agent-2026.rejected.md");
  await expect(c.locator("a", { hasText: "the review" })).toHaveAttribute("href", "rat/agent-2026.md");
  // the linked files are served
  for (const href of ["rat/agent-2026.rejected.md", "rat/agent-2026.md"]) expect((await page.request.get(`/${href}`)).ok()).toBe(true);
});
