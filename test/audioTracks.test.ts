import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "../src/core/EventEmitter";
import { PlaybackEngine } from "../src/core/PlaybackEngine";

/**
 * Audio tracks reach the player from three different places — hls.js,
 * the element's own `audioTracks` list, and the Matroska remuxer — and the
 * UI has to see one shape regardless. These cover the normalization.
 */

function makeVideo(): HTMLVideoElement {
  const video = document.createElement("video");
  video.canPlayType = (() => "probably") as HTMLVideoElement["canPlayType"];
  return video;
}

function withNativeAudioTracks(video: HTMLVideoElement, tracks: Array<{ id: string; label: string; language: string; enabled: boolean }>) {
  const list = Object.assign([...tracks], { length: tracks.length });
  Object.defineProperty(video, "audioTracks", { value: list, configurable: true });
  return list;
}

describe("PlaybackEngine audio tracks", () => {
  it("reports no tracks when the browser exposes none", async () => {
    const engine = new PlaybackEngine(makeVideo(), new EventEmitter());
    await engine.load([{ src: "https://example.com/video.mp4" }]);
    expect(engine.audioTracks).toEqual([]);
    engine.destroy();
  });

  it("normalizes the native audioTracks list", async () => {
    const video = makeVideo();
    withNativeAudioTracks(video, [
      { id: "a1", label: "English", language: "en", enabled: true },
      { id: "a2", label: "Français", language: "fr", enabled: false },
    ]);

    const engine = new PlaybackEngine(video, new EventEmitter());
    await engine.load([{ src: "https://example.com/video.mp4" }]);

    expect(engine.audioTracks).toEqual([
      { id: "a1", label: "English", language: "en", active: true },
      { id: "a2", label: "Français", language: "fr", active: false },
    ]);
    engine.destroy();
  });

  it("falls back to the language, then a positional name, when a label is missing", async () => {
    const video = makeVideo();
    withNativeAudioTracks(video, [
      { id: "a1", label: "", language: "de", enabled: true },
      { id: "a2", label: "", language: "", enabled: false },
    ]);

    const engine = new PlaybackEngine(video, new EventEmitter());
    await engine.load([{ src: "https://example.com/video.mp4" }]);

    expect(engine.audioTracks.map((t) => t.label)).toEqual(["de", "Track 2"]);
    engine.destroy();
  });

  it("switching a native track flips `enabled` and emits audiotrackchange", async () => {
    const video = makeVideo();
    const list = withNativeAudioTracks(video, [
      { id: "a1", label: "English", language: "en", enabled: true },
      { id: "a2", label: "Français", language: "fr", enabled: false },
    ]);

    const emitter = new EventEmitter();
    const spy = vi.fn();
    emitter.on("audiotrackchange", spy);

    const engine = new PlaybackEngine(video, emitter);
    await engine.load([{ src: "https://example.com/video.mp4" }]);
    engine.setAudioTrack("a2");

    expect(list[0]!.enabled).toBe(false);
    expect(list[1]!.enabled).toBe(true);
    expect(spy).toHaveBeenCalledWith({ track: expect.objectContaining({ id: "a2", active: true }) });
    engine.destroy();
  });

  it("ignores a request for a track that doesn't exist", async () => {
    const video = makeVideo();
    const list = withNativeAudioTracks(video, [{ id: "a1", label: "English", language: "en", enabled: true }]);

    const engine = new PlaybackEngine(video, new EventEmitter());
    await engine.load([{ src: "https://example.com/video.mp4" }]);
    engine.setAudioTrack("nope");

    // Nothing matched, so nothing should have been enabled either.
    expect(list[0]!.enabled).toBe(false);
    expect(engine.audioTracks.every((t) => !t.active)).toBe(true);
    engine.destroy();
  });
});
