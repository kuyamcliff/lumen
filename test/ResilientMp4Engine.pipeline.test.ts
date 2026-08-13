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
  open(): void {
    this.readyState = "open";
    this.dispatchEvent(new Event("sourceopen"));
  }
}

describe("ResilientMp4Engine pipeline (real mp4box.js, fake MediaSource)", () => {
  beforeEach(() => {
    vi.stubGlobal("MediaSource", FakeMediaSource);
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

    const attemptPromise = engine.attempt("https://example.com/truncated-sample.mp4");

    // Let mp4box.js parse the moov and configure segmentation (this is the
    // synchronous-ordering fix under test), then open the MediaSource the
    // engine created, exactly as a real "sourceopen" event would.
    await vi.waitFor(() => {
      const ms = (engine as unknown as { mediaSource: FakeMediaSource | null }).mediaSource;
      expect(ms).not.toBeNull();
    });
    const mediaSource = (engine as unknown as { mediaSource: FakeMediaSource }).mediaSource;
    mediaSource.open();

    const ok = await attemptPromise;
    expect(ok).toBe(true);

    const sourceBuffer = mediaSource.sourceBuffers[0];
    expect(sourceBuffer).toBeDefined();

    await vi.waitFor(() => {
      expect(sourceBuffer!.appended.length).toBeGreaterThan(0);
    });

    // The first appended buffer is the combined init segment — a real
    // fragmented MP4 starts with an ftyp box.
    const first = new Uint8Array(sourceBuffer!.appended[0]!);
    const fourcc = String.fromCharCode(first[4]!, first[5]!, first[6]!, first[7]!);
    expect(fourcc).toBe("ftyp");

    engine.destroy();
  });
});
