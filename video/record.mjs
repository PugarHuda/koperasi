// node video/record.mjs [sNN ...]: records each page scene of the video from the real app (live site, or the local
// page for the member preview), 1920x1080, with a visible cursor. For each scene it writes public/clips/<id>.webm and
// public/clips/<id>.json: { start (ms into the clip where the scene begins), marks: [{ t, kind, rect, label, dur }] }.
// Marks drive the zoom and highlight boxes in Remotion. Scene lengths follow the narration (public/audio/<id>.json).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";

const ROOT = import.meta.dirname;
const LIVE = "https://koperasi-kohl.vercel.app";
const LOCAL = "http://localhost:5173";
const CLIPS = path.join(ROOT, "public/clips");
fs.mkdirSync(CLIPS, { recursive: true });
const words = (id) => JSON.parse(fs.readFileSync(path.join(ROOT, `public/audio/${id}.json`), "utf8"));
const length = (id) => words(id).at(-1).end + 1200;

// a cursor the recording can see, following the mouse
const CURSOR = `addEventListener("DOMContentLoaded", () => {
  const c = document.createElement("div");
  c.style.cssText = "position:fixed;z-index:99999;width:22px;height:22px;border-radius:50%;background:rgba(255,255,255,.9);border:3px solid #1f4bff;box-shadow:0 2px 10px rgba(0,0,0,.35);pointer-events:none;transform:translate(-50%,-50%);left:-50px;top:-50px;transition:width .15s,height .15s";
  document.body.append(c);
  addEventListener("mousemove", (e) => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; });
  addEventListener("mousedown", () => { c.style.width = c.style.height = "16px"; });
  addEventListener("mouseup", () => { c.style.width = c.style.height = "22px"; });
});`;

const browser = await chromium.launch();

async function scene(id, url, act) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: CLIPS, size: { width: 1920, height: 1080 } } });
  const t0 = Date.now();
  await ctx.addInitScript(CURSOR);
  const page = await ctx.newPage();
  const marks = [];
  let start = 0;
  const now = () => Date.now() - t0 - start;
  const rect = async (sel) => (await page.locator(sel).first().boundingBox()) ?? null;
  const h = {
    page,
    /** the scene begins here: everything before is cut */
    ready: async () => { await page.mouse.move(960, 540); start = Date.now() - t0; },
    /** wait until `ms` into the scene */
    at: async (ms) => { const d = ms - now(); if (d > 0) await page.waitForTimeout(d); },
    glide: async (sel, offset = 90) => {
      await page.locator(sel).first().evaluate((el, o) => { window.scrollTo({ top: el.getBoundingClientRect().top + scrollY - o, behavior: "smooth" }); }, offset);
      await page.waitForTimeout(1300);
    },
    // the cursor rests on the element's top-right corner, so it never hides what the narration talks about
    point: async (sel) => { const r = await rect(sel); if (r) await page.mouse.move(Math.min(r.x + r.width - 18, 1900), Math.max(r.y + 14, 10), { steps: 30 }); },
    box: async (sel, label, dur = 4000) => { marks.push({ t: now(), kind: "box", rect: await rect(sel), label, dur }); await h.point(sel); },
    zoom: async (sel, label, dur = 5000) => { marks.push({ t: now(), kind: "zoom", rect: await rect(sel), label, dur }); await h.point(sel); },
    log: (line) => marks.push({ t: now(), kind: "term", label: line }),
  };
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await act(h);
  await h.at(length(id));
  const video = page.video();
  await ctx.close();
  fs.renameSync(await video.path(), path.join(CLIPS, `${id}.webm`));
  fs.writeFileSync(path.join(CLIPS, `${id}.json`), JSON.stringify({ start, marks }, null, 1));
  console.log(id, `${(length(id) / 1000).toFixed(1)}s`, marks.length, "marks");
}

const loaded = (page) => page.waitForFunction(() => !/Reading the DAO/.test(document.querySelector("#p-voters")?.textContent ?? "Reading the DAO"), null, { timeout: 60000 });
const scenes = {
  s02: () => scene("s02", `${LIVE}/`, async (h) => {
    await loaded(h.page);
    await h.ready();
    await h.at(1500); await h.box(".panel", "Read live from the Sputnik DAO", 6000);
    await h.at(8500); await h.zoom("#p-voters", "Each member: one vote", 5500);
  }),
  s03: () => scene("s03", `${LIVE}/`, async (h) => {
    await loaded(h.page);
    await h.page.waitForFunction(() => document.querySelector("#ck-bylaws")?.classList.contains("pass"), null, { timeout: 60000 });
    await h.glide("#checks", 40);
    await h.ready();
    await h.at(2500); await h.box("#ck-bylaws", "By-laws hash = the vote", 4500);
    await h.at(7500); await h.box("#ck-code", "0 full-access keys", 4500);
    await h.at(12500);
    await h.page.waitForSelector("#ck-tee-run:not([disabled])", { timeout: 30000 });
    await h.point("#ck-tee-run");
    await h.page.click("#ck-tee-run");
    await h.at(13500); await h.zoom("#ck-tee", "TEE attestation, your nonce", 8500);
  }),
  s04: () => scene("s04", `${LIVE}/`, async (h) => {
    await loaded(h.page);
    await h.glide("#live", 40);
    await h.page.waitForSelector("#live-list li", { timeout: 40000 }).catch(() => {});
    await h.ready();
    await h.at(800); await h.box("#live-list", "NEP-297 events, live", 5500);
  }),
  s05: () => scene("s05", `${LIVE}/`, async (h) => {
    await loaded(h.page);
    await h.glide("#members", 40);
    await h.ready();
    await h.at(1500); await h.box("#meters", "Savings and contribution", 4500);
    await h.at(6500); await h.page.selectOption("#member-pick", { index: 1 }).catch(() => {});
    await h.at(9500); await h.glide("#bylaws", 40);
    await h.at(11000); await h.box("#versions", "Every by-laws version, by vote", 4000);
    await h.at(15500); await h.zoom("#verify", "Hash checked in your browser", 4500);
  }),
  s06: () => scene("s06", `${LIVE}/`, async (h) => {
    await loaded(h.page);
    await h.glide("#work", 40);
    await h.ready();
    await h.at(1500); await h.box(".phone", "One receipt per job", 4500);
    await h.at(6500); await h.glide("#receipts", 60);
    await h.zoom("#receipts", "Price, inference cost, by-laws", 4500);
    await h.at(12000); await h.glide("#audit", 40);
    await h.box("#verdict", "The steward's audit", 4000);
    await h.at(17500); await h.box("#audit-term", "90-day term, by vote", 3500);
    await h.at(21000); await h.box("#rekon", "Paid vs passed on", 3200);
  }),
  s07: () => scene("s07", `${LIVE}/`, async (h) => {
    await loaded(h.page);
    await h.glide("#shares", 40);
    await h.ready();
    await h.at(1000); await h.box("#plans", "Split by the voted rule", 4000);
    await h.at(5500); await h.box("#periods", "Every share, on-chain", 3800);
  }),
  s08: () => scene("s08", `${LIVE}/`, async (h) => {
    await loaded(h.page);
    await h.page.waitForSelector("#tiers li", { timeout: 40000 });
    await h.page.waitForLoadState("networkidle").catch(() => {});
    await h.glide("#tiers", 200);
    await h.ready();
    await h.at(1000); await h.box("#tiers", "Three tiers, voted", 10000);
    await h.at(11500); await h.zoom("#tiers li:nth-child(2)", "Veto window: 10 minutes, by vote", 9300);
    await h.at(21000); await h.glide("#tasks", 60);
    await h.zoom("#tasks", "Paid by DAO proposals", 4300);
    await h.at(25500); await h.glide("#records", 60);
    await h.box("#records", "Every point names its source", 3500);
  }),
  s09: () => scene("s09", `${LIVE}/`, async (h) => {
    await loaded(h.page);
    await h.glide("#commons", 40);
    await h.page.waitForSelector("#cases tbody tr td strong", { timeout: 40000 });
    await h.ready();
    await h.at(1500); await h.glide("#pledges", 120);
    await h.box("#pledges", "Pledges: work, not money", 5000);
    await h.at(8000); await h.zoom("#cases", "A jury of 3, drawn at random", 10000);
    await h.at(19000); await h.glide("#commons", 40);
    await h.box("#standing", "Standing", 3000);
    await h.at(22500); await h.zoom("#multichain", "Ethereum address, no private key", 8000);
  }),
  s10: () => scene("s10", `${LIVE}/cert.html?who=kop-alice-mw4i3w8f.testnet`, async (h) => {
    await h.page.waitForSelector("#cert-sum tr", { timeout: 40000 });
    await h.ready();
    await h.at(1200); await h.box("#cert-sum-t", "Read live from the chain", 4000);
    await h.at(5500); await h.glide("#cert-pledges", 80);
    await h.box("#cert-pledges", "Kept pledges", 2200);
    await h.at(7800); await h.box("#cert-juries", "Jury duty", 2000);
  }),
  s11: () => scene("s11", `${LOCAL}/?as=kop-alice-mw4i3w8f.testnet`, async (h) => {
    await h.page.waitForSelector("#joinapp .jh", { timeout: 60000 });
    await h.glide("#joinapp", 30);
    await h.ready();
    const head = (t) => `#joinapp h3.jh:has-text("${t}")`;
    await h.at(1000); await h.box(head("Open proposals"), "Vote on open proposals", 3500);
    await h.at(5000); await h.glide(head("Tasks with earned trust"), 120);
    await h.box(head("Tasks with earned trust"), "Take and post tasks", 3500);
    await h.at(9500); await h.glide(head("Pledges and the co-op court"), 120);
    await h.zoom(head("Pledges and the co-op court"), "Pledge, call in, rule", 5000);
    await h.at(15000); await h.glide(head("Invite someone"), 120);
    await h.box(head("Invite someone"), "Signed vouch (NEP-413)", 5000);
  }),
  s12: () => scene("s12", `${LIVE}/`, async (h) => {
    await loaded(h.page);
    await h.glide("#pledges", 160);
    await h.ready();
    await h.at(500); await h.box("#pledges", "Before: 1 of 2", 2500);
    // the real transaction, run while the screen records
    const out = spawn(process.execPath, [path.join(ROOT, "live-pledge.mjs")], { cwd: path.join(ROOT, "..") });
    let buf = "";
    out.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { h.log(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    out.stderr.on("data", (d) => process.stderr.write(d));
    await new Promise((ok, no) => out.on("exit", (c) => (c ? no(new Error(`live-pledge exited ${c}`)) : ok())));
    await h.page.waitForTimeout(1500);
    await h.page.reload({ waitUntil: "domcontentloaded" });
    await loaded(h.page);
    await h.page.waitForSelector("#pledges tbody tr td strong", { timeout: 40000 });
    await h.glide("#pledges", 160);
    await h.zoom("#pledges", "After: 2 of 2, both kept", 4500);
  }),
};

const want = process.argv.slice(2);
for (const [id, run] of Object.entries(scenes)) if (!want.length || want.includes(id)) await run();
await browser.close();
