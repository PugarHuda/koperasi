// node video/shots30.mjs   screenshots of the live page for the 30-second opening (src/Intro30.tsx), into public/shots30/
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const PAGE = process.env.BASE_URL ?? "https://koperasi-kohl.vercel.app";
const out = path.join(import.meta.dirname, "public", "shots30");
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, colorScheme: "dark" });
const shot = async (name, url, selector, wait) => {
  await page.goto(`${PAGE}${url}`, { waitUntil: "domcontentloaded" });
  const el = page.locator(selector).first();
  if (wait) await page.locator(wait.sel).first().filter({ hasText: wait.text }).waitFor({ timeout: 60_000 });
  await el.scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await el.screenshot({ path: path.join(out, `${name}.png`) });
  console.log(name);
};
await shot("hero", "/", ".hero", { sel: "#proofline", text: "members" });
await shot("attacks", "/#checks", "#ck-attacks", { sel: "#ck-attacks", text: "of" });
await shot("taskbond", "/#work", "#p-agent", { sel: "#p-agent", text: "Taskbond" });
await shot("passport", "/cert.html?who=kop-carol-mw80aczw.testnet", "#cert-sum-t", { sel: "#cert-sum", text: "trust source" });
await shot("meeting", "/#commons", "#rat", { sel: "#rat", text: "Annual members" });
await shot("duties", "/#commons", "#duties", { sel: "#duties", text: "Mandatory dues" });
await shot("federation", "/coops.html", "#network", { sel: "#resolutions tbody tr", text: "Resolution" });
await browser.close();
