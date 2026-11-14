// node video/check-marks.mjs [out/koperasi.mp4] [timeline.json] [sNN ...]: one contact sheet per scene, a frame at the
// middle of each highlight mark (after its zoom has settled), into out/marks/<id>.png, to check that every box sits on
// what the narration names. Prints each mark with its time in the video.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = import.meta.dirname;
const [video = "out/koperasi.mp4", tl = "timeline.json", ...want] = process.argv.slice(2);
const timeline = JSON.parse(fs.readFileSync(path.join(ROOT, "src", tl), "utf8"));
const dir = path.join(ROOT, "out/marks");
fs.mkdirSync(dir, { recursive: true });
const f = (ms) => Math.round((ms / 1000) * 30);
// where each scene starts in the joined video: the parts' real lengths (each part's audio pads it a little)
const tag = tl === "timeline.json" ? "part" : "p60";
const probe = (file) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString()) * 30;
let from = 0;
for (const s of timeline) {
  const at = from;
  const part = path.join(ROOT, "out", `${tag}-${s.id}.mp4`);
  from += fs.existsSync(part) ? probe(part) : f(s.durMs);
  if (want.length && !want.includes(s.id)) continue;
  const marks = (s.marks ?? []).filter((m) => m.rect && m.kind !== "term");
  if (!marks.length) continue;
  const shots = marks.map((m, i) => {
    const t = at / 30 + (m.t + Math.min(m.dur / 2, 1400)) / 1000;
    const file = path.join(dir, `${s.id}-${i}.png`);
    // seek near, then decode up to the exact frame (a fast seek alone can return a half-decoded frame)
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-ss", Math.max(0, t - 3).toFixed(2), "-i", path.join(ROOT, video), "-ss", Math.min(t, 3).toFixed(2), "-frames:v", "1", "-vf", "scale=640:-1", file]);
    console.log(`${s.id}#${i} ${t.toFixed(1)}s ${m.kind} "${m.label}"`);
    return file;
  });
  // a sheet of up to 3 frames per row (the frames are read as one image sequence: xstack blended its inputs)
  const cols = Math.min(3, shots.length), rows = Math.ceil(shots.length / cols);
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", path.join(dir, `${s.id}-%d.png`), "-vf", `tile=${cols}x${rows}`, "-frames:v", "1", path.join(dir, `${s.id}.png`)]);
  for (const p of shots) fs.rmSync(p);
}
