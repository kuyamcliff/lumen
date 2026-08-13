import playerStyles from "./styles/player.css?inline";
import { renderShell } from "./ui/template";
import { EventEmitter } from "./core/EventEmitter";
import { PlaybackEngine } from "./core/PlaybackEngine";
import { SubtitleManager } from "./subtitles/SubtitleManager";
import { ControlsController } from "./ui/ControlsController";
import type {
  LumenEventMap,
  LumenEventName,
  LumenQualityLevel,
  LumenSource,
  LumenTextTrackInit,
  LumenTheme,
  SubtitleStylePrefs,
} from "./types";

const OBSERVED = [
  "src",
  "poster",
  "autoplay",
  "loop",
  "muted",
  "playsinline",
  "crossorigin",
  "preload",
  "theme",
  "aspect-ratio",
  "object-fit",
  "thumbnails",
] as const;

/**
 * `<lumen-player>` — a framework-agnostic Web Component video player.
 *
 * Minimal usage:
 * ```html
 * <lumen-player src="https://example.com/video.m3u8" poster="poster.jpg"></lumen-player>
 * ```
 */
export class LumenPlayer extends HTMLElement {
  static readonly observedAttributes = OBSERVED;

  private emitter = new EventEmitter();
  private engine!: PlaybackEngine;
  private subtitles!: SubtitleManager;
  private controls!: ControlsController;
  private video!: HTMLVideoElement;
  private root!: HTMLElement;
  private connected = false;
  private pendingSources: LumenSource[] = [];

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = playerStyles;
    shadow.appendChild(style);

    const wrapper = document.createElement("div");
    wrapper.innerHTML = renderShell();
    const shell = wrapper.firstElementChild as HTMLElement;
    shadow.appendChild(shell);

    this.root = shell;
    this.video = shell.querySelector("video") as HTMLVideoElement;
  }

  connectedCallback(): void {
    if (this.connected) return;
    this.connected = true;

    this.video.playsInline = true;
    if (this.hasAttribute("crossorigin")) {
      this.video.crossOrigin = this.getAttribute("crossorigin") || "anonymous";
    }
    if (this.hasAttribute("preload")) {
      this.video.preload = this.getAttribute("preload") as HTMLVideoElement["preload"];
    } else {
      this.video.preload = "metadata";
    }
    this.video.loop = this.hasAttribute("loop");
    this.video.muted = this.hasAttribute("muted");
    this.video.autoplay = this.hasAttribute("autoplay");

    this.engine = new PlaybackEngine(this.video, this.emitter);
    const captionsOverlay = this.root.querySelector(".lumen-captions") as HTMLElement;
    this.subtitles = new SubtitleManager(this.video, captionsOverlay, this.emitter);

    this.controls = new ControlsController({
      root: this.root,
      video: this.video,
      host: this,
      emitter: this.emitter,
      engine: this.engine,
      subtitles: this.subtitles,
      retry: () => this.engine.load(this.pendingSources),
    });

    this.applyTheme();
    this.applyAspectRatio();
    this.applyObjectFit();
    if (this.hasAttribute("poster")) this.controls.setPoster(this.getAttribute("poster"));
    if (this.hasAttribute("thumbnails")) void this.controls.setThumbnails(this.getAttribute("thumbnails"));

    this.ingestLightDomTracks();
    this.ingestLightDomSources();

    this.emitter.emit("ready", undefined);
  }

  disconnectedCallback(): void {
    // Keep engine/controls alive across a reparent (e.g. moving into a
    // fullscreen-friendly wrapper) — only tear down on explicit destroy().
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (!this.connected || oldValue === newValue) return;
    switch (name) {
      case "src":
        this.ingestLightDomSources();
        break;
      case "poster":
        this.controls.setPoster(newValue);
        break;
      case "autoplay":
        this.video.autoplay = newValue !== null;
        break;
      case "loop":
        this.video.loop = newValue !== null;
        break;
      case "muted":
        this.video.muted = newValue !== null;
        break;
      case "crossorigin":
        this.video.crossOrigin = newValue;
        break;
      case "preload":
        if (newValue) this.video.preload = newValue as HTMLVideoElement["preload"];
        break;
      case "theme":
        this.applyTheme();
        break;
      case "aspect-ratio":
        this.applyAspectRatio();
        break;
      case "object-fit":
        this.applyObjectFit();
        break;
      case "thumbnails":
        void this.controls.setThumbnails(newValue);
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------- setup

  private applyTheme(): void {
    const theme = (this.getAttribute("theme") as LumenTheme | "system" | null) ?? "dark";
    this.setAttribute("data-theme", theme);
  }

  private applyAspectRatio(): void {
    const ratio = this.getAttribute("aspect-ratio");
    if (ratio) {
      this.style.setProperty("--lumen-aspect-ratio", ratio.replace("/", " / "));
    }
  }

  private applyObjectFit(): void {
    const fit = this.getAttribute("object-fit");
    if (fit) this.style.setProperty("--lumen-object-fit", fit);
  }

  private ingestLightDomSources(): void {
    const sources: LumenSource[] = [];
    const srcAttr = this.getAttribute("src");
    if (srcAttr) sources.push({ src: srcAttr });

    for (const el of Array.from(this.querySelectorAll(":scope > source"))) {
      const src = el.getAttribute("src");
      if (!src) continue;
      sources.push({ src, type: (el.getAttribute("data-lumen-type") as LumenSource["type"]) ?? "auto" });
    }

    if (sources.length === 0) return;
    void this.load(sources);
  }

  private ingestLightDomTracks(): void {
    for (const el of Array.from(this.querySelectorAll(":scope > track"))) {
      const src = el.getAttribute("src");
      if (!src) continue;
      const init: LumenTextTrackInit = {
        src,
        kind: (el.getAttribute("kind") as TextTrackKind) ?? "subtitles",
        label: el.getAttribute("label") ?? el.getAttribute("srclang") ?? "Subtitles",
        srclang: el.getAttribute("srclang") ?? "en",
        default: el.hasAttribute("default"),
      };
      this.subtitles.addTrack(init);
    }
    this.subtitles.restorePreference();
  }

  // ------------------------------------------------------------ public API

  async load(sources: LumenSource | LumenSource[]): Promise<void> {
    this.pendingSources = Array.isArray(sources) ? sources : [sources];
    await this.engine?.load(this.pendingSources);
  }

  play(): Promise<void> {
    return this.video.play();
  }

  pause(): void {
    this.video.pause();
  }

  seek(time: number): void {
    this.video.currentTime = time;
  }

  requestFullscreen(): Promise<void> {
    return super.requestFullscreen();
  }

  requestPictureInPicture(): Promise<PictureInPictureWindow> {
    return this.video.requestPictureInPicture();
  }

  addTextTrack(init: LumenTextTrackInit): void {
    this.subtitles.addTrack(init);
  }

  setSubtitlePrefs(prefs: Partial<SubtitleStylePrefs>): void {
    this.subtitles.setPrefs(prefs);
  }

  get subtitlePrefs(): SubtitleStylePrefs {
    return this.subtitles.prefs;
  }

  get textTracks(): TextTrack[] {
    return this.subtitles?.tracks ?? [];
  }

  get qualityLevels(): LumenQualityLevel[] {
    return this.engine?.qualityLevels ?? [];
  }

  get currentQuality(): LumenQualityLevel | null {
    return this.engine?.currentQuality ?? null;
  }

  setQuality(id: number | "auto"): void {
    this.engine?.setQuality(id);
  }

  get currentTime(): number {
    return this.video?.currentTime ?? 0;
  }
  set currentTime(value: number) {
    this.video.currentTime = value;
  }

  get duration(): number {
    return this.video?.duration ?? NaN;
  }

  get paused(): boolean {
    return this.video?.paused ?? true;
  }

  get ended(): boolean {
    return this.video?.ended ?? false;
  }

  get volume(): number {
    return this.video?.volume ?? 1;
  }
  set volume(value: number) {
    this.video.volume = value;
  }

  get muted(): boolean {
    return this.video?.muted ?? false;
  }
  set muted(value: boolean) {
    this.video.muted = value;
  }

  get playbackRate(): number {
    return this.video?.playbackRate ?? 1;
  }
  set playbackRate(value: number) {
    this.video.playbackRate = value;
  }

  get videoElement(): HTMLVideoElement {
    return this.video;
  }

  on<K extends LumenEventName>(event: K, listener: (detail: LumenEventMap[K]) => void): () => void {
    return this.emitter.on(event, listener);
  }

  once<K extends LumenEventName>(event: K, listener: (detail: LumenEventMap[K]) => void): () => void {
    return this.emitter.once(event, listener);
  }

  off<K extends LumenEventName>(event: K, listener: (detail: LumenEventMap[K]) => void): void {
    this.emitter.off(event, listener);
  }

  destroy(): void {
    this.emitter.emit("destroy", undefined);
    this.controls?.destroy();
    this.subtitles?.destroy();
    this.engine?.destroy();
    this.emitter.clear();
  }
}
