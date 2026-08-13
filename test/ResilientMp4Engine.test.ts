import { describe, expect, it } from "vitest";
import { EventEmitter } from "../src/core/EventEmitter";
import { ResilientMp4Engine } from "../src/core/ResilientMp4Engine";

describe("ResilientMp4Engine", () => {
  it("returns false without throwing when MediaSource isn't available (e.g. jsdom, old browsers)", async () => {
    // jsdom doesn't implement MediaSource — this exercises the same
    // feature-detection path real unsupported browsers would take.
    expect(typeof (globalThis as { MediaSource?: unknown }).MediaSource).toBe("undefined");

    const video = document.createElement("video");
    const engine = new ResilientMp4Engine(video, new EventEmitter());

    const ok = await engine.attempt("https://example.com/video.mp4");
    expect(ok).toBe(false);
  });

  it("destroy() is a no-op-safe when called before attempt() ever runs", () => {
    const video = document.createElement("video");
    const engine = new ResilientMp4Engine(video, new EventEmitter());
    expect(() => engine.destroy()).not.toThrow();
  });
});
