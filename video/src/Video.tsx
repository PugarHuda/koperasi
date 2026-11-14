import React from "react";
import { AbsoluteFill, Audio, Freeze, OffthreadVideo, Sequence, interpolate, spring, staticFile, useCurrentFrame, Easing } from "remotion";
import timeline from "./timeline.json";
import timeline60 from "./timeline60.json";

export const FPS = 30;
const f = (ms: number) => Math.round((ms / 1000) * FPS);
type Rect = { x: number; y: number; width: number; height: number };
type Mark = { t: number; kind: "box" | "zoom" | "click" | "term"; rect?: Rect | null; label: string; dur?: number; click?: number; x?: number; y?: number; cont?: boolean; zoom?: boolean };
type Word = { w: string; start: number; end: number };
type Scene = { id: string; kind: string; chapter: string; n?: number; words: Word[]; audio: string; durMs: number; clip?: string; start?: number;
  clipMs?: number; marks?: Mark[]; lines?: string[]; pass?: number; intro?: boolean };
export const FULL = timeline as Scene[];
export const SHORT = timeline60 as Scene[];
export const framesOf = (scenes: Scene[]) => scenes.reduce((acc, s) => acc + f(s.durMs), 0);

const BLUE = "#2b5cff";
const GOLD = "#ffd54a";
const SANS = "'Segoe UI', 'Inter', system-ui, sans-serif";
const MONO = "'Cascadia Mono', Consolas, monospace";
const ease = Easing.bezier(0.33, 0, 0.2, 1);

/** 0→1 over the first `edge` ms of [t, t+dur], 1→0 over the last `edge` ms. */
const envelope = (ms: number, t: number, dur: number, edge = 600) => {
  const e = Math.min(edge, dur / 2 - 1);
  return interpolate(ms, [t, t + e, t + dur - e, t + dur], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
};

// the frame above the subtitles, where a zoomed target is centred
const VIEW_H = 1080 - 170;
/** Where the camera looks for one mark: the rect with some padding, as large as fits above the subtitles (at most 2x). */
function target(r: Rect) {
  const pad = 36;
  const s = Math.min(2, (1920 * 0.9) / (r.width + 2 * pad), (VIEW_H * 0.92) / (r.height + 2 * pad));
  if (s < 1.12) return { s: 1, tx: 0, ty: 0 }; // nearly full size already: the box alone shows it
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  const tx = Math.min(0, Math.max(1920 - 1920 * s, 960 - cx * s));
  const ty = Math.min(0, Math.max(1080 - 1080 * s, VIEW_H / 2 - cy * s));
  return { s, tx, ty };
}
/** Each mark's [start, end] for the camera: when the next mark follows within 0.5 s, this one fades out while that one
 * fades in, so the camera pans straight from one to the next instead of zooming out and in again. */
function spans(marks: Mark[]) {
  const ms = marks.filter((m) => m.kind !== "term" && m.rect && m.zoom !== false);
  return ms.map((m, i) => {
    const end = m.t + (m.dur ?? 4000);
    const next = ms[i + 1];
    return { m, start: m.t, end: next && next.t - end < 500 && next.t > m.t ? Math.max(end, next.t + 650) : end };
  });
}
/** A weighted blend of every active mark's view (weights ease in and out), so the camera never jumps. */
function camera(ms: number, marks: Mark[]) {
  let W = 0, s = 0, tx = 0, ty = 0;
  for (const { m, start, end } of spans(marks)) {
    const p = envelope(ms, start, end - start, 650);
    if (p <= 0) continue;
    const c = target(m.rect!);
    W += p; s += p * c.s; tx += p * c.tx; ty += p * c.ty;
  }
  if (W > 1) return { s: s / W, tx: tx / W, ty: ty / W };
  return { s: 1 - W + s, tx, ty };
}

const Label: React.FC<{ text: string; x: number; y: number; o: number }> = ({ text, x, y, o }) => (
  <div style={{ position: "absolute", left: x, top: y, transform: `translateY(-100%) translateY(${-10 + (1 - o) * 12}px)`, opacity: o,
    background: GOLD, color: "#0b0f24", font: `700 26px ${SANS}`, padding: "8px 16px", borderRadius: 10, whiteSpace: "nowrap",
    boxShadow: "0 8px 24px rgba(0,0,0,.35)" }}>{text}</div>
);

const Overlays: React.FC<{ ms: number; marks: Mark[]; cam: { s: number; tx: number; ty: number } }> = ({ ms, marks, cam }) => (
  <>
    {marks.filter((m) => m.kind !== "term" && m.rect).map((m, i, all) => {
      // a mark continued at a new place (the page moved its target) keeps the box on, without fading out and in
      const end = m.t + (m.dur ?? 4000);
      const next = all[i + 1];
      const fin = m.cont ? 1 : interpolate(ms, [m.t, m.t + 350], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
      const fout = next?.cont && next.t - end < 100 ? (ms < end ? 1 : 0) : interpolate(ms, [end - 350, end], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
      const o = ms < m.t || ms > end ? 0 : Math.min(fin, fout);
      if (o <= 0.01) return null;
      const r = m.rect!;
      const pad = 10;
      const x = Math.max(4, r.x * cam.s + cam.tx - pad), y = Math.max(4, r.y * cam.s + cam.ty - pad);
      const x2 = Math.min(1916, (r.x + r.width) * cam.s + cam.tx + pad), y2 = Math.min(VIEW_H + 40, (r.y + r.height) * cam.s + cam.ty + pad);
      const lw = m.label.length * 14 + 40;
      // the label sits above the box; when the box starts at the top of the frame, below it (or inside its top edge if tall)
      const ly = y > 70 ? y : y2 + 58 < VIEW_H ? y2 + 58 : y + 64;
      return (
        <React.Fragment key={i}>
          <div style={{ position: "absolute", left: x, top: y, width: x2 - x, height: y2 - y, border: `4px solid ${GOLD}`, borderRadius: 16,
            boxShadow: `0 0 0 9999px rgba(3,6,20,${0.3 * o}), 0 0 36px rgba(255,213,74,.5)`, opacity: o,
            transform: `scale(${1.03 - 0.03 * o})`, transformOrigin: "center" }} />
          <Label text={m.label} x={Math.max(16, Math.min(x, 1920 - 24 - lw))} y={ly} o={o} />
        </React.Fragment>
      );
    })}
    {marks.filter((m) => m.kind === "click" && m.click !== undefined && m.x !== undefined).map((m, i) => {
      const p = interpolate(ms, [m.click!, m.click! + 450], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
      if (p <= 0 || p >= 1) return null;
      const cx = m.x! * cam.s + cam.tx, cy = m.y! * cam.s + cam.ty, d = 20 + 70 * p;
      return <div key={`c${i}`} style={{ position: "absolute", left: cx - d / 2, top: cy - d / 2, width: d, height: d, borderRadius: "50%",
        border: `4px solid ${GOLD}`, opacity: 1 - p }} />;
    })}
  </>
);

/** A soft click on every real click of the recording. */
const Clicks: React.FC<{ marks: Mark[] }> = ({ marks }) => (
  <>
    {marks.filter((m) => m.kind === "click" && m.click !== undefined && m.click >= 0).map((m, i) => (
      <Sequence key={i} from={f(m.click!)} durationInFrames={10}>
        <Audio src={staticFile("sfx/click.wav")} volume={0.4} />
      </Sequence>
    ))}
  </>
);

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
      <Clicks marks={marks} />
    </AbsoluteFill>
  );
};

const Terminal: React.FC<{ s: Scene }> = ({ s }) => {
  const frame = useCurrentFrame();
  const ms = (frame / FPS) * 1000;
  const lines = s.lines ?? [];
  const shown = Math.min(lines.length, Math.floor(interpolate(ms, [400, Math.max(1500, s.durMs - 4000)], [0, lines.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })));
  const visible = lines.slice(Math.max(0, shown - 20), shown);
  const done = shown >= lines.length;
  const color = (l: string) => (l.startsWith("PASS") ? "#7CF29A" : l.startsWith("FAIL") ? "#ff6b6b" : l.startsWith("INFO") ? "#8fb4ff" : /checks out/.test(l) ? "#7CF29A" : "#c9d3f5");
  return (
    <AbsoluteFill style={{ background: "radial-gradient(circle at 30% 20%, #10205e, #050816 70%)", alignItems: "center", justifyContent: "flex-start", paddingTop: 60 }}>
      <div style={{ width: 1680, height: 820, background: "rgba(6,8,20,.96)", borderRadius: 22, border: "1px solid rgba(255,255,255,.14)",
        boxShadow: "0 30px 90px rgba(0,0,0,.6)", padding: "26px 34px", font: `21px ${MONO}`, overflow: "hidden" }}>
        <div style={{ color: GOLD, marginBottom: 12, fontSize: 24 }}>$ curl -sO https://koperasi-kohl.vercel.app/verify.mjs && node verify.mjs</div>
        {visible.map((l, i) => (
          <div key={i} style={{ color: color(l), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", lineHeight: 1.45,
            fontWeight: /checks out/.test(l) ? 700 : 400, fontSize: /checks out/.test(l) ? 30 : 21 }}>{l}</div>
        ))}
        {done && s.pass ? <div style={{ marginTop: 16, color: "#0b0f24", background: "#7CF29A", display: "inline-block", padding: "8px 18px", borderRadius: 10,
          font: `700 30px ${SANS}`, opacity: interpolate(ms, [s.durMs - 4000, s.durMs - 3600], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>
          {s.pass} claims PASS · 0 FAIL · read-only, no keys</div> : null}
      </div>
    </AbsoluteFill>
  );
};

const PIECES = ["Sputnik DAO v2", "Trezu templates", "Global contracts", "NEP-141 USDC", "NEP-297 events", "NEP-366 gasless", "NEP-413 signed vouches",
  "Chain Signatures", "NEAR AI Cloud (TEE)", "Shade Agent (TDX)", "OutLayer enclave", "Agent Market"];

const Title: React.FC<{ s: Scene }> = ({ s }) => {
  const frame = useCurrentFrame();
  const ms = (frame / FPS) * 1000;
  const intro = !!s.intro;
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
            <div style={{ font: `400 34px ${SANS}`, marginTop: 34, color: "#c9d3f5", opacity: interpolate(ms, [Math.min(6000, s.durMs - 2500), Math.min(6800, s.durMs - 1700)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>
              A member-owned AI agent co-op on NEAR testnet · koperasi-kohl.vercel.app
            </div>
          </>
        ) : (
          <>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginTop: 40, maxWidth: 1500 }}>
              {PIECES.map((p, i) => {
                const o = spring({ frame: frame - f(300 + i * 180), fps: FPS, config: { damping: 15 } });
                return <div key={p} style={{ font: `600 32px ${SANS}`, padding: "12px 24px", borderRadius: 999, background: "rgba(43,92,255,.22)",
                  border: "1px solid rgba(143,180,255,.5)", opacity: o, transform: `scale(${0.8 + 0.2 * o})` }}>{p}</div>;
              })}
            </div>
            <div style={{ font: `500 36px ${SANS}`, marginTop: 56, color: "#c9d3f5", opacity: interpolate(ms, [2500, 3300], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>
              koperasi-kohl.vercel.app · github.com/PugarHuda/koperasi · <span style={{ color: GOLD }}>node verify.mjs</span>
            </div>
          </>
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** Subtitles from the voice's own word timings: short chunks (at most two lines), the spoken word lit. */
const Subtitles: React.FC<{ words: Word[] }> = ({ words }) => {
  const frame = useCurrentFrame();
  const ms = (frame / FPS) * 1000;
  const chunks: Word[][] = [];
  for (const w of words) {
    const cur = chunks.at(-1);
    const prev = cur?.at(-1);
    const stop = prev && /[.,:;?!]$/.test(prev.w) && cur.length >= 3;
    if (!cur || cur.length >= 10 || stop || (prev && w.start - prev.end > 320 && cur.length >= 3)) chunks.push([w]);
    else cur.push(w);
  }
  const i = chunks.findIndex((c, k) => ms >= c[0].start - 120 && (k === chunks.length - 1 ? ms <= c.at(-1)!.end + 900 : ms < chunks[k + 1][0].start - 120));
  if (i < 0) return null;
  return (
    <div style={{ position: "absolute", bottom: 34, left: 0, right: 0, display: "flex", justifyContent: "center" }}>
      <div style={{ background: "rgba(0,0,0,.86)", borderRadius: 14, padding: "10px 28px", font: `600 42px/1.25 ${SANS}`, maxWidth: 1640, textAlign: "center",
        boxShadow: "0 10px 30px rgba(0,0,0,.4)", textShadow: "0 2px 4px rgba(0,0,0,.6)" }}>
        {chunks[i].map((w, k) => (
          <span key={k} style={{ color: ms >= w.start ? "#ffffff" : "rgba(255,255,255,.62)" }}>{w.w}{k < chunks[i].length - 1 ? " " : ""}</span>
        ))}
      </div>
    </div>
  );
};

const Chapter: React.FC<{ s: Scene }> = ({ s }) => {
  const frame = useCurrentFrame();
  if (!s.chapter) return null;
  const o = interpolate(frame, [0, 10, f(s.durMs) - 10, f(s.durMs)], [0, 1, 1, 0], { extrapolateRight: "clamp" });
  return (
    <div style={{ position: "absolute", top: 28, right: 32, opacity: o, display: "flex", gap: 12, alignItems: "center", font: `700 24px ${SANS}`,
      background: "rgba(5,8,22,.85)", color: "white", padding: "10px 18px", borderRadius: 12, border: `1px solid ${BLUE}` }}>
      <span style={{ color: GOLD }}>{String(s.n ?? 0).padStart(2, "0")}</span>{s.chapter}
    </div>
  );
};

const Fade: React.FC<{ s: Scene; children: React.ReactNode }> = ({ s, children }) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [0, 8, f(s.durMs) - 8, f(s.durMs)], [0, 1, 1, 0], { extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
};

const Video: React.FC<{ scenes: Scene[] }> = ({ scenes }) => {
  let from = 0;
  return (
    <AbsoluteFill style={{ background: "#050816" }}>
      {scenes.map((s) => {
        const at = from;
        from += f(s.durMs);
        return (
          <Sequence key={s.id} from={at} durationInFrames={f(s.durMs)}>
            <Audio src={staticFile(s.audio)} />
            <Fade s={s}>
              {s.kind === "title" ? <Title s={s} /> : s.kind === "terminal" ? <Terminal s={s} /> : <PageScene s={s} />}
            </Fade>
            <Chapter s={s} />
            <Subtitles words={s.words} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
export const FullVideo: React.FC = () => <Video scenes={FULL} />;
export const ShortVideo: React.FC = () => <Video scenes={SHORT} />;
