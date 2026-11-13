import React from "react";
import { Composition } from "remotion";
import { Video, FPS, totalFrames } from "./Video";
import { Intro30, INTRO_FPS, intro30Frames } from "./Intro30";

export const Root: React.FC = () => (
  <>
    <Composition id="Koperasi" component={Video} durationInFrames={totalFrames} fps={FPS} width={1920} height={1080} />
    <Composition id="Intro30" component={Intro30} durationInFrames={intro30Frames} fps={INTRO_FPS} width={1920} height={1080} />
  </>
);
