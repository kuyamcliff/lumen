import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "../src/core/EventEmitter";
import { MatroskaRemuxEngine } from "../src/remux/MatroskaRemuxEngine";
import type { LumenError } from "../src/types";
import {
  MKV_ID,
  audioTrackEntry,
  buildMkv,
  element,
  simpleBlockPayload,
  videoTrackEntry,
} from "./helpers/mkvBuilder";

/**
 * End-to-end coverage for the MKV playback path: a synthetic Matroska file
 * goes in, and what comes out is checked to be a real fragmented MP4 — by
 * parsing it back with mp4box.js, an independent implementation. A muxer
 * that merely produces plausible-looking bytes would pass a hand-written
 * assertion but fail this.
 */

class FakeSourceBuffer extends EventTarget {
  updating = false;
  mode = "segments";
  appended: Uint8Array[] = [];
  appendBuffer(data: Uint8Array): void {
    this.updating = true;
    this.appended.push(data);
    queueMicrotask(() => {
      this.updating = false;
      this.dispatchEvent(new Event("updateend"));
    });
  }
}

class FakeMediaSource extends EventTarget {
  static supported = true;
  static requestedTypes: string[] = [];
  static isTypeSupported(mime: string): boolean {
    FakeMediaSource.requestedTypes.push(mime);
    return FakeMediaSource.supported;
  }
  readyState: "closed" | "open" | "ended" = "closed";
  sourceBuffers: FakeSourceBuffer[] = [];
  addSourceBuffer(): FakeSourceBuffer {
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

function stubMediaSource(): void {
  const ctor = function (this: FakeMediaSource) {
    const instance = new FakeMediaSource();
    lastMediaSource = instance;
    instance.openSoon();
    return instance;
  } as unknown as typeof MediaSource;
  (ctor as unknown as { isTypeSupported: (m: string) => boolean }).isTypeSupported = (mime) =>
    FakeMediaSource.isTypeSupported(mime);
  vi.stubGlobal("MediaSource", ctor);
}

const frame = (byte: number, length: number) => new Uint8Array(length).fill(byte);

/** 25fps video plus AAC audio, three clusters, with a B-frame-style out-of-order PTS. */
function sampleMkv(): Uint8Array {
  const clusters = [0, 1, 2].map((index) => {
    const base = index * 200;
    return {
      timestamp: base,
      blocks: [
        element(MKV_ID.SimpleBlock, simpleBlockPayload({ track: 1, timestamp: 0, frames: [frame(0x10 + index, 128)] })),
        // Decode order 2,1 with presentation order 1,2 — what B-frames look like.
        element(MKV_ID.SimpleBlock, simpleBlockPayload({ track: 1, timestamp: 80, keyframe: false, frames: [frame(0x20 + index, 96)] })),
        element(MKV_ID.SimpleBlock, simpleBlockPayload({ track: 1, timestamp: 40, keyframe: false, frames: [frame(0x30 + index, 64)] })),
        element(MKV_ID.SimpleBlock, simpleBlockPayload({ track: 2, timestamp: 0, frames: [frame(0x40 + index, 48)] })),
        element(MKV_ID.SimpleBlock, simpleBlockPayload({ track: 2, timestamp: 100, frames: [frame(0x50 + index, 48)] })),
      ],
    };
  });

  return buildMkv({
    trackEntries: [
      videoTrackEntry({ number: 1, width: 1280, height: 720 }),
      audioTrackEntry({ number: 2, channels: 2, sampleRate: 48000 }),
    ],
    clusters,
  });
}

async function runEngine(mkv: Uint8Array): Promise<{
  ok: boolean;
  appended: Uint8Array[];
  errors: LumenError[];
  mimes: string[];
}> {
  const errors: LumenError[] = [];
  const emitter = new EventEmitter();
  emitter.on("error", (e) => errors.push(e));

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array(mkv).buffer, { status: 200 })),
  );

  const video = document.createElement("video");
  const engine = new MatroskaRemuxEngine(video, emitter);
  const ok = await engine.attempt("https://example.com/movie.mkv");

  // Let the queued appends drain through the fake SourceBuffer.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const appended = lastMediaSource?.sourceBuffers[0]?.appended ?? [];
  engine.destroy();
  return { ok, appended, errors, mimes: [...FakeMediaSource.requestedTypes] };
}

function fourccAt(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

describe("Matroska → fragmented MP4 pipeline", () => {
  beforeEach(() => {
    lastMediaSource = null;
    FakeMediaSource.supported = true;
    FakeMediaSource.requestedTypes = [];
    stubMediaSource();
    vi.stubGlobal("URL", { createObjectURL: () => "blob:fake", revokeObjectURL: () => {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("negotiates a MIME type carrying both codecs from the Matroska CodecPrivate", async () => {
    const { ok, mimes } = await runEngine(sampleMkv());

    expect(ok).toBe(true);
    // avcC bytes 1-3 are profile/compat/level (High, 0x00, 3.1) and the AAC
    // AudioSpecificConfig decodes to object type 2 (AAC-LC).
    expect(mimes[0]).toBe('video/mp4; codecs="avc1.64001f,mp4a.40.2"');
  });

  it("emits an init segment followed by media fragments", async () => {
    const { appended } = await runEngine(sampleMkv());

    expect(appended.length).toBeGreaterThan(1);

    const init = appended[0]!;
    expect(fourccAt(init, 4)).toBe("ftyp");

    for (const fragment of appended.slice(1)) {
      expect(fourccAt(fragment, 4)).toBe("moof");
    }
  });

  it("produces a fragmented MP4 that mp4box.js parses back with the original track layout", async () => {
    const { appended } = await runEngine(sampleMkv());

    const mp4box = await import("mp4box");
    const isoFile = mp4box.createFile();

    const info = await new Promise<Record<string, any>>((resolve, reject) => {
      isoFile.onReady = (movie) => resolve(movie as unknown as Record<string, any>);
      isoFile.onError = (_module, message) => reject(new Error(message));

      let fileStart = 0;
      for (const segment of appended) {
        const copy = new Uint8Array(segment).buffer;
        isoFile.appendBuffer(mp4box.MP4BoxBuffer.fromArrayBuffer(copy, fileStart));
        fileStart += segment.byteLength;
      }
      isoFile.flush();
    });

    expect(info.isFragmented).toBe(true);
    expect(info.videoTracks).toHaveLength(1);
    expect(info.audioTracks).toHaveLength(1);

    const video = info.videoTracks[0];
    expect(video.codec).toBe("avc1.64001f");
    expect(video.video).toMatchObject({ width: 1280, height: 720 });
    expect(video.language).toBe("eng");

    const audio = info.audioTracks[0];
    expect(audio.codec).toBe("mp4a.40.2");
    expect(audio.audio).toMatchObject({ channel_count: 2, sample_rate: 48000 });
  });

  it("carries every source frame through to the muxed output", async () => {
    const { appended } = await runEngine(sampleMkv());

    // 3 clusters x (3 video + 2 audio) frames, minus the one sample per
    // track deliberately held back to compute the final duration.
    const totalBytes = appended.slice(1).reduce((sum, segment) => sum + segment.byteLength, 0);
    const sourceBytes = 3 * (128 + 96 + 64 + 48 + 48);
    expect(totalBytes).toBeGreaterThan(sourceBytes * 0.8);
  });

  it("drops undecodable audio and plays video only, warning rather than failing", async () => {
    // AC-3 has no MP4 mapping here and no browser decodes it, which is the
    // single most common reason an MKV "won't play" — video must survive.
    const mkv = buildMkv({
      trackEntries: [
        videoTrackEntry({ number: 1, width: 640, height: 360 }),
        audioTrackEntry({ number: 2, channels: 6, sampleRate: 48000, codecId: "A_AC3", codecPrivate: new Uint8Array([0]) }),
      ],
      clusters: [
        {
          timestamp: 0,
          blocks: [
            element(MKV_ID.SimpleBlock, simpleBlockPayload({ track: 1, timestamp: 0, frames: [frame(0xaa, 64)] })),
            element(MKV_ID.SimpleBlock, simpleBlockPayload({ track: 1, timestamp: 40, keyframe: false, frames: [frame(0xbb, 64)] })),
          ],
        },
      ],
    });

    const { ok, mimes, errors } = await runEngine(mkv);

    expect(ok).toBe(true);
    expect(mimes[0]).toBe('video/mp4; codecs="avc1.64001f"');

    const warning = errors.find((e) => !e.fatal);
    expect(warning?.message).toContain("A_AC3");
    expect(errors.some((e) => e.fatal)).toBe(false);
  });

  it("fails cleanly with an actionable message when no track is decodable", async () => {
    FakeMediaSource.supported = false;

    const { ok, errors } = await runEngine(sampleMkv());

    expect(ok).toBe(false);
    expect(errors.some((e) => e.fatal && /codec your browser can't play/i.test(e.message))).toBe(true);
  });
});
