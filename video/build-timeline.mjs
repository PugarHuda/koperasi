// node video/build-timeline.mjs: narration + word timings + recorded clips -> src/timeline.json (what Remotion plays).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = import.meta.dirname;
const pub = (p) => path.join(ROOT, "public", p);
const narration = JSON.parse(fs.readFileSync(path.join(ROOT, "narration.json"), "utf8"));
const probe = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString()) * 1000;

const CHAPTERS = { s01: "", s02: "Who controls the agent", s03: "Don't trust us", s04: "Live events", s05: "Members and by-laws",
  s06: "Work and audit", s07: "Profit shares", s08: "Earned trust", s09: "Commons and the co-op court", s10: "Work record",
  s11: "A member's panel", s12: "A real transaction", s13: "npm run verify", s14: "" };

const scenes = narration.map((n) => {
  // the voice's words come without punctuation: take each word's spelling from the narration text, in order
  const words = JSON.parse(fs.readFileSync(pub(`audio/${n.id}.json`), "utf8"));
  const tokens = n.text.split(/\s+/);
  const bare = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  let k = 0;
  for (const w of words) {
    for (let j = k; j < Math.min(k + 3, tokens.length); j++) {
      if (bare(tokens[j]).startsWith(bare(w.w)) && bare(w.w)) { w.w = tokens[j]; k = j + 1; break; }
    }
  }
  const audioMs = probe(pub(`audio/${n.id}.mp3`));
  const s = { id: n.id, kind: n.kind, chapter: CHAPTERS[n.id], words, audio: `audio/${n.id}.mp3`, durMs: Math.max(audioMs, words.at(-1).end) + 900 };
  if (fs.existsSync(pub(`clips/${n.id}.json`))) {
    const meta = JSON.parse(fs.readFileSync(pub(`clips/${n.id}.json`), "utf8"));
    const clipMs = probe(pub(`clips/${n.id}.webm`));
    const last = Math.max(0, ...meta.marks.map((m) => m.t + (m.dur ?? 0)));
    // past the clip's end the last frame holds (Remotion <Freeze>), so the narration is never cut
    s.durMs = Math.max(s.durMs, last + 500);
    Object.assign(s, { clip: `clips/${n.id}.webm`, start: meta.start, clipMs: clipMs - meta.start - 150, marks: meta.marks });
  }
  if (n.id === "s13") s.lines = fs.readFileSync(pub("clips/s13.txt"), "utf8").split(/\r?\n/).filter((l) => l.trim());
  return s;
});
fs.writeFileSync(path.join(ROOT, "src/timeline.json"), JSON.stringify(scenes));
const total = scenes.reduce((a, s) => a + s.durMs, 0);
console.log(scenes.map((s) => `${s.id} ${(s.durMs / 1000).toFixed(1)}s`).join("  "), `\ntotal ${(total / 1000).toFixed(1)}s`);
