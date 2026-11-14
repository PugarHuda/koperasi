// node video/record.mjs [sNN ...]: records each page scene of the video from the real app (live site, or the local
// page for the member preview), 1920x1080, with a visible cursor. For each scene it writes public/clips/<id>.mp4 and
// public/clips/<id>.json: { start (ms into the clip where the scene begins), marks: [{ t, kind, rect, label, dur, click? }] }.
// Marks drive the zoom, the highlight boxes and the click sound in Remotion; they are timed to the narration's words
// (public/audio/<id>.json), and their rects are the elements' bounding boxes at that moment.
// Read-only: no wallet is connected and nothing is signed; the member preview only types into a preview field.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";

const ROOT = import.meta.dirname;
const LIVE = process.env.KOP_PAGE_URL ?? "https://koperasi-kohl.vercel.app"; // KOP_PAGE_URL=http://localhost:5173 records the local copy
const LOCAL = "http://localhost:5173";
const CLIPS = path.join(ROOT, "public/clips");
fs.mkdirSync(CLIPS, { recursive: true });
const words = (id) => JSON.parse(fs.readFileSync(path.join(ROOT, `public/audio/${id}.json`), "utf8"));
const length = (id) => words(id).at(-1).end + 1200;
const bare = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, "");

// a cursor the recording can see, following the mouse
const CURSOR = `addEventListener("DOMContentLoaded", () => {
  const c = document.createElement("div");
  c.style.cssText = "position:fixed;z-index:99999;width:22px;height:22px;border-radius:50%;background:rgba(255,255,255,.9);border:3px solid #1f4bff;box-shadow:0 2px 10px rgba(0,0,0,.35);pointer-events:none;transform:translate(-50%,-50%);left:960px;top:540px;transition:width .12s,height .12s";
  document.body.append(c);
  addEventListener("mousemove", (e) => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; });
  addEventListener("mousedown", () => { c.style.width = c.style.height = "14px"; });
  addEventListener("mouseup", () => { c.style.width = c.style.height = "22px"; });
});`;

const browser = await chromium.launch();

/** In the page: the rect of a target. A target is a selector, or { sel, text } (the deepest element under sel whose
 * text has `text`), { sel, line } (the <br>-separated line of sel holding `line`), { sel, all: true } (the union of
 * every match), with { up: n } to take an ancestor. Clamped to the viewport. */
function locate(t) {
  const q = typeof t === "string" ? { sel: t } : t;
  let els = [...document.querySelectorAll(q.sel)];
  if (!els.length) return null;
  if (!q.all) els = [els[0]];
  if (q.text) {
    const under = [...els[0].querySelectorAll("*")].filter((e) => e.textContent.includes(q.text) && e.getClientRects().length);
    els = [under.at(-1) ?? els[0]];
  }
  for (let i = 0; i < (q.up ?? 0); i++) els = els.map((e) => e.parentElement);
  if (q.closest) els = els.map((e) => e.closest(q.closest) ?? e);
  if (q.section) {
    // a heading of the wallet panel and its siblings up to the next heading
    const h3 = [...els[0].querySelectorAll("h3.jh")].find((e) => e.textContent.startsWith(q.section));
    if (!h3) return null;
    els = [h3];
    for (let n = h3.nextElementSibling; n && !n.matches("h3.jh"); n = n.nextElementSibling) els.push(n);
  }
  let rects;
  if (q.line) {
    const lines = [[]];
    for (const k of els[0].childNodes) k.nodeName === "BR" ? lines.push([]) : lines.at(-1).push(k);
    const L = lines.find((l) => l.map((n) => n.textContent).join("").includes(q.line));
    if (!L) return null;
    const r = document.createRange(); r.setStartBefore(L[0]); r.setEndAfter(L.at(-1));
    rects = [r.getBoundingClientRect()];
  } else if (q.tight) {
    // the text's own extent, not the block's full width
    rects = els.map((e) => { const r = document.createRange(); r.selectNodeContents(e); return r.getBoundingClientRect(); });
  } else rects = els.map((e) => e.getBoundingClientRect());
  rects = rects.filter((r) => r.width > 0 && r.height > 0);
  if (!rects.length) return null;
  const x0 = Math.max(0, Math.min(...rects.map((r) => r.left))), y0 = Math.max(0, Math.min(...rects.map((r) => r.top)));
  const x1 = Math.min(innerWidth, Math.max(...rects.map((r) => r.right))), y1 = Math.min(innerHeight, Math.max(...rects.map((r) => r.bottom)));
  return x1 > x0 && y1 > y0 ? { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) } : null;
}

async function scene(id, url, act) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: CLIPS, size: { width: 1920, height: 1080 } } });
  const t0 = Date.now();
  await ctx.addInitScript(CURSOR);
  await ctx.addInitScript(() => { try { localStorage.setItem("kop-lang", "en"); } catch { /* private window: English is the default anyway */ } });
  const page = await ctx.newPage();
  const marks = [];
  const W = words(id);
  let start = 0, flash = -1;
  const now = () => Date.now() - t0 - start;
  /** ms into the scene where the narration says `w` (its nth time), a little ahead so the eye is there first */
  const word = (w, nth = 0, lead = 350) => {
    const hits = W.filter((x) => bare(x.w).startsWith(bare(w)));
    if (!hits[nth]) throw new Error(`${id}: no word "${w}"`);
    return Math.max(0, hits[nth].start - lead);
  };
  const rect = (t) => page.evaluate(locate, t);
  /** the target's rect once it has stopped moving (late content, a scroll still easing out), up to 2.5 s */
  const stableRect = async (t) => {
    let r = await rect(t);
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(125);
      const r2 = await rect(t);
      if (r && r2 && Math.abs(r.x - r2.x) + Math.abs(r.y - r2.y) + Math.abs(r.width - r2.width) + Math.abs(r.height - r2.height) < 3) return r2;
      r = r2;
    }
    return r;
  };
  // while a mark is on screen, follow its target: if the page moves it (content loading above it), the mark ends there
  // and a new one starts at the new place, so the zoom never frames a stale spot
  let watching = null;
  const follow = (m, t) => { watching = { m, t }; };
  const poll = setInterval(async () => {
    const w = watching;
    if (!w || now() > w.m.t + w.m.dur) return;
    const r = await rect(w.t).catch(() => null);
    if (watching !== w || !r || !w.m.rect) return;
    if (Math.abs(r.x - w.m.rect.x) + Math.abs(r.y - w.m.rect.y) + Math.abs(r.height - w.m.rect.height) < 6) return;
    const t1 = now(), end = w.m.t + w.m.dur;
    if (end - t1 < 400) { watching = null; return; }
    w.m.dur = Math.max(300, t1 - w.m.t);
    const m2 = { ...w.m, t: t1, rect: r, dur: end - t1, cont: true };
    marks.push(m2);
    watching = { m: m2, t: w.t };
  }, 150);
  const sel = (t) => (typeof t === "string" ? t : t.sel);
  const h = {
    page, word,
    /** the scene begins here: everything before is cut */
    ready: async () => {
      // a magenta square for half a second before the scene: found in the video later, it ties the video's clock to
      // this one (Playwright's video starts a little after the context, by a varying delay)
      await page.evaluate(() => new Promise((ok) => {
        const d = document.createElement("div");
        d.id = "kop-sync";
        d.style.cssText = "position:fixed;left:0;top:0;width:48px;height:48px;background:#ff00ff;z-index:100000";
        document.body.append(d);
        requestAnimationFrame(() => requestAnimationFrame(ok));
      }));
      flash = Date.now() - t0;
      await page.waitForTimeout(500);
      await page.evaluate(() => document.getElementById("kop-sync")?.remove());
      await page.waitForTimeout(400);
      start = Date.now() - t0;
    },
    /** wait until `ms` into the scene (a number, or a narration word) */
    at: async (ms) => { if (typeof ms === "string") ms = word(ms); const d = ms - now(); if (d > 0) await page.waitForTimeout(d); },
    /** end every mark still on screen: the page is about to move */
    cut: () => {
      watching = null;
      const t = now();
      for (const m of marks) if (m.t + m.dur > t) m.dur = Math.max(300, t - m.t);
    },
    glide: async (t, offset = 90) => {
      h.cut(); // the page moves on purpose: the mark before has ended
      await page.locator(sel(t)).first().evaluate((el, o) => { window.scrollTo({ top: el.getBoundingClientRect().top + scrollY - o, behavior: "smooth" }); }, offset);
      await h.settle();
    },
    /** wait until the page stops scrolling */
    settle: async () => {
      let last = -1;
      for (let i = 0; i < 40; i++) { await page.waitForTimeout(120); const y = await page.evaluate(() => scrollY); if (y === last) break; last = y; }
    },
    /** a real click on a link of the page's header (the page scrolls there); the camera stays wide while it moves */
    nav: async (link, label) => {
      h.cut();
      await h.click(link, label, 1300, undefined, false);
      await h.settle();
    },
    // the cursor rests on the target's top-right corner, so it never hides what the narration talks about
    point: async (t) => { const r = await rect(t); if (r) await page.mouse.move(Math.min(r.x + r.width - 18, 1900), Math.max(r.y + 14, 10), { steps: 25 }); },
    /** look at a target until `until` (ms or word; default 3500 ms on) */
    show: async (t, label, until) => {
      const r = await stableRect(t);
      if (!r) console.warn(`${id}: nothing at`, t);
      const end = typeof until === "string" ? word(until) : until ?? now() + 3500;
      const m = { t: now(), kind: "zoom", rect: r, label, dur: Math.max(1500, end - now()) };
      marks.push(m);
      follow(m, t);
      await h.point(t);
    },
    /** move to a target and really click it; the zoom frames `focus` (default the target) */
    click: async (t, label, dur = 2200, focus, zoom = true) => {
      const r = await stableRect(t);
      await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2, { steps: 22 });
      h.cut(); // a click changes the page: the marks before it end here
      const m = { t: now(), kind: "click", rect: focus ? await stableRect(focus) : r, label, dur, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), ...(zoom ? {} : { zoom: false }) };
      marks.push(m);
      await page.waitForTimeout(500);
      m.click = now();
      await page.mouse.down(); await page.waitForTimeout(70); await page.mouse.up();
    },
  };
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.mouse.move(960, 540);
    await act(h);
  } catch (e) { clearInterval(poll); await ctx.close().catch(() => {}); throw e; }
  await h.at(length(id));
  clearInterval(poll);
  marks.sort((a, b) => a.t - b.t);
  const video = page.video();
  await ctx.close();
  const webm = path.join(CLIPS, `${id}.webm`);
  fs.renameSync(await video.path(), webm);
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", webm, "-c:v", "libx264", "-crf", "16", "-preset", "fast", "-g", "15", "-pix_fmt", "yuv420p", "-r", "30", path.join(CLIPS, `${id}.mp4`)]);
  fs.rmSync(webm);
  // where the magenta square first shows in the video: video time = this clock + offset
  const px = execFileSync("ffmpeg", ["-loglevel", "error", "-i", path.join(CLIPS, `${id}.mp4`), "-vf", "crop=16:16:16:16,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 26 });
  let frame = -1;
  for (let i = 0; i + 2 < px.length; i += 3) if (px[i] > 200 && px[i + 1] < 90 && px[i + 2] > 200) { frame = i / 3; break; }
  const offset = frame >= 0 ? Math.round((frame / 30) * 1000 - flash) : 0;
  if (frame < 0) console.warn(`${id}: sync square not found; the marks may be off`);
  start += offset;
  fs.writeFileSync(path.join(CLIPS, `${id}.json`), JSON.stringify({ start, offset, marks }, null, 1));
  console.log(id, `${(length(id) / 1000).toFixed(1)}s`, marks.length, "marks", `video offset ${offset} ms`, marks.filter((m) => !m.rect).length ? "(SOME WITHOUT RECT)" : "");
}

/** wait until the page shows `re` in `sel` (live data from testnet) */
const until = (page, sel, re, timeout = 90000) =>
  page.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s)?.textContent ?? ""), [sel, re.source], { timeout });
const loaded = async (page) => {
  await page.waitForFunction(() => !/Reading the DAO/.test(document.querySelector("#p-voters")?.textContent ?? "Reading the DAO"), null, { timeout: 90000 });
  await until(page, "#p-agent", /Taskbond/);
};
const commons = async (page) => {
  await loaded(page);
  await page.waitForFunction(() => !document.querySelector("#card-proposal").hidden && !document.querySelector("#card-tee").hidden && !document.querySelector("#card-credit").hidden && !document.querySelector("#duties").hidden, null, { timeout: 90000 });
  await page.waitForSelector("#cases tbody tr td", { timeout: 90000 });
};

const scenes = {
  s02: () => scene("s02", `${LIVE}/`, async (h) => {
    await loaded(h.page);
    await h.page.waitForTimeout(1500);
    await h.ready();
    await h.at("first"); await h.show(".panel", "Who controls this agent?", "members");
    await h.at("members"); await h.show("#p-voters", "The members vote, one each", "instructions");
    await h.at("instructions"); await h.show({ sel: "#p-terms", up: 1 }, "By-laws v10, locked by hash", "obeys");
    await h.at("obeys"); await h.show("#p-agent", "The agent obeys only v10", length("s02") - 600);
  }),
  s03: () => scene("s03", `${LIVE}/`, async (h) => {
    await loaded(h.page);
    await until(h.page, "#br-rep", /veto|trusted/);
    await h.ready();
    await h.at(300); await h.nav(".hero-cta a[href='#brief']", "Check it yourself");
    await h.at("Collective"); await h.show("#br-own", "Collective ownership", "budget");
    await h.at("budget"); await h.show("#br-budget", "A shared budget", "programmable");
    await h.at("programmable"); await h.show("#br-rewards", "Programmable rewards", "reputation");
    await h.at("reputation"); await h.show("#br-rep", "Access by reputation", "Each");
    await h.at("Each"); await h.show("#counts", "Read from the chain as the page loads", length("s03") - 600);
  }),
  s04: () => scene("s04", `${LIVE}/`, async (h) => {
    await loaded(h.page);
    await h.page.waitForFunction(() => document.querySelector("#ck-bylaws")?.classList.contains("pass"), null, { timeout: 90000 });
    await until(h.page, "#ck-attacks", /of \d+ attacks/);
    await h.page.waitForSelector("#ck-tee-run:not([disabled])", { timeout: 60000 });
    await h.ready();
    await h.at(200); await h.glide("#checks", 20);
    // the TEE check takes ~15 s: click first, read the other checks while it runs
    await h.at("button");
    await h.click("#ck-tee-run", "Verify with my own nonce", h.word("Meanwhile") - h.word("button"), { sel: "#ck-tee-run, #ck-tee-out", all: true, tight: true });
    await h.at("hashes"); await h.show("#ck-bylaws", "By-laws hash = the members' vote", "full");
    await h.at("full"); await h.show("#ck-code", "0 full-access keys: code by vote", "Nineteen");
    await h.at("Nineteen"); await h.show("#ck-attacks", "19 of 19 attacks refused on-chain", "answer");
    await until(h.page, "#ck-tee-run", /again/, 60000).catch(() => console.warn("s04: TEE check slow"));
    await h.at("answer");
    await h.show({ sel: "#ck-tee-out > p:first-child, #ck-tee-out table", all: true, tight: true }, "Intel TDX UpToDate, bound to my nonce", length("s04") - 300);
  }),
  s05: () => scene("s05", `${LIVE}/`, async (h) => {
    await loaded(h.page);
    await h.page.waitForSelector("#receipts tbody tr td", { timeout: 90000 });
    await h.page.evaluate(() => scrollTo(0, 320));
    await h.page.waitForTimeout(1200);
    await h.ready();
    await h.at(200); await h.show("#status > div:nth-child(3)", "Jobs on-chain, with TEE proof", "Taskbond");
    await h.at("Taskbond"); await h.show("#p-agent", "6 Taskbond wins: 95, 95, 95, 95, 85, 85", "Every");
    await h.at("Every"); await h.glide("#receipts", 60);
    await h.show({ sel: "#receipts tbody tr:nth-child(-n+5)", all: true }, "Price, inference, by-laws, TEE proof", length("s05") - 500);
  }),
  s06: () => scene("s06", `${LIVE}/`, async (h) => {
    await commons(h.page);
    await h.page.waitForTimeout(800);
    await h.ready();
    await h.at(200); await h.glide("#card-proposal", 60);
    await h.at("read"); await h.show("#card-proposal", "The agent's own proposal: v9", "approved");
    await h.at("approved"); await h.show({ sel: "#card-proposal", text: "Approved" }, "DAO proposal #139: approved", "wrong");
    await h.at("wrong"); await h.show({ sel: "#card-proposal", text: "Since then" }, "v9 counted a Taskbond job as 0 USDC", "proposes");
    await h.at("proposes"); await h.show({ sel: "#card-proposal", text: "Since then" }, "The members' v10 (#140) restored v8", length("s06") - 400);
  }),
  s07: () => scene("s07", `${LIVE}/`, async (h) => {
    await commons(h.page);
    await h.page.waitForTimeout(500);
    await h.ready();
    await h.at(200); await h.nav(".top nav a[href='#commons']", "Commons");
    await h.at(h.word("dispute", 0, 1200));
    await h.page.evaluate(() => { [...document.querySelectorAll("#cases tbody tr")].find((e) => e.textContent.includes("demo-court-mwfa3tpt")).id = "kop-case10"; });
    await h.glide("#kop-case10", 300); await h.at("dispute");
    await h.show({ sel: "#cases tbody", text: "demo-court-mwfa3tpt", closest: "tr" }, "A jury of three: upheld, refunded", "refunded");
    await h.at("refunded"); await h.glide("#duties", 160);
    await h.show({ sel: "#duties", line: "The agent is a member too" }, "The risk fund, and its halved share", h.word("At", 1));
    await h.at(h.word("At", 1)); await h.show({ sel: "#duties", line: "The agent answers to the court" }, "3 upheld cases: suspended", length("s07") - 500);
  }),
  s08: () => scene("s08", `${LIVE}/`, async (h) => {
    await commons(h.page);
    await h.page.waitForTimeout(500);
    await h.ready();
    await h.at(200); await h.glide("#card-tee", 60);
    await h.at("key"); await h.show("#card-tee", "Shade Agent: key made in a TDX VM", "registry");
    await h.at("registry"); await h.show({ sel: "#card-tee .card-out", text: "#137", up: 1 }, "Approved by the members: #137, #138", "Then");
    await h.at("Then"); await h.show({ sel: "#card-tee .card-out", text: "recorded receipt" }, "A receipt from inside the TEE", length("s08") - 500);
  }),
  s09: () => scene("s09", `${LIVE}/`, async (h) => {
    await commons(h.page);
    await h.page.waitForTimeout(500);
    await h.ready();
    await h.at(200); await h.glide("#card-credit", 60);
    await h.at("loan"); await h.show({ sel: "#card-credit", text: "4% loans" }, "The 4% vote: refused by the contract", "member's");
    await h.at("member's"); await h.show({ sel: "#card-credit", text: "credit score" }, "Credit from a sister co-op's stamp", length("s09") - 1700);
    await h.at(length("s09") - 2600);
    await h.glide("#links a[href='/coops.html']", 500);
    await h.click("#links a[href='/coops.html']", "Every co-op on this code", 1400);
    await h.page.waitForTimeout(800);
  }),
  s09b: () => scene("s09b", `${LIVE}/coops.html`, async (h) => {
    await h.page.waitForSelector("#resolutions tbody tr td", { timeout: 90000 });
    await until(h.page, "#resolutions", /Resolution 3/);
    await h.glide("#network", 20);
    await h.page.waitForTimeout(800);
    await h.ready();
    await h.at("resolution"); await h.show({ sel: "#resolutions tbody tr", all: true }, "Each vote cast by a co-op's own DAO", "including");
    await h.at("including"); await h.show({ sel: "#resolutions tbody tr:nth-child(3)" }, "Resolution 3: agents pass work between co-ops", length("s09b") - 400);
  }),
  s10: () => scene("s10", `${LIVE}/`, async (h) => {
    await loaded(h.page);
    await h.page.waitForSelector("#tiers li", { timeout: 90000 });
    await h.page.waitForSelector("#plans *", { timeout: 90000 });
    await h.page.waitForSelector("#standing li", { timeout: 90000 });
    // the meters show a member with savings and a share (bob); picked before the scene, so the narration's
    // "each member has one vote" lands on the meters with the camera already still (the header click takes ~3 s)
    // the narration reaches "one vote" 2.4 s in, faster than a header click and its scroll: start at the section
    await h.page.selectOption("#member-pick", { index: 2 }).catch(() => {});
    await h.glide("#members", 40);
    await h.ready();
    await h.at(200); await h.show("#meters", "One vote each", "Small");
    await h.at("Small"); await h.glide("#tiers", 140);
    await h.show("#tiers li:nth-child(2)", "Earned trust, 10-minute veto window", "Profit");
    await h.at("Profit"); await h.glide("#shares", 40);
    await h.show("#plans", "Shared by the voted rule", "standing");
    await h.at("standing"); await h.glide("#standing", 120);
    await h.show("#standing", "Pledges kept, jury duty served", length("s10") - 400);
  }),
  s11: () => scene("s11", `${LIVE}/cert.html?who=kop-bob-mw4i3w8f.testnet`, async (h) => {
    await h.page.waitForSelector("#cert-sum tr", { timeout: 90000 });
    await h.page.waitForTimeout(800);
    await h.ready();
    await h.at(300); await h.show("#cert-sum", "A work record, read live", "Type");
    await h.at("Type");
    await h.click("#cert-input", "Type an account", 1200);
    await h.page.keyboard.press("Control+A");
    await h.page.keyboard.type("kop-alice-mw4i3w8f.testnet", { delay: 45 });
    await h.click("#cert-form button, #cert-form [type=submit]", "Show", 1000);
    h.cut();
    await h.page.waitForURL(/alice/);
    await until(h.page, "#cert-who", /kop-alice/, 60000);
    await h.page.waitForSelector("#cert-juries tr td", { timeout: 60000 });
    await h.page.waitForTimeout(400);
    await h.show("#cert-sum", "Alice: pledges kept, jury rulings", "Nobody");
    await h.at("Nobody"); await h.glide("#cert-pledges", 100);
    await h.show({ sel: "#cert-pledges, #cert-juries", all: true }, "Nothing typed by hand", length("s11") - 300);
  }),
  s12: () => scene("s12", `${LOCAL}/`, async (h) => {
    await loaded(h.page);
    await h.page.waitForTimeout(800);
    await h.ready();
    await h.at("Open");
    await h.click("#open-app", "Open the member app", 800); // the page leaves right after the click
    await h.page.waitForURL(/dashboard/);
    await h.page.waitForTimeout(1500);
  }),
  // the app as it stands once loaded (its first read takes a while on a busy RPC)
  s12c: () => scene("s12c", `${LOCAL}/dashboard.html#/agent`, async (h) => {
    // a view reads the chain when first opened: open the agent's first, then go back to the overview
    await until(h.page, "#a-tee .out", /Worker/, 120000);
    await until(h.page, "#a-bylaws .out", /v\d+/, 120000);
    await h.page.click("#side-nav a[href='#/overview']");
    await h.page.waitForSelector("#kpis div", { timeout: 120000 });
    await h.page.waitForTimeout(1500);
    await h.ready();
    await h.at(300); await h.show("#kpis", "The co-op at a glance", "agent's");
    await h.at("agent's");
    await h.click("#side-nav a[href='#/agent']", "The agent", 1300, undefined, false);
    await h.page.waitForTimeout(600);
    await h.show({ sel: "#a-bylaws, #a-tee", all: true }, "By-laws and the Shade Agent", length("s12c") - 300);
  }),
  // contract 0.3.6/0.3.7 in the member app: each view is read once off camera (its first read is slow), then the
  // scene opens on the overview and gets there by a real click in the sidebar
  s12d: () => scene("s12d", `${LIVE}/dashboard.html#/report`, async (h) => {
    await until(h.page, "#r-recovery .out", /SHA-256/, 120000);
    await until(h.page, "#r-court .out", /upheld/, 120000);
    await h.page.click("#side-nav a[href='#/overview']");
    await h.page.waitForSelector("#kpis div", { timeout: 120000 });
    await h.page.waitForTimeout(1000);
    await h.ready();
    await h.at(200); await h.click("#side-nav a[href='#/report']", "Agent report", 1300, undefined, false);
    await h.page.waitForTimeout(500);
    await h.glide("#r-court", 120);
    await h.at("In"); await h.show("#r-court", "Court: 9 of 13 upheld, suspended once, reinstated", h.word("To", 0, 900));
    await h.at(h.word("To", 0, 900)); await h.glide("#r-recovery", 120);
    await h.show("#r-recovery", "Recovery plan approved, pinned by its hash", h.word("restarts", 0, 700));
        await h.at(h.word("restarts", 0, 700));
    await h.show({ sel: "#r-recovery .out", text: "ramp over 30 days", tight: true }, "Its share ramps back up over 30 days", length("s12d") - 300);
  }),
  s12e: () => scene("s12e", `${LIVE}/dashboard.html#/federation`, async (h) => {
    await until(h.page, "#f-accepted .out", /accepted/i, 120000);
    await until(h.page, "#f-loans .out", /Repaid/, 120000);
    await h.page.click("#side-nav a[href='#/overview']");
    await h.page.waitForSelector("#kpis div", { timeout: 120000 });
    await h.page.waitForTimeout(1000);
    await h.ready();
    await h.at(100); await h.click("#side-nav a[href='#/federation']", "Federation", 1100, undefined, false);
    await h.page.waitForTimeout(400);
    await h.glide("#f-referrals", 60);
    await h.show("#f-referrals", "Jobs below its price, passed to a sister co-op", "and");
    await h.at("and"); await h.show("#f-accepted", "Read on the sister's own contract: accepted", h.word("members", 0, 1000));
    await h.at(h.word("members", 0, 1000)); await h.glide("#f-loans", 80);
    await h.show("#f-loans", "Loans to a sister co-op, by vote", "This");
    await h.at("This"); await h.show({ sel: "#f-loans tbody tr:first-child" }, "1.00 lent, 1.00 repaid, 0.05 interest", length("s12e") - 300);
  }),
  s12f: () => scene("s12f", `${LIVE}/dashboard.html#/commons`, async (h) => {
    await until(h.page, "#c-polls .out", /280/, 120000);
    await until(h.page, "#c-cases .out", /Juries are drawn/, 120000);
    await h.page.click("#side-nav a[href='#/overview']");
    await h.page.waitForSelector("#kpis div", { timeout: 120000 });
    await h.page.waitForTimeout(1000);
    await h.ready();
    await h.at(100); await h.click("#side-nav a[href='#/commons']", "Commons", 1000, undefined, false);
    await h.page.waitForTimeout(400);
    await h.show({ sel: "#c-cases .out", text: "Juries are drawn", tight: true }, "Juries: drawn by reputation, square-root weighted", h.word("And", 0, 900));
    await h.at(h.word("And", 0, 900)); await h.glide("#c-polls", 120);
    await h.show("#c-polls", "Technical polls: weighed by reputation (#145)", "In");
    await h.at("In"); await h.show({ sel: "#c-polls tbody tr:nth-child(2)" }, "Poll #0: larger model 280, current 220", length("s12f") - 300);
  }),
  s12b: () => scene("s12b", `${LOCAL}/dashboard.html?as=kop-bob-mw4i3w8f.testnet#/membership`, async (h) => {
    await h.page.waitForSelector("#w-share-amt", { timeout: 150000 });
    const sec = (title) => ({ sel: "#joinapp", section: title });
    await h.page.waitForTimeout(800);
    await h.glide("#joinapp", 20);
    await h.ready();
    await h.at(300); await h.show({ sel: "#joinapp", text: "Signed in as" }, "Previewed as bob (no wallet, nothing signed)", "First");
    await h.at("First"); await h.show("#w-inbox", "Needs you: votes waiting", "Type");
    await h.at("Type"); await h.glide("#w-share-amt", 300);
    await h.click("#w-share-amt", "Propose a profit share", 1200);
    await h.page.keyboard.type("10", { delay: 160 });
    await h.page.waitForTimeout(300);
    await h.show(sec("Members' meeting"), "Each member's part, before the vote", h.word("Below", 0, 600));
    await h.at(h.word("Below", 0, 600)); await h.glide("#joinapp h3:has-text('Tasks with earned trust')", 80); 
    await h.show(sec("Tasks with earned trust"), "Tasks to take", h.word("Then", 0, 600));
    await h.at(h.word("Then", 0, 600)); await h.glide("#joinapp h3:has-text('Pledges and the co-op court')", 80); 
    await h.show(sec("Pledges and the co-op court"), "Pledges to call in", h.word("surety", 0, 1000));
    await h.at(h.word("surety", 0, 1000)); await h.glide("#joinapp h3:has-text('Surety and loans')", 80); 
    await h.show(sec("Surety and loans"), "Surety and loans", "app");
    await h.at("app"); await h.glide("body", 0);
    await h.click(".lang-btn", "Bahasa Indonesia", 2000);
    await h.page.waitForTimeout(2200);
    await h.click(".lang-btn", "Back to English", 1300);
    await h.page.waitForTimeout(1200);
  }),
};

const want = process.argv.slice(2);
for (const [id, run] of Object.entries(scenes)) {
  if (want.length && !want.includes(id)) continue;
  for (let attempt = 1; ; attempt++) {
    try { await run(); break; } catch (e) {
      console.warn(`${id}: attempt ${attempt} failed: ${e.message.split("\n")[0]}`);
      if (attempt >= 3) throw e;
    }
  }
}
await browser.close();
