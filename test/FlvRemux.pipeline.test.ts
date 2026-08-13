import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "../src/core/EventEmitter";
import { FlvRemuxEngine } from "../src/remux/FlvRemuxEngine";
import type { LumenError } from "../src/types";
import { fakeAacAsc, fakeAvcC } from "./helpers/mkvBuilder";

/**
 * End-to-end coverage for FLV playback: a synthetic FLV goes in, and the
 * fragmented MP4 that comes out is parsed back with mp4box.js — an
 * independent implementation, so bytes that merely look plausible fail.
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
  openSoon(): void {
    queueMicrotask(() => {
      this.readyState = "open";
      this.dispatchEvent(new Event("sourceopen"));
    });
  }
}

let lastMediaSource: FakeMediaSource | null = null;

function stubMediaSource(): void {
  const ctor = function () {
    const instance = new FakeMediaSource();
    lastMediaSource = instance;
    instance.openSoon();
    return instance;
  } as unknown as typeof MediaSource;
  (ctor as unknown as { isTypeSupported: (m: string) => boolean }).isTypeSupported = (mime) =>
    FakeMediaSource.isTypeSupported(mime);
  vi.stubGlobal("MediaSource", ctor);
}

// ---- FLV construction -------------------------------------------------

function tag(type: number, timestamp: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + 11 + body.length);
  out[4] = type;
  out[5] = (body.length >> 16) & 0xff;
  out[6] = (body.length >> 8) & 0xff;
  out[7] = body.length & 0xff;
  out[8] = (timestamp >> 16) & 0xff;
  out[9] = (timestamp >> 8) & 0xff;
  out[10] = timestamp & 0xff;
  out.set(body, 15);
  return out;
}

function videoBody(frameType: number, packetType: number, cts: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = (frameType << 4) | 7;
  out[1] = packetType;
  out[2] = (cts >> 16) & 0xff;
  out[3] = (cts >> 8) & 0xff;
  out[4] = cts & 0xff;
  out.set(payload, 5);
  return out;
}

function audioBody(packetType: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + payload.length);
  out[0] = (10 << 4) | (3 << 2) | 0x03;
  out[1] = packetType;
  out.set(payload, 2);
  return out;
}

function metadataBody(width: number, height: number): Uint8Array {
  const parts: number[] = [];
  const pushString = (text: string) => {
    parts.push((text.length >> 8) & 0xff, text.length & 0xff);
    for (const char of text) parts.push(char.charCodeAt(0));
  };
  const pushNumber = (value: number) => {
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setFloat64(0, value);
    parts.push(...new Uint8Array(buffer));
  };
  parts.push(0x02);
  pushString("onMetaData");
  parts.push(0x08, 0, 0, 0, 2);
  pushString("width");
  parts.push(0x00);
  pushNumber(width);
  pushString("height");
  parts.push(0x00);
  pushNumber(height);
  parts.push(0, 0, 0x09);
  return new Uint8Array(parts);
}

function buildFlv(tags: Uint8Array[]): Uint8Array {
  const header = new Uint8Array([0x46, 0x4c, 0x56, 0x01, 0x05, 0, 0, 0, 9]);
  const total = tags.reduce((sum, t) => sum + t.length, header.length);
  const out = new Uint8Array(total);
  out.set(header, 0);
  let offset = header.length;
  for (const t of tags) {
    out.set(t, offset);
    offset += t.length;
  }
  return out;
}

const frame = (byte: number, length: number) => new Uint8Array(length).fill(byte);

/** 25fps H.264 plus AAC, with a B-frame-style composition offset. */
function sampleFlv(): Uint8Array {
  const tags: Uint8Array[] = [
    tag(18, 0, metadataBody(1280, 720)),
    tag(9, 0, videoBody(1, 0, 0, fakeAvcC())),
    tag(8, 0, audioBody(0, fakeAacAsc())),
  ];
  for (let i = 0; i < 6; i++) {
    const time = i * 40;
    tags.push(tag(9, time, videoBody(i % 3 === 0 ? 1 : 2, 1, i % 3 === 0 ? 0 : 40, frame(0x10 + i, 128))));
    tags.push(tag(8, time, audioBody(1, frame(0x40 + i, 48))));
  }
  return buildFlv(tags);
}

async function run(flv: Uint8Array) {
  const errors: LumenError[] = [];
  const emitter = new EventEmitter();
  emitter.on("error", (e) => errors.push(e));

  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(flv).buffer, { status: 200 })));

  const video = document.createElement("video");
  const engine = new FlvRemuxEngine(video, emitter);
  const ok = await engine.attempt("https://example.com/video.flv");
  await new Promise((resolve) => setTimeout(resolve, 50));

  const appended = lastMediaSource?.sourceBuffers[0]?.appended ?? [];
  engine.destroy();
  return { ok, appended, errors, mimes: [...FakeMediaSource.requestedTypes] };
}

const fourccAt = (bytes: Uint8Array, offset: number) =>
  String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);

describe("FLV → fragmented MP4 pipeline", () => {
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

  it("negotiates a MIME type from the FLV configuration tags", async () => {
    const { ok, mimes } = await run(sampleFlv());
    expect(ok).toBe(true);
    expect(mimes[0]).toBe('video/mp4; codecs="avc1.64001f,mp4a.40.2"');
  });

  it("emits an init segment followed by media fragments", async () => {
    const { appended } = await run(sampleFlv());
    expect(appended.length).toBeGreaterThan(1);
    expect(fourccAt(appended[0]!, 4)).toBe("ftyp");
    for (const fragment of appended.slice(1)) {
      expect(fourccAt(fragment, 4)).toBe("moof");
    }
  });

  it("produces a fragmented MP4 mp4box.js parses back with both tracks", async () => {
    const { appended } = await run(sampleFlv());

    const mp4box = await import("mp4box");
    const isoFile = mp4box.createFile();

    const info = await new Promise<Record<string, any>>((resolve, reject) => {
      isoFile.onReady = (movie) => resolve(movie as unknown as Record<string, any>);
      isoFile.onError = (_m, message) => reject(new Error(message));

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
    expect(info.videoTracks[0].codec).toBe("avc1.64001f");
    // Dimensions come from the onMetaData tag — FLV's AVC config has none.
    expect(info.videoTracks[0].video).toMatchObject({ width: 1280, height: 720 });
    expect(info.audioTracks[0].codec).toBe("mp4a.40.2");
  });

  it("plays video-only when the FLV carries no audio", async () => {
    const tags = [tag(9, 0, videoBody(1, 0, 0, fakeAvcC()))];
    for (let i = 0; i < 4; i++) {
      tags.push(tag(9, i * 40, videoBody(i === 0 ? 1 : 2, 1, 0, frame(0xaa, 64))));
    }

    const { ok, mimes } = await run(buildFlv(tags));
    expect(ok).toBe(true);
    expect(mimes[0]).toBe('video/mp4; codecs="avc1.64001f"');
  });

  it("builds exactly one MediaSource when both config tags arrive", async () => {
    // Video and audio configuration each call maybeStart(); without a guard
    // the two interleave across the grace period and build two pipelines.
    const created: FakeMediaSource[] = [];
    const ctor = function () {
      const instance = new FakeMediaSource();
      created.push(instance);
      lastMediaSource = instance;
      instance.openSoon();
      return instance;
    } as unknown as typeof MediaSource;
    (ctor as unknown as { isTypeSupported: () => boolean }).isTypeSupported = () => true;
    vi.stubGlobal("MediaSource", ctor);

    await run(sampleFlv());
    expect(created).toHaveLength(1);
  });

  it("fails cleanly when the browser can't decode the codecs", async () => {
    FakeMediaSource.supported = false;
    const { ok, errors } = await run(sampleFlv());

    expect(ok).toBe(false);
    expect(errors.some((e) => e.fatal && /codec your browser can't play/i.test(e.message))).toBe(true);
  });

  it("returns false rather than throwing on a non-FLV file", async () => {
    const { ok } = await run(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    expect(ok).toBe(false);
  });
});
