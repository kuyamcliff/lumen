import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "../src/core/EventEmitter";
import { AviRemuxEngine } from "../src/remux/AviRemuxEngine";
import type { LumenError } from "../src/types";
import {
  MP3_FRAME_SAMPLES,
  MP3_SAMPLE_RATE,
  PPS,
  SPS,
  annexB,
  audioFormat,
  avih,
  buildAvi,
  idrFrame,
  interFrame,
  list,
  mediaChunk,
  mp3Frame,
  strh,
  videoFormat,
} from "./helpers/aviBuilder";

/**
 * End-to-end coverage for the AVI playback path.
 *
 * A synthetic AVI goes in; what comes out is checked to be a real
 * fragmented MP4 by parsing it back with mp4box.js — an independent
 * implementation that a muxer producing merely plausible-looking bytes
 * would not satisfy.
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

/** H.264 with parameter sets in the header, plus an MP3 track. */
function sampleAvi(options: { extradataInHeader?: boolean } = {}): Uint8Array {
  const extradata = options.extradataInHeader === false ? undefined : annexB(SPS, PPS);
  const videoChunks = [
    // The first frame repeats the parameter sets in-band, as encoders do.
    mediaChunk(0, "dc", annexB(SPS, PPS, idrFrame(96))),
    mediaChunk(0, "dc", annexB(interFrame(48))),
    mediaChunk(0, "dc", annexB(interFrame(56))),
    mediaChunk(0, "dc", annexB(idrFrame(88))),
    mediaChunk(0, "dc", annexB(interFrame(40))),
  ];
  const audioChunks = [0, 1, 2, 3].map(() => mediaChunk(1, "wb", mp3Frame()));

  const interleaved: Uint8Array[] = [];
  for (let i = 0; i < videoChunks.length; i++) {
    interleaved.push(videoChunks[i]!);
    if (audioChunks[i]) interleaved.push(audioChunks[i]!);
  }

  return buildAvi(
    [
      avih(640, 360, 2),
      list(
        "strl",
        strh({ type: "vids", handler: "H264", scale: 1, rate: 25 }),
        videoFormat(640, 360, "H264", extradata),
      ),
      list("strl", strh({ type: "auds", handler: "    ", scale: 1, rate: 38 }), audioFormat(0x0055, 2, 44100)),
    ],
    interleaved,
  );
}

async function runEngine(avi: Uint8Array): Promise<{
  ok: boolean;
  appended: Uint8Array[];
  errors: LumenError[];
  mimes: string[];
  engine: AviRemuxEngine;
}> {
  const errors: LumenError[] = [];
  const emitter = new EventEmitter();
  emitter.on("error", (e) => errors.push(e));

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array(avi).buffer, { status: 200 })),
  );

  const video = document.createElement("video");
  const engine = new AviRemuxEngine(video, emitter);
  const ok = await engine.attempt("https://example.com/clip.avi");

  await new Promise((resolve) => setTimeout(resolve, 50));

  const appended = lastMediaSource?.sourceBuffers[0]?.appended ?? [];
  return { ok, appended, errors, mimes: [...FakeMediaSource.requestedTypes], engine };
}

function fourccAt(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

describe("AVI → fragmented MP4 pipeline", () => {
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

  it("negotiates a MIME type from the H.264 parameter sets and the MP3 tag", async () => {
    const { ok, mimes, engine } = await runEngine(sampleAvi());

    expect(ok).toBe(true);
    // avc1.42001e = baseline profile 0x42, no constraints, level 3.0 —
    // read straight out of the SPS the fixture wrote.
    expect(mimes[0]).toBe('video/mp4; codecs="avc1.42001e,mp4a.40.34"');
    expect(engine.mimeType).toBe(mimes[0]);
    engine.destroy();
  });

  it("emits an init segment followed by media fragments", async () => {
    const { appended, engine } = await runEngine(sampleAvi());

    expect(appended.length).toBeGreaterThan(1);
    expect(fourccAt(appended[0]!, 4)).toBe("ftyp");
    for (const fragment of appended.slice(1)) {
      expect(fourccAt(fragment, 4)).toBe("moof");
    }
    engine.destroy();
  });

  it("produces a fragmented MP4 that mp4box.js parses back with both tracks", async () => {
    const { appended, engine } = await runEngine(sampleAvi());

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

    expect(info.videoTracks[0].codec).toBe("avc1.42001e");
    expect(info.videoTracks[0].video).toMatchObject({ width: 640, height: 360 });
    expect(info.audioTracks[0].audio).toMatchObject({ sample_rate: 44100 });
    engine.destroy();
  });

  it("starts the first fragment at the beginning of the timeline", async () => {
    const { appended, engine } = await runEngine(sampleAvi());
    expect(baseMediaDecodeTime(appended[1]!)).toBe(0);
    engine.destroy();
  });

  it("times MP3 audio by counting decoded samples, not by the header's rate", async () => {
    const { appended, engine } = await runEngine(sampleAvi());

    // The fixture's audio header declares 38 blocks per second, which is
    // wrong on purpose — real MP3-in-AVI headers routinely are. Trusting it
    // would give 44100/38 ≈ 1161 ticks per chunk and drift audibly; reading
    // the frames gives exactly 1152, the samples an MPEG-1 Layer III frame
    // decodes to.
    const audioFragment = appended.slice(1).find((segment) => trackIdOf(segment) === 2);
    expect(audioFragment).toBeDefined();

    const durations = trunDurations(audioFragment!);
    expect(durations.length).toBeGreaterThan(1);
    for (const duration of durations) expect(duration).toBe(MP3_FRAME_SAMPLES);
    // Sanity: at the track's own timescale that is 26.1 ms per frame.
    expect(MP3_FRAME_SAMPLES / MP3_SAMPLE_RATE).toBeCloseTo(0.026122, 5);
    engine.destroy();
  });

  it("times video from the stream header's scale and rate", async () => {
    const { appended, engine } = await runEngine(sampleAvi());

    const videoFragment = appended.slice(1).find((segment) => trackIdOf(segment) === 1);
    expect(videoFragment).toBeDefined();
    // 25 fps at the 90 kHz mux timescale is 3600 ticks per frame.
    for (const duration of trunDurations(videoFragment!)) expect(duration).toBe(3600);
    engine.destroy();
  });

  it("starts the pipeline from in-band parameter sets when the header has none", async () => {
    const { ok, mimes, engine } = await runEngine(sampleAvi({ extradataInHeader: false }));

    expect(ok).toBe(true);
    expect(mimes[0]).toBe('video/mp4; codecs="avc1.42001e,mp4a.40.34"');
    engine.destroy();
  });

  it("names the codec when the video is one no browser decodes", async () => {
    const xvid = buildAvi(
      [
        avih(640, 360, 1),
        list("strl", strh({ type: "vids", handler: "XVID", scale: 1, rate: 25 }), videoFormat(640, 360, "XVID")),
      ],
      [mediaChunk(0, "dc", new Uint8Array(64))],
    );

    const { ok, errors, engine } = await runEngine(xvid);

    expect(ok).toBe(false);
    expect(errors[0]?.message).toContain("MPEG-4 ASP (XVID)");
    expect(errors[0]?.fatal).toBe(true);
    engine.destroy();
  });

  it("plays video only when the audio codec has no browser support", async () => {
    const pcm = buildAvi(
      [
        avih(640, 360, 2),
        list(
          "strl",
          strh({ type: "vids", handler: "H264", scale: 1, rate: 25 }),
          videoFormat(640, 360, "H264", annexB(SPS, PPS)),
        ),
        // 0x0001 is plain PCM, which MP4/MSE has no usable mapping for.
        list("strl", strh({ type: "auds", handler: "    ", scale: 1, rate: 44100, sampleSize: 4 }), audioFormat(0x0001, 2, 44100)),
      ],
      [mediaChunk(0, "dc", annexB(idrFrame())), mediaChunk(1, "wb", new Uint8Array(128))],
    );

    const { ok, errors, mimes, engine } = await runEngine(pcm);

    expect(ok).toBe(true);
    expect(mimes[0]).toBe('video/mp4; codecs="avc1.42001e"');
    const warning = errors.find((error) => !error.fatal);
    expect(warning?.message).toContain("PCM");
    engine.destroy();
  });

  it("drops frames before the first keyframe rather than feeding an undecodable start", async () => {
    const file = buildAvi(
      [
        avih(640, 360, 1),
        list(
          "strl",
          strh({ type: "vids", handler: "H264", scale: 1, rate: 25 }),
          videoFormat(640, 360, "H264", annexB(SPS, PPS)),
        ),
      ],
      [
        mediaChunk(0, "dc", annexB(interFrame(32))),
        mediaChunk(0, "dc", annexB(interFrame(32))),
        mediaChunk(0, "dc", annexB(idrFrame(64))),
        mediaChunk(0, "dc", annexB(interFrame(32))),
      ],
    );

    const { appended, engine } = await runEngine(file);
    const fragments = appended.slice(1);
    expect(fragments.length).toBeGreaterThan(0);
    // The first fragment must begin at the keyframe, which is frame 2 —
    // 2 × 3600 ticks at the 90 kHz timescale.
    expect(baseMediaDecodeTime(fragments[0]!)).toBe(7200);
    engine.destroy();
  });
});

describe("the checked-in AVI fixture", () => {
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

  it("remuxes a real H.264/AAC AVI into an MP4 that mp4box.js accepts", async () => {
    const { readFileSync } = await import("node:fs");
    const file = new Uint8Array(readFileSync("examples/media/sample-h264.avi"));

    const { ok, appended, mimes, engine } = await runEngine(file);

    expect(ok).toBe(true);
    // High profile 4.2 video with AAC-LC audio, read out of the AVI's own
    // stream headers rather than assumed.
    expect(mimes[0]).toBe('video/mp4; codecs="avc1.64001f,mp4a.40.2"');

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
    expect(info.videoTracks[0].video).toMatchObject({ width: 960, height: 540 });
    expect(info.audioTracks[0].audio).toMatchObject({ sample_rate: 48000, channel_count: 2 });

    // Four seconds of 29.97 fps video, at the 90 kHz mux timescale.
    const videoFragments = appended.slice(1).filter((segment) => trackIdOf(segment) === 1);
    const lastVideo = videoFragments[videoFragments.length - 1]!;
    const endTicks = baseMediaDecodeTime(lastVideo) + trunDurations(lastVideo).reduce((a, b) => a + b, 0);
    expect(endTicks / 90000).toBeGreaterThan(3.5);

    engine.destroy();
  });
});

/**
 * Reads `tfdt`'s baseMediaDecodeTime out of a fragment.
 *
 * Scanning for the box rather than computing an offset keeps the test
 * honest about layout changes in the muxer.
 */
/** The track id a fragment's `tfhd` names. */
function trackIdOf(fragment: Uint8Array): number {
  for (let i = 0; i + 12 < fragment.byteLength; i++) {
    if (fourccAt(fragment, i) !== "tfhd") continue;
    const view = new DataView(fragment.buffer, fragment.byteOffset, fragment.byteLength);
    return view.getUint32(i + 8);
  }
  return -1;
}

/**
 * Per-sample durations from a fragment's `trun`.
 *
 * The muxer writes duration, size, flags and composition offset for every
 * sample, in that order, after the sample count and data offset.
 */
function trunDurations(fragment: Uint8Array): number[] {
  for (let i = 0; i + 16 < fragment.byteLength; i++) {
    if (fourccAt(fragment, i) !== "trun") continue;
    const view = new DataView(fragment.buffer, fragment.byteOffset, fragment.byteLength);
    const count = view.getUint32(i + 8);
    const durations: number[] = [];
    for (let sample = 0; sample < count; sample++) {
      durations.push(view.getUint32(i + 16 + sample * 16));
    }
    return durations;
  }
  return [];
}

function baseMediaDecodeTime(fragment: Uint8Array): number {
  for (let i = 0; i + 20 < fragment.byteLength; i++) {
    if (fourccAt(fragment, i) !== "tfdt") continue;
    const view = new DataView(fragment.buffer, fragment.byteOffset, fragment.byteLength);
    const version = fragment[i + 4]!;
    return version === 1 ? Number(view.getBigUint64(i + 8)) : view.getUint32(i + 8);
  }
  return -1;
}
