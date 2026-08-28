/**
 * The data behind VLC's "Media Information" and "Statistics" windows:
 * what this file is, which pipeline is playing it, and how well that's
 * going right now.
 */
export interface LumenMediaInfo {
  /** The URL the element is actually playing (a blob: URL when remuxed). */
  source: string;
  /** Human-readable container name, e.g. "Matroska (MKV)". */
  container: string;
  /** Which pipeline is driving playback, e.g. "hls.js" or "MKV remux". */
  engine: string;
  /** RFC 6381 codecs the pipeline negotiated, when it knows them. */
  codecs: string | null;
  width: number;
  height: number;
  /** Measured frames per second, or null before enough frames have shown. */
  frameRate: number | null;
  duration: number;
  /** Stream bitrate in kbit/s, measured or reported by the ABR engine. */
  bitrateKbps: number | null;
  droppedFrames: number;
  decodedFrames: number;
  /** Seconds of media buffered ahead of the playhead. */
  bufferAheadSeconds: number;
  bufferedRanges: Array<[number, number]>;
  audioTrackCount: number;
  textTrackCount: number;
  playbackRate: number;
  /** HTMLMediaElement readyState, 0–4. */
  readyState: number;
}

interface VideoWithByteCounters extends HTMLVideoElement {
  webkitVideoDecodedByteCount?: number;
  webkitAudioDecodedByteCount?: number;
}

interface FrameCallbackMetadata {
  mediaTime: number;
  presentedFrames: number;
}

/**
 * `requestVideoFrameCallback` is standard but not universal (Firefox
 * shipped it late), so it is treated as optional rather than assumed —
 * declared alongside HTMLVideoElement rather than as a subtype, since the
 * DOM lib already declares the methods as required.
 */
type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: FrameCallbackMetadata) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/**
 * Measures what only observation can tell us: the real frame rate and the
 * real bitrate.
 *
 * Frame rate comes from `requestVideoFrameCallback`, which reports the
 * presentation time of each frame the compositor actually shows — that's
 * the only way to get a true rate for a remuxed stream, whose container
 * may carry no frame-rate field at all. Where that API is missing, decoded
 * frame counts over wall-clock time are the fallback.
 */
export class MediaInfoProbe {
  private video: VideoWithFrameCallback & VideoWithByteCounters;
  private frameHandle: number | null = null;
  private lastFrame: { mediaTime: number; presentedFrames: number } | null = null;
  private measuredFps: number | null = null;

  private lastByteSample: { bytes: number; at: number } | null = null;
  private measuredBitrate: number | null = null;
  private running = false;

  constructor(video: HTMLVideoElement) {
    this.video = video as VideoWithFrameCallback & VideoWithByteCounters;
  }

  /** Begins sampling. Idempotent, and cheap enough to leave running. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleFrameCallback();
  }

  stop(): void {
    this.running = false;
    if (this.frameHandle !== null) {
      this.video.cancelVideoFrameCallback?.(this.frameHandle);
      this.frameHandle = null;
    }
    this.lastFrame = null;
    this.lastByteSample = null;
  }

  /** Discards measurements that belong to the previous source. */
  reset(): void {
    this.lastFrame = null;
    this.measuredFps = null;
    this.lastByteSample = null;
    this.measuredBitrate = null;
  }

  get frameRate(): number | null {
    return this.measuredFps;
  }

  private scheduleFrameCallback(): void {
    if (!this.running || typeof this.video.requestVideoFrameCallback !== "function") return;

    this.frameHandle = this.video.requestVideoFrameCallback((_now, metadata) => {
      const previous = this.lastFrame;
      if (previous) {
        const frames = metadata.presentedFrames - previous.presentedFrames;
        const seconds = metadata.mediaTime - previous.mediaTime;
        // Sample across a window rather than frame to frame: consecutive
        // frames give a noisy 1/Δt that swings by several fps.
        if (frames >= 10 && seconds > 0.2) {
          const fps = frames / seconds;
          // Exponential smoothing keeps a variable-frame-rate file from
          // making the number jitter while still tracking a real change.
          this.measuredFps = this.measuredFps === null ? fps : this.measuredFps * 0.7 + fps * 0.3;
          this.lastFrame = { mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames };
        }
      } else {
        this.lastFrame = { mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames };
      }
      this.scheduleFrameCallback();
    });
  }

  /**
   * Bitrate from the browser's decoded-byte counters, sampled over at
   * least a second so a bursty download doesn't read as a 90 Mbit stream.
   * Returns null where the counters don't exist (they're Chromium-only).
   */
  sampleBitrate(): number | null {
    const video = this.video;
    const bytes = (video.webkitVideoDecodedByteCount ?? 0) + (video.webkitAudioDecodedByteCount ?? 0);
    if (bytes === 0) return this.measuredBitrate;

    const now = Date.now();
    const previous = this.lastByteSample;
    if (!previous) {
      this.lastByteSample = { bytes, at: now };
      return this.measuredBitrate;
    }

    const elapsed = (now - previous.at) / 1000;
    if (elapsed < 1) return this.measuredBitrate;

    const delta = bytes - previous.bytes;
    this.lastByteSample = { bytes, at: now };
    if (delta <= 0) return this.measuredBitrate;

    const kbps = (delta * 8) / elapsed / 1000;
    this.measuredBitrate = this.measuredBitrate === null ? kbps : this.measuredBitrate * 0.6 + kbps * 0.4;
    return this.measuredBitrate;
  }

  /**
   * Estimates the frame rate without `requestVideoFrameCallback`, using
   * the decoded-frame counter. Less precise, but present everywhere.
   */
  fallbackFrameRate(previousTotal: number, previousAt: number, playbackRate: number): number | null {
    const quality = this.video.getVideoPlaybackQuality?.();
    if (!quality) return null;
    const elapsed = (Date.now() - previousAt) / 1000;
    if (elapsed < 0.5) return null;
    const frames = quality.totalVideoFrames - previousTotal;
    if (frames <= 0) return null;
    return frames / elapsed / (playbackRate || 1);
  }
}
