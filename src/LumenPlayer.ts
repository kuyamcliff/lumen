import playerStyles from "./styles/player.css?inline";
import { renderShell } from "./ui/template";
import { EventEmitter } from "./core/EventEmitter";
import { PlaybackEngine } from "./core/PlaybackEngine";
import { SubtitleManager } from "./subtitles/SubtitleManager";
import { ControlsController } from "./ui/ControlsController";
import { ChapterManager } from "./media/ChapterManager";
import { CastController } from "./media/CastController";
import { enterFullscreen, exitFullscreen, isFullscreen } from "./media/fullscreen";
import { safePlay } from "./utils/dom";
import { Translator, type LumenStrings } from "./i18n";
import { DrmController, type LumenDrmConfig } from "./core/DrmController";
import type { LumenPlugin } from "./plugins/types";
import type {
  LumenAudioTrack,
  LumenChapter,
  LumenEventMap,
  LumenEventName,
  LumenPlaylistItem,
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
  "chapters",
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
  private chapterManager!: ChapterManager;
  private castController!: CastController;
  private controls!: ControlsController;
  private video!: HTMLVideoElement;
  private root!: HTMLElement;
  private connected = false;
  private pendingSources: LumenSource[] = [];
  private translator = new Translator();
  private items: LumenPlaylistItem[] = [];
  private itemIndex = -1;
  private drmController: DrmController | null = null;
  private drmConfig: LumenDrmConfig = {};
  private plugins: LumenPlugin[] = [];
  private pluginTeardowns: Array<() => void> = [];

  /** Plugins applied to every player instance created afterwards. */
  private static globalPlugins: LumenPlugin[] = [];

  /** Registers a plugin for all future players. */
  static use(plugin: LumenPlugin): void {
    LumenPlayer.globalPlugins.push(plugin);
  }

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

    this.engine = new PlaybackEngine(this.video, this.emitter, {
      drm: () => this.drmController,
    });
    const captionsOverlay = this.root.querySelector(".lumen-captions") as HTMLElement;
    this.subtitles = new SubtitleManager(this.video, captionsOverlay, this.emitter);
    this.chapterManager = new ChapterManager(this.video, this.emitter);
    this.castController = new CastController(this.video, (available) =>
      this.emitter.emit("castavailabilitychange", { available }),
    );

    this.controls = new ControlsController({
      root: this.root,
      video: this.video,
      host: this,
      emitter: this.emitter,
      engine: this.engine,
      subtitles: this.subtitles,
      chapters: this.chapterManager,
      cast: this.castController,
      strings: this.translator,
      playlist: {
        hasPlaylist: () => this.items.length > 1,
        hasNext: () => this.itemIndex >= 0 && this.itemIndex < this.items.length - 1,
        hasPrevious: () => this.itemIndex > 0,
        next: () => this.next(),
        previous: () => this.previous(),
      },
      retry: () => this.engine.load(this.pendingSources),
    });

    // Advancing a playlist is the one place the player reacts to `ended`
    // itself; without a playlist it stays out of the way.
    this.video.addEventListener("ended", () => {
      if (this.video.loop) return;
      if (this.itemIndex >= 0 && this.itemIndex < this.items.length - 1) this.next();
    });

    this.applyTheme();
    this.applyAspectRatio();
    this.applyObjectFit();
    if (this.hasAttribute("poster")) this.controls.setPoster(this.getAttribute("poster"));
    if (this.hasAttribute("thumbnails")) void this.controls.setThumbnails(this.getAttribute("thumbnails"));
    if (this.hasAttribute("chapters")) this.chapterManager.addTrackElement(this.getAttribute("chapters")!);

    this.ingestLightDomTracks();
    this.chapterManager.adoptExisting();
    this.ingestLightDomSources();

    for (const plugin of [...LumenPlayer.globalPlugins, ...this.plugins]) {
      this.applyPlugin(plugin);
    }

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
      case "chapters":
        // Observed but never handled: pointing the attribute at a new VTT
        // after mount left the old chapters in place.
        this.chapterManager.reset();
        if (newValue) this.chapterManager.addTrackElement(newValue);
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
    // Removing the attribute has to remove the property too, or the shape
    // set once could never be undone.
    if (ratio) this.style.setProperty("--lumen-aspect-ratio", ratio.replace("/", " / "));
    else this.style.removeProperty("--lumen-aspect-ratio");
  }

  private applyObjectFit(): void {
    const fit = this.getAttribute("object-fit");
    if (fit) this.style.setProperty("--lumen-object-fit", fit);
    else this.style.removeProperty("--lumen-object-fit");
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

  /** Loads a source. Accepts a URL string, a source object, or a list of fallbacks. */
  async load(sources: string | LumenSource | LumenSource[]): Promise<void> {
    const list = Array.isArray(sources) ? sources : [sources];
    this.pendingSources = list.map((source) => (typeof source === "string" ? { src: source } : source));
    await this.engine?.load(this.pendingSources);
  }

  play(): Promise<void> {
    return safePlay(this.video);
  }

  pause(): void {
    this.video.pause();
  }

  seek(time: number): void {
    this.video.currentTime = time;
  }

  /**
   * Overrides `Element.requestFullscreen` so the prefixed and iOS paths are
   * covered. Always returns a promise — the inherited method doesn't even
   * exist on iPhone, so calling it there threw synchronously and no
   * `.catch()` could help.
   */
  requestFullscreen(): Promise<void> {
    return enterFullscreen(this, this.video);
  }

  exitFullscreen(): Promise<void> {
    return exitFullscreen(this.video);
  }

  get isFullscreen(): boolean {
    return isFullscreen(this, this.video);
  }

  async requestPictureInPicture(): Promise<PictureInPictureWindow> {
    // Not every browser implements PiP; rejecting is something a caller can
    // handle, throwing synchronously from an async-looking call is not.
    if (typeof this.video.requestPictureInPicture !== "function") {
      throw new Error("Picture-in-Picture is not available");
    }
    return this.video.requestPictureInPicture();
  }

  addTextTrack(init: LumenTextTrackInit): void {
    this.subtitles.addTrack(init);
  }

  // ------------------------------------------------------------- playlist

  /**
   * The queue of items to play. Setting it loads the first entry; playback
   * advances automatically when each item ends.
   */
  get playlist(): LumenPlaylistItem[] {
    return this.items;
  }

  set playlist(items: LumenPlaylistItem[]) {
    this.items = [...items];
    this.emitter.emit("playlistchange", { items: this.items });
    this.controls?.refreshPlaylistButtons();
    if (this.items.length > 0) void this.playItem(0);
  }

  get playlistIndex(): number {
    return this.itemIndex;
  }

  /** Loads a specific playlist entry. Out-of-range indices are ignored. */
  async playItem(index: number): Promise<void> {
    const item = this.items[index];
    if (!item) return;

    this.itemIndex = index;

    // Each item owns its own subtitles, chapters and artwork, so anything
    // carried over from the previous one has to go.
    this.clearItemState();

    if (item.poster) this.controls.setPoster(item.poster);
    if (item.thumbnails) void this.controls.setThumbnails(item.thumbnails);
    if (item.chapters) this.chapterManager.addTrackElement(item.chapters);
    for (const track of item.tracks ?? []) this.subtitles.addTrack(track);

    this.controls.refreshPlaylistButtons();
    this.emitter.emit("playlistitemchange", { item, index });
    if (item.title) this.controls.announce(this.translator.t("nowPlaying", item.title));

    await this.load(item.src);
    // Autoplay only once the playlist is already rolling, so setting a
    // playlist doesn't start playback the user never asked for.
    if (index > 0) void safePlay(this.video).catch(() => {});
  }

  next(): void {
    if (this.itemIndex < this.items.length - 1) void this.playItem(this.itemIndex + 1);
  }

  previous(): void {
    if (this.itemIndex > 0) void this.playItem(this.itemIndex - 1);
  }

  private clearItemState(): void {
    this.subtitles.setActiveTrack(null);
    // Including the thumbnail track: an item without its own sprite sheet
    // used to keep showing the previous item's frames on hover.
    void this.controls.setThumbnails(null);
    for (const element of Array.from(this.video.querySelectorAll("track"))) {
      element.remove();
    }
    this.chapterManager.reset();
    this.controls.setPoster(null);
  }

  // ------------------------------------------------------------- chapters

  get chapters(): LumenChapter[] {
    return this.chapterManager?.chapters ?? [];
  }

  setChapters(chapters: LumenChapter[]): void {
    this.chapterManager.setChapters(chapters);
  }

  /** The chapter containing the current playback position, if any. */
  get currentChapter(): LumenChapter | null {
    return this.chapterManager?.chapterAt(this.video.currentTime) ?? null;
  }

  // ---------------------------------------------------------- audio tracks

  get audioTracks(): LumenAudioTrack[] {
    return this.engine?.audioTracks ?? [];
  }

  setAudioTrack(id: string): void {
    this.engine?.setAudioTrack(id);
  }

  // ----------------------------------------------------------------- i18n

  /** Replaces any subset of the UI strings; omitted keys stay English. */
  setTranslations(strings: Partial<LumenStrings>): void {
    this.translator.set(strings);
    this.controls?.retranslate();
  }

  // --------------------------------------------------------------- plugins

  /**
   * Registers a plugin on this player. Safe to call before or after the
   * element is connected — plugins registered early run at mount.
   */
  use(plugin: LumenPlugin): this {
    this.plugins.push(plugin);
    if (this.connected) this.applyPlugin(plugin);
    return this;
  }

  private applyPlugin(plugin: LumenPlugin): void {
    try {
      const teardown = plugin.setup(this);
      if (typeof teardown === "function") this.pluginTeardowns.push(teardown);
    } catch {
      // A broken plugin must not take the player down with it.
      this.controls?.announce(`Plugin "${plugin.name}" failed to start`);
    }
  }

  // ------------------------------------------------------------------ drm

  /**
   * DRM configuration. Applies to the next `load()`, and is passed to
   * whichever pipeline plays the stream (native EME, hls.js, or dash.js).
   */
  get drm(): LumenDrmConfig {
    return this.drmConfig;
  }

  set drm(config: LumenDrmConfig) {
    this.drmConfig = config;
    this.drmController?.destroy();
    this.drmController = new DrmController(this.video, config, (message) =>
      this.emitter.emit("error", { code: "DECODE", message, fatal: true }),
    );
    this.drmController.attach();
  }

  // ----------------------------------------------------------------- cast

  /** True when a cast receiver (AirPlay or Remote Playback) is reachable. */
  get isCastAvailable(): boolean {
    return this.castController?.isAvailable ?? false;
  }

  requestCast(): Promise<boolean> {
    return this.castController?.prompt() ?? Promise.resolve(false);
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
    for (const teardown of this.pluginTeardowns) {
      try {
        teardown();
      } catch {
        /* a plugin failing to clean up shouldn't block the rest */
      }
    }
    this.pluginTeardowns = [];
    this.drmController?.destroy();
    this.castController?.destroy();
    this.chapterManager?.destroy();
    this.controls?.destroy();
    this.subtitles?.destroy();
    this.engine?.destroy();
    this.emitter.clear();
  }
}
