import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaybackEngine } from "../src/core/PlaybackEngine";
import { EventEmitter } from "../src/core/EventEmitter";
import type { LumenError } from "../src/types";

/**
 * Source routing, exercised with real container bytes rather than mocked
 * detection. What matters here is that a file reaches the pipeline that
 * can actually play it — a misroute is invisible in unit tests of the
 * demuxers themselves but fatal in practice, because the viewer just sees
 * a dead player.
 */

// --------------------------------------------------------------- fixtures

function isoBmff(brand = "isom"): Uint8Array {
  const bytes = new Uint8Array(64);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 32);
  bytes.set([0x66, 0x74, 0x79, 0x70], 4); // "ftyp"
  for (let i = 0; i < 4; i++) bytes[8 + i] = brand.charCodeAt(i);
  return bytes;
}

/** QuickTime uses the same box structure with a `qt  ` brand. */
const MOV = isoBmff("qt  ");

function transportStream(): Uint8Array {
  // Three sync bytes 188 apart is what the sniffer requires, so the buffer
  // has to be long enough to actually contain them.
  const bytes = new Uint8Array(1024);
  for (let offset = 0; offset + 1 < bytes.length; offset += 188) bytes[offset] = 0x47;
  return bytes;
}

function matroska(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  bytes.set([0x6d, 0x61, 0x74, 0x72, 0x6f, 0x73, 0x6b, 0x61], 16); // "matroska"
  return bytes;
}

function avi(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  bytes.set([0x41, 0x56, 0x49, 0x20], 8); // "AVI "
  return bytes;
}

function flv(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x46, 0x4c, 0x56, 0x01], 0); // "FLV" + version
  return bytes;
}

// ------------------------------------------------------------------ setup

let video: HTMLVideoElement;
let emitter: EventEmitter;
let engine: PlaybackEngine;
let errors: LumenError[];
let requested: string[];

function serve(body: Uint8Array): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      requested.push(String(url));
      return new Response(body, { status: 206 });
    }),
  );
}

beforeEach(() => {
  requested = [];
  errors = [];
  video = document.createElement("video");
  // jsdom answers every canPlayType with "", which would mean "this
  // browser plays nothing"; a permissive default keeps the routing under
  // test rather than the probe's fallbacks.
  video.canPlayType = () => "maybe";
  document.body.appendChild(video);

  emitter = new EventEmitter();
  emitter.on("error", (error) => errors.push(error));
  engine = new PlaybackEngine(video, emitter);
});

afterEach(() => {
  engine.destroy();
  video.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- by type

describe("routing by declared type", () => {
  it("sends .m3u8 straight to the HLS path without probing", async () => {
    serve(isoBmff());
    await engine.load([{ src: "https://cdn/stream.m3u8" }]);

    expect(engine.isHls).toBe(true);
    // Native HLS was claimed available, so no probe request should exist.
    expect(requested).toEqual([]);
    expect(video.src).toContain("stream.m3u8");
  });

  it("honours an explicit type over a misleading extension", async () => {
    serve(isoBmff());
    await engine.load([{ src: "https://cdn/playlist.mp4", type: "hls" }]);
    expect(engine.isHls).toBe(true);
  });

  it("takes the native fast path for .mp4/.webm/.ogg without a probe", async () => {
    serve(isoBmff());
    for (const src of ["https://cdn/a.mp4", "https://cdn/b.webm", "https://cdn/c.ogg"]) {
      await engine.load([{ src }]);
      expect(video.src).toBe(src);
    }
    expect(requested).toEqual([]);
  });

  it("routes .mpd to the DASH engine and reports when dash.js is absent", async () => {
    serve(isoBmff());
    await engine.load([{ src: "https://cdn/manifest.mpd" }]);

    // dash.js isn't installed in this project, so the engine must say so
    // rather than failing silently.
    expect(errors.at(-1)?.message).toMatch(/dash\.js/i);
    expect(errors.at(-1)?.code).toBe("SRC_NOT_SUPPORTED");
  });

  it("picks an HLS source ahead of others in a fallback list", async () => {
    serve(isoBmff());
    await engine.load([
      { src: "https://cdn/movie.mkv" },
      { src: "https://cdn/movie.m3u8" },
      { src: "https://cdn/movie.mp4" },
    ]);
    expect(engine.isHls).toBe(true);
  });

  it("reports a fatal error for an empty source list", async () => {
    await engine.load([]);
    expect(errors.at(-1)?.code).toBe("SRC_NOT_SUPPORTED");
    expect(errors.at(-1)?.fatal).toBe(true);
  });
});

// ----------------------------------------------------------- by container

describe("routing by sniffed container", () => {
  it("probes an extension-less URL and plays ISO-BMFF natively", async () => {
    serve(isoBmff());
    await engine.load([{ src: "https://cdn/asset/9f3a1c" }]);

    expect(requested).toEqual(["https://cdn/asset/9f3a1c"]);
    expect(video.src).toBe("https://cdn/asset/9f3a1c");
  });

  it("plays a .mov natively — QuickTime is ISO-BMFF, not a separate format", async () => {
    serve(MOV);
    await engine.load([{ src: "https://cdn/clip.mov" }]);
    expect(video.src).toBe("https://cdn/clip.mov");
  });

  it("routes a file whose extension lies about being MKV", async () => {
    // Named .mov, actually Matroska. The bytes decide.
    serve(matroska());
    await engine.load([{ src: "https://cdn/mislabelled.mov" }]);

    // No hls.js/MSE in jsdom, so it can't succeed — but it must fail as
    // Matroska, which proves it was sent to the remuxer.
    await vi.waitFor(() => expect(errors.at(-1)?.message).toMatch(/Matroska/i));
  });

  it("routes MPEG-TS through hls.js and explains when it's missing", async () => {
    serve(transportStream());
    await engine.load([{ src: "https://cdn/segment.bin" }]);

    // hls.js is installed here but reports unsupported without MSE, which
    // is the honest jsdom answer; either way the message must name TS.
    await vi.waitFor(() => {
      const last = errors.at(-1);
      expect(last?.message ?? "").toMatch(/MPEG-TS/i);
    });
  });

  it("routes FLV to the remuxer", async () => {
    serve(flv());
    await engine.load([{ src: "https://cdn/legacy.bin" }]);
    await vi.waitFor(() => expect(errors.at(-1)?.message).toMatch(/FLV/i));
  });

  it("refuses AVI with an actionable message instead of a blank player", async () => {
    serve(avi());
    await engine.load([{ src: "https://cdn/old.avi" }]);

    await vi.waitFor(() => {
      expect(errors.at(-1)?.code).toBe("CONTAINER_UNSUPPORTED");
      expect(errors.at(-1)?.message).toMatch(/AVI/);
      // Actionable: it says what to do about it.
      expect(errors.at(-1)?.message).toMatch(/MP4|WebM/);
    });
  });

  it("still attempts native playback when the container can't be identified", async () => {
    serve(new Uint8Array(64));
    await engine.load([{ src: "https://cdn/mystery" }]);
    expect(video.src).toBe("https://cdn/mystery");
  });

  it("treats an unreachable probe as unknown rather than an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network"); }));
    await engine.load([{ src: "https://cdn/offline-probe" }]);

    expect(errors).toEqual([]);
    expect(video.src).toBe("https://cdn/offline-probe");
  });
});

// ------------------------------------------------- synthetic TS playlist

describe("MPEG-TS synthetic playlist", () => {
  /** Captures the manifest URL hls.js would be handed. */
  async function manifestFor(src: string): Promise<string> {
    let manifest = "";
    const FakeHls = Object.assign(
      class {
        static isSupported = () => true;
        config = {};
        on() {}
        loadSource(url: string) {
          manifest = url;
        }
        attachMedia() {}
        destroy() {}
      },
      { Events: {}, ErrorTypes: {}, ErrorDetails: {} },
    );
    vi.stubGlobal("Hls", FakeHls);

    // The hls.js constructor lookup is cached for the lifetime of the
    // module, so a fresh copy is needed for the stub to be seen.
    vi.resetModules();
    const { PlaybackEngine: Fresh } = await import("../src/core/PlaybackEngine");
    const local = new Fresh(video, emitter);

    serve(transportStream());
    await local.load([{ src }]);
    await vi.waitFor(() => expect(manifest).not.toBe(""));
    local.destroy();
    return manifest;
  }

  it("makes the segment URL absolute", async () => {
    // The playlist lives at a data: URL, against which a relative path
    // resolves to nothing usable.
    const manifest = await manifestFor("clips/segment.ts");
    expect(decodeURIComponent(manifest)).toContain(new URL("clips/segment.ts", document.baseURI).href);
  });

  it("survives non-Latin-1 characters in the URL", async () => {
    // btoa() throws InvalidCharacterError on anything above U+00FF, which
    // took down the entire load for a perfectly ordinary filename.
    const src = "https://cdn/vidéos/épisode-1.ts";
    await expect(manifestFor(src)).resolves.toContain("data:application/vnd.apple.mpegurl,");
  });
});

// ------------------------------------------------------------ concurrency

describe("overlapping loads", () => {
  it("ignores a slow probe once a newer source has been requested", async () => {
    // A viewer clicking quickly through a playlist must not have the first
    // item's probe result applied to the second item.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("slow")) {
          await gate;
          return new Response(matroska(), { status: 206 });
        }
        return new Response(isoBmff(), { status: 206 });
      }),
    );

    const first = engine.load([{ src: "https://cdn/slow" }]);
    const second = engine.load([{ src: "https://cdn/fast" }]);
    await second;
    release!();
    await first;

    expect(video.src).toBe("https://cdn/fast");
    // The stale Matroska result must not have produced an error either.
    expect(errors).toEqual([]);
  });
});
