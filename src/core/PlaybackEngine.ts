import type HlsType from "hls.js";
import type { ErrorData } from "hls.js";
import type { EventEmitter } from "./EventEmitter";
import type { LumenError, LumenQualityLevel, LumenSource } from "../types";
import { RETRY_BACKOFF_MS, delay } from "../utils/retry";
import { ResilientMp4Engine } from "./ResilientMp4Engine";

declare global {
  interface Window {
    Hls?: typeof HlsType;
  }
}

// WHATWG MediaError codes (https://html.spec.whatwg.org/#error-codes), used
// as numeric literals rather than `MediaError.MEDIA_ERR_*` — the global
// MediaError constructor isn't implemented in every environment that runs
// this code (e.g. jsdom-based tests), even though the values themselves are
// a stable part of the spec.
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

const HLS_EXT = /\.m3u8($|\?)/i;
const MP4_EXT = /\.mp4($|\?)/i;
const WEBM_EXT = /\.webm($|\?)/i;
const OGG_EXT = /\.og[gv]($|\?)/i;

function detectType(source: LumenSource): "hls" | "mp4" | "webm" | "ogg" | "auto" {
  if (source.type && source.type !== "auto") return source.type;
  if (HLS_EXT.test(source.src)) return "hls";
  if (WEBM_EXT.test(source.src)) return "webm";
  if (OGG_EXT.test(source.src)) return "ogg";
  if (MP4_EXT.test(source.src)) return "mp4";
  return "auto";
}

function mimeFor(type: string): string {
  switch (type) {
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "ogg":
      return "video/ogg";
    default:
      return "";
  }
}

let hlsCtorPromise: Promise<typeof HlsType | null> | null = null;

/** Resolves the hls.js constructor from a global `window.Hls` (script-tag usage) or a dynamic import (bundled usage). Cached so repeated players share one lookup. */
function loadHlsCtor(): Promise<typeof HlsType | null> {
  if (hlsCtorPromise) return hlsCtorPromise;
  hlsCtorPromise = (async () => {
    if (typeof window !== "undefined" && window.Hls) {
      return window.Hls;
    }
    try {
      // Intentionally a bare specifier: bundler consumers resolve it from
      // node_modules, and it stays external in our own build (see
      // vite.config.ts) so the core bundle never pays for it.
      const mod = await import(/* @vite-ignore */ "hls.js");
      const ctor = (mod as { default?: typeof HlsType }).default ?? (mod as unknown as typeof HlsType);
      return ctor ?? null;
    } catch {
      return null;
    }
  })();
  return hlsCtorPromise;
}

export interface PlaybackEngineOptions {
  /** Force a specific engine instead of auto-detecting. Mostly for tests. */
  forceEngine?: "native" | "hlsjs";
}

/**
 * Owns the relationship between a <video> element and its media source.
 * Picks native playback, native-HLS (Safari), or hls.js, and layers a
 * resilience/retry strategy on top so transient network blips and partial
 * files degrade gracefully instead of surfacing a raw MediaError.
 */
export class PlaybackEngine {
  private video: HTMLVideoElement;
  private emitter: EventEmitter;
  private hls: HlsType | null = null;
  private currentSources: LumenSource[] = [];
  private currentType: ReturnType<typeof detectType> | null = null;
  private retryAttempt = 0;
  private destroyed = false;
  private _qualityLevels: LumenQualityLevel[] = [];
  private _isHls = false;
  private resilientEngine: ResilientMp4Engine | null = null;
  private triedResilient = false;
  private boundOnVideoError = this.onVideoError.bind(this);
  private boundOnStalled = this.onStalled.bind(this);
  private boundOnPlaying = () => {
    this.retryAttempt = 0;
  };

  constructor(video: HTMLVideoElement, emitter: EventEmitter, private options: PlaybackEngineOptions = {}) {
    this.video = video;
    this.emitter = emitter;
    this.video.addEventListener("error", this.boundOnVideoError);
    this.video.addEventListener("stalled", this.boundOnStalled);
    this.video.addEventListener("playing", this.boundOnPlaying);
  }

  get isHls(): boolean {
    return this._isHls;
  }

  get qualityLevels(): LumenQualityLevel[] {
    return this._qualityLevels;
  }

  get currentQuality(): LumenQualityLevel | null {
    if (!this.hls || this.hls.currentLevel < 0) return null;
    return this._qualityLevels.find((l) => l.id === this.hls?.currentLevel) ?? null;
  }

  get isAutoQuality(): boolean {
    return !this.hls || this.hls.currentLevel === -1;
  }

  setQuality(id: number | "auto"): void {
    if (!this.hls) return;
    this.hls.currentLevel = id === "auto" ? -1 : id;
    const level = id === "auto" ? null : this._qualityLevels.find((l) => l.id === id) ?? null;
    this.emitter.emit("qualitychange", { level, auto: id === "auto" });
  }

  async load(sources: LumenSource[]): Promise<void> {
    this.currentSources = sources;
    this.teardownHls();
    this.teardownResilient();
    this._qualityLevels = [];
    this.retryAttempt = 0;
    this.triedResilient = false;

    const best = this.pickBestSource(sources);
    if (!best) {
      this.currentType = null;
      this.emitFatal("SRC_NOT_SUPPORTED", "No supported source was provided.");
      return;
    }

    const type = detectType(best);
    this.currentType = type;

    if (type === "hls") {
      await this.loadHls(best.src);
    } else {
      this._isHls = false;
      this.video.src = best.src;
    }
  }

  private pickBestSource(sources: LumenSource[]): LumenSource | undefined {
    // Prefer an explicit HLS source when the browser can play it at all
    // (native or via hls.js — checked lazily during load).
    const hls = sources.find((s) => detectType(s) === "hls");
    if (hls) return hls;

    return sources.find((s) => {
      const type = detectType(s);
      const mime = mimeFor(type);
      if (!mime) return true; // "auto" — let the browser decide
      return this.video.canPlayType(mime) !== "";
    }) ?? sources[0];
  }

  private async loadHls(src: string): Promise<void> {
    const canNative = this.options.forceEngine !== "hlsjs" && this.video.canPlayType("application/vnd.apple.mpegurl") !== "";

    if (canNative && this.options.forceEngine !== "hlsjs") {
      this._isHls = true;
      this.video.src = src;
      return;
    }

    const HlsCtor = await loadHlsCtor();
    if (!HlsCtor || !HlsCtor.isSupported()) {
      if (canNative) {
        this._isHls = true;
        this.video.src = src;
        return;
      }
      this.emitFatal(
        "SRC_NOT_SUPPORTED",
        "HLS playback requires hls.js. Include it via <script src=\"…/hls.min.js\"> or install it as a dependency.",
      );
      return;
    }

    this._isHls = true;
    const hls = new HlsCtor({
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 90,
    });
    this.hls = hls;

    hls.on(HlsCtor.Events.MANIFEST_PARSED, (_evt: unknown, data: { levels: HlsType["levels"] }) => {
      this._qualityLevels = data.levels.map((level, id) => ({
        id,
        height: level.height ?? 0,
        width: level.width ?? 0,
        bitrate: level.bitrate ?? 0,
        label: level.height ? `${level.height}p` : `Level ${id}`,
      }));
      this.emitter.emit("qualitieschange", { levels: this._qualityLevels });
    });

    hls.on(HlsCtor.Events.LEVEL_SWITCHED, (_evt: unknown, data: { level: number }) => {
      const level = this._qualityLevels.find((l) => l.id === data.level) ?? null;
      this.emitter.emit("qualitychange", { level, auto: hls.currentLevel === -1 });
    });

    hls.on(HlsCtor.Events.ERROR, (_evt: unknown, data: ErrorData) => {
      this.onHlsError(HlsCtor, data);
    });

    hls.attachMedia(this.video);
    hls.loadSource(src);
  }

  private onHlsError(HlsCtor: typeof HlsType, data: ErrorData): void {
    if (!data.fatal) return;

    switch (data.type) {
      case HlsCtor.ErrorTypes.NETWORK_ERROR:
        this.retryWithBackoff(() => this.hls?.startLoad(), "NETWORK", "Reconnecting…");
        return;
      case HlsCtor.ErrorTypes.MEDIA_ERROR:
        this.retryWithBackoff(() => this.hls?.recoverMediaError(), "DECODE", "Recovering playback…");
        return;
      default:
        this.emitFatal("MANIFEST_LOAD", data.details ?? "The stream could not be loaded.", data);
        this.teardownHls();
    }
  }

  private onVideoError(): void {
    // If hls.js owns this element, its own ERROR event already handled it.
    if (this.hls) return;

    const error = this.video.error;
    if (!error) return;

    switch (error.code) {
      case MEDIA_ERR_NETWORK:
        this.retryWithBackoff(() => this.reloadProgressive(), "NETWORK", "Reconnecting…");
        break;
      case MEDIA_ERR_DECODE:
        this.retryWithBackoff(() => this.reloadProgressive(), "DECODE", "Recovering playback…");
        break;
      case MEDIA_ERR_SRC_NOT_SUPPORTED:
        // A malformed/incomplete moov often surfaces as "not supported"
        // immediately, with no retries in between — worth one resilient
        // attempt before accepting that verdict for a progressive MP4.
        if (!this._isHls && this.currentType === "mp4" && !this.triedResilient) {
          this.triedResilient = true;
          void this.tryResilientRecovery("SRC_NOT_SUPPORTED");
        } else {
          this.emitFatal("SRC_NOT_SUPPORTED", "This video format isn't supported by your browser.", error);
        }
        break;
      default:
        this.emitFatal("UNKNOWN", "Playback stopped unexpectedly.", error);
    }
  }

  private onStalled(): void {
    this.emitter.emit("waiting", undefined);
  }

  private reloadProgressive(): void {
    const time = this.video.currentTime;
    const wasPlaying = !this.video.paused;
    const src = this.currentSources[0]?.src;
    if (!src) return;

    // Cache-bust so a range request against a since-completed upload (a
    // common cause of "partial" MP4 failures) re-fetches full headers.
    const url = new URL(src, window.location.href);
    url.searchParams.set("_lumen_retry", String(Date.now()));
    this.video.src = url.toString();
    this.video.currentTime = time;
    if (wasPlaying) {
      this.video.play().catch(() => {
        /* autoplay policies may block this; user can press play */
      });
    }
  }

  private retryWithBackoff(action: () => void, code: LumenError["code"], statusMessage: string): void {
    if (this.destroyed) return;
    if (this.retryAttempt >= RETRY_BACKOFF_MS.length) {
      this.exhaustedRetries(code);
      return;
    }

    const wait = RETRY_BACKOFF_MS[this.retryAttempt] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1] ?? 4000;
    this.retryAttempt += 1;
    this.emitter.emit("error", { code, message: statusMessage, fatal: false });

    void delay(wait).then(() => {
      if (this.destroyed) return;
      action();
    });
  }

  /** Standard retries are exhausted. For a plain progressive MP4, make one last attempt via the mp4box.js/MSE fallback before giving up — see ResilientMp4Engine. */
  private exhaustedRetries(code: LumenError["code"]): void {
    const canTryResilient = !this._isHls && this.currentType === "mp4" && !this.triedResilient;
    if (!canTryResilient) {
      this.emitPermanentFailure(code);
      return;
    }
    this.triedResilient = true;
    void this.tryResilientRecovery(code);
  }

  private async tryResilientRecovery(code: LumenError["code"]): Promise<void> {
    const src = this.currentSources.find((s) => detectType(s) === "mp4")?.src ?? this.currentSources[0]?.src;
    if (!src) {
      this.emitPermanentFailure(code);
      return;
    }

    const engine = new ResilientMp4Engine(this.video, this.emitter);
    this.resilientEngine = engine;
    const recovered = await engine.attempt(src);
    if (this.destroyed) return;

    if (!recovered) {
      this.resilientEngine = null;
      this.emitPermanentFailure(code);
    }
    // On success, ResilientMp4Engine has already pointed the <video> at its
    // own MediaSource; ordinary <video> events drive playback from here.
  }

  private emitPermanentFailure(code: LumenError["code"]): void {
    this.emitFatal(
      code,
      "This video couldn't finish loading. It may be incomplete or the connection is unstable.",
    );
  }

  private emitFatal(code: LumenError["code"], message: string, raw?: unknown): void {
    this.emitter.emit("error", { code, message, fatal: true, raw });
  }

  private teardownHls(): void {
    this.hls?.destroy();
    this.hls = null;
    this._isHls = false;
  }

  private teardownResilient(): void {
    this.resilientEngine?.destroy();
    this.resilientEngine = null;
  }

  destroy(): void {
    this.destroyed = true;
    this.video.removeEventListener("error", this.boundOnVideoError);
    this.video.removeEventListener("stalled", this.boundOnStalled);
    this.video.removeEventListener("playing", this.boundOnPlaying);
    this.teardownHls();
    this.teardownResilient();
  }
}
