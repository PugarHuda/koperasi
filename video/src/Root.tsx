import React from "react";
import { Composition } from "remotion";
import { FullVideo, ShortVideo, FULL, SHORT, FPS, framesOf } from "./Video";
import { Intro30, INTRO_FPS, intro30Frames } from "./Intro30";

export const Root: React.FC = () => (
  <>
    <Composition id="Koperasi" component={FullVideo} durationInFrames={framesOf(FULL)} fps={FPS} width={1920} height={1080} />
    <Composition id="Koperasi60" component={ShortVideo} durationInFrames={Math.max(1, framesOf(SHORT))} fps={FPS} width={1920} height={1080} />
    <Composition id="Intro30" component={Intro30} durationInFrames={intro30Frames} fps={INTRO_FPS} width={1920} height={1080} />
  </>
);
