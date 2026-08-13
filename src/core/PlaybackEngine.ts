import type HlsType from "hls.js";
import type { ErrorData } from "hls.js";
import type { EventEmitter } from "./EventEmitter";
import type { LumenAudioTrack, LumenError, LumenQualityLevel, LumenSource, LumenSourceType } from "../types";
import { RETRY_BACKOFF_MS, delay } from "../utils/retry";
import { ResilientMp4Engine } from "./ResilientMp4Engine";
import { containerLabel, probeContainer, type ContainerKind } from "./containers";
import type { MatroskaRemuxEngine } from "../remux/MatroskaRemuxEngine";
import type { DashEngine } from "./DashEngine";
import type { FlvRemuxEngine } from "../remux/FlvRemuxEngine";
import type { DrmController } from "./DrmController";

declare global {
  interface Window {
    Hls?: typeof HlsType;
  }
}

/**
 * Minimal shape of the `AudioTrackList` API. TypeScript's DOM lib omits it
 * because support is uneven (Safari implements it; Chrome does not), but
 * where it exists it's the only way to switch audio on native playback.
 */
interface AudioTrackListLike {
  readonly length: number;
  [index: number]: { id: string; label: string; language: string; enabled: boolean };
}

// WHATWG MediaError codes (https://html.spec.whatwg.org/#error-codes), used
// as numeric literals rather than `MediaError.MEDIA_ERR_*` — the global
// MediaError constructor isn't implemented in every environment that runs
// this code (e.g. jsdom-based tests), even though the values themselves are
// a stable part of the spec.
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

const EXTENSION_TYPES: Array<[RegExp, LumenSourceType]> = [
  [/\.m3u8($|\?)/i, "hls"],
  [/\.webm($|\?)/i, "webm"],
  [/\.og[gv]($|\?)/i, "ogg"],
  [/\.mp4($|\?)/i, "mp4"],
  [/\.m4v($|\?)/i, "mp4"],
  [/\.mov($|\?)/i, "mov"],
  [/\.qt($|\?)/i, "mov"],
  [/\.mkv($|\?)/i, "mkv"],
  [/\.mka($|\?)/i, "mkv"],
  [/\.(ts|m2ts|mts)($|\?)/i, "ts"],
  [/\.mpd($|\?)/i, "dash"],
  [/\.flv($|\?)/i, "flv"],
];

function detectType(source: LumenSource): LumenSourceType {
  if (source.type && source.type !== "auto") return source.type;
  for (const [pattern, type] of EXTENSION_TYPES) {
    if (pattern.test(source.src)) return type;
  }
  return "auto";
}

function mimeFor(type: LumenSourceType): string {
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

/**
 * Extensions we trust enough to skip byte-sniffing.
 *
 * Probing costs an extra round trip, so formats the browser plays natively
 * take the fast path straight to the video element. Everything else —
 * including anything with a misleading or missing extension — gets
 * sniffed, because that's exactly where extensions can't be trusted.
 */
const NATIVE_FAST_PATH = new Set<LumenSourceType>(["hls", "mp4", "webm", "ogg"]);

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
  /** Supplies DRM configuration to whichever pipeline ends up playing. */
  drm?: () => DrmController | null;
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
  private matroskaEngine: MatroskaRemuxEngine | null = null;
  private dashEngine: DashEngine | null = null;
  private flvEngine: FlvRemuxEngine | null = null;
  private triedResilient = false;
  private currentContainer: ContainerKind | null = null;
  /** Incremented on every load() so a slow async probe can't apply to a newer source. */
  private loadToken = 0;
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
    if (this.dashEngine) return this.dashEngine.qualityLevels;
    return this._qualityLevels;
  }

  get currentQuality(): LumenQualityLevel | null {
    if (this.dashEngine) return this.dashEngine.currentQuality;
    if (!this.hls || this.hls.currentLevel < 0) return null;
    return this._qualityLevels.find((l) => l.id === this.hls?.currentLevel) ?? null;
  }

  get isAutoQuality(): boolean {
    if (this.dashEngine) return this.dashEngine.isAutoQuality;
    return !this.hls || this.hls.currentLevel === -1;
  }

  /** True when an adaptive engine (HLS or DASH) is driving playback. */
  get isAdaptive(): boolean {
    return this._isHls || this.dashEngine !== null;
  }

  setQuality(id: number | "auto"): void {
    if (this.dashEngine) {
      this.dashEngine.setQuality(id);
      return;
    }
    if (!this.hls) return;
    this.hls.currentLevel = id === "auto" ? -1 : id;
    const level = id === "auto" ? null : this._qualityLevels.find((l) => l.id === id) ?? null;
    this.emitter.emit("qualitychange", { level, auto: id === "auto" });
  }

  /**
   * Audio tracks from whichever pipeline is driving playback: hls.js for
   * adaptive streams, the element's own `audioTracks` where the browser
   * implements it (Safari), or the Matroska remuxer for MKV.
   */
  get audioTracks(): LumenAudioTrack[] {
    if (this.hls) {
      return this.hls.audioTracks.map((track, index) => ({
        id: String(track.id ?? index),
        label: track.name || track.lang || `Track ${index + 1}`,
        language: track.lang ?? "",
        active: this.hls?.audioTrack === (track.id ?? index),
      }));
    }

    if (this.dashEngine) return this.dashEngine.audioTracks;
    if (this.matroskaEngine) return this.matroskaEngine.audioTracks;

    const native = (this.video as HTMLVideoElement & { audioTracks?: AudioTrackListLike }).audioTracks;
    if (native && native.length > 0) {
      return Array.from({ length: native.length }, (_, index) => {
        const track = native[index]!;
        return {
          id: track.id || String(index),
          label: track.label || track.language || `Track ${index + 1}`,
          language: track.language ?? "",
          active: track.enabled,
        };
      });
    }

    return [];
  }

  setAudioTrack(id: string): void {
    if (this.dashEngine) {
      this.dashEngine.setAudioTrack(id);
      this.emitAudioTrackChange(id);
      return;
    }
    if (this.hls) {
      const index = this.hls.audioTracks.findIndex((track, i) => String(track.id ?? i) === id);
      if (index >= 0) this.hls.audioTrack = this.hls.audioTracks[index]!.id ?? index;
      this.emitAudioTrackChange(id);
      return;
    }

    if (this.matroskaEngine) {
      void this.matroskaEngine.selectAudioTrack(id).then(() => this.emitAudioTrackChange(id));
      return;
    }

    const native = (this.video as HTMLVideoElement & { audioTracks?: AudioTrackListLike }).audioTracks;
    if (native) {
      for (let i = 0; i < native.length; i++) {
        const track = native[i]!;
        track.enabled = (track.id || String(i)) === id;
      }
      this.emitAudioTrackChange(id);
    }
  }

  private emitAudioTrackChange(id: string): void {
    const track = this.audioTracks.find((t) => t.id === id) ?? null;
    this.emitter.emit("audiotrackchange", { track });
  }

  async load(sources: LumenSource[]): Promise<void> {
    this.currentSources = sources;
    this.teardownHls();
    this.teardownResilient();
    this.teardownMatroska();
    this.teardownDash();
    this.teardownFlv();
    this._qualityLevels = [];
    this.retryAttempt = 0;
    this.triedResilient = false;
    this.currentContainer = null;
    const token = ++this.loadToken;

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
      return;
    }

    if (type === "dash") {
      await this.loadDash(best.src);
      return;
    }

    this._isHls = false;

    // Formats the browser handles natively go straight to the element —
    // no probe, no extra request, byte-for-byte the old fast path.
    if (NATIVE_FAST_PATH.has(type)) {
      this.video.src = best.src;
      return;
    }

    await this.loadByContainer(best.src, token);
  }

  /**
   * Routes a non-native source by what its bytes actually say it is.
   *
   * Extensions and Content-Type headers are unreliable, so anything that
   * isn't already known-native is sniffed and dispatched to the demuxer
   * that can genuinely handle it.
   */
  private async loadByContainer(src: string, token: number): Promise<void> {
    const container = await probeContainer(src);
    if (this.destroyed || token !== this.loadToken) return;
    this.currentContainer = container;

    switch (container) {
      case "matroska":
        await this.loadMatroska(src, token);
        return;

      case "mpeg-ts":
        await this.loadTransportStream(src);
        return;

      case "flv":
        await this.loadFlv(src, token);
        return;

      case "iso-bmff":
      case "webm":
      case "ogg":
      case "unknown":
        // Native first: MOV, oddly-branded MP4s and extension-less files
        // very often play directly, and when they don't the existing
        // error path falls through to the mp4box remuxer.
        this.video.src = src;
        return;

      default:
        this.emitFatal(
          "CONTAINER_UNSUPPORTED",
          `${containerLabel(container)} files can't be played in a browser. Converting this to MP4 or WebM will fix it.`,
        );
    }
  }

  /** Plays FLV by remuxing to fragmented MP4 — Flash is gone, its files aren't. */
  private async loadFlv(src: string, token: number): Promise<void> {
    const { FlvRemuxEngine } = await import("../remux/FlvRemuxEngine");
    if (this.destroyed || token !== this.loadToken) return;

    const engine = new FlvRemuxEngine(this.video, this.emitter);
    this.flvEngine = engine;

    const ok = await engine.attempt(src);
    if (this.destroyed || token !== this.loadToken) return;
    if (!ok) {
      this.teardownFlv();
      this.emitFatal(
        "CONTAINER_UNSUPPORTED",
        "This FLV file couldn't be played. Its codecs may not be supported by your browser.",
      );
    }
  }

  /** Plays an MPEG-DASH manifest through dash.js. */
  private async loadDash(src: string): Promise<void> {
    const { DashEngine } = await import("./DashEngine");
    if (this.destroyed) return;

    const engine = new DashEngine(this.video, this.emitter);
    const loaded = await engine.load(src, this.options.drm?.() ?? null);
    if (this.destroyed) return;

    if (!loaded) {
      this.emitFatal(
        "SRC_NOT_SUPPORTED",
        "DASH playback requires dash.js. Include it via a script tag or install it as a dependency.",
      );
      return;
    }
    this.dashEngine = engine;
  }

  /** Plays Matroska by remuxing to fragmented MP4 — no browser plays it directly. */
  private async loadMatroska(src: string, token: number): Promise<void> {
    const { MatroskaRemuxEngine } = await import("../remux/MatroskaRemuxEngine");
    if (this.destroyed || token !== this.loadToken) return;

    const engine = new MatroskaRemuxEngine(this.video, this.emitter);
    this.matroskaEngine = engine;

    const ok = await engine.attempt(src);
    if (this.destroyed || token !== this.loadToken) return;
    if (!ok) {
      this.teardownMatroska();
      this.emitFatal(
        "CONTAINER_UNSUPPORTED",
        "This Matroska file couldn't be played. Its video codec may not be supported by your browser.",
      );
    }
  }

  /**
   * Plays a raw MPEG-TS through hls.js, which already contains a
   * transport-stream transmuxer — handing it a one-entry playlist reuses
   * that instead of duplicating a TS demuxer here.
   */
  private async loadTransportStream(src: string): Promise<void> {
    const HlsCtor = await loadHlsCtor();
    if (this.destroyed) return;

    if (!HlsCtor || !HlsCtor.isSupported()) {
      this.emitFatal(
        "CONTAINER_UNSUPPORTED",
        "Playing MPEG-TS files requires hls.js. Include it via a script tag or install it as a dependency.",
      );
      return;
    }

    const playlist = ["#EXTM3U", "#EXT-X-TARGETDURATION:10", "#EXTINF:10,", src, "#EXT-X-ENDLIST"].join("\n");
    this.attachHls(HlsCtor, `data:application/vnd.apple.mpegurl;base64,${btoa(playlist)}`);
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

    this.attachHls(HlsCtor, src);
  }

  /** Creates an hls.js instance, wires its events, and points it at a manifest. */
  private attachHls(HlsCtor: typeof HlsType, manifestUrl: string): void {
    this._isHls = true;
    const drm = this.options.drm?.() ?? null;
    const hls = new HlsCtor({
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 90,
      ...(drm?.isConfigured ? { drmSystems: drm.toHlsConfig(), emeEnabled: true } : {}),
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
    hls.loadSource(manifestUrl);
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
        // immediately, with no retries in between. It's also what a
        // perfectly healthy MOV gets, since browsers reject the
        // `video/quicktime` MIME while still being able to decode what's
        // inside — so both cases are worth one remux attempt.
        if (!this._isHls && this.canRemuxAsIsoBmff() && !this.triedResilient) {
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

  /**
   * True when the current source belongs to the ISO-BMFF family, which is
   * what the mp4box.js remuxer understands. Covers MOV and other brands,
   * not just files that happen to end in `.mp4`.
   */
  private canRemuxAsIsoBmff(): boolean {
    if (this.currentContainer) return this.currentContainer === "iso-bmff";
    return this.currentType === "mp4" || this.currentType === "mov";
  }

  /** Standard retries are exhausted. For ISO-BMFF sources, make one last attempt via the mp4box.js/MSE fallback before giving up — see ResilientMp4Engine. */
  private exhaustedRetries(code: LumenError["code"]): void {
    const canTryResilient = !this._isHls && this.canRemuxAsIsoBmff() && !this.triedResilient;
    if (!canTryResilient) {
      this.emitPermanentFailure(code);
      return;
    }
    this.triedResilient = true;
    void this.tryResilientRecovery(code);
  }

  private async tryResilientRecovery(code: LumenError["code"]): Promise<void> {
    const isIsoBmff = (source: LumenSource) => {
      const type = detectType(source);
      return type === "mp4" || type === "mov";
    };
    const src = this.currentSources.find(isIsoBmff)?.src ?? this.currentSources[0]?.src;
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

  private teardownMatroska(): void {
    this.matroskaEngine?.destroy();
    this.matroskaEngine = null;
  }

  private teardownDash(): void {
    this.dashEngine?.destroy();
    this.dashEngine = null;
  }

  private teardownFlv(): void {
    this.flvEngine?.destroy();
    this.flvEngine = null;
  }

  destroy(): void {
    this.destroyed = true;
    this.video.removeEventListener("error", this.boundOnVideoError);
    this.video.removeEventListener("stalled", this.boundOnStalled);
    this.video.removeEventListener("playing", this.boundOnPlaying);
    this.teardownHls();
    this.teardownResilient();
    this.teardownMatroska();
    this.teardownDash();
    this.teardownFlv();
  }
}
