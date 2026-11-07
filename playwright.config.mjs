// npx playwright test                       (against the live page)
// BASE_URL=http://localhost:5173 npx playwright test   (against `cd web && python -m http.server 5173`)
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  retries: 1,
  // every test reads public NEAR RPCs and GitHub, which rate-limit per IP: keep the load polite
  workers: 2,
  use: { baseURL: process.env.BASE_URL ?? "https://koperasi-kohl.vercel.app" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
});
