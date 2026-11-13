// The 30-second opening: what no other entry has, each line with the live page as proof (video/shots30.mjs).
import React from "react";
import { AbsoluteFill, Img, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig, Easing } from "remotion";

export const INTRO_FPS = 30;
const SCENE = Math.round((30 * INTRO_FPS) / 7); // seven cards in 30 seconds
const BLUE = "#2b5cff";
const GOLD = "#ffd54a";
const INK = "#030a2a";
const SANS = "'Segoe UI', 'Inter', system-ui, sans-serif";
const MONO = "'Cascadia Mono', Consolas, monospace";

type Card = { kicker: string; title: string; sub: string; shot?: string; shot2?: string; code?: string };
const CARDS: Card[] = [
  { kicker: "Koperasi · NEAR testnet", title: "A co-op owns this AI agent.", sub: "One member, one vote. The agent's prompt, model and wallet answer to the members' votes.", shot: "hero.png" },
  { kicker: "It proposes. The members decide.", title: "The agent asked for a higher price.", sub: "It read its own record; the members passed it. Its next look, in a TEE: too few jobs to judge, so it proposed nothing.", shot: "duties.png" },
  { kicker: "It pays for its own mistakes", title: "A jury upheld a case. The buyer was refunded at once.", sub: "From the agent's own savings: 10% of its earnings and a surplus share that halves when it loses in court.", shot: "risk.png" },
  { kicker: "A federation of co-ops", title: "The members voted 4% loans. The code said no.", sub: "The federation's resolution set 2% in every member co-op's contract. Late loans are told to the sister co-ops.", shot: "federation.png" },
  { kicker: "Agents hire agents", title: "A job below its price went to a sister co-op.", sub: "The agent decided from the chain; the other co-op's agent did it, and its members paid the 30% the federation set.", code: "receipt proof, koperasi-mw80aczw\n\n\"referred_by\": \"koperasi-mw4i2iwk.testnet\"" },
  { kicker: "Work judged by someone else", title: "95/100, three times, on another team's market.", sub: "Taskbond's guard approved the voted prompt, its reviewer AI scored the work, its escrow paid.", shot: "taskbond.png" },
  { kicker: "Don't trust us", title: "Check every claim. No clone.", sub: "77 claims, read from NEAR, Ethereum, Base and Arbitrum testnets. 19 attacks on the live co-op, all refused.", code: "curl -sO https://koperasi-kohl.vercel.app/verify.mjs && node verify.mjs\n\nevery claim checks out." },
];

const Scene: React.FC<{ c: Card }> = ({ c }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const inn = spring({ frame, fps, config: { damping: 200 } });
  const out = interpolate(frame, [SCENE - 10, SCENE], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const zoom = interpolate(frame, [0, SCENE], [1, 1.06], { easing: Easing.out(Easing.quad) });
  return (
    <AbsoluteFill style={{ background: INK, opacity: out, fontFamily: SANS, color: "#fff" }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: 1920, height: 10, background: BLUE }} />
      <div style={{ position: "absolute", left: 110, top: 150, width: 760, transform: `translateY(${(1 - inn) * 40}px)`, opacity: inn }}>
        <div style={{ color: GOLD, font: `700 30px ${SANS}`, letterSpacing: 2, textTransform: "uppercase" }}>{c.kicker}</div>
        <div style={{ font: `800 78px/1.05 ${SANS}`, marginTop: 26 }}>{c.title}</div>
        <div style={{ font: `400 36px/1.35 ${SANS}`, marginTop: 34, color: "#c9d4ff" }}>{c.sub}</div>
      </div>
      <div style={{ position: "absolute", left: 960, top: 120, width: 860, height: 840, display: "flex", flexDirection: "column", gap: 24,
        justifyContent: "center", alignItems: "center", opacity: inn, transform: `scale(${zoom})` }}>
        {c.shot && <Img src={staticFile(`shots30/${c.shot}`)} style={{ maxWidth: 860, maxHeight: c.shot2 ? 300 : 820, objectFit: "contain", borderRadius: 18,
          boxShadow: "0 30px 80px rgba(0,0,0,.55)", border: `3px solid ${GOLD}` }} />}
        {c.shot2 && <Img src={staticFile(`shots30/${c.shot2}`)} style={{ maxWidth: 860, maxHeight: 480, objectFit: "contain", borderRadius: 18,
          boxShadow: "0 30px 80px rgba(0,0,0,.55)", border: `3px solid ${GOLD}` }} />}
        {c.code && <pre style={{ font: `600 30px/1.5 ${MONO}`, background: "#0b1440", border: `3px solid ${GOLD}`, borderRadius: 18, padding: "40px 44px",
          whiteSpace: "pre-wrap", width: 820, color: "#e8edff" }}>{c.code.split("\n\n")[0]}<span style={{ color: "#7ee2a8" }}>{`\n\n${c.code.split("\n\n")[1]}`}</span></pre>}
      </div>
      <div style={{ position: "absolute", left: 110, bottom: 70, font: `600 26px ${MONO}`, color: "#9fb4ff" }}>koperasi-kohl.vercel.app</div>
    </AbsoluteFill>
  );
};

export const intro30Frames = CARDS.length * SCENE;
export const Intro30: React.FC = () => (
  <AbsoluteFill style={{ background: INK }}>
    {CARDS.map((c, i) => (
      <Sequence key={i} from={i * SCENE} durationInFrames={SCENE}><Scene c={c} /></Sequence>
    ))}
  </AbsoluteFill>
);
