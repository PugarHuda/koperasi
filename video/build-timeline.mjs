// node video/build-timeline.mjs [narration60.json timeline60.json]: narration + word timings + recorded clips ->
// src/timeline.json (what Remotion plays). A scene of the 60-second cut names a recorded scene (`clip`) and where in it
// to begin (`from`, ms, or `fromWord`: a word of that scene's narration); its marks shift with it.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = import.meta.dirname;
const [narrFile = "narration.json", outFile = "timeline.json"] = process.argv.slice(2);
const short = outFile !== "timeline.json";
const pub = (p) => path.join(ROOT, "public", p);
const narration = JSON.parse(fs.readFileSync(path.join(ROOT, narrFile), "utf8"));
const probe = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString()) * 1000;
const bare = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, "");

const CHAPTERS = { s02: "Who controls the agent", s03: "The Social Money brief", s04: "Don't trust us", s05: "The agent's work",
  s06: "The agent proposes, the members decide", s07: "It pays for its own mistakes", s08: "Shade Agent", s09: "A federation of co-ops",
  s09b: "A federation of co-ops", s10: "One member, one vote", s11: "Work record", s12: "The member app", s12b: "The member app", s12c: "The member app", s13: "Verify in one command" };

let n = 0, lastChapter = "";
const scenes = narration.map((nar, i) => {
  // the voice's words come without punctuation: take each word's spelling from the narration text, in order
  const words = JSON.parse(fs.readFileSync(pub(`audio/${nar.id}.json`), "utf8"));
  const tokens = nar.text.split(/\s+/);
  let k = 0;
  for (const w of words) {
    for (let j = k; j < Math.min(k + 3, tokens.length); j++) {
      if (bare(tokens[j]).startsWith(bare(w.w)) && bare(w.w)) { w.w = tokens[j]; k = j + 1; break; }
    }
  }
  const src = nar.clip ?? nar.id;
  const chapter = short ? "" : CHAPTERS[nar.id] ?? "";
  if (chapter && chapter !== lastChapter) n++;
  lastChapter = chapter;
  const audioMs = probe(pub(`audio/${nar.id}.mp3`));
  const pad = short ? 500 : 700;
  const s = { id: nar.id, kind: nar.kind, chapter, n, intro: i === 0 && nar.kind === "title", words, audio: `audio/${nar.id}.mp3`,
    durMs: Math.max(audioMs, words.at(-1).end) + pad };
  if (nar.kind === "title") s.durMs = Math.max(s.durMs, short ? 3000 : 6000);
  if (nar.kind === "page") {
    const meta = JSON.parse(fs.readFileSync(pub(`clips/${src}.json`), "utf8"));
    let from = nar.from ?? 0;
    if (nar.fromWord) {
      const w = JSON.parse(fs.readFileSync(pub(`audio/${src}.json`), "utf8")).find((x) => bare(x.w).startsWith(bare(nar.fromWord)));
      from = Math.max(0, w.start - 600);
    }
    const clipMs = probe(pub(`clips/${src}.mp4`));
    const shift = (m) => ({ ...m, t: m.t - from, ...(m.click !== undefined ? { click: m.click - from } : {}) });
    // a mark the recorder continued at a new place (the page moved its target) is seen ~0.6 s late: start it earlier
    const early = meta.marks.map((m, k, all) => (m.cont ? { ...m, t: m.t - 600, dur: m.dur + 600 }
      : all[k + 1]?.cont ? { ...m, dur: Math.max(300, m.dur - 600) } : m));
    let marks = early.map(shift);
    if (short) {
      // cut marks to the scene: those still on screen, ending by the scene's end
      marks = marks.filter((m) => m.t + (m.dur ?? 0) > 300 && m.t < s.durMs - 800)
        .map((m) => (m.t < 0 ? { ...m, dur: m.dur + m.t, t: 0 } : m))
        .map((m) => ({ ...m, dur: Math.min(m.dur, s.durMs - 300 - m.t) }));
    } else {
      const last = Math.max(0, ...marks.map((m) => m.t + (m.dur ?? 0)));
      // past the clip's end the last frame holds (Remotion <Freeze>), so the narration is never cut
      s.durMs = Math.max(s.durMs, last + 500);
    }
    Object.assign(s, { clip: `clips/${src}.mp4`, start: meta.start + from, clipMs: clipMs - meta.start - from - 150, marks });
  }
  if (nar.kind === "terminal") {
    s.lines = fs.readFileSync(pub("clips/s13.txt"), "utf8").split(/\r?\n/).filter((l) => l.trim());
    s.pass = fs.readFileSync(pub("clips/s13-full.txt"), "utf8").split(/\r?\n/).filter((l) => l.startsWith("PASS")).length;
    s.durMs = Math.max(s.durMs, short ? 4500 : 9000);
  }
  return s;
});
fs.writeFileSync(path.join(ROOT, "src", outFile), JSON.stringify(scenes));
const total = scenes.reduce((a, s) => a + s.durMs, 0);
console.log(scenes.map((s) => `${s.id} ${(s.durMs / 1000).toFixed(1)}s`).join("  "), `\ntotal ${(total / 1000).toFixed(1)}s`);
