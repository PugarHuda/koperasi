// npx playwright test                                   (against the live page)
// BASE_URL=http://localhost:5173 npx playwright test    (against `cd web && python -m http.server 5173`; also runs the
//                                                        wallet-panel previews, which work on localhost only)
// npx playwright show-report                            (the HTML report, with traces of failed tests)
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  testMatch: /.*\.spec\.mjs$/,
  timeout: 90_000,
  expect: { timeout: 30_000, toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: "disabled" } },
  retries: 1,
  // every test reads public NEAR RPCs and GitHub, which rate-limit per IP: keep the load polite
  workers: 2,
  reporter: [["line"], ["html", { open: "never" }]],
  snapshotPathTemplate: "tests/__screenshots__/{projectName}/{arg}{ext}",
  use: {
    baseURL: process.env.BASE_URL ?? "https://koperasi-kohl.vercel.app",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "firefox", use: { ...devices["Desktop Firefox"], viewport: { width: 1280, height: 800 } } },
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 800 } } },
    { name: "tablet", use: { ...devices["iPad (gen 7)"], browserName: "chromium" } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
    { name: "iphone", use: { ...devices["iPhone 13"] } },
  ],
});
