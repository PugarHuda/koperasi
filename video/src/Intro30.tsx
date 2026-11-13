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
  { kicker: "Red team, on-chain", title: "19 attacks. 19 refused.", sub: "Real transactions against the live co-op; your browser re-reads every refusal.", shot: "attacks.png" },
  { kicker: "Work judged by someone else", title: "95/100, three times, on another team's market.", sub: "Taskbond's guard approved the voted prompt, its reviewer AI scored the work, its escrow paid.", shot: "taskbond.png" },
  { kicker: "Reputation that travels", title: "Trust earned in one co-op counts in another.", sub: "Co-ops recognise each other by vote, and federate: one co-op, one vote, a shared reserve.", shot: "passport.png", shot2: "federation.png" },
  { kicker: "The agent answers to the court", title: "Three upheld cases, and it is suspended.", sub: "The members reinstated it by vote. Members also lend to each other, each loan with a guarantor.", shot: "duties.png" },
  { kicker: "Indonesian co-op law, on-chain", title: "The members approve the year's books.", sub: "The agent writes the report in a TEE; the vote records it and sets the dues. One draft was voted down.", shot: "meeting.png" },
  { kicker: "Don't trust us", title: "Check every claim. No clone.", sub: "It reads NEAR, Ethereum, Base and Arbitrum testnets.", code: "curl -sO https://koperasi-kohl.vercel.app/verify.mjs && node verify.mjs\n\nevery claim checks out." },
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
