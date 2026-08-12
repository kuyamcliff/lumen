import type { ISOFile, MP4BoxBuffer as MP4BoxBufferType, Movie } from "mp4box";
import type { EventEmitter } from "./EventEmitter";

declare global {
  interface Window {
    MP4Box?: typeof import("mp4box");
  }
}

let mp4boxModulePromise: Promise<typeof import("mp4box") | null> | null = null;

/** Same global-first, dynamic-import-second resolution strategy as hls.js — see PlaybackEngine.loadHlsCtor. */
function loadMp4Box(): Promise<typeof import("mp4box") | null> {
  if (mp4boxModulePromise) return mp4boxModulePromise;
  mp4boxModulePromise = (async () => {
    if (typeof window !== "undefined" && window.MP4Box) return window.MP4Box;
    try {
      // Bare specifier, intentionally external in vite.config.ts — bundler
      // consumers resolve it from node_modules; the core never pays for it.
      return await import(/* @vite-ignore */ "mp4box");
    } catch {
      return null;
    }
  })();
  return mp4boxModulePromise;
}

const FETCH_CHUNK_TARGET = 1.5 * 1024 * 1024; // bytes per appendBuffer() call

/**
 * Last-resort playback path for progressive MP4s that native `<video>`
 * couldn't handle after retrying (see PlaybackEngine). Streams the file
 * through mp4box.js, remuxes it into fragmented MP4 segments as bytes
 * arrive, and feeds them into a MediaSource SourceBuffer — so a file
 * that's truncated, has its `moov` box in an order the browser's own
 * demuxer rejects, or hiccups mid-download still plays as much as is
 * actually decodable, instead of a dead player and a cryptic MediaError.
 *
 * Known limits, by design (documented in the README): MP4 only (mp4box.js
 * doesn't handle WebM/Ogg), audio+video are muxed into a single combined
 * SourceBuffer, and seeking is clamped to what's already buffered — this
 * engine trades full random access for the ability to play a file the
 * browser otherwise refuses to touch at all.
 */
export class ResilientMp4Engine {
  private video: HTMLVideoElement;
  private emitter: EventEmitter;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private isoFile: ISOFile | null = null;
  private abortController: AbortController | null = null;
  private objectUrl: string | null = null;
  private pendingSegments: ArrayBuffer[] = [];
  private streamDone = false;
  private destroyed = false;

  constructor(video: HTMLVideoElement, emitter: EventEmitter) {
    this.video = video;
    this.emitter = emitter;
  }

  /** Returns true if it managed to hand off playback to a MediaSource; false means the caller should show the normal fatal error. */
  async attempt(url: string): Promise<boolean> {
    if (typeof MediaSource === "undefined") return false;

    const mp4box = await loadMp4Box();
    if (!mp4box) return false;

    let response: Response;
    try {
      response = await fetch(url);
    } catch {
      return false;
    }
    if (!response.ok || !response.body) return false;

    this.emitter.emit("error", {
      code: "DECODE",
      message: "Attempting best-effort recovery…",
      fatal: false,
    });

    const isoFile = mp4box.createFile();
    this.isoFile = isoFile;

    const ready = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };

      isoFile.onError = () => finish(false);
      isoFile.onReady = (info: Movie) => {
        const mime = this.buildMimeType(info);
        if (!mime || typeof MediaSource === "undefined" || !MediaSource.isTypeSupported(mime)) {
          finish(false);
          return;
        }
        try {
          // Segmentation must be configured — and start() called —
          // synchronously here, before this appendBuffer() call returns.
          // For small/fast responses the whole file can already be queued
          // up by the time the (async) MediaSource "sourceopen" event
          // would fire, so waiting for that event to call start() risks
          // missing the window where mp4box.js still has samples to hand
          // off; segments produced before the SourceBuffer exists simply
          // queue in pendingSegments until it does.
          this.configureSegmentation(isoFile, info);
          this.openMediaSource(mime);
        } catch {
          finish(false);
          return;
        }
        finish(true);
      };

      void this.pump(response, isoFile, mp4box).catch(() => finish(false));
    });

    if (!ready || this.destroyed) {
      this.cleanupFailed();
      return false;
    }
    return true;
  }

  private async pump(
    response: Response,
    isoFile: ISOFile,
    mp4box: typeof import("mp4box"),
  ): Promise<void> {
    const reader = response.body!.getReader();
    const abort = new AbortController();
    this.abortController = abort;

    let fileStart = 0;
    let pendingLength = 0;
    let pendingParts: Uint8Array[] = [];

    const flushPending = () => {
      if (pendingParts.length === 0) return;
      const combined = new Uint8Array(pendingLength);
      let offset = 0;
      for (const part of pendingParts) {
        combined.set(part, offset);
        offset += part.length;
      }
      pendingParts = [];
      pendingLength = 0;

      const buf = mp4box.MP4BoxBuffer.fromArrayBuffer(combined.buffer, fileStart) as MP4BoxBufferType;
      fileStart += combined.byteLength;
      isoFile.appendBuffer(buf);
    };

    try {
      for (;;) {
        if (this.destroyed || abort.signal.aborted) return;
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        pendingParts.push(value);
        pendingLength += value.byteLength;
        if (pendingLength >= FETCH_CHUNK_TARGET) flushPending();
      }
      flushPending();
      isoFile.flush();
      this.streamDone = true;
      this.maybeEndOfStream();
    } catch {
      // Network failure mid-stream: whatever was already appended stays
      // playable. Mark the stream done so buffered playback can finish
      // cleanly instead of hanging forever waiting for more data.
      this.streamDone = true;
      this.maybeEndOfStream();
    }
  }

  /** Configures fragmentation and starts sample processing — must run before mp4box.js is handed any more data (see the call site). */
  private configureSegmentation(isoFile: ISOFile, info: Movie): void {
    for (const track of info.tracks) {
      isoFile.setSegmentOptions(track.id, undefined, { nbSamples: 1000 });
    }

    const init = isoFile.initializeSegmentation();
    this.pendingSegments.push(init.buffer);

    isoFile.onSegment = (id: number, _user: unknown, buffer: ArrayBuffer, sampleNum: number) => {
      this.pendingSegments.push(buffer);
      isoFile.releaseUsedSamples(id, sampleNum);
      this.pumpSegments();
    };

    isoFile.start();
  }

  /** Points the <video> at a MediaSource and, once it's open, creates the SourceBuffer that pumpSegments() feeds. */
  private openMediaSource(mime: string): void {
    const mediaSource = new MediaSource();
    this.mediaSource = mediaSource;
    this.objectUrl = URL.createObjectURL(mediaSource);
    this.video.src = this.objectUrl;

    mediaSource.addEventListener(
      "sourceopen",
      () => {
        if (this.destroyed) return;
        let sourceBuffer: SourceBuffer;
        try {
          sourceBuffer = mediaSource.addSourceBuffer(mime);
        } catch {
          this.failAfterOpen();
          return;
        }
        sourceBuffer.mode = "sequence";
        this.sourceBuffer = sourceBuffer;

        sourceBuffer.addEventListener("updateend", () => this.pumpSegments());
        sourceBuffer.addEventListener("error", () => this.failAfterOpen());

        this.pumpSegments();
      },
      { once: true },
    );
  }

  private buildMimeType(info: Movie): string | null {
    const codecs = info.tracks.map((t) => t.codec).filter(Boolean);
    if (codecs.length === 0) return null;
    return `video/mp4; codecs="${codecs.join(",")}"`;
  }

  private pumpSegments(): void {
    const sb = this.sourceBuffer;
    if (!sb || sb.updating) return;
    const next = this.pendingSegments.shift();
    if (next) {
      try {
        sb.appendBuffer(next);
      } catch {
        this.failAfterOpen();
      }
      return;
    }
    this.maybeEndOfStream();
  }

  private maybeEndOfStream(): void {
    const ms = this.mediaSource;
    if (!ms || ms.readyState !== "open") return;
    if (!this.streamDone) return;
    if (this.sourceBuffer?.updating) return;
    if (this.pendingSegments.length > 0) return;
    try {
      ms.endOfStream();
    } catch {
      /* already ending/ended — fine to ignore */
    }
  }

  private failAfterOpen(): void {
    // We already handed the element a src and started feeding it — at this
    // point there's nothing better to fall back to. Surface it as a fatal
    // error rather than silently freezing.
    this.emitter.emit("error", {
      code: "DECODE",
      message: "This video couldn't be recovered. It may be too badly damaged to play.",
      fatal: true,
    });
    this.destroy();
  }

  private cleanupFailed(): void {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
  }

  destroy(): void {
    this.destroyed = true;
    this.abortController?.abort();
    if (this.isoFile) {
      this.isoFile.onSegment = undefined;
      this.isoFile.onReady = undefined;
      this.isoFile.onError = undefined;
    }
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }
}
