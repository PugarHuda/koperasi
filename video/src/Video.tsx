import React from "react";
import { AbsoluteFill, Audio, Freeze, OffthreadVideo, Sequence, interpolate, spring, staticFile, useCurrentFrame, Easing } from "remotion";
import timeline from "./timeline.json";

export const FPS = 30;
const f = (ms: number) => Math.round((ms / 1000) * FPS);
type Rect = { x: number; y: number; width: number; height: number };
type Mark = { t: number; kind: "box" | "zoom" | "term"; rect?: Rect | null; label: string; dur?: number };
type Word = { w: string; start: number; end: number };
type Scene = { id: string; kind: string; chapter: string; words: Word[]; audio: string; durMs: number; clip?: string; start?: number; clipMs?: number; marks?: Mark[]; lines?: string[] };
const scenes = timeline as Scene[];
const froms: number[] = [];
export const totalFrames = scenes.reduce((acc, s) => { froms.push(acc); return acc + f(s.durMs); }, 0);

const BLUE = "#2b5cff";
const GOLD = "#ffd54a";
const SANS = "'Segoe UI', 'Inter', system-ui, sans-serif";
const MONO = "'Cascadia Mono', Consolas, monospace";
const ease = Easing.bezier(0.33, 0, 0.2, 1);

/** 0→1 over the first 600 ms of [t, t+dur], 1→0 over the last 600 ms. */
const envelope = (ms: number, t: number, dur: number, edge = 600) =>
  interpolate(ms, [t, t + edge, t + dur - edge, t + dur], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });

function camera(ms: number, marks: Mark[]) {
  let best = { p: 0, s: 1, tx: 0, ty: 0 };
  for (const m of marks) {
    if (m.kind !== "zoom" || !m.rect) continue;
    const p = envelope(ms, m.t, m.dur ?? 4000, 700);
    if (p <= best.p) continue;
    const r = m.rect;
    const s = Math.min(2.3, (1920 * 0.72) / r.width, (1080 * 0.62) / r.height);
    if (s < 1.3) continue; // nearly full width: a zoom would only crop it; the box alone shows it
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const tx = Math.min(0, Math.max(1920 - 1920 * s, 960 - cx * s));
    const ty = Math.min(0, Math.max(1080 - 1080 * s, 540 - cy * s));
    best = { p, s, tx, ty };
  }
  const { p } = best;
  return { s: 1 + (best.s - 1) * p, tx: best.tx * p, ty: best.ty * p };
}

const Label: React.FC<{ text: string; x: number; y: number; o: number }> = ({ text, x, y, o }) => (
  <div style={{ position: "absolute", left: x, top: y, transform: `translateY(-100%) translateY(${-10 + (1 - o) * 12}px)`, opacity: o,
    background: GOLD, color: "#0b0f24", font: `700 26px ${SANS}`, padding: "8px 16px", borderRadius: 10, whiteSpace: "nowrap",
    boxShadow: "0 8px 24px rgba(0,0,0,.35)" }}>{text}</div>
);

const Overlays: React.FC<{ ms: number; marks: Mark[]; cam: { s: number; tx: number; ty: number } }> = ({ ms, marks, cam }) => (
  <>
    {marks.filter((m) => m.kind !== "term" && m.rect).map((m, i) => {
      const o = envelope(ms, m.t, m.dur ?? 4000, 350);
      if (o <= 0.01) return null;
      const r = m.rect!;
      const pad = 10;
      const x = r.x * cam.s + cam.tx - pad, y = r.y * cam.s + cam.ty - pad;
      const w = r.width * cam.s + pad * 2, h = Math.min(r.height * cam.s + pad * 2, 1080 - Math.max(y, 0) - 20);
      return (
        <React.Fragment key={i}>
          <div style={{ position: "absolute", left: x, top: Math.max(y, 8), width: w, height: h, border: `5px solid ${GOLD}`, borderRadius: 18,
            boxShadow: `0 0 0 9999px rgba(3,6,20,${0.38 * o}), 0 0 40px rgba(255,213,74,.55)`, opacity: o,
            transform: `scale(${1.04 - 0.04 * o})`, transformOrigin: "center" }} />
          <Label text={m.label} x={Math.max(16, Math.min(x, 1920 - 40 - m.label.length * 15))} y={Math.max(y, 70)} o={o} />
        </React.Fragment>
      );
    })}
  </>
);

const TermPanel: React.FC<{ ms: number; marks: Mark[] }> = ({ ms, marks }) => {
  const lines = marks.filter((m) => m.kind === "term" && m.t <= ms);
  if (!lines.length) return null;
  const o = interpolate(ms, [lines[0].t, lines[0].t + 300], [0, 1], { extrapolateRight: "clamp" });
  // a scrim while the transaction runs and the page reloads (hides the reload flash), lifted for the "after" zoom
  const after = marks.find((m) => m.kind === "zoom" && m.t > lines[0].t);
  const scrim = after ? interpolate(ms, [after.t - 400, after.t], [0.82, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) * o : 0.82 * o;
  return (
    <>
    <div style={{ position: "absolute", inset: 0, background: `rgba(5,8,22,${scrim})` }} />
    <div style={{ position: "absolute", left: 40, bottom: 170, width: 1180, background: "rgba(8,10,24,.94)", borderRadius: 16, opacity: o,
      border: "1px solid rgba(255,255,255,.15)", boxShadow: "0 20px 60px rgba(0,0,0,.5)", padding: "18px 24px", font: `24px ${MONO}`, color: "#d7e0ff" }}>
      <div style={{ font: `600 18px ${SANS}`, color: "#8fa2ff", marginBottom: 8 }}>Terminal: a real testnet transaction</div>
      {lines.map((l, i) => (
        <div key={i} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: l.label.startsWith("$") ? "#ffd54a" : /kept/.test(l.label) ? "#7CF29A" : "#d7e0ff" }}>
          {l.label.replace("https://testnet.nearblocks.io/txns/", "tx ")}
        </div>
      ))}
    </div>
    </>
  );
};

const PageScene: React.FC<{ s: Scene }> = ({ s }) => {
  const frame = useCurrentFrame();
  const ms = (frame / FPS) * 1000;
  const marks = s.marks ?? [];
  const cam = camera(ms, marks);
  const video = <OffthreadVideo src={staticFile(s.clip!)} startFrom={f(s.start!)} muted style={{ width: 1920, height: 1080 }} />;
  return (
    <AbsoluteFill style={{ background: "#050816", overflow: "hidden" }}>
      <div style={{ position: "absolute", width: 1920, height: 1080, transformOrigin: "0 0", transform: `translate(${cam.tx}px, ${cam.ty}px) scale(${cam.s})` }}>
        {ms > s.clipMs! ? <Freeze frame={f(s.clipMs!)}>{video}</Freeze> : video}
      </div>
      <Overlays ms={ms} marks={marks} cam={cam} />
      <TermPanel ms={ms} marks={marks} />
    </AbsoluteFill>
  );
};

const Terminal: React.FC<{ s: Scene }> = ({ s }) => {
  const frame = useCurrentFrame();
  const ms = (frame / FPS) * 1000;
  const lines = s.lines ?? [];
  const shown = Math.min(lines.length, Math.floor(interpolate(ms, [400, s.durMs - 3500], [0, lines.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })));
  const visible = lines.slice(Math.max(0, shown - 24), shown);
  const done = shown >= lines.length;
  const z = done ? interpolate(ms, [s.durMs - 3500, s.durMs - 2600], [1, 1.12], { extrapolateRight: "clamp", easing: ease }) : 1;
  const color = (l: string) => (l.startsWith("PASS") ? "#7CF29A" : l.startsWith("FAIL") ? "#ff6b6b" : l.startsWith("INFO") ? "#8fb4ff" : /checks out/.test(l) ? "#7CF29A" : "#c9d3f5");
  return (
    <AbsoluteFill style={{ background: "radial-gradient(circle at 30% 20%, #10205e, #050816 70%)", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: 1680, height: 860, background: "rgba(6,8,20,.96)", borderRadius: 22, border: "1px solid rgba(255,255,255,.14)",
        boxShadow: "0 30px 90px rgba(0,0,0,.6)", padding: "26px 34px", font: `21px ${MONO}`, overflow: "hidden", transform: `scale(${z})` }}>
        <div style={{ color: GOLD, marginBottom: 12 }}>$ npm run verify   <span style={{ color: "#8fa2ff" }}># read-only: no keys, no transactions</span></div>
        {visible.map((l, i) => (
          <div key={i} style={{ color: color(l), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", lineHeight: 1.45,
            fontWeight: /checks out/.test(l) ? 700 : 400, fontSize: /checks out/.test(l) ? 30 : 21 }}>{l}</div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

const PIECES = ["Sputnik DAO v2", "Trezu templates", "Global contracts", "NEP-141 USDC", "NEP-297 events", "NEP-330 builds", "NEP-366 gasless",
  "NEP-413 signed vouches", "Function-call keys", "Staking pools", "Chain Signatures", "NEAR AI Cloud (TEE)", "NEAR AI Agent Market", "NEAR Connect"];

const Title: React.FC<{ s: Scene }> = ({ s }) => {
  const frame = useCurrentFrame();
  const ms = (frame / FPS) * 1000;
  const intro = s.id === "s01";
  const pop = spring({ frame, fps: FPS, config: { damping: 14 } });
  const bg = interpolate(frame, [0, f(s.durMs)], [1, 1.08]);
  return (
    <AbsoluteFill style={{ background: "#050816", overflow: "hidden", fontFamily: SANS, color: "white" }}>
      <AbsoluteFill style={{ background: `radial-gradient(circle at 70% 40%, ${BLUE}66, transparent 55%), radial-gradient(circle at 20% 80%, #0b1c7a, transparent 60%)`, transform: `scale(${bg})` }} />
      <AbsoluteFill style={{ padding: "120px 140px", justifyContent: "center" }}>
        <div style={{ font: `900 150px ${SANS}`, letterSpacing: 6, transform: `translateY(${(1 - pop) * 40}px)`, opacity: pop }}>KOPERASI</div>
        {intro ? (
          <>
            <div style={{ font: `600 54px ${SANS}`, marginTop: 10, opacity: interpolate(ms, [700, 1300], [0, 1], { extrapolateRight: "clamp" }) }}>
              Co-own an AI agent. <span style={{ color: "#8fb4ff" }}>One member, one vote.</span>
            </div>
            <div style={{ font: `400 34px ${SANS}`, marginTop: 34, color: "#c9d3f5", opacity: interpolate(ms, [7000, 7800], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>
              A member-owned AI agent co-op on NEAR · NEAR HACKATHON · Social Money
            </div>
          </>
        ) : (
          <>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginTop: 40, maxWidth: 1500 }}>
              {PIECES.map((p, i) => {
                const o = spring({ frame: frame - f(400 + i * 520), fps: FPS, config: { damping: 15 } });
                return <div key={p} style={{ font: `600 32px ${SANS}`, padding: "12px 24px", borderRadius: 999, background: "rgba(43,92,255,.22)",
                  border: "1px solid rgba(143,180,255,.5)", opacity: o, transform: `scale(${0.8 + 0.2 * o})` }}>{p}</div>;
              })}
            </div>
            <div style={{ font: `500 36px ${SANS}`, marginTop: 56, color: "#c9d3f5", opacity: interpolate(ms, [s.durMs - 6500, s.durMs - 5500], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>
              koperasi-kohl.vercel.app · github.com/PugarHuda/koperasi · <span style={{ color: GOLD }}>npm run verify</span>
            </div>
          </>
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** Subtitles from the voice's own word timings: short lines, the spoken word lit. */
const Subtitles: React.FC<{ words: Word[] }> = ({ words }) => {
  const frame = useCurrentFrame();
  const ms = (frame / FPS) * 1000;
  const chunks: Word[][] = [];
  for (const w of words) {
    const cur = chunks.at(-1);
    const prev = cur?.at(-1);
    const stop = prev && /[.,:;?!]$/.test(prev.w) && cur.length >= 3;
    if (!cur || cur.length >= 9 || stop || (prev && w.start - prev.end > 320 && cur.length >= 3)) chunks.push([w]);
    else cur.push(w);
  }
  const i = chunks.findIndex((c, k) => ms >= c[0].start - 120 && (k === chunks.length - 1 ? ms <= c.at(-1)!.end + 900 : ms < chunks[k + 1][0].start - 120));
  if (i < 0) return null;
  return (
    <div style={{ position: "absolute", bottom: 56, left: 0, right: 0, display: "flex", justifyContent: "center" }}>
      <div style={{ background: "rgba(5,8,22,.82)", borderRadius: 14, padding: "12px 26px", font: `600 42px ${SANS}`, maxWidth: 1600, textAlign: "center",
        boxShadow: "0 10px 30px rgba(0,0,0,.4)" }}>
        {chunks[i].map((w, k) => (
          <span key={k} style={{ color: ms >= w.start ? "#ffffff" : "rgba(255,255,255,.5)" }}>{w.w}{k < chunks[i].length - 1 ? " " : ""}</span>
        ))}
      </div>
    </div>
  );
};

const Chapter: React.FC<{ s: Scene; n: number }> = ({ s, n }) => {
  const frame = useCurrentFrame();
  if (!s.chapter) return null;
  const o = interpolate(frame, [0, 10, f(s.durMs) - 10, f(s.durMs)], [0, 1, 1, 0], { extrapolateRight: "clamp" });
  return (
    <div style={{ position: "absolute", top: 28, left: 32, opacity: o, display: "flex", gap: 12, alignItems: "center", font: `700 24px ${SANS}`,
      background: "rgba(5,8,22,.85)", color: "white", padding: "10px 18px", borderRadius: 12, border: `1px solid ${BLUE}` }}>
      <span style={{ color: GOLD }}>{String(n).padStart(2, "0")}</span>{s.chapter}
    </div>
  );
};

const Fade: React.FC<{ s: Scene; children: React.ReactNode }> = ({ s, children }) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [0, 8, f(s.durMs) - 8, f(s.durMs)], [0, 1, 1, 0], { extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
};

export const Video: React.FC = () => (
  <AbsoluteFill style={{ background: "#050816" }}>
    {scenes.map((s, i) => (
      <Sequence key={s.id} from={froms[i]} durationInFrames={f(s.durMs)}>
        <Audio src={staticFile(s.audio)} />
        <Fade s={s}>
          {s.kind === "title" ? <Title s={s} /> : s.kind === "terminal" ? <Terminal s={s} /> : <PageScene s={s} />}
        </Fade>
        <Chapter s={s} n={i} />
        <Subtitles words={s.words} />
      </Sequence>
    ))}
  </AbsoluteFill>
);
