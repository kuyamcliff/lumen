import type { EventEmitter } from "../core/EventEmitter";

/** How playback behaves when the current item finishes. */
export type RepeatMode = "off" | "one" | "all";

export interface AbLoop {
  start: number;
  /** null while only the A point has been set. */
  end: number | null;
}

/**
 * A→B looping: mark a point, mark a second one, and playback repeats
 * between them until you clear it. VLC puts this behind one toolbar button
 * that cycles A → B → off, and that's the model here.
 *
 * Enforcement rides on `timeupdate` rather than a timer: it fires often
 * enough to catch the B point within a frame or two at 1×, and it costs
 * nothing when no loop is set.
 */
export class LoopController {
  private video: HTMLVideoElement;
  private emitter: EventEmitter;
  private loop: AbLoop | null = null;
  private boundTimeUpdate = this.onTimeUpdate.bind(this);

  constructor(video: HTMLVideoElement, emitter: EventEmitter) {
    this.video = video;
    this.emitter = emitter;
    this.video.addEventListener("timeupdate", this.boundTimeUpdate);
  }

  get abLoop(): AbLoop | null {
    return this.loop ? { ...this.loop } : null;
  }

  /**
   * Advances the A→B loop one step: sets A, then B, then clears.
   * Returns the state it moved to, so a caller can announce it.
   */
  cycle(): "a-set" | "b-set" | "cleared" {
    const time = this.video.currentTime;

    if (!this.loop) {
      this.loop = { start: time, end: null };
      this.emitChange();
      return "a-set";
    }

    if (this.loop.end === null) {
      // A B point at or before A would loop zero or negative seconds; the
      // useful reading of "B is behind A" is that the two are swapped.
      if (time <= this.loop.start) {
        this.loop = { start: time, end: this.loop.start };
      } else {
        this.loop = { start: this.loop.start, end: time };
      }
      this.emitChange();
      return "b-set";
    }

    this.loop = null;
    this.emitChange();
    return "cleared";
  }

  /** Sets both points at once, or clears the loop with `null`. */
  set(loop: AbLoop | null): void {
    if (!loop) {
      this.loop = null;
    } else {
      const end = loop.end === null ? null : Math.max(loop.start, loop.end);
      this.loop = { start: Math.max(0, loop.start), end };
    }
    this.emitChange();
  }

  clear(): void {
    if (!this.loop) return;
    this.loop = null;
    this.emitChange();
  }

  private onTimeUpdate(): void {
    const loop = this.loop;
    if (!loop || loop.end === null) return;
    const time = this.video.currentTime;
    if (time >= loop.end || time < loop.start - 0.5) {
      this.video.currentTime = loop.start;
    }
  }

  private emitChange(): void {
    this.emitter.emit("abloopchange", { loop: this.abLoop });
  }

  destroy(): void {
    this.video.removeEventListener("timeupdate", this.boundTimeUpdate);
    this.loop = null;
  }
}
