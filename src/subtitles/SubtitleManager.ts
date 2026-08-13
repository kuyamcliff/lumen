import type { EventEmitter } from "../core/EventEmitter";
import { DEFAULT_SUBTITLE_PREFS, type LumenTextTrackInit, type SubtitleStylePrefs } from "../types";
import { getItem, setItem } from "../utils/storage";

const TEXT_KINDS = new Set<TextTrackKind>(["subtitles", "captions"]);

function isTextKind(track: TextTrack): boolean {
  return TEXT_KINDS.has(track.kind);
}

/** The parts of a cue this module actually uses. */
interface TimedCue {
  startTime: number;
  endTime: number;
  text: string;
}

/**
 * Cues are duck-typed rather than tested with `instanceof VTTCue`, for two
 * reasons that both end in captions silently never appearing: `VTTCue` is
 * not defined in every environment (the bare reference throws), and cues
 * extracted from in-band CEA-608/708 captions are plain `TextTrackCue`
 * objects in Safari, which an `instanceof` check drops on the floor.
 */
function asTimedCue(cue: TextTrackCue): TimedCue | null {
  const candidate = cue as Partial<TimedCue>;
  return typeof candidate.startTime === "number" &&
    typeof candidate.endTime === "number" &&
    typeof candidate.text === "string"
    ? (candidate as TimedCue)
    : null;
}

function sanitizeCueHtml(raw: string): string {
  const escaped = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped
    .replace(/&lt;(\/?)(b|i|u)&gt;/gi, "<$1$2>")
    .replace(/\r?\n/g, "<br>");
}

/**
 * Owns everything text-track related: discovery of embedded/external
 * tracks, active-track switching, persisted user styling preferences, and
 * rendering active cues into a custom overlay so styling isn't limited to
 * whatever the browser's native caption renderer allows (which also breaks
 * down inside a Shadow DOM in fullscreen on several browsers).
 */
export class SubtitleManager {
  private video: HTMLVideoElement;
  private overlay: HTMLElement;
  private emitter: EventEmitter;
  private _prefs: SubtitleStylePrefs;
  private appliedOffsets = new WeakMap<TextTrack, number>();
  private activeTrack: TextTrack | null = null;
  private boundCueChange = this.renderActiveCues.bind(this);
  private boundTrackListChange = this.onTrackListChange.bind(this);

  constructor(video: HTMLVideoElement, overlay: HTMLElement, emitter: EventEmitter) {
    this.video = video;
    this.overlay = overlay;
    this.emitter = emitter;
    this._prefs = { ...DEFAULT_SUBTITLE_PREFS, ...getItem("subtitle-prefs", {}) };
    this.applyOverlayStyle();
    // Feature-detected: TextTrackList extends EventTarget per spec, but
    // some test/runtime environments (e.g. jsdom) don't implement it.
    if (typeof this.video.textTracks.addEventListener === "function") {
      this.video.textTracks.addEventListener("addtrack", this.boundTrackListChange);
      this.video.textTracks.addEventListener("removetrack", this.boundTrackListChange);
    }
  }

  get tracks(): TextTrack[] {
    return Array.from(this.video.textTracks).filter(isTextKind);
  }

  get current(): TextTrack | null {
    return this.activeTrack;
  }

  get prefs(): SubtitleStylePrefs {
    return this._prefs;
  }

  addTrack(init: LumenTextTrackInit): HTMLTrackElement {
    const el = document.createElement("track");
    el.kind = init.kind ?? "subtitles";
    el.label = init.label;
    el.srclang = init.srclang;
    el.src = init.src;
    if (init.default) el.default = true;

    el.addEventListener("load", () => {
      const offset = this._prefs.offsetSeconds;
      if (offset !== 0 && el.track) this.shiftCues(el.track, offset);
      if (init.default) this.setActiveTrack(el.track);
    });

    this.video.appendChild(el);
    return el;
  }

  /** Restores a previously chosen language, if that track exists. Call after tracks are attached. */
  restorePreference(): void {
    const lang = getItem<string | null>("subtitle-lang", null);
    if (!lang) return;
    const match = this.tracks.find((t) => t.language === lang);
    if (match) this.setActiveTrack(match);
  }

  setActiveTrack(track: TextTrack | null): void {
    if (this.activeTrack) {
      this.activeTrack.removeEventListener("cuechange", this.boundCueChange);
      this.activeTrack.mode = "disabled";
    }

    this.activeTrack = track;
    this.overlay.replaceChildren();

    if (track) {
      // "hidden" parses cues and fires cuechange without drawing the
      // browser's own caption box — we render cues ourselves below.
      track.mode = "hidden";
      track.addEventListener("cuechange", this.boundCueChange);
      setItem("subtitle-lang", track.language || track.label);
    } else {
      setItem("subtitle-lang", null);
    }

    this.emitter.emit("texttrackchange", { track });
  }

  setPrefs(patch: Partial<SubtitleStylePrefs>): void {
    const nextOffset = patch.offsetSeconds;
    this._prefs = { ...this._prefs, ...patch };
    setItem("subtitle-prefs", this._prefs);
    this.applyOverlayStyle();

    if (typeof nextOffset === "number" && this.activeTrack) {
      this.shiftCues(this.activeTrack, nextOffset);
    }
    this.renderActiveCues();
  }

  private shiftCues(track: TextTrack, targetOffset: number): void {
    const previous = this.appliedOffsets.get(track) ?? 0;
    const delta = targetOffset - previous;
    if (delta !== 0 && track.cues) {
      for (const cue of Array.from(track.cues)) {
        const timed = asTimedCue(cue);
        if (timed) {
          timed.startTime += delta;
          timed.endTime += delta;
        }
      }
    }
    this.appliedOffsets.set(track, targetOffset);
  }

  private renderActiveCues(): void {
    this.overlay.replaceChildren();
    if (!this.activeTrack) return;

    const cues = this.activeTrack.activeCues;
    if (!cues || cues.length === 0) return;

    const frag = document.createDocumentFragment();
    for (const cue of Array.from(cues)) {
      const timed = asTimedCue(cue);
      if (!timed) continue;
      const line = document.createElement("span");
      line.className = "lumen-cue";
      line.innerHTML = sanitizeCueHtml(timed.text);
      frag.appendChild(line);
    }
    this.overlay.appendChild(frag);
  }

  private applyOverlayStyle(): void {
    const p = this._prefs;
    this.overlay.style.setProperty("--lumen-cue-scale", String(p.fontSize));
    this.overlay.style.setProperty("--lumen-cue-color", p.color);
    this.overlay.style.setProperty("--lumen-cue-bg", p.background);
    this.overlay.style.setProperty("--lumen-cue-bg-opacity", String(p.backgroundOpacity));
    if (p.fontFamily) this.overlay.style.setProperty("--lumen-cue-font", p.fontFamily);
    this.overlay.dataset.edge = p.edge;
    this.overlay.dataset.position = p.position;
  }

  private onTrackListChange(): void {
    this.emitter.emit("texttrackchange", { track: this.activeTrack });
  }

  destroy(): void {
    if (this.activeTrack) this.activeTrack.removeEventListener("cuechange", this.boundCueChange);
    if (typeof this.video.textTracks.removeEventListener === "function") {
      this.video.textTracks.removeEventListener("addtrack", this.boundTrackListChange);
      this.video.textTracks.removeEventListener("removetrack", this.boundTrackListChange);
    }
    this.overlay.replaceChildren();
  }
}
