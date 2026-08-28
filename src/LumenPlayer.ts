import playerStyles from "./styles/player.css?inline";
import { renderShell } from "./ui/template";
import { EventEmitter } from "./core/EventEmitter";
import { PlaybackEngine } from "./core/PlaybackEngine";
import { SubtitleManager } from "./subtitles/SubtitleManager";
import { ControlsController } from "./ui/ControlsController";
import { ChapterManager } from "./media/ChapterManager";
import { CastController } from "./media/CastController";
import { Translator, type LumenStrings } from "./i18n";
import { DrmController, type LumenDrmConfig } from "./core/DrmController";
import { AudioController, type AudioEffectState } from "./audio/AudioController";
import { VideoFilters, type VideoFilterState } from "./video/VideoFilters";
import { LoopController, type AbLoop, type RepeatMode } from "./media/LoopController";
import { PositionMemory } from "./media/PositionMemory";
import type { MediaInfoProbe, LumenMediaInfo } from "./media/MediaInfo";
import type { SnapshotOptions } from "./media/Snapshot";
import { containerLabel } from "./core/containers";
import { bufferedAhead, clamp, formatTime, timeRanges } from "./utils/time";
import type { LumenPlugin } from "./plugins/types";
import type {
  LumenAudioTrack,
  LumenBookmarkEntry,
  LumenChapter,
  LumenEventMap,
  LumenEventName,
  LumenPanel,
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
  "lang",
  "resume",
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

  private audioController!: AudioController;
  private videoFilters!: VideoFilters;
  private loopController!: LoopController;
  private positions = new PositionMemory();
  /** Frame-rate/bitrate sampler; loaded on demand — see `startProbe`. */
  private probe: MediaInfoProbe | null = null;
  private probeLoading: Promise<MediaInfoProbe | null> | null = null;
  private repeatMode: RepeatMode = "off";
  private shuffleEnabled = false;
  /** Playback order under shuffle; empty when playing in list order. */
  private shuffleOrder: number[] = [];
  /** Object URLs created for local files, revoked when they're replaced. */
  private objectUrls: string[] = [];
  private lastSavedPosition = 0;

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

    this.audioController = new AudioController(this.video, () =>
      this.controls?.announce(this.translator.t("audioEffectsUnavailable")),
    );
    this.videoFilters = new VideoFilters(this.video, this, this.root, () =>
      this.emitter.emit("videofilterchange", { filters: this.videoFilters.filters }),
    );
    this.loopController = new LoopController(this.video, this.emitter);

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
      player: this,
    });

    this.bindPlaybackMemory();

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

  /**
   * Wires the behaviours that outlive a single frame of playback: what
   * happens at the end of an item, and remembering where the viewer got to.
   */
  private bindPlaybackMemory(): void {
    this.video.addEventListener("ended", () => this.onEnded());

    this.video.addEventListener("timeupdate", () => {
      const time = this.video.currentTime;
      // Written at most every five seconds: this runs four times a second
      // and localStorage is synchronous.
      if (Math.abs(time - this.lastSavedPosition) < 5) return;
      this.lastSavedPosition = time;
      this.positions.save(time, this.video.duration);
    });

    this.video.addEventListener("pause", () => {
      this.positions.save(this.video.currentTime, this.video.duration);
    });

    this.video.addEventListener("loadedmetadata", () => {
      this.probe?.reset();
      this.videoFilters.refresh();
      this.controls.refreshTimeline();
      this.maybeResume();
    });
  }

  /**
   * Resumes where the viewer left off, unless `resume="off"` says not to.
   *
   * Only positions far enough from both ends qualify, so this never
   * hijacks a file that was barely started or already finished.
   */
  private maybeResume(): void {
    if (this.getAttribute("resume") === "off") return;
    const position = this.positions.resumePosition(this.video.duration);
    if (position === null) return;
    this.video.currentTime = position;
    this.lastSavedPosition = position;
    this.emitter.emit("resume", { position });
    this.controls.announce(this.translator.t("resumedAt", formatTime(position)));
  }

  /** End-of-item behaviour: repeat, then playlist advance, then nothing. */
  private onEnded(): void {
    this.positions.clearPosition();
    this.lastSavedPosition = 0;
    if (this.video.loop) return;

    if (this.repeatMode === "one") {
      this.video.currentTime = 0;
      void this.video.play().catch(() => {});
      return;
    }

    const nextIndex = this.nextIndex();
    if (nextIndex !== null) void this.playItem(nextIndex);
  }

  /**
   * The index to play after the current one, honouring shuffle and repeat.
   * Returns null when the queue is finished.
   */
  private nextIndex(): number | null {
    if (this.items.length === 0 || this.itemIndex < 0) return null;

    if (this.shuffleEnabled) {
      const position = this.shuffleOrder.indexOf(this.itemIndex);
      const next = this.shuffleOrder[position + 1];
      if (next !== undefined) return next;
      if (this.repeatMode !== "all") return null;
      // A fresh shuffle for the next pass, so a repeat isn't the same order.
      this.reshuffle();
      return this.shuffleOrder[0] ?? null;
    }

    if (this.itemIndex < this.items.length - 1) return this.itemIndex + 1;
    return this.repeatMode === "all" ? 0 : null;
  }

  private previousIndex(): number | null {
    if (this.items.length === 0 || this.itemIndex < 0) return null;

    if (this.shuffleEnabled) {
      const position = this.shuffleOrder.indexOf(this.itemIndex);
      const previous = this.shuffleOrder[position - 1];
      if (previous !== undefined) return previous;
      return this.repeatMode === "all" ? (this.shuffleOrder[this.shuffleOrder.length - 1] ?? null) : null;
    }

    if (this.itemIndex > 0) return this.itemIndex - 1;
    return this.repeatMode === "all" ? this.items.length - 1 : null;
  }

  /** Fisher-Yates over the item indices, keeping the current one first. */
  private reshuffle(): void {
    const order = this.items.map((_, index) => index);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    if (this.itemIndex >= 0) {
      const at = order.indexOf(this.itemIndex);
      if (at > 0) {
        order.splice(at, 1);
        order.unshift(this.itemIndex);
      }
    }
    this.shuffleOrder = order;
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

  /** Loads a source. Accepts a URL string, a source object, or a list of fallbacks. */
  async load(sources: string | LumenSource | LumenSource[]): Promise<void> {
    const list = Array.isArray(sources) ? sources : [sources];
    this.pendingSources = list.map((source) => (typeof source === "string" ? { src: source } : source));
    // Position memory and the A-B loop belong to one file; a new source
    // starts both over.
    this.positions.track(this.pendingSources[0]?.src ?? null);
    this.lastSavedPosition = 0;
    this.loopController?.clear();
    this.probe?.reset();
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
    this.itemIndex = -1;
    if (this.shuffleEnabled) this.reshuffle();
    this.emitter.emit("playlistchange", { items: this.items });
    this.controls?.refreshPlaylistButtons();
    // Shuffle decides where a shuffled queue starts; otherwise it's the top.
    const first = this.shuffleEnabled ? this.shuffleOrder[0] ?? 0 : 0;
    if (this.items.length > 0) void this.playItem(first);
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
    if (index > 0) void this.video.play().catch(() => {});
  }

  next(): void {
    const index = this.nextIndex();
    if (index !== null) void this.playItem(index);
  }

  previous(): void {
    const index = this.previousIndex();
    if (index !== null) void this.playItem(index);
  }

  private clearItemState(): void {
    this.subtitles.setActiveTrack(null);
    for (const element of Array.from(this.video.querySelectorAll("track"))) {
      element.remove();
    }
    this.chapterManager.reset();
    this.controls.setPoster(null);
  }

  // ------------------------------------------- playlist bridge (for the UI)

  hasPlaylist(): boolean {
    return this.items.length > 1;
  }

  hasNext(): boolean {
    return this.nextIndex() !== null;
  }

  hasPrevious(): boolean {
    return this.previousIndex() !== null;
  }

  playlistItems(): LumenPlaylistItem[] {
    return this.items;
  }

  currentPlaylistIndex(): number {
    return this.itemIndex;
  }

  getRepeat(): RepeatMode {
    return this.repeatMode;
  }

  setRepeat(mode: RepeatMode): void {
    this.repeatMode = mode;
    this.emitter.emit("repeatchange", { mode });
    this.controls?.refreshPlaylistButtons();
  }

  /** Convenience alias for `getRepeat()`/`setRepeat()`. */
  get repeat(): RepeatMode {
    return this.repeatMode;
  }

  set repeat(mode: RepeatMode) {
    this.setRepeat(mode);
  }

  getShuffle(): boolean {
    return this.shuffleEnabled;
  }

  setShuffle(shuffle: boolean): void {
    this.shuffleEnabled = shuffle;
    if (shuffle) this.reshuffle();
    else this.shuffleOrder = [];
    this.emitter.emit("shufflechange", { shuffle });
    this.controls?.refreshPlaylistButtons();
  }

  get shuffle(): boolean {
    return this.shuffleEnabled;
  }

  set shuffle(value: boolean) {
    this.setShuffle(value);
  }

  // ------------------------------------------------------ audio effects

  /**
   * The audio processing chain: equalizer, preamp, volume boost, audio
   * delay, stereo routing and the normalizer.
   *
   * ```js
   * player.audio.setPreset("rock");
   * player.audio.set({ boost: 1.5, delayMs: 120 });
   * ```
   *
   * Nothing is engaged until something is actually set, because routing an
   * element through Web Audio is permanent and needs same-origin media.
   */
  get audio(): AudioController {
    return this.audioController;
  }

  get audioEffects(): AudioEffectState {
    return this.audioController.effects;
  }

  setAudioEffects(patch: Partial<AudioEffectState>): void {
    this.audioController.set(patch);
    this.emitter.emit("audioeffectchange", { effects: this.audioController.effects });
  }

  /** Loads one of the eighteen VLC equalizer presets by id, e.g. `"rock"`. */
  setEqualizerPreset(id: string): boolean {
    const applied = this.audioController.setPreset(id);
    if (applied) this.emitter.emit("audioeffectchange", { effects: this.audioController.effects });
    return applied;
  }

  // ------------------------------------------------------ video filters

  /** Picture adjustments and geometry: brightness, gamma, zoom, rotation… */
  get filters(): VideoFilters {
    return this.videoFilters;
  }

  get videoFilterState(): VideoFilterState {
    return this.videoFilters.filters;
  }

  setVideoFilters(patch: Partial<VideoFilterState>): void {
    this.videoFilters.set(patch);
  }

  // ------------------------------------------------------------ looping

  /** The A→B loop controller. */
  get loop(): LoopController {
    return this.loopController;
  }

  get abLoop(): AbLoop | null {
    return this.loopController.abLoop;
  }

  setAbLoop(loop: AbLoop | null): void {
    this.loopController.set(loop);
  }

  /** Advances the A→B loop: sets A, then B, then clears. */
  cycleAbLoop(): void {
    this.controls.cycleAbLoop();
  }

  // ---------------------------------------------------- frame stepping

  /**
   * Measured frame rate, once enough frames have been presented to know
   * it. Null before then — the container often doesn't say.
   */
  get frameRate(): number | null {
    void this.startProbe();
    return this.probe?.frameRate ?? null;
  }

  /**
   * Loads and starts the frame-rate/bitrate sampler.
   *
   * Nothing needs it until something asks for statistics or steps a frame,
   * so it stays out of the core bundle and out of the render loop until
   * then. The first `frameRate` read after that still returns null — one
   * sample can't establish a rate — which is why `stepFrame` has a default.
   */
  private async startProbe(): Promise<void> {
    if (this.probe || !this.connected) return;
    if (!this.probeLoading) {
      this.probeLoading = import("./media/MediaInfo")
        .then(({ MediaInfoProbe }) => {
          this.probe = new MediaInfoProbe(this.video);
          this.probe.start();
          return this.probe;
        })
        .catch(() => null);
    }
    await this.probeLoading;
  }

  /**
   * Steps one frame, pausing first — VLC's `e`.
   *
   * Without a measured rate this falls back to 25 fps, which lands within
   * a frame of the truth for anything between 24 and 30.
   */
  stepFrame(direction = 1): void {
    const fps = this.frameRate && this.frameRate > 1 ? this.frameRate : 25;
    this.video.pause();
    const duration = Number.isFinite(this.video.duration) ? this.video.duration : Number.MAX_SAFE_INTEGER;
    this.video.currentTime = clamp(this.video.currentTime + direction / fps, 0, duration);
  }

  // --------------------------------------------------------- snapshots

  /**
   * Captures the current frame as an encoded image.
   *
   * The capture code is imported on demand — a page that never takes a
   * snapshot shouldn't carry a canvas encoder.
   */
  async snapshot(options: SnapshotOptions = {}): Promise<Blob> {
    const { captureFrame, encodeSnapshot } = await import("./media/Snapshot");
    const canvas = captureFrame(this.video, { ...options, cssFilter: this.videoFilters.cssFilter() });
    return encodeSnapshot(canvas, options);
  }

  /** Captures the current frame and saves it — VLC's Shift+S. */
  async saveSnapshot(options: SnapshotOptions = {}): Promise<void> {
    try {
      const blob = await this.snapshot(options);
      const { snapshotFilename, downloadBlob } = await import("./media/Snapshot");
      const filename = snapshotFilename(options.type ?? "image/png");
      this.emitter.emit("snapshot", { blob, filename });
      downloadBlob(blob, filename);
      this.controls.announce(this.translator.t("snapshotSaved", filename));
    } catch (error) {
      const { SnapshotError } = await import("./media/Snapshot");
      const message =
        error instanceof SnapshotError && error.reason === "tainted"
          ? error.message
          : this.translator.t("snapshotUnavailable");
      this.controls.announce(message);
      this.emitter.emit("error", { code: "UNKNOWN", message, fatal: false, raw: error });
    }
  }

  // --------------------------------------------------------- bookmarks

  getBookmarks(): LumenBookmarkEntry[] {
    return this.positions.bookmarks;
  }

  get bookmarks(): LumenBookmarkEntry[] {
    return this.positions.bookmarks;
  }

  /** Marks the current position. Defaults to the timestamp as its label. */
  addBookmark(label?: string): void {
    const time = this.video.currentTime;
    const bookmarks = this.positions.addBookmark({ time, label: label ?? formatTime(time) });
    this.emitter.emit("bookmarkschange", { bookmarks });
  }

  removeBookmark(time: number): void {
    const bookmarks = this.positions.removeBookmark(time);
    this.emitter.emit("bookmarkschange", { bookmarks });
  }

  // --------------------------------------------------------- media info

  /** A live snapshot of what's playing and how well — VLC's Ctrl+I. */
  mediaInfo(): LumenMediaInfo {
    void this.startProbe();
    const quality = this.video.getVideoPlaybackQuality?.();
    const measured = this.probe?.sampleBitrate() ?? null;

    return {
      // The element's own `currentSrc` is a blob: URL whenever a remuxer is
      // driving it, which tells a viewer nothing; the URL they asked for
      // does.
      source: this.pendingSources[0]?.src || this.video.currentSrc || "",
      container: containerLabel(this.engine?.container ?? "unknown"),
      engine: this.engine?.engineName ?? "native",
      codecs: this.engine?.codecs ?? null,
      width: this.video.videoWidth,
      height: this.video.videoHeight,
      frameRate: this.probe?.frameRate ?? null,
      duration: this.video.duration,
      // An adaptive engine knows the exact level bitrate; everything else
      // has to be measured from the decoded-byte counters.
      bitrateKbps: this.engine?.reportedBitrateKbps ?? measured,
      droppedFrames: quality?.droppedVideoFrames ?? 0,
      decodedFrames: quality?.totalVideoFrames ?? 0,
      bufferAheadSeconds: bufferedAhead(this.video.buffered, this.video.currentTime),
      bufferedRanges: timeRanges(this.video.buffered),
      audioTrackCount: this.engine?.audioTracks.length ?? 0,
      textTrackCount: this.subtitles?.tracks.length ?? 0,
      playbackRate: this.video.playbackRate,
      readyState: this.video.readyState,
    };
  }

  // ------------------------------------------------------- local files

  /**
   * Plays files from the viewer's machine — the file picker, and whatever
   * gets dropped onto the player.
   *
   * Video files become the queue; subtitle files are converted to WebVTT
   * and attached to whatever is playing, so dropping a movie and its
   * `.srt` together does the obvious thing.
   */
  async openFiles(files: File[]): Promise<void> {
    const { sortFiles, titleFromFilename } = await import("./media/files");
    const { media, subtitles, rejected } = sortFiles(files);

    if (media.length > 0) {
      this.revokeObjectUrls();
      const items: LumenPlaylistItem[] = media.map((file) => {
        const url = URL.createObjectURL(file);
        this.objectUrls.push(url);
        return { src: url, title: titleFromFilename(file.name) };
      });

      // One file or twenty, the queue is the same mechanism — which also
      // means each one gets the same per-item cleanup of the last file's
      // subtitles, chapters and poster.
      this.playlist = items;
    }

    for (const file of subtitles) {
      await this.addSubtitleFile(file);
    }

    if (media.length === 0 && subtitles.length === 0 && rejected.length > 0) {
      this.controls.announce(this.translator.t("unsupportedFile"));
    }
  }

  /** Convenience wrapper for a single file. */
  openFile(file: File): Promise<void> {
    return this.openFiles([file]);
  }

  /**
   * Loads a subtitle file of any supported format.
   *
   * The converter is a dynamic import: pages that only ever see WebVTT
   * shouldn't download an ASS parser.
   */
  async addSubtitleFile(file: File): Promise<void> {
    try {
      const text = await file.text();
      const [{ toWebVttUrl }, { languageFromFilename, titleFromFilename }] = await Promise.all([
        import("./subtitles/convert"),
        import("./media/files"),
      ]);
      const url = toWebVttUrl(text, file.name);
      this.objectUrls.push(url);

      const language = languageFromFilename(file.name);
      this.subtitles.addTrack({
        src: url,
        label: titleFromFilename(file.name),
        srclang: language ?? "und",
        default: this.subtitles.tracks.length === 0,
      });
      this.controls.announce(this.translator.t("subtitleFileAdded"));
    } catch {
      this.controls.announce(this.translator.t("unsupportedFile"));
    }
  }

  private revokeObjectUrls(): void {
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls = [];
  }

  // ---------------------------------------------------- subtitle timing

  /** Subtitle delay in seconds; positive shows cues later — VLC's `g`/`h`. */
  getSubtitleOffset(): number {
    return this.subtitles.prefs.offsetSeconds;
  }

  setSubtitleOffset(seconds: number): void {
    this.subtitles.setPrefs({ offsetSeconds: seconds });
  }

  get subtitleOffset(): number {
    return this.getSubtitleOffset();
  }

  set subtitleOffset(seconds: number) {
    this.setSubtitleOffset(seconds);
  }

  // ------------------------------------------------------------- panels

  /** Opens a side panel, or closes the open one with `null`. */
  openPanel(panel: LumenPanel | null): void {
    if (panel === null) this.controls.closePanel();
    else void this.controls.openPanel(panel);
  }

  get panel(): LumenPanel | null {
    return this.controls?.openPanelView ?? null;
  }

  /** Re-loads the current source; also what the error UI's retry does. */
  retry(): void {
    void this.engine.load(this.pendingSources);
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
    this.loopController?.destroy();
    this.audioController?.destroy();
    this.videoFilters?.destroy();
    this.probe?.stop();
    this.revokeObjectUrls();
    this.emitter.clear();
  }
}
