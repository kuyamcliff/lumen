import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "../src/core/EventEmitter";

const { attemptMock, destroyMock } = vi.hoisted(() => ({
  attemptMock: vi.fn(),
  destroyMock: vi.fn(),
}));

vi.mock("../src/core/ResilientMp4Engine", () => ({
  ResilientMp4Engine: vi.fn().mockImplementation(() => ({
    attempt: attemptMock,
    destroy: destroyMock,
  })),
}));

// Imported after the mock so PlaybackEngine picks up the mocked class.
const { PlaybackEngine } = await import("../src/core/PlaybackEngine");

function makeVideo(): HTMLVideoElement {
  const video = document.createElement("video");
  video.canPlayType = (() => "probably") as HTMLVideoElement["canPlayType"];
  return video;
}

// jsdom doesn't implement the MediaError interface, so this uses the
// standard MEDIA_ERR_NETWORK value (2) directly rather than the global.
const MEDIA_ERR_NETWORK = 2;

function dispatchNetworkError(video: HTMLVideoElement) {
  Object.defineProperty(video, "error", {
    value: { code: MEDIA_ERR_NETWORK },
    configurable: true,
  });
  video.dispatchEvent(new Event("error"));
}

describe("PlaybackEngine resilient MP4 fallback", () => {
  beforeEach(() => {
    attemptMock.mockReset();
    destroyMock.mockReset();
    vi.useFakeTimers();
  });

  it("hands off to the resilient engine once native retries are exhausted, and stays non-fatal on success", async () => {
    attemptMock.mockResolvedValue(true);
    const video = makeVideo();
    const emitter = new EventEmitter();
    const events: Array<{ fatal: boolean; message: string }> = [];
    emitter.on("error", (e) => events.push(e));

    const engine = new PlaybackEngine(video, emitter);
    await engine.load([{ src: "https://example.com/video.mp4" }]);

    // Three network errors exhaust RETRY_BACKOFF_MS (length 3); each retry
    // action is a fake-timer callback, so flush between dispatches.
    for (let i = 0; i < 3; i++) {
      dispatchNetworkError(video);
      await vi.runAllTimersAsync();
    }
    // Fourth error: retries are exhausted -> resilient fallback kicks in.
    dispatchNetworkError(video);
    await vi.runAllTimersAsync();

    expect(attemptMock).toHaveBeenCalledWith("https://example.com/video.mp4");
    expect(events.some((e) => e.fatal)).toBe(false);

    engine.destroy();
  });

  it("emits a fatal error if the resilient engine also fails", async () => {
    attemptMock.mockResolvedValue(false);
    const video = makeVideo();
    const emitter = new EventEmitter();
    const events: Array<{ fatal: boolean; message: string }> = [];
    emitter.on("error", (e) => events.push(e));

    const engine = new PlaybackEngine(video, emitter);
    await engine.load([{ src: "https://example.com/video.mp4" }]);

    for (let i = 0; i < 3; i++) {
      dispatchNetworkError(video);
      await vi.runAllTimersAsync();
    }
    dispatchNetworkError(video);
    await vi.runAllTimersAsync();

    expect(attemptMock).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.fatal)).toBe(true);

    engine.destroy();
  });

  it("never attempts the resilient fallback for HLS sources", async () => {
    attemptMock.mockResolvedValue(true);
    const video = makeVideo();
    // Force hls.js-less native HLS so no real network/hls.js work happens.
    video.canPlayType = ((type: string) =>
      type === "application/vnd.apple.mpegurl" ? "probably" : "") as HTMLVideoElement["canPlayType"];
    const emitter = new EventEmitter();

    const engine = new PlaybackEngine(video, emitter);
    await engine.load([{ src: "https://example.com/stream.m3u8" }]);

    for (let i = 0; i < 4; i++) {
      dispatchNetworkError(video);
      await vi.runAllTimersAsync();
    }

    expect(attemptMock).not.toHaveBeenCalled();
    engine.destroy();
  });

  it("only attempts the resilient fallback once per load()", async () => {
    attemptMock.mockResolvedValue(false);
    const video = makeVideo();
    const emitter = new EventEmitter();

    const engine = new PlaybackEngine(video, emitter);
    await engine.load([{ src: "https://example.com/video.mp4" }]);

    for (let i = 0; i < 3; i++) {
      dispatchNetworkError(video);
      await vi.runAllTimersAsync();
    }
    dispatchNetworkError(video); // exhausts retries -> 1st resilient attempt (fails)
    await vi.runAllTimersAsync();
    dispatchNetworkError(video); // should go straight to fatal, no 2nd attempt
    await vi.runAllTimersAsync();

    expect(attemptMock).toHaveBeenCalledTimes(1);
    engine.destroy();
  });
});
