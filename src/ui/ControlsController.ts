import type { EventEmitter } from "../core/EventEmitter";
import type { PlaybackEngine } from "../core/PlaybackEngine";
import type { SubtitleManager } from "../subtitles/SubtitleManager";
import type { ChapterManager } from "../media/ChapterManager";
import type { CastController } from "../media/CastController";
import type { Translator } from "../i18n";
import type { LumenError, LumenPanel } from "../types";
import { bufferedEnd, clamp, formatTime } from "../utils/time";
import { isCoarsePointer } from "../utils/dom";
import { icon } from "./icons";
import { ThumbnailTrack } from "./Thumbnails";
import type { PlayerBridge } from "./PlayerBridge";
import type { PanelController } from "./panels/index";

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const IDLE_MS = 2600;
/** How often the media-info panel refreshes its live statistics. */
const STATS_INTERVAL_MS = 1000;
/** Subtitle and audio delay nudge, matching VLC's 50 ms steps. */
const DELAY_STEP_MS = 50;

type MenuView = "root" | "speed" | "quality" | "captions" | "appearance" | "audio" | "chapters" | "tools";

export interface ControlsControllerOptions {
  root: HTMLElement;
  video: HTMLVideoElement;
  host: HTMLElement;
  emitter: EventEmitter;
  engine: PlaybackEngine;
  subtitles: SubtitleManager;
  chapters: ChapterManager;
  cast: CastController;
  strings: Translator;
  player: PlayerBridge;
}

/**
 * True when a drag carries files rather than, say, selected text.
 *
 * Inlined rather than imported from `media/files` so that module — which
 * is only needed once files actually arrive — stays out of the core
 * bundle entirely.
 */
function dragHasFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  return types ? Array.from(types).includes("Files") : false;
}

function $(root: ParentNode, selector: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`Lumen: missing control element "${selector}"`);
  return el;
}

/** Wires every interactive control to the video element, playback engine, and subtitle manager. */
export class ControlsController {
  private root: HTMLElement;
  private video: HTMLVideoElement;
  private host: HTMLElement;
  private emitter: EventEmitter;
  private engine: PlaybackEngine;
  private subtitles: SubtitleManager;
  private chapters: ChapterManager;
  private cast: CastController;
  private strings: Translator;
  private player: PlayerBridge;

  private els: {
    poster: HTMLElement;
    center: HTMLElement;
    bigPlay: HTMLButtonElement;
    spinner: HTMLElement;
    error: HTMLElement;
    errorMessage: HTMLElement;
    controls: HTMLElement;
    progress: HTMLElement;
    fill: HTMLElement;
    buffered: HTMLElement;
    preview: HTMLElement;
    previewImg: HTMLImageElement;
    previewTime: HTMLElement;
    previewChapter: HTMLElement;
    chapterMarks: HTMLElement;
    bookmarkMarks: HTMLElement;
    loopRegion: HTMLElement;
    loopBadge: HTMLElement;
    time: HTMLElement;
    volumeInput: HTMLInputElement;
    captions: HTMLElement;
    castButton: HTMLElement;
    nextButton: HTMLElement;
    previousButton: HTMLElement;
    menu: HTMLElement;
    panel: HTMLElement;
    panelTitle: HTMLElement;
    panelBody: HTMLElement;
    playlistButton: HTMLElement;
    effectsButton: HTMLElement;
    drop: HTMLElement;
    dropMessage: HTMLElement;
    fileInput: HTMLInputElement;
    announcer: HTMLElement;
  };

  private idleTimer: number | null = null;
  private isScrubbing = false;
  private wasPlayingBeforeScrub = false;
  private menuOpen = false;
  private menuView: MenuView = "root";
  private thumbnails: ThumbnailTrack | null = null;
  private panelView: LumenPanel | null = null;
  private panelController: PanelController | null = null;
  private panelLoading: Promise<PanelController | null> | null = null;
  private statsTimer: number | null = null;
  private dragDepth = 0;
  /** Set while waiting to see whether a click is really a double-click. */
  private clickTimer: number | null = null;
  private boundOutsideClick = this.onOutsideClick.bind(this);
  private boundKeydown = this.onKeydown.bind(this);
  private boundFullscreenChange = () => this.onFullscreenChange();

  constructor(opts: ControlsControllerOptions) {
    this.root = opts.root;
    this.video = opts.video;
    this.host = opts.host;
    this.emitter = opts.emitter;
    this.engine = opts.engine;
    this.subtitles = opts.subtitles;
    this.chapters = opts.chapters;
    this.cast = opts.cast;
    this.strings = opts.strings;
    this.player = opts.player;

    this.els = {
      poster: $(this.root, ".lumen-poster"),
      center: $(this.root, ".lumen-center"),
      bigPlay: $(this.root, '[data-action="play-pause"].lumen-big-play') as HTMLButtonElement,
      spinner: $(this.root, ".lumen-spinner"),
      error: $(this.root, ".lumen-error"),
      errorMessage: $(this.root, '[data-el="error-message"]'),
      controls: $(this.root, ".lumen-controls"),
      progress: $(this.root, '[data-el="progress"]'),
      fill: $(this.root, '[data-el="fill"]'),
      buffered: $(this.root, '[data-el="buffered"]'),
      preview: $(this.root, '[data-el="preview"]'),
      previewImg: $(this.root, '[data-el="preview-img"]') as HTMLImageElement,
      previewTime: $(this.root, '[data-el="preview-time"]'),
      previewChapter: $(this.root, '[data-el="preview-chapter"]'),
      chapterMarks: $(this.root, '[data-el="chapter-marks"]'),
      bookmarkMarks: $(this.root, '[data-el="bookmark-marks"]'),
      loopRegion: $(this.root, '[data-el="loop-region"]'),
      loopBadge: $(this.root, '[data-el="loop-badge"]'),
      time: $(this.root, '[data-el="time"]'),
      volumeInput: $(this.root, '[data-el="volume"]') as HTMLInputElement,
      captions: $(this.root, '[data-action="captions-toggle"]'),
      castButton: $(this.root, '[data-action="cast"]'),
      nextButton: $(this.root, '[data-action="next"]'),
      previousButton: $(this.root, '[data-action="previous"]'),
      menu: $(this.root, '[data-el="menu"]'),
      panel: $(this.root, '[data-el="panel"]'),
      panelTitle: $(this.root, '[data-el="panel-title"]'),
      panelBody: $(this.root, '[data-el="panel-body"]'),
      playlistButton: $(this.root, '[data-action="panel-playlist"]'),
      effectsButton: $(this.root, '[data-action="panel-effects"]'),
      drop: $(this.root, '[data-el="drop"]'),
      dropMessage: $(this.root, '[data-el="drop-message"]'),
      fileInput: $(this.root, '[data-el="file-input"]') as HTMLInputElement,
      announcer: $(this.root, '[data-el="announcer"]'),
    };

    this.bindVideoEvents();
    this.bindClicks();
    this.bindProgress();
    this.bindVolume();
    this.bindIdle();
    this.bindKeyboard();
    this.bindEngineEvents();
    this.bindSubtitleEvents();
    this.bindChapterEvents();
    this.bindFiles();
    this.bindLoopEvents();
    this.bindMenu();
    this.updatePipSupport();
    this.updateFullscreenIcon();
    this.applyStaticLabels();
    this.refreshPlaylistButtons();

    document.addEventListener("click", this.boundOutsideClick, true);
    document.addEventListener("fullscreenchange", this.boundFullscreenChange);
  }

  /** Applies translated labels to controls whose text never changes at runtime. */
  private applyStaticLabels(): void {
    const label = (selector: string, key: Parameters<Translator["t"]>[0]) => {
      this.root.querySelector(selector)?.setAttribute("aria-label", this.strings.t(key));
    };
    label('[data-el="progress"]', "seek");
    label('[data-el="volume"]', "volume");
    label(".lumen-spinner", "loading");
    label('[data-action="captions-toggle"]', "captions");
    label('[data-action="settings"]', "settings");
    label('[data-action="pip"]', "pictureInPicture");
    label('[data-action="cast"]', "cast");
    label('[data-action="next"]', "next");
    label('[data-action="previous"]', "previous");
    label('[data-action="panel-playlist"]', "playlist");
    label('[data-action="panel-effects"]', "effects");
    label('[data-action="panel-close"]', "closePanel");
    this.els.dropMessage.textContent = this.strings.t("dropToPlay");
    this.els.loopBadge.textContent = this.strings.t("abLoop");

    const retry = this.root.querySelector('[data-action="retry"]');
    if (retry) retry.innerHTML = `${icon("refresh")} ${this.strings.t("tryAgain")}`;
  }

  /** Shows the next/previous buttons only when a playlist actually offers somewhere to go. */
  refreshPlaylistButtons(): void {
    const hasPlaylist = this.player.hasPlaylist();
    this.els.nextButton.hidden = !hasPlaylist;
    this.els.previousButton.hidden = !hasPlaylist;
    this.els.playlistButton.hidden = !hasPlaylist;
    this.els.nextButton.toggleAttribute("disabled", !this.player.hasNext());
    this.els.previousButton.toggleAttribute("disabled", !this.player.hasPrevious());
    if (this.panelView === "playlist") void this.renderPanel();
  }

  private activeChapterStart: number | null = null;

  /** Emits `chapterchange` when playback moves into a different chapter. */
  private checkChapterBoundary(): void {
    const chapter = this.chapters.chapterAt(this.video.currentTime);
    const start = chapter?.start ?? null;
    if (start === this.activeChapterStart) return;
    this.activeChapterStart = start;
    this.emitter.emit("chapterchange", { chapter });
  }

  private bindChapterEvents(): void {
    this.emitter.on("chapterschange", () => this.renderChapterMarks());
    this.emitter.on("castavailabilitychange", ({ available }) => {
      this.els.castButton.hidden = !available;
    });
  }

  /** Draws a divider at each chapter boundary along the progress bar. */
  private renderChapterMarks(): void {
    const chapters = this.chapters.chapters;
    const duration = this.video.duration;
    this.els.chapterMarks.replaceChildren();
    if (chapters.length < 2 || !Number.isFinite(duration) || duration <= 0) return;

    const fragment = document.createDocumentFragment();
    // The first chapter starts at 0, so its divider would sit on the very
    // edge of the bar; skip it.
    for (const chapter of chapters.slice(1)) {
      const mark = document.createElement("div");
      mark.className = "lumen-chapter-mark";
      mark.style.left = `${clamp((chapter.start / duration) * 100, 0, 100)}%`;
      fragment.appendChild(mark);
    }
    this.els.chapterMarks.appendChild(fragment);
  }

  // ---------------------------------------------------------------- video

  private bindVideoEvents(): void {
    const v = this.video;
    v.addEventListener("play", () => {
      this.setPlayingUi(true);
      this.emitter.emit("play", undefined);
      this.scheduleIdle();
    });
    v.addEventListener("pause", () => {
      this.setPlayingUi(false);
      this.emitter.emit("pause", undefined);
      this.showControls();
    });
    v.addEventListener("ended", () => {
      this.emitter.emit("ended", undefined);
      this.showControls();
    });
    v.addEventListener("timeupdate", () => {
      this.updateProgress();
      this.emitter.emit("timeupdate", { currentTime: v.currentTime, duration: v.duration || 0 });
      this.checkChapterBoundary();
    });
    v.addEventListener("progress", () => {
      this.updateBuffered();
      this.emitter.emit("progress", { buffered: bufferedEnd(v.buffered) });
    });
    v.addEventListener("volumechange", () => {
      this.updateVolumeUi();
      this.emitter.emit("volumechange", { volume: v.volume, muted: v.muted });
    });
    v.addEventListener("ratechange", () => this.emitter.emit("ratechange", { rate: v.playbackRate }));
    v.addEventListener("waiting", () => {
      this.els.spinner.hidden = false;
      this.emitter.emit("waiting", undefined);
    });
    v.addEventListener("playing", () => {
      this.els.spinner.hidden = true;
      this.hideError();
      this.emitter.emit("playing", undefined);
    });
    v.addEventListener("canplay", () => {
      this.els.spinner.hidden = true;
      this.emitter.emit("canplay", undefined);
    });
    v.addEventListener("seeking", () => this.emitter.emit("seeking", undefined));
    v.addEventListener("seeked", () => this.emitter.emit("seeked", undefined));
    v.addEventListener("loadedmetadata", () => {
      this.emitter.emit("loadedmetadata", { duration: v.duration || 0 });
      this.updateProgress();
      // Chapter positions are percentages of the duration, so they can't be
      // placed until the duration is known.
      this.renderChapterMarks();
    });
    v.addEventListener("durationchange", () => this.renderChapterMarks());
    v.addEventListener("enterpictureinpicture", () => {
      this.emitter.emit("enterpip", undefined);
    });
    v.addEventListener("leavepictureinpicture", () => {
      this.emitter.emit("leavepip", undefined);
    });
  }

  private bindEngineEvents(): void {
    this.emitter.on("error", (err) => this.onError(err));
    this.emitter.on("qualitieschange", () => {
      /* menu is rendered lazily when opened */
    });
  }

  private setPlayingUi(playing: boolean): void {
    const svg = playing ? icon("pause") : icon("play");
    this.els.bigPlay.innerHTML = svg;
    this.els.bigPlay.setAttribute("aria-label", this.strings.t(playing ? "pause" : "play"));
    this.els.bigPlay.hidden = playing;
    const playBtn = $(this.root, '.lumen-row [data-action="play-pause"]');
    playBtn.innerHTML = svg;
    playBtn.setAttribute("aria-label", this.strings.t(playing ? "pause" : "play"));
    if (playing) {
      this.els.poster.hidden = true;
      this.announce(this.strings.t("playing"));
    } else {
      this.announce(this.strings.t("paused"));
    }
  }

  // -------------------------------------------------------------- clicks

  private bindClicks(): void {
    this.root.addEventListener("click", (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
      if (!target) return;
      const action = target.dataset.action;
      switch (action) {
        case "play-pause":
          this.togglePlay();
          break;
        case "mute":
          this.video.muted = !this.video.muted;
          if (!this.video.muted && this.video.volume === 0) this.video.volume = 0.5;
          break;
        case "captions-toggle":
          this.toggleCaptionsQuick();
          break;
        case "pip":
          this.togglePip();
          break;
        case "cast":
          void this.cast.prompt().then((shown) => {
            if (!shown) this.announce(this.strings.t("castUnavailable"));
          });
          break;
        case "next":
          this.player.next();
          break;
        case "previous":
          this.player.previous();
          break;
        case "panel-playlist":
          void this.togglePanel("playlist");
          break;
        case "panel-effects":
          void this.togglePanel("effects");
          break;
        case "panel-close":
          this.closePanel();
          break;
        case "open-file":
          this.els.fileInput.click();
          break;
        case "fullscreen":
          this.toggleFullscreen();
          break;
        case "settings":
          this.toggleMenu();
          break;
        case "retry":
          this.hideError();
          this.player.retry();
          break;
        default:
          break;
      }
    });

    // Clicking/tapping the video surface itself toggles play (desktop only —
    // on touch it should just reveal controls, handled by bindIdle).
    //
    // The toggle is deferred by one double-click interval: without that, a
    // double-click to go fullscreen also pauses and resumes the video,
    // which is visible as a stutter at exactly the wrong moment.
    this.video.addEventListener("click", () => {
      if (isCoarsePointer()) return;
      if (this.clickTimer !== null) return;
      this.clickTimer = window.setTimeout(() => {
        this.clickTimer = null;
        this.togglePlay();
      }, 220);
    });

    this.root.addEventListener("dblclick", (e) => {
      if (this.clickTimer !== null) {
        window.clearTimeout(this.clickTimer);
        this.clickTimer = null;
      }
      if ((e.target as HTMLElement).closest(".lumen-controls, .lumen-menu, .lumen-panel")) return;
      void this.toggleFullscreen();
    });
  }

  private togglePlay(): void {
    if (this.video.paused || this.video.ended) {
      this.video.play().catch(() => this.announce(this.strings.t("playbackBlocked")));
    } else {
      this.video.pause();
    }
  }

  // ------------------------------------------------------------- progress

  private bindProgress(): void {
    const bar = this.els.progress;

    const timeFromEvent = (clientX: number): number => {
      const rect = bar.getBoundingClientRect();
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
      return ratio * (this.video.duration || 0);
    };

    const showPreview = async (clientX: number) => {
      const time = timeFromEvent(clientX);
      const rect = bar.getBoundingClientRect();
      const x = clamp(clientX - rect.left, 0, rect.width);
      this.els.preview.style.left = `${x}px`;
      this.els.preview.classList.add("is-visible");
      this.els.previewTime.textContent = formatTime(time);

      const chapter = this.chapters.chapterAt(time);
      this.els.previewChapter.hidden = !chapter?.title;
      if (chapter?.title) this.els.previewChapter.textContent = chapter.title;

      if (this.thumbnails?.isReady) {
        const cue = this.thumbnails.cueAt(time);
        if (cue) {
          this.els.previewImg.hidden = false;
          this.els.previewImg.src = cue.url;
          if (cue.xywh) {
            const [cx, cy, cw, ch] = cue.xywh;
            this.els.previewImg.style.clipPath = `inset(0)`;
            this.els.previewImg.style.width = `${cw}px`;
            this.els.previewImg.style.height = `${ch}px`;
            this.els.previewImg.style.objectPosition = `-${cx}px -${cy}px`;
          }
        }
      } else {
        this.els.previewImg.hidden = true;
      }
    };

    bar.addEventListener("pointermove", (e) => {
      if (!this.isScrubbing && isCoarsePointer()) return;
      void showPreview(e.clientX);
    });
    bar.addEventListener("pointerleave", () => {
      if (!this.isScrubbing) this.els.preview.classList.remove("is-visible");
    });

    bar.addEventListener("pointerdown", (e) => {
      this.isScrubbing = true;
      this.wasPlayingBeforeScrub = !this.video.paused;
      this.video.pause();
      bar.setPointerCapture(e.pointerId);
      bar.classList.add("is-scrubbing");
      const time = timeFromEvent(e.clientX);
      this.video.currentTime = time;
      this.updateProgress();
      void showPreview(e.clientX);
    });

    bar.addEventListener("pointermove", (e) => {
      if (!this.isScrubbing) return;
      const time = timeFromEvent(e.clientX);
      this.video.currentTime = time;
      this.updateProgress();
    });

    const endScrub = (e: PointerEvent) => {
      if (!this.isScrubbing) return;
      this.isScrubbing = false;
      bar.classList.remove("is-scrubbing");
      bar.releasePointerCapture(e.pointerId);
      this.els.preview.classList.remove("is-visible");
      if (this.wasPlayingBeforeScrub) this.video.play().catch(() => {});
    };
    bar.addEventListener("pointerup", endScrub);
    bar.addEventListener("pointercancel", endScrub);

    bar.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 10 : 5;
      if (e.key === "ArrowRight") {
        this.seekBy(step);
        e.preventDefault();
      } else if (e.key === "ArrowLeft") {
        this.seekBy(-step);
        e.preventDefault();
      } else if (e.key === "Home") {
        this.video.currentTime = 0;
        e.preventDefault();
      } else if (e.key === "End" && Number.isFinite(this.video.duration)) {
        this.video.currentTime = this.video.duration;
        e.preventDefault();
      }
    });
  }

  private seekBy(delta: number): void {
    const duration = this.video.duration || 0;
    this.video.currentTime = clamp(this.video.currentTime + delta, 0, duration);
  }

  private updateProgress(): void {
    const { currentTime, duration } = this.video;
    const pct = duration ? clamp((currentTime / duration) * 100, 0, 100) : 0;
    this.els.fill.style.width = `${pct}%`;
    this.els.progress.setAttribute("aria-valuenow", String(Math.round(pct)));
    this.els.progress.setAttribute("aria-valuetext", `${formatTime(currentTime)} / ${formatTime(duration)}`);
    this.els.time.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
  }

  private updateBuffered(): void {
    const duration = this.video.duration || 0;
    if (!duration) return;
    const end = bufferedEnd(this.video.buffered);
    this.els.buffered.style.width = `${clamp((end / duration) * 100, 0, 100)}%`;
  }

  // --------------------------------------------------------------- volume

  private bindVolume(): void {
    this.els.volumeInput.addEventListener("input", () => {
      const value = Number(this.els.volumeInput.value);
      this.video.volume = value;
      this.video.muted = value === 0;
    });
    this.updateVolumeUi();
  }

  private updateVolumeUi(): void {
    const { volume, muted } = this.video;
    this.els.volumeInput.value = String(muted ? 0 : volume);
    const muteBtn = $(this.root, '[data-action="mute"]');
    const iconName = muted || volume === 0 ? "volume-mute" : volume < 0.5 ? "volume-low" : "volume-high";
    muteBtn.innerHTML = icon(iconName);
    muteBtn.setAttribute("aria-label", this.strings.t(muted ? "unmute" : "mute"));
    muteBtn.setAttribute("aria-pressed", String(muted));
  }

  // ------------------------------------------------------------ captions

  private bindSubtitleEvents(): void {
    this.emitter.on("texttrackchange", () => this.refreshCaptionsButton());
    // Subtitles found inside the media file itself (MKV) appear after
    // playback starts, so the captions button has to re-evaluate then.
    this.emitter.on("embeddedtexttrack", ({ track }) => {
      this.refreshCaptionsButton();
      this.announce(this.strings.t("subtitlesAvailable", track.label || track.language));
    });
    this.refreshCaptionsButton();
  }

  private refreshCaptionsButton(): void {
    const hasTracks = this.subtitles.tracks.length > 0;
    this.els.captions.hidden = !hasTracks;
    const active = this.subtitles.current;
    this.els.captions.setAttribute("aria-pressed", String(!!active));
  }

  /** The track to restore when captions are switched back on. */
  private lastCaptionTrack: TextTrack | null = null;

  private toggleCaptionsQuick(): void {
    if (this.subtitles.current) {
      this.lastCaptionTrack = this.subtitles.current;
      this.subtitles.setActiveTrack(null);
      this.announce(this.strings.t("captionsOff"));
      return;
    }

    // Toggling back on should return the track that was on before, not
    // reset to the first one in the list.
    const tracks = this.subtitles.tracks;
    const restore = this.lastCaptionTrack && tracks.includes(this.lastCaptionTrack)
      ? this.lastCaptionTrack
      : tracks[0];
    if (restore) {
      this.subtitles.setActiveTrack(restore);
      this.announce(this.strings.t("captionsAnnouncement", restore.label || restore.language));
    }
  }

  // ------------------------------------------------------------- pip/fs

  private updatePipSupport(): void {
    const supported = "pictureInPictureEnabled" in document && !this.video.disablePictureInPicture;
    $(this.root, '[data-action="pip"]').hidden = !supported;
  }

  private async togglePip(): Promise<void> {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await this.video.requestPictureInPicture();
      }
    } catch {
      this.announce(this.strings.t("pipUnavailable"));
    }
  }

  private async toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await this.host.requestFullscreen();
      }
    } catch {
      this.announce(this.strings.t("fullscreenUnavailable"));
    }
  }

  private onFullscreenChange(): void {
    this.updateFullscreenIcon();
    const isFs = document.fullscreenElement === this.host;
    this.emitter.emit(isFs ? "enterfullscreen" : "exitfullscreen", undefined);
  }

  private updateFullscreenIcon(): void {
    const btn = $(this.root, '[data-action="fullscreen"]');
    const isFs = document.fullscreenElement === this.host;
    btn.innerHTML = icon(isFs ? "fullscreen-exit" : "fullscreen");
    btn.setAttribute("aria-label", this.strings.t(isFs ? "exitFullscreen" : "fullscreen"));
  }

  // -------------------------------------------------------------- errors

  private onError(err: LumenError): void {
    if (!err.fatal) {
      this.announce(err.message);
      return;
    }
    this.els.spinner.hidden = true;
    this.els.errorMessage.textContent = err.message;
    this.els.error.hidden = false;
    this.showControls();
  }

  private hideError(): void {
    this.els.error.hidden = true;
  }

  // -------------------------------------------------------------- panels

  /** Opens a panel, or closes it if it's already the one showing. */
  async togglePanel(view: LumenPanel): Promise<void> {
    if (this.panelView === view) {
      this.closePanel();
      return;
    }
    await this.openPanel(view);
  }

  async openPanel(view: LumenPanel): Promise<void> {
    this.closeMenu();
    this.panelView = view;
    this.showControls();
    this.updatePanelButtons();
    this.emitter.emit("panelchange", { panel: view });

    // Revealed only once the module — and with it the panel stylesheet —
    // has arrived, so the drawer never flashes up unstyled.
    await this.renderPanel();
    if (this.panelView !== view) return;
    this.els.panel.hidden = false;
    this.root.classList.add("has-panel");

    // The statistics view is the only one that changes on its own.
    if (view === "info") this.startStats();
    else this.stopStats();
  }

  closePanel(): void {
    if (this.panelView === null) return;
    this.panelView = null;
    this.els.panel.hidden = true;
    this.root.classList.remove("has-panel");
    this.panelController?.stop();
    this.els.panelBody.replaceChildren();
    this.stopStats();
    this.updatePanelButtons();
    this.emitter.emit("panelchange", { panel: null });
  }

  get openPanelView(): LumenPanel | null {
    return this.panelView;
  }

  private updatePanelButtons(): void {
    this.els.playlistButton.setAttribute("aria-pressed", String(this.panelView === "playlist"));
    this.els.effectsButton.setAttribute(
      "aria-pressed",
      String(this.panelView === "effects" || this.panelView === "equalizer"),
    );
  }

  /**
   * Loads the panel module on first use.
   *
   * Panels are a dialog's worth of controls — sliders, an equalizer bank,
   * a statistics table — and none of it is needed to watch a video, so it
   * lives in its own chunk behind this dynamic import rather than in the
   * bundle every page downloads.
   */
  private async ensurePanelController(): Promise<PanelController | null> {
    if (this.panelController) return this.panelController;
    if (!this.panelLoading) {
      this.panelLoading = import("./panels/index")
        .then(({ PanelController }) => {
          this.panelController = new PanelController(
            {
              bridge: this.player,
              video: this.video,
              subtitles: this.subtitles,
              strings: this.strings,
              announce: (message) => this.announce(message),
            },
            this.els.panelBody,
            this.els.panelTitle,
          );
          return this.panelController;
        })
        .catch(() => null);
    }
    return this.panelLoading;
  }

  private async renderPanel(): Promise<void> {
    const view = this.panelView;
    if (!view) return;
    const controller = await this.ensurePanelController();
    // The panel may have been closed while the chunk was in flight.
    if (!controller || this.panelView !== view) return;
    controller.render(view);
  }

  private startStats(): void {
    this.stopStats();
    this.statsTimer = window.setInterval(() => this.panelController?.refresh(), STATS_INTERVAL_MS);
  }

  private stopStats(): void {
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  // --------------------------------------------------------------- files

  /**
   * Local files: a picker, a drop target, and the plumbing between them.
   *
   * `dragenter`/`dragleave` fire for every child element the pointer
   * crosses, so the overlay is driven by a depth counter rather than by
   * the events alone — otherwise it flickers off the moment the cursor
   * moves over the controls.
   */
  private bindFiles(): void {
    this.els.fileInput.addEventListener("change", () => {
      const files = Array.from(this.els.fileInput.files ?? []);
      if (files.length > 0) void this.player.openFiles(files);
      // Cleared so choosing the same file twice in a row still fires.
      this.els.fileInput.value = "";
    });

    // The panel's "Open file" button can't reach the input directly, so it
    // asks through an event that bubbles out of the shadow subtree.
    this.els.panelBody.addEventListener("lumen-open-file", () => this.els.fileInput.click());

    this.root.addEventListener("dragenter", (event) => {
      if (!dragHasFiles(event)) return;
      event.preventDefault();
      this.dragDepth++;
      this.showDropTarget(true);
    });

    this.root.addEventListener("dragover", (event) => {
      if (!dragHasFiles(event)) return;
      // Without this the browser navigates to the file instead.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    });

    this.root.addEventListener("dragleave", (event) => {
      if (!dragHasFiles(event)) return;
      this.dragDepth = Math.max(0, this.dragDepth - 1);
      if (this.dragDepth === 0) this.showDropTarget(false);
    });

    this.root.addEventListener("drop", (event) => {
      if (!dragHasFiles(event)) return;
      event.preventDefault();
      this.dragDepth = 0;
      this.showDropTarget(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) void this.player.openFiles(files);
    });
  }

  /**
   * Shows or hides the drop target. The big play button is hidden with it,
   * so the folder prompt doesn't land on top of another control.
   */
  private showDropTarget(visible: boolean): void {
    this.els.drop.hidden = !visible;
    this.root.classList.toggle("is-dragging", visible);
  }

  /** Opens the file picker; also reachable from the tools menu and `o`. */
  promptForFile(): void {
    this.els.fileInput.click();
  }

  // ---------------------------------------------------------- A-B loop

  private bindLoopEvents(): void {
    this.emitter.on("abloopchange", () => this.renderLoopRegion());
    this.emitter.on("bookmarkschange", () => this.renderBookmarkMarks());
    this.emitter.on("loadedmetadata", () => {
      this.renderLoopRegion();
      this.renderBookmarkMarks();
    });
  }

  /** Paints the looped span onto the progress bar. */
  private renderLoopRegion(): void {
    const loop = this.player.loop.abLoop;
    const duration = this.video.duration;
    this.els.loopBadge.hidden = loop === null;

    if (!loop || !Number.isFinite(duration) || duration <= 0) {
      this.els.loopRegion.hidden = true;
      return;
    }

    const start = clamp((loop.start / duration) * 100, 0, 100);
    // With only the A point set, the region runs to the end of the bar —
    // which is exactly what will be looped if B is never marked.
    const end = loop.end === null ? 100 : clamp((loop.end / duration) * 100, 0, 100);
    this.els.loopRegion.hidden = false;
    this.els.loopRegion.style.left = `${start}%`;
    this.els.loopRegion.style.width = `${Math.max(0, end - start)}%`;
  }

  /** Draws a pin on the progress bar for every bookmark in this file. */
  private renderBookmarkMarks(): void {
    const bookmarks = this.player.getBookmarks();
    const duration = this.video.duration;
    this.els.bookmarkMarks.replaceChildren();
    if (bookmarks.length === 0 || !Number.isFinite(duration) || duration <= 0) return;

    const fragment = document.createDocumentFragment();
    for (const bookmark of bookmarks) {
      const mark = document.createElement("div");
      mark.className = "lumen-bookmark-mark";
      mark.style.left = `${clamp((bookmark.time / duration) * 100, 0, 100)}%`;
      mark.title = bookmark.label;
      fragment.appendChild(mark);
    }
    this.els.bookmarkMarks.appendChild(fragment);
  }

  // --------------------------------------------------------------- menu

  private toggleMenu(): void {
    this.menuOpen ? this.closeMenu() : this.openMenu("root");
  }

  private openMenu(view: MenuView): void {
    this.menuOpen = true;
    this.menuView = view;
    this.renderMenu();
    this.els.menu.hidden = false;
    $(this.root, '[data-action="settings"]').setAttribute("aria-expanded", "true");
    this.showControls();
  }

  private closeMenu(): void {
    this.menuOpen = false;
    this.els.menu.hidden = true;
    $(this.root, '[data-action="settings"]').setAttribute("aria-expanded", "false");
  }

  private onOutsideClick(e: MouseEvent): void {
    if (!this.menuOpen) return;
    const path = e.composedPath();
    if (!path.includes(this.els.menu) && !path.includes($(this.root, '[data-action="settings"]'))) {
      this.closeMenu();
    }
  }

  /**
   * The menu's click handler is installed once, on the container.
   *
   * It used to be added per render with `{ once: true }`, which meant any
   * click that missed an actionable row — the gap between items, a label
   * inside an appearance row — consumed the listener and left the whole
   * menu dead until it was reopened.
   */
  private bindMenu(): void {
    this.els.menu.addEventListener("click", (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>("[data-menu-action]");
      if (item) this.onMenuAction(item);
    });
  }

  private renderMenu(): void {
    const menu = this.els.menu;
    menu.replaceChildren();

    if (this.menuView === "root") {
      const rate = this.video.playbackRate;
      const rateLabel = rate === 1 ? this.strings.t("normalSpeed") : `${rate}×`;
      menu.appendChild(this.menuRow(this.strings.t("speed"), rateLabel, "open-speed"));

      const quality = this.engine.currentQuality;
      const qualityLabel = this.engine.isAutoQuality
        ? `${this.strings.t("auto")}${quality ? ` (${quality.label})` : ""}`
        : quality?.label ?? this.strings.t("auto");
      if (this.engine.isHls && this.engine.qualityLevels.length > 0) {
        menu.appendChild(this.menuRow(this.strings.t("quality"), qualityLabel, "open-quality"));
      }

      const audioTracks = this.engine.audioTracks;
      if (audioTracks.length > 1) {
        const active = audioTracks.find((track) => track.active);
        menu.appendChild(this.menuRow(this.strings.t("audio"), active?.label ?? "", "open-audio"));
      }

      const chapters = this.chapters.chapters;
      if (chapters.length > 0) {
        const current = this.chapters.chapterAt(this.video.currentTime);
        menu.appendChild(this.menuRow(this.strings.t("chapters"), current?.title ?? "", "open-chapters"));
      }

      if (this.subtitles.tracks.length > 0) {
        menu.appendChild(
          this.menuRow(
            this.strings.t("captions"),
            this.subtitles.current?.label ?? this.strings.t("off"),
            "open-captions",
          ),
        );
      }

      menu.appendChild(this.menuRow(this.strings.t("effects"), "", "open-tools"));
      return;
    }

    menu.appendChild(this.backRow());

    if (this.menuView === "speed") {
      for (const speed of SPEEDS) {
        const label = speed === 1 ? this.strings.t("normalSpeed") : `${speed}×`;
        menu.appendChild(this.menuItem(label, this.video.playbackRate === speed, "set-speed", String(speed)));
      }
    } else if (this.menuView === "quality") {
      menu.appendChild(this.menuItem(this.strings.t("auto"), this.engine.isAutoQuality, "set-quality", "auto"));
      for (const level of this.engine.qualityLevels) {
        menu.appendChild(
          this.menuItem(
            level.label,
            !this.engine.isAutoQuality && this.engine.currentQuality?.id === level.id,
            "set-quality",
            String(level.id),
          ),
        );
      }
    } else if (this.menuView === "audio") {
      for (const track of this.engine.audioTracks) {
        menu.appendChild(this.menuItem(track.label, track.active, "set-audio", track.id));
      }
    } else if (this.menuView === "chapters") {
      const current = this.chapters.chapterAt(this.video.currentTime);
      this.chapters.chapters.forEach((chapter, index) => {
        const item = this.menuItem(
          chapter.title || `${index + 1}`,
          current?.start === chapter.start,
          "seek-chapter",
          String(chapter.start),
        );
        // Chapter rows carry their start time, which is the one piece of
        // context that makes a long chapter list scannable.
        const time = document.createElement("span");
        time.style.cssText = "color:var(--lumen-color-text-muted);font-variant-numeric:tabular-nums";
        time.textContent = formatTime(chapter.start);
        item.appendChild(time);
        menu.appendChild(item);
      });
    } else if (this.menuView === "captions") {
      menu.appendChild(this.menuItem(this.strings.t("off"), !this.subtitles.current, "set-track", "off"));
      this.subtitles.tracks.forEach((t, i) => {
        menu.appendChild(this.menuItem(t.label || t.language || `Track ${i + 1}`, this.subtitles.current === t, "set-track", String(i)));
      });
      if (this.subtitles.current) {
        menu.appendChild(this.menuRow(this.strings.t("appearance"), "", "open-appearance"));
      }
    } else if (this.menuView === "tools") {
      const tools: Array<[string, string]> = [
        [this.strings.t("equalizer"), "panel-equalizer"],
        [this.strings.t("effects"), "panel-effects"],
        [this.strings.t("playlist"), "panel-playlist"],
        [this.strings.t("mediaInformation"), "panel-info"],
        [this.strings.t("shortcuts"), "panel-shortcuts"],
        [this.strings.t("snapshot"), "snapshot"],
        [this.strings.t("abLoop"), "ab-loop"],
        [this.strings.t("addBookmark"), "add-bookmark"],
        [this.strings.t("openFile"), "open-file-menu"],
      ];
      for (const [label, action] of tools) {
        menu.appendChild(this.menuRow(label, "", action));
      }
    } else if (this.menuView === "appearance") {
      const t = this.strings;
      menu.appendChild(
        this.appearanceOptionRow(t.t("subtitleSize"), [t.t("small"), t.t("medium"), t.t("large")], (index) =>
          this.subtitles.setPrefs({ fontSize: [0.8, 1, 1.3][index] ?? 1 }),
        ),
      );
      menu.appendChild(
        this.appearanceOptionRow(t.t("subtitleBackground"), [t.t("solid"), t.t("off")], (index) =>
          this.subtitles.setPrefs({ backgroundOpacity: index === 0 ? 0.6 : 0 }),
        ),
      );
      menu.appendChild(
        this.appearanceOptionRow(t.t("subtitleEdge"), [t.t("dropShadow"), t.t("outline"), t.t("none")], (index) =>
          this.subtitles.setPrefs({ edge: (["drop-shadow", "outline", "none"] as const)[index] ?? "none" }),
        ),
      );
      menu.appendChild(
        this.appearanceOptionRow(t.t("subtitlePosition"), [t.t("bottom"), t.t("top")], (index) =>
          this.subtitles.setPrefs({ position: index === 0 ? "bottom" : "top" }),
        ),
      );
    }
  }

  private menuRow(label: string, value: string, action: string): HTMLElement {
    const row = document.createElement("button");
    row.className = "lumen-menu-item";
    row.dataset.menuAction = action;
    row.setAttribute("role", "menuitem");
    row.innerHTML = `<span>${label}</span><span class="lumen-menu-value" style="color:var(--lumen-color-text-muted);display:flex;align-items:center;gap:4px">${value} ${icon("chevronRight")}</span>`;
    return row;
  }

  private backRow(): HTMLElement {
    const row = document.createElement("button");
    row.className = "lumen-menu-item lumen-menu-back";
    row.dataset.menuAction = "back";
    row.innerHTML = `${icon("chevronLeft")} ${this.strings.t("back")}`;
    return row;
  }

  private menuItem(label: string, checked: boolean, action: string, value: string): HTMLElement {
    const item = document.createElement("button");
    item.className = "lumen-menu-item";
    item.dataset.menuAction = action;
    item.dataset.value = value;
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-checked", String(checked));
    item.textContent = label;
    return item;
  }

  /**
   * A labelled row of choices. `onPick` receives the option's index rather
   * than its text, so the handler keeps working under translation.
   */
  private appearanceOptionRow(
    label: string,
    options: string[],
    onPick: (index: number) => void,
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "lumen-menu-row";
    const title = document.createElement("span");
    title.textContent = label;
    row.appendChild(title);

    const group = document.createElement("div");
    group.style.display = "flex";
    group.style.gap = "4px";
    options.forEach((option, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = option;
      button.style.cssText =
        "all:unset;cursor:pointer;font-size:0.75rem;padding:4px 8px;border-radius:6px;border:1px solid var(--lumen-color-border);color:var(--lumen-color-text)";
      button.addEventListener("click", () => {
        onPick(index);
        this.announce(`${label}: ${option}`);
      });
      group.appendChild(button);
    });

    row.appendChild(group);
    return row;
  }

  private onMenuAction(item: HTMLElement): void {
    const action = item.dataset.menuAction;
    switch (action) {
      case "back":
        this.openMenu("root");
        return;
      case "open-speed":
        this.openMenu("speed");
        return;
      case "open-quality":
        this.openMenu("quality");
        return;
      case "open-captions":
        this.openMenu("captions");
        return;
      case "open-appearance":
        this.openMenu("appearance");
        return;
      case "open-audio":
        this.openMenu("audio");
        return;
      case "open-chapters":
        this.openMenu("chapters");
        return;
      case "open-tools":
        this.openMenu("tools");
        return;
      case "panel-equalizer":
      case "panel-effects":
      case "panel-playlist":
      case "panel-info":
      case "panel-shortcuts": {
        const view = action.slice("panel-".length) as LumenPanel;
        this.closeMenu();
        void this.openPanel(view);
        return;
      }
      case "snapshot":
        this.closeMenu();
        void this.player.saveSnapshot();
        return;
      case "ab-loop":
        this.closeMenu();
        this.cycleAbLoop();
        return;
      case "add-bookmark":
        this.closeMenu();
        this.player.addBookmark();
        this.announce(this.strings.t("bookmarkAdded"));
        return;
      case "open-file-menu":
        this.closeMenu();
        this.promptForFile();
        return;
      case "set-audio": {
        const id = item.dataset.value ?? "";
        this.engine.setAudioTrack(id);
        this.announce(this.strings.t("audioAnnouncement", item.textContent ?? ""));
        this.openMenu("root");
        return;
      }
      case "seek-chapter": {
        const start = Number(item.dataset.value);
        if (Number.isFinite(start)) this.video.currentTime = start;
        this.announce(this.strings.t("chapterAnnouncement", item.textContent ?? ""));
        this.closeMenu();
        return;
      }
      case "set-speed": {
        const rate = Number(item.dataset.value);
        this.video.playbackRate = rate;
        this.announce(this.strings.t("speedAnnouncement", `${rate}×`));
        this.openMenu("root");
        return;
      }
      case "set-quality": {
        const value = item.dataset.value === "auto" ? "auto" : Number(item.dataset.value);
        this.engine.setQuality(value);
        this.announce(this.strings.t("qualityAnnouncement", value === "auto" ? this.strings.t("auto") : item.textContent ?? ""));
        this.openMenu("root");
        return;
      }
      case "set-track": {
        if (item.dataset.value === "off") {
          this.subtitles.setActiveTrack(null);
        } else {
          const idx = Number(item.dataset.value);
          this.subtitles.setActiveTrack(this.subtitles.tracks[idx] ?? null);
        }
        this.refreshCaptionsButton();
        this.openMenu("root");
        return;
      }
      default:
        return;
    }
  }

  // --------------------------------------------------------------- idle

  private bindIdle(): void {
    const reset = () => this.scheduleIdle();
    this.root.addEventListener("pointermove", reset);
    this.root.addEventListener("pointerdown", reset);
    this.root.addEventListener("keydown", reset);
    this.root.addEventListener("focusin", () => this.showControls());
    this.root.addEventListener("pointerleave", () => {
      if (!this.video.paused && !this.menuOpen) this.scheduleIdle(400);
    });
  }

  private scheduleIdle(delay = IDLE_MS): void {
    this.showControls();
    // Nothing auto-hides while playback is stopped or a surface is open:
    // there is no video to get out of the way of.
    if (this.video.paused || this.menuOpen || this.panelView !== null) return;
    this.idleTimer = window.setTimeout(() => {
      this.root.classList.add("is-idle");
    }, delay);
  }

  /**
   * Reveals the controls and cancels any pending hide.
   *
   * Cancelling matters: pausing used to only remove the class, leaving a
   * timer armed from before the pause to fire a moment later and hide the
   * controls again — on a paused video, with no way to get them back
   * except moving the pointer.
   */
  private showControls(): void {
    if (this.idleTimer !== null) {
      window.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.root.classList.remove("is-idle");
  }

  // ----------------------------------------------------------- keyboard

  private bindKeyboard(): void {
    this.root.addEventListener("keydown", this.boundKeydown);
  }

  /**
   * The focused element *inside the shadow tree*.
   *
   * `document.activeElement` reports the host element for anything focused
   * within a shadow root, so comparing it against a control in here never
   * matches — which is how the "don't hijack the volume slider's arrow
   * keys" guard below could silently do nothing.
   */
  private activeElement(): Element | null {
    const root = this.root.getRootNode();
    if (root instanceof ShadowRoot) return root.activeElement;
    return this.root.ownerDocument.activeElement;
  }

  private onKeydown(e: KeyboardEvent): void {
    const activeEl = this.activeElement();
    if (activeEl === this.els.volumeInput) return; // let the native range handle its own arrows
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // A panel is full of sliders, selects and buttons; single letters there
    // belong to whatever has focus, not to the player.
    if (this.panelView !== null && this.els.panel.contains(activeEl as Node)) {
      if (e.key === "Escape") this.closePanel();
      return;
    }

    switch (e.key) {
      case " ":
      case "k":
      case "K":
        this.togglePlay();
        e.preventDefault();
        break;
      case "ArrowRight":
        if (activeEl !== this.els.progress) {
          this.seekBy(5);
          e.preventDefault();
        }
        break;
      case "ArrowLeft":
        if (activeEl !== this.els.progress) {
          this.seekBy(-5);
          e.preventDefault();
        }
        break;
      case "j":
      case "J":
        this.seekBy(-10);
        break;
      case "l":
        this.seekBy(10);
        break;
      case "ArrowUp":
        this.video.volume = clamp(this.video.volume + 0.05, 0, 1);
        this.video.muted = false;
        e.preventDefault();
        break;
      case "ArrowDown":
        this.video.volume = clamp(this.video.volume - 0.05, 0, 1);
        e.preventDefault();
        break;
      case "m":
      case "M":
        this.video.muted = !this.video.muted;
        break;
      case "f":
      case "F":
        void this.toggleFullscreen();
        break;
      case "c":
      case "C":
      case "v":
        // VLC cycles subtitle tracks with `v`; `c` is the web convention
        // for toggling them. Both land on the same control.
        this.toggleCaptionsQuick();
        break;
      case "<":
      case ",":
        this.nudgeSpeed(-0.25);
        break;
      case ">":
      case ".":
        this.nudgeSpeed(0.25);
        break;

      // ---- VLC's power-user bindings ----
      case "e":
        this.player.stepFrame(1);
        break;
      case "E":
        this.player.stepFrame(-1);
        break;
      case "g":
        this.nudgeSubtitleDelay(-DELAY_STEP_MS);
        break;
      case "h":
        this.nudgeSubtitleDelay(DELAY_STEP_MS);
        break;
      case "G":
        this.nudgeAudioDelay(-DELAY_STEP_MS);
        break;
      case "H":
        this.nudgeAudioDelay(DELAY_STEP_MS);
        break;
      case "a":
        this.announce(
          this.strings.t("aspectAnnouncement", this.player.filters.cycleAspectRatio() ?? this.strings.t("source")),
        );
        break;
      case "z":
        this.announce(
          this.strings.t("zoomAnnouncement", `${Math.round(this.player.filters.cycleZoom() * 100)}%`),
        );
        break;
      case "r":
        this.announce(this.strings.t("rotationAnnouncement", `${this.player.filters.rotate()}°`));
        break;
      case "b":
        this.cycleAudioTrack();
        break;
      case "A":
        this.cycleAbLoop();
        break;
      case "B":
        this.player.addBookmark();
        this.announce(this.strings.t("bookmarkAdded"));
        break;
      case "s":
      case "S":
        void this.player.saveSnapshot();
        break;
      case "n":
        this.player.next();
        break;
      case "N":
        this.player.previous();
        break;
      case "R":
        this.player.setShuffle(!this.player.getShuffle());
        this.announce(
          this.strings.t("shuffleAnnouncement", this.strings.t(this.player.getShuffle() ? "on" : "off")),
        );
        break;
      case "L":
        this.cycleRepeat();
        break;
      case "p":
      case "P":
        void this.togglePanel("playlist");
        break;
      case "x":
      case "X":
        void this.togglePanel("effects");
        break;
      case "q":
      case "Q":
        void this.togglePanel("equalizer");
        break;
      case "i":
      case "I":
        void this.togglePanel("info");
        break;
      case "o":
      case "O":
        this.promptForFile();
        break;
      case "?":
        void this.togglePanel("shortcuts");
        break;

      case "Escape":
        if (this.menuOpen) this.closeMenu();
        else if (this.panelView !== null) this.closePanel();
        break;
      default:
        if (/^[0-9]$/.test(e.key) && Number.isFinite(this.video.duration)) {
          this.video.currentTime = (Number(e.key) / 10) * this.video.duration;
          e.preventDefault();
        }
    }
  }

  private nudgeSpeed(delta: number): void {
    const rate = clamp(this.video.playbackRate + delta, 0.25, 4);
    this.video.playbackRate = rate;
    this.announce(this.strings.t("speedAnnouncement", `${rate}×`));
  }

  private nudgeSubtitleDelay(deltaMs: number): void {
    const next = Math.round((this.player.getSubtitleOffset() + deltaMs / 1000) * 1000) / 1000;
    this.player.setSubtitleOffset(next);
    this.announce(this.strings.t("subtitleDelayAnnouncement", `${Math.round(next * 1000)} ms`));
  }

  private nudgeAudioDelay(deltaMs: number): void {
    const audio = this.player.audio;
    audio.set({ delayMs: audio.effects.delayMs + deltaMs });
    this.announce(this.strings.t("audioDelayAnnouncement", `${audio.effects.delayMs} ms`));
  }

  /** VLC's `b`: step to the next audio track, wrapping at the end. */
  private cycleAudioTrack(): void {
    const tracks = this.engine.audioTracks;
    if (tracks.length < 2) return;
    const current = tracks.findIndex((track) => track.active);
    const next = tracks[(current + 1) % tracks.length];
    if (!next) return;
    this.engine.setAudioTrack(next.id);
    this.announce(this.strings.t("audioAnnouncement", next.label));
  }

  /** Advances the A→B loop and announces which step it landed on. */
  cycleAbLoop(): void {
    const state = this.player.loop.cycle();
    const loop = this.player.loop.abLoop;
    if (state === "a-set") {
      this.announce(this.strings.t("abLoopStart"));
    } else if (state === "b-set" && loop?.end != null) {
      this.announce(this.strings.t("abLoopSet", `${formatTime(loop.start)} – ${formatTime(loop.end)}`));
    } else {
      this.announce(this.strings.t("abLoopCleared"));
    }
  }

  private cycleRepeat(): void {
    const order = ["off", "one", "all"] as const;
    const next = order[(order.indexOf(this.player.getRepeat()) + 1) % order.length] ?? "off";
    this.player.setRepeat(next);
    const label = next === "off" ? this.strings.t("off") : this.strings.t(next === "one" ? "repeatOne" : "repeatAll");
    this.announce(this.strings.t("repeatAnnouncement", label));
  }

  // ------------------------------------------------------------- public

  setPoster(url: string | null): void {
    if (url) {
      this.els.poster.style.backgroundImage = `url("${url}")`;
      this.els.poster.hidden = false;
    } else {
      this.els.poster.hidden = true;
    }
  }

  async setThumbnails(url: string | null): Promise<void> {
    this.thumbnails = url ? await ThumbnailTrack.load(url) : null;
  }

  announce(message: string): void {
    this.els.announcer.textContent = message;
  }

  /** Re-applies labels after the translation table changes. */
  retranslate(): void {
    this.applyStaticLabels();
    this.setPlayingUi(!this.video.paused);
    this.updateVolumeUi();
    this.updateFullscreenIcon();
    if (this.menuOpen) this.renderMenu();
    if (this.panelView !== null) void this.renderPanel();
  }

  /** Redraws the parts of the bar whose positions depend on the duration. */
  refreshTimeline(): void {
    this.renderLoopRegion();
    this.renderBookmarkMarks();
  }

  destroy(): void {
    document.removeEventListener("click", this.boundOutsideClick, true);
    document.removeEventListener("fullscreenchange", this.boundFullscreenChange);
    if (this.idleTimer) window.clearTimeout(this.idleTimer);
    if (this.clickTimer) window.clearTimeout(this.clickTimer);
    this.stopStats();
    this.panelController?.stop();
    this.panelController = null;
  }
}
