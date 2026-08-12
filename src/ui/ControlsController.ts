import type { EventEmitter } from "../core/EventEmitter";
import type { PlaybackEngine } from "../core/PlaybackEngine";
import type { SubtitleManager } from "../subtitles/SubtitleManager";
import type { LumenError, LumenQualityLevel } from "../types";
import { bufferedEnd, clamp, formatTime } from "../utils/time";
import { isCoarsePointer } from "../utils/dom";
import { icon } from "./icons";
import { ThumbnailTrack } from "./Thumbnails";

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const IDLE_MS = 2600;
type MenuView = "root" | "speed" | "quality" | "captions" | "appearance";

export interface ControlsControllerOptions {
  root: HTMLElement;
  video: HTMLVideoElement;
  host: HTMLElement;
  emitter: EventEmitter;
  engine: PlaybackEngine;
  subtitles: SubtitleManager;
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
    time: HTMLElement;
    volumeInput: HTMLInputElement;
    captions: HTMLElement;
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

  constructor(opts: ControlsControllerOptions) {
    this.root = opts.root;
    this.video = opts.video;
    this.host = opts.host;
    this.emitter = opts.emitter;
    this.engine = opts.engine;
    this.subtitles = opts.subtitles;
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
      time: $(this.root, '[data-el="time"]'),
      volumeInput: $(this.root, '[data-el="volume"]') as HTMLInputElement,
      captions: $(this.root, '[data-action="captions-toggle"]'),
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
    this.updatePipSupport();
    this.updateFullscreenIcon();

    document.addEventListener("click", this.boundOutsideClick, true);
    document.addEventListener("fullscreenchange", () => this.onFullscreenChange());
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
    });
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
    this.els.bigPlay.setAttribute("aria-label", playing ? "Pause" : "Play");
    this.els.bigPlay.hidden = playing;
    const playBtn = $(this.root, '.lumen-row [data-action="play-pause"]');
    playBtn.innerHTML = svg;
    playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
    if (playing) {
      this.els.poster.hidden = true;
      this.announce("Playing");
    } else {
      this.announce("Paused");
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
        case "fullscreen":
          this.toggleFullscreen();
          break;
        case "settings":
          this.toggleMenu();
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
      this.video.play().catch(() => this.announce("Playback was blocked by the browser"));
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
    muteBtn.setAttribute("aria-label", muted ? "Unmute" : "Mute");
    muteBtn.setAttribute("aria-pressed", String(muted));
  }

  // ------------------------------------------------------------ captions

  private bindSubtitleEvents(): void {
    this.emitter.on("texttrackchange", () => this.refreshCaptionsButton());
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
      this.announce("Captions off");
    } else {
      const first = this.subtitles.tracks[0];
      if (first) {
        this.subtitles.setActiveTrack(first);
        this.announce(`Captions: ${first.label || first.language}`);
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
      this.announce("Picture-in-picture isn't available right now");
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
      this.announce("Fullscreen isn't available right now");
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
    btn.setAttribute("aria-label", isFs ? "Exit fullscreen" : "Fullscreen");
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

  private renderMenu(): void {
    const menu = this.els.menu;
    menu.replaceChildren();
    menu.addEventListener(
      "click",
      (e) => {
        const item = (e.target as HTMLElement).closest<HTMLElement>("[data-menu-action]");
        if (item) this.onMenuAction(item);
      },
      { once: true },
    );

    if (this.menuView === "root") {
      menu.appendChild(this.menuRow("gauge", `Speed`, `${this.video.playbackRate}×`, "open-speed"));
      const quality = this.engine.currentQuality;
      const qualityLabel = this.engine.isHls
        ? this.engine.isAutoQuality
          ? `Auto${quality ? ` (${quality.label})` : ""}`
          : quality?.label ?? "Auto"
        : "";
      if (this.engine.isHls && this.engine.qualityLevels.length > 0) {
        menu.appendChild(this.menuRow("settings", "Quality", qualityLabel, "open-quality"));
      }
      if (this.subtitles.tracks.length > 0) {
        menu.appendChild(this.menuRow("captions", "Captions", this.subtitles.current?.label ?? "Off", "open-captions"));
      }
      return;
    }

    menu.appendChild(this.backRow());

    if (this.menuView === "speed") {
      for (const speed of SPEEDS) {
        menu.appendChild(
          this.menuItem(`${speed}×`, this.video.playbackRate === speed, "set-speed", String(speed)),
        );
      }
    } else if (this.menuView === "quality") {
      menu.appendChild(this.menuItem("Auto", this.engine.isAutoQuality, "set-quality", "auto"));
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
    } else if (this.menuView === "captions") {
      menu.appendChild(this.menuItem("Off", !this.subtitles.current, "set-track", "off"));
      this.subtitles.tracks.forEach((t, i) => {
        menu.appendChild(this.menuItem(t.label || t.language || `Track ${i + 1}`, this.subtitles.current === t, "set-track", String(i)));
      });
      if (this.subtitles.current) {
        menu.appendChild(this.menuRow("settings", "Appearance", "", "open-appearance"));
      }
    } else if (this.menuView === "appearance") {
      menu.appendChild(this.sizeRow());
      menu.appendChild(this.appearanceOptionRow("Background", ["Solid", "Off"], (v) =>
        this.subtitles.setPrefs({ backgroundOpacity: v === "Solid" ? 0.6 : 0 }),
      ));
      menu.appendChild(
        this.appearanceOptionRow("Edge", ["Drop shadow", "Outline", "None"], (v) =>
          this.subtitles.setPrefs({
            edge: v === "Drop shadow" ? "drop-shadow" : v === "Outline" ? "outline" : "none",
          }),
        ),
      );
      menu.appendChild(
        this.appearanceOptionRow("Position", ["Bottom", "Top"], (v) =>
          this.subtitles.setPrefs({ position: v === "Bottom" ? "bottom" : "top" }),
        ),
      );
    }
  }

  private menuRow(iconName: Parameters<typeof icon>[0], label: string, value: string, action: string): HTMLElement {
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
    row.innerHTML = `${icon("chevronLeft")} Back`;
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

  private sizeRow(): HTMLElement {
    return this.appearanceOptionRow("Size", ["Small", "Medium", "Large"], (v) =>
      this.subtitles.setPrefs({ fontSize: v === "Small" ? 0.8 : v === "Large" ? 1.3 : 1 }),
    );
  }

  private appearanceOptionRow(label: string, options: string[], onPick: (value: string) => void): HTMLElement {
    const row = document.createElement("div");
    row.className = "lumen-menu-row";
    const title = document.createElement("span");
    title.textContent = label;
    row.appendChild(title);
    const group = document.createElement("div");
    group.style.display = "flex";
    group.style.gap = "4px";
    for (const opt of options) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = opt;
      btn.style.cssText =
        "all:unset;cursor:pointer;font-size:0.75rem;padding:4px 8px;border-radius:6px;border:1px solid var(--lumen-color-border);color:var(--lumen-color-text)";
      btn.addEventListener("click", () => {
        onPick(opt);
        this.announce(`${label}: ${opt}`);
      });
      group.appendChild(btn);
    }
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
      case "set-speed": {
        const rate = Number(item.dataset.value);
        this.video.playbackRate = rate;
        this.announce(`Speed ${rate}×`);
        this.openMenu("root");
        return;
      }
      case "set-quality": {
        const value = item.dataset.value === "auto" ? "auto" : Number(item.dataset.value);
        this.engine.setQuality(value);
        this.announce(value === "auto" ? "Quality: Auto" : `Quality: ${item.textContent}`);
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

  destroy(): void {
    document.removeEventListener("click", this.boundOutsideClick, true);
    if (this.idleTimer) window.clearTimeout(this.idleTimer);
  }
}
