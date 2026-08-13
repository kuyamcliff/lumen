import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "../src/core/EventEmitter";
import { ResilientMp4Engine } from "../src/core/ResilientMp4Engine";

// Real-world regression coverage for the mp4box.js/MSE fallback pipeline,
// without needing an actual browser: MediaSource/SourceBuffer are replaced
// with minimal fakes that just record what would have been appended, while
// mp4box.js itself (a pure ISO-BMFF parser, no DOM dependency) and the
// fixture file are real. This is what caught the original bug — mp4box.js
// needs setSegmentOptions()/start() called *before* it's given the whole
// file, or it never produces segments at all for small/fast responses.

const FIXTURE = resolve(__dirname, "../examples/media/truncated-sample.mp4");

class FakeSourceBuffer extends EventTarget {
  updating = false;
  mode = "segments";
  appended: ArrayBuffer[] = [];
  appendBuffer(buf: ArrayBuffer): void {
    this.updating = true;
    this.appended.push(buf);
    queueMicrotask(() => {
      this.updating = false;
      this.dispatchEvent(new Event("updateend"));
    });
  }
}

class FakeMediaSource extends EventTarget {
  static isTypeSupported(): boolean {
    return true;
  }
  readyState: "closed" | "open" | "ended" = "closed";
  sourceBuffers: FakeSourceBuffer[] = [];
  addSourceBuffer(_mime: string): FakeSourceBuffer {
    const sb = new FakeSourceBuffer();
    this.sourceBuffers.push(sb);
    return sb;
  }
  endOfStream(): void {
    this.readyState = "ended";
  }
  /** Mirrors the browser firing "sourceopen" once the element attaches. */
  openSoon(): void {
    queueMicrotask(() => {
      this.readyState = "open";
      this.dispatchEvent(new Event("sourceopen"));
    });
  }
}

let lastMediaSource: FakeMediaSource | null = null;

/** Stubs MediaSource so instances open themselves, as a real one does. */
function stubMediaSource(): void {
  const ctor = function () {
    const instance = new FakeMediaSource();
    lastMediaSource = instance;
    instance.openSoon();
    return instance;
  } as unknown as typeof MediaSource;
  (ctor as unknown as { isTypeSupported: () => boolean }).isTypeSupported = () => true;
  vi.stubGlobal("MediaSource", ctor);
}

describe("ResilientMp4Engine pipeline (real mp4box.js, fake MediaSource)", () => {
  beforeEach(() => {
    lastMediaSource = null;
    stubMediaSource();
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:fake",
      revokeObjectURL: () => {},
    });

    const bytes = readFileSync(FIXTURE);
    const body = new Uint8Array(bytes).buffer;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("produces at least one real fragmented-MP4 init segment and hands it to the SourceBuffer", async () => {
    const video = document.createElement("video");
    const engine = new ResilientMp4Engine(video, new EventEmitter());

    const ok = await engine.attempt("https://example.com/truncated-sample.mp4");
    expect(ok).toBe(true);

    const mediaSource = lastMediaSource!;
    expect(mediaSource).not.toBeNull();

    await vi.waitFor(() => expect(mediaSource.sourceBuffers.length).toBeGreaterThan(0));
    const sourceBuffer = mediaSource.sourceBuffers[0];
    expect(sourceBuffer).toBeDefined();

    await vi.waitFor(() => {
      expect(sourceBuffer!.appended.length).toBeGreaterThan(0);
    });

    // The first appended buffer is the combined init segment — a real
    // fragmented MP4 starts with an ftyp box.
    const first = new Uint8Array(sourceBuffer!.appended[0]! as ArrayBufferLike as ArrayBuffer);
    const fourcc = String.fromCharCode(first[4]!, first[5]!, first[6]!, first[7]!);
    expect(fourcc).toBe("ftyp");

    engine.destroy();
  });
});
