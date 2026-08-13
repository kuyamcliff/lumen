import type { EventEmitter } from "../core/EventEmitter";
import type { LumenChapter } from "../types";

/**
 * Reads chapter markers from a WebVTT chapters track.
 *
 * The browser already parses `<track kind="chapters">` into cues, so this
 * mostly waits for that to happen and normalizes the result — a chapters
 * track is set to "hidden" rather than "showing" so its cues are parsed
 * without the browser trying to render them over the video.
 */
export class ChapterManager {
  private video: HTMLVideoElement;
  private emitter: EventEmitter;
  private explicit: LumenChapter[] | null = null;
  private track: TextTrack | null = null;
  private boundOnCueChange = () => this.emitChange();

  constructor(video: HTMLVideoElement, emitter: EventEmitter) {
    this.video = video;
    this.emitter = emitter;
  }

  /** Adds a chapters track from a WebVTT URL. */
  addTrackElement(src: string, label = "Chapters", srclang = "en"): HTMLTrackElement {
    const element = document.createElement("track");
    element.kind = "chapters";
    element.label = label;
    element.srclang = srclang;
    element.src = src;
    this.video.appendChild(element);
    this.attach(element);
    return element;
  }

  /**
   * Starts loading a chapters track and adopts it once parsed.
   *
   * Setting the track's mode is what makes the browser fetch the VTT at
   * all — a track left "disabled" never loads, so waiting for its `load`
   * event before setting the mode would wait forever.
   */
  private attach(element: HTMLTrackElement): void {
    if (element.track) element.track.mode = "hidden";

    if (element.readyState === element.LOADED) {
      this.adopt(element.track);
      return;
    }
    element.addEventListener("load", () => this.adopt(element.track), { once: true });
  }

  /** Sets chapters directly, bypassing WebVTT entirely. */
  setChapters(chapters: LumenChapter[]): void {
    this.explicit = [...chapters].sort((a, b) => a.start - b.start);
    this.emitChange();
  }

  /**
   * Clears all chapter state without discarding the instance.
   *
   * Other components hold a long-lived reference to this manager, so
   * moving to a new playlist item has to reset in place — replacing the
   * object would leave them pointed at a dead one.
   */
  reset(): void {
    this.track?.removeEventListener("cuechange", this.boundOnCueChange);
    this.track = null;
    this.explicit = null;
    this.emitChange();
  }

  /** Picks up a chapters track that was declared in the light DOM. */
  adoptExisting(): void {
    const element = this.video.querySelector<HTMLTrackElement>('track[kind="chapters"]');
    if (element) this.attach(element);
  }

  private adopt(track: TextTrack | null): void {
    if (!track) return;
    this.track = track;
    // "hidden" parses cues without rendering them.
    track.mode = "hidden";
    track.addEventListener("cuechange", this.boundOnCueChange);
    this.emitChange();
  }

  get chapters(): LumenChapter[] {
    if (this.explicit) return this.explicit;
    const cues = this.track?.cues;
    if (!cues || cues.length === 0) return [];

    const duration = Number.isFinite(this.video.duration) ? this.video.duration : Infinity;
    return Array.from(cues).map((cue, index) => ({
      start: cue.startTime,
      // WebVTT chapter cues sometimes run to the next chapter rather than
      // carrying a meaningful end time; clamp the last one to the duration.
      end: Number.isFinite(cue.endTime) ? cue.endTime : Math.min(duration, cues[index + 1]?.startTime ?? duration),
      title: (cue as VTTCue).text ?? "",
    }));
  }

  chapterAt(time: number): LumenChapter | null {
    const chapters = this.chapters;
    for (let i = chapters.length - 1; i >= 0; i--) {
      if (time >= chapters[i]!.start) return chapters[i]!;
    }
    return null;
  }

  private emitChange(): void {
    this.emitter.emit("chapterschange", { chapters: this.chapters });
  }

  destroy(): void {
    this.track?.removeEventListener("cuechange", this.boundOnCueChange);
    this.track = null;
  }
}
