# python tts.py: narration.json -> public/audio/<id>.mp3 + public/audio/<id>.json (word timings, ms), with Microsoft's
# neural voice through edge-tts (natural, no key). The word timings drive the subtitles.
import asyncio
import json
import pathlib
import edge_tts

VOICE = "en-US-AndrewMultilingualNeural"
ROOT = pathlib.Path(__file__).parent
OUT = ROOT / "public" / "audio"


async def one(scene):
    words = []
    mp3 = OUT / f"{scene['id']}.mp3"
    com = edge_tts.Communicate(scene["text"], VOICE, rate="-4%", boundary="WordBoundary")
    with open(mp3, "wb") as f:
        async for chunk in com.stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                # offsets are in 100 ns ticks
                words.append({"w": chunk["text"], "start": chunk["offset"] / 10_000, "end": (chunk["offset"] + chunk["duration"]) / 10_000})
    (OUT / f"{scene['id']}.json").write_text(json.dumps(words))
    print(scene["id"], f"{words[-1]['end'] / 1000:.1f}s", len(words), "words")


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for s in json.loads((ROOT / "narration.json").read_text(encoding="utf8")):
        for attempt in range(4):
            try:
                await one(s)
                break
            except edge_tts.exceptions.NoAudioReceived:
                await asyncio.sleep(3)
        else:
            raise SystemExit(f"no audio for {s['id']}")

asyncio.run(main())
