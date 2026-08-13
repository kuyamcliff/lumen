import type { EventEmitter } from "../core/EventEmitter";
import type { PlaybackEngine } from "../core/PlaybackEngine";
import type { SubtitleManager } from "../subtitles/SubtitleManager";
import type { ChapterManager } from "../media/ChapterManager";
import type { CastController } from "../media/CastController";
import type { Translator } from "../i18n";
import type { LumenError } from "../types";
import { bufferedEnd, clamp, formatTime } from "../utils/time";
import { isCoarsePointer } from "../utils/dom";
import { icon } from "./icons";
import { ThumbnailTrack } from "./Thumbnails";
import {
  enterFullscreen,
  exitFullscreen,
  isFullscreen,
  isFullscreenSupported,
  onFullscreenChange,
} from "../media/fullscreen";

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const IDLE_MS = 2600;
type MenuView = "root" | "speed" | "quality" | "captions" | "appearance" | "audio" | "chapters";

/** Playlist state the controls need, without coupling them to the player. */
export interface PlaylistBridge {
  hasPlaylist(): boolean;
  hasNext(): boolean;
  hasPrevious(): boolean;
  next(): void;
  previous(): void;
}

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
  playlist: PlaylistBridge;
  retry: () => void;
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
  private playlist: PlaylistBridge;
  private retryAction: () => void;

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
    time: HTMLElement;
    volumeInput: HTMLInputElement;
    captions: HTMLElement;
    castButton: HTMLElement;
    nextButton: HTMLElement;
    previousButton: HTMLElement;
    menu: HTMLElement;
    announcer: HTMLElement;
  };

  private idleTimer: number | null = null;
  private isScrubbing = false;
  private wasPlayingBeforeScrub = false;
  private menuOpen = false;
  private menuView: MenuView = "root";
  private thumbnails: ThumbnailTrack | null = null;
  private boundOutsideClick = this.onOutsideClick.bind(this);
  private boundKeydown = this.onKeydown.bind(this);
  private boundFullscreenChange = () => this.onFullscreenChange();
  /** Unsubscribes every fullscreen-change spelling in one call. */
  private offFullscreenChange: (() => void) | null = null;
  private boundMenuClick = (event: Event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>("[data-menu-action]");
    if (item) this.onMenuAction(item);
  };
  private boundMenuKeydown = (event: Event) => this.onMenuKeydown(event as KeyboardEvent);
  /** The control that opened the menu, so focus can be handed back on close. */
  private menuOpener: HTMLElement | null = null;

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
    this.playlist = opts.playlist;
    this.retryAction = opts.retry;

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
      time: $(this.root, '[data-el="time"]'),
      volumeInput: $(this.root, '[data-el="volume"]') as HTMLInputElement,
      captions: $(this.root, '[data-action="captions-toggle"]'),
      castButton: $(this.root, '[data-action="cast"]'),
      nextButton: $(this.root, '[data-action="next"]'),
      previousButton: $(this.root, '[data-action="previous"]'),
      menu: $(this.root, '[data-el="menu"]'),
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
    this.updatePipSupport();
    this.updateFullscreenIcon();
    this.applyStaticLabels();
    this.refreshPlaylistButtons();

    document.addEventListener("click", this.boundOutsideClick, true);
    this.offFullscreenChange = onFullscreenChange(this.video, this.boundFullscreenChange);

    // Menu contents are re-rendered constantly, so the handler is delegated
    // from the menu container once. Registering it per render used to leak
    // a listener each time — and worse, a `once` listener meant a single
    // click on anything that wasn't a menu item (the panel's own padding, a
    // caption-appearance button) silently killed the whole menu.
    this.els.menu.addEventListener("click", this.boundMenuClick);
    this.els.menu.addEventListener("keydown", this.boundMenuKeydown);
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

    const retry = this.root.querySelector('[data-action="retry"]');
    if (retry) retry.innerHTML = `${icon("refresh")} ${this.strings.t("tryAgain")}`;
  }

  /** Shows the next/previous buttons only when a playlist actually offers somewhere to go. */
  refreshPlaylistButtons(): void {
    const hasPlaylist = this.playlist.hasPlaylist();
    this.els.nextButton.hidden = !hasPlaylist;
    this.els.previousButton.hidden = !hasPlaylist;
    this.els.nextButton.toggleAttribute("disabled", !this.playlist.hasNext());
    this.els.previousButton.toggleAttribute("disabled", !this.playlist.hasPrevious());
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
          this.playlist.next();
          break;
        case "previous":
          this.playlist.previous();
          break;
        case "fullscreen":
          this.toggleFullscreen();
          break;
        case "settings":
          // `detail === 0` means the click came from the keyboard (Enter or
          // Space), where focus must move into the menu to keep going.
          this.toggleMenu((e as MouseEvent).detail === 0);
          break;
        case "retry":
          this.hideError();
          this.retryAction();
          break;
        default:
          break;
      }
    });

    // Clicking/tapping the video surface itself toggles play (desktop only —
    // on touch it should just reveal controls, handled by bindIdle).
    this.video.addEventListener("click", () => {
      if (!isCoarsePointer()) this.togglePlay();
    });

    this.root.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest(".lumen-controls, .lumen-menu")) return;
      this.toggleFullscreen();
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
    this.els.progress.setAttribute("aria-valuetext", `${formatTime(currentTime)} of ${formatTime(duration)}`);
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

  private toggleCaptionsQuick(): void {
    if (this.subtitles.current) {
      this.subtitles.setActiveTrack(null);
      this.announce(this.strings.t("captionsOff"));
    } else {
      const first = this.subtitles.tracks[0];
      if (first) {
        this.subtitles.setActiveTrack(first);
        this.announce(this.strings.t("captionsAnnouncement", first.label || first.language));
      }
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
      if (isFullscreen(this.host, this.video)) {
        await exitFullscreen(this.video);
      } else {
        await enterFullscreen(this.host, this.video);
      }
    } catch {
      this.announce(this.strings.t("fullscreenUnavailable"));
    }
  }

  private onFullscreenChange(): void {
    this.updateFullscreenIcon();
    const isFs = isFullscreen(this.host, this.video);
    this.emitter.emit(isFs ? "enterfullscreen" : "exitfullscreen", undefined);
  }

  private updateFullscreenIcon(): void {
    const btn = $(this.root, '[data-action="fullscreen"]');
    // Hidden where no form of fullscreen exists at all, rather than left
    // there to announce "unavailable" on every press.
    btn.hidden = !isFullscreenSupported(this.host, this.video);
    const isFs = isFullscreen(this.host, this.video);
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

  // --------------------------------------------------------------- menu

  private toggleMenu(focusFirst = false): void {
    if (this.menuOpen) this.closeMenu();
    else this.openMenu("root", focusFirst);
  }

  private openMenu(view: MenuView, focusFirst = false): void {
    // Remember where focus came from the first time the menu opens, not on
    // every submenu navigation — otherwise closing would return focus to a
    // menu row that no longer exists.
    if (!this.menuOpen) {
      const active = this.root.getRootNode() as ShadowRoot | Document;
      this.menuOpener = (active.activeElement as HTMLElement | null) ?? null;
    }

    this.menuOpen = true;
    this.menuView = view;
    this.renderMenu();
    this.els.menu.hidden = false;
    $(this.root, '[data-action="settings"]').setAttribute("aria-expanded", "true");
    this.showControls();

    if (focusFirst) this.focusMenuItem(0);
  }

  /** Focusable rows of the open menu, in visual order. */
  private menuItems(): HTMLElement[] {
    return [...this.els.menu.querySelectorAll<HTMLElement>("[data-menu-action], .lumen-menu-row button")];
  }

  private focusMenuItem(index: number): void {
    const items = this.menuItems();
    if (items.length === 0) return;
    // Wrap around: a menu is a loop, not a list with dead ends.
    const target = items[(index + items.length) % items.length]!;
    target.focus();
  }

  /**
   * Arrow-key navigation inside the menu.
   *
   * Menu semantics differ from Tab order: Up/Down move between rows, Left
   * backs out of a submenu, and Escape closes and returns focus to the
   * button that opened it.
   */
  private onMenuKeydown(event: KeyboardEvent): void {
    const items = this.menuItems();
    const index = items.indexOf(event.target as HTMLElement);

    switch (event.key) {
      case "ArrowDown":
        this.focusMenuItem(index + 1);
        event.preventDefault();
        break;
      case "ArrowUp":
        this.focusMenuItem(index - 1);
        event.preventDefault();
        break;
      case "Home":
        this.focusMenuItem(0);
        event.preventDefault();
        break;
      case "End":
        this.focusMenuItem(items.length - 1);
        event.preventDefault();
        break;
      case "ArrowLeft":
        if (this.menuView !== "root") {
          this.openMenu("root", true);
          event.preventDefault();
        }
        break;
      case "Escape":
        this.closeMenu();
        event.preventDefault();
        // Escape shouldn't also reach the player's own handler.
        event.stopPropagation();
        break;
      default:
        break;
    }
  }

  private closeMenu(): void {
    if (!this.menuOpen) return;
    this.menuOpen = false;
    this.els.menu.hidden = true;
    $(this.root, '[data-action="settings"]').setAttribute("aria-expanded", "false");

    // Returning focus is what keeps keyboard use coherent: closing a menu
    // should never dump focus back to the top of the document.
    if (this.menuOpener?.isConnected) this.menuOpener.focus();
    else $(this.root, '[data-action="settings"]').focus();
    this.menuOpener = null;
  }

  private onOutsideClick(e: MouseEvent): void {
    if (!this.menuOpen) return;
    const path = e.composedPath();
    if (!path.includes(this.els.menu) && !path.includes($(this.root, '[data-action="settings"]'))) {
      this.closeMenu();
    }
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
      // `isAdaptive`, not `isHls`: DASH streams carry quality levels too,
      // and gating on HLS alone hid the menu for every one of them.
      if (this.engine.isAdaptive && this.engine.qualityLevels.length > 0) {
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

    const name = document.createElement("span");
    name.textContent = label;

    const detail = document.createElement("span");
    detail.className = "lumen-menu-value";
    detail.style.cssText = "color:var(--lumen-color-text-muted);display:flex;align-items:center;gap:4px";

    // Assembled from nodes rather than an interpolated HTML string: `value`
    // is media-derived — a caption track's label, an audio track's name
    // from a manifest — so an angle bracket in it used to be parsed as
    // markup, which is a script-injection route for anyone who can serve
    // the media.
    const text = document.createElement("span");
    text.textContent = value;
    detail.appendChild(text);
    detail.insertAdjacentHTML("beforeend", icon("chevronRight"));

    row.append(name, detail);
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
    // Preserve keyboard context: if a row was activated by keyboard, the
    // view it opens should receive focus rather than stranding it.
    const keyboard = this.menuItems().includes(document.activeElement as HTMLElement) ||
      this.els.menu.contains((this.root.getRootNode() as ShadowRoot).activeElement as Node);
    switch (action) {
      case "back":
        this.openMenu("root", keyboard);
        return;
      case "open-speed":
        this.openMenu("speed", keyboard);
        return;
      case "open-quality":
        this.openMenu("quality", keyboard);
        return;
      case "open-captions":
        this.openMenu("captions", keyboard);
        return;
      case "open-appearance":
        this.openMenu("appearance", keyboard);
        return;
      case "open-audio":
        this.openMenu("audio", keyboard);
        return;
      case "open-chapters":
        this.openMenu("chapters", keyboard);
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
    if (this.idleTimer) window.clearTimeout(this.idleTimer);
    if (this.video.paused || this.menuOpen) return;
    this.idleTimer = window.setTimeout(() => {
      this.root.classList.add("is-idle");
    }, delay);
  }

  private showControls(): void {
    this.root.classList.remove("is-idle");
  }

  // ----------------------------------------------------------- keyboard

  private bindKeyboard(): void {
    this.root.addEventListener("keydown", this.boundKeydown);
  }

  private onKeydown(e: KeyboardEvent): void {
    const activeEl = this.root.ownerDocument.activeElement;
    if (activeEl === this.els.volumeInput) return; // let the native range handle its own arrows
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    switch (e.key) {
      case " ":
      case "k":
      case "K":
        this.togglePlay();
        e.preventDefault();
        break;
      case "ArrowRight":
        if (activeEl !== this.els.progress) this.seekBy(5);
        break;
      case "ArrowLeft":
        if (activeEl !== this.els.progress) this.seekBy(-5);
        break;
      case "j":
      case "J":
        this.seekBy(-10);
        break;
      case "l":
      case "L":
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
        this.toggleCaptionsQuick();
        break;
      case "<":
      case ",":
        this.video.playbackRate = Math.max(0.25, this.video.playbackRate - 0.25);
        break;
      case ">":
      case ".":
        this.video.playbackRate = Math.min(2, this.video.playbackRate + 0.25);
        break;
      case "Escape":
        if (this.menuOpen) this.closeMenu();
        break;
      default:
        if (/^[0-9]$/.test(e.key) && Number.isFinite(this.video.duration)) {
          this.video.currentTime = (Number(e.key) / 10) * this.video.duration;
        }
    }
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
  }

  destroy(): void {
    document.removeEventListener("click", this.boundOutsideClick, true);
    // This one used to be an anonymous listener that was never removed, so
    // a destroyed player kept reacting to fullscreen changes forever.
    this.offFullscreenChange?.();
    this.offFullscreenChange = null;
    this.els.menu.removeEventListener("click", this.boundMenuClick);
    this.els.menu.removeEventListener("keydown", this.boundMenuKeydown);
    this.root.removeEventListener("keydown", this.boundKeydown);
    if (this.idleTimer) window.clearTimeout(this.idleTimer);
  }
}
