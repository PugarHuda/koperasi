// node video/render-parts.mjs [chrome-headless-shell path] [Koperasi60]: renders the video one scene at a time (a long single render
// fails on a nearly full disk: Chrome starts refusing the video frames), then joins the parts with ffmpeg.
// Parts already rendered are kept, so a failed run resumes where it stopped.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = import.meta.dirname;
const out = (p) => path.join(ROOT, "out", p);
const browser = process.argv[2];
const comp = process.argv[3] ?? "Koperasi";
const short = comp === "Koperasi60";
const timeline = JSON.parse(fs.readFileSync(path.join(ROOT, short ? "src/timeline60.json" : "src/timeline.json"), "utf8"));
const tag = short ? "p60" : "part";
const f = (ms) => Math.round((ms / 1000) * 30);
let from = 0;
const parts = [];
for (const s of timeline) {
  const to = from + f(s.durMs) - 1;
  const file = out(`${tag}-${s.id}.mp4`);
  parts.push(file);
  // relative to video/: the repo path has spaces, and npx on Windows goes through a shell
  const rel = `out/${tag}-${s.id}.mp4`;
  if (!fs.existsSync(file)) {
    console.log(`${s.id}: frames ${from}-${to}`);
    execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["remotion", "render", "src/index.ts", comp, rel, "--codec", "h264", "--crf", "20",
      "--concurrency", "3", "--timeout", "120000", `--frames=${from}-${to}`, ...(browser ? [`--browser-executable=${browser}`] : [])], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], shell: true });
  }
  from = to + 1;
}
fs.writeFileSync(out(`${tag}s.txt`), parts.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n"));
// video re-encoded once (a stream-copied join seeks badly in some players); audio re-encoded so the joins have no gaps
execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", out(`${tag}s.txt`), "-c:v", "libx264", "-crf", "18", "-preset", "fast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", out(short ? "koperasi-60.mp4" : "koperasi.mp4")]);
console.log(short ? "out/koperasi-60.mp4" : "out/koperasi.mp4");
