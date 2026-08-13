import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "../src/core/EventEmitter";
import { PlaybackEngine } from "../src/core/PlaybackEngine";

function makeVideo(canPlay: (type: string) => CanPlayTypeResult = () => "probably"): HTMLVideoElement {
  const video = document.createElement("video");
  video.canPlayType = canPlay as HTMLVideoElement["canPlayType"];
  return video;
}

describe("PlaybackEngine", () => {
  it("loads a progressive mp4 source directly onto the video element", async () => {
    const video = makeVideo();
    const engine = new PlaybackEngine(video, new EventEmitter());

    await engine.load([{ src: "https://example.com/video.mp4" }]);

    expect(video.src).toContain("video.mp4");
    expect(engine.isHls).toBe(false);
  });

  it("uses native HLS when the browser reports support", async () => {
    const video = makeVideo((type) => (type === "application/vnd.apple.mpegurl" ? "probably" : ""));
    const engine = new PlaybackEngine(video, new EventEmitter());

    await engine.load([{ src: "https://example.com/stream.m3u8" }]);

    expect(video.src).toContain("stream.m3u8");
    expect(engine.isHls).toBe(true);
  });

  it("prefers an explicit HLS source over a progressive fallback when both are given", async () => {
    const video = makeVideo((type) => (type === "application/vnd.apple.mpegurl" ? "probably" : ""));
    const engine = new PlaybackEngine(video, new EventEmitter());

    await engine.load([
      { src: "https://example.com/video.mp4", type: "mp4" },
      { src: "https://example.com/stream.m3u8", type: "hls" },
    ]);

    expect(video.src).toContain("stream.m3u8");
  });

  it("emits a fatal SRC_NOT_SUPPORTED error when given no sources", async () => {
    const video = makeVideo();
    const emitter = new EventEmitter();
    const spy = vi.fn();
    emitter.on("error", spy);
    const engine = new PlaybackEngine(video, emitter);

    await engine.load([]);

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SRC_NOT_SUPPORTED", fatal: true }),
    );
  });

  it("reports no quality levels and null currentQuality before an HLS manifest loads", async () => {
    const video = makeVideo();
    const engine = new PlaybackEngine(video, new EventEmitter());
    await engine.load([{ src: "https://example.com/video.mp4" }]);

    expect(engine.qualityLevels).toEqual([]);
    expect(engine.currentQuality).toBeNull();
  });

  it("destroy() removes its video event listeners without throwing", async () => {
    const video = makeVideo();
    const engine = new PlaybackEngine(video, new EventEmitter());
    await engine.load([{ src: "https://example.com/video.mp4" }]);
    expect(() => engine.destroy()).not.toThrow();
  });
});
