/**
 * Owns a MediaSource and its SourceBuffer, and serializes appends.
 *
 * SourceBuffer.appendBuffer() throws if called while an earlier append is
 * still in flight, so every producer needs the same little queue. Both
 * remux paths (mp4box.js for ISO-BMFF, the Matroska remuxer) share this
 * rather than each growing their own copy.
 */
export class MseSink {
  private video: HTMLVideoElement;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private objectUrl: string | null = null;
  private queue: Uint8Array[] = [];
  private inputEnded = false;
  private destroyed = false;
  private onFatal: (message: string) => void;

  constructor(video: HTMLVideoElement, onFatal: (message: string) => void) {
    this.video = video;
    this.onFatal = onFatal;
  }

  static isSupported(mime: string): boolean {
    return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(mime);
  }

  /**
   * Points the video element at a new MediaSource and resolves once its
   * SourceBuffer is ready. Resolves false if the browser refuses the MIME
   * type or the source never opens.
   */
  open(mime: string, mode: AppendMode = "segments"): Promise<boolean> {
    if (typeof MediaSource === "undefined") return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
      const mediaSource = new MediaSource();
      this.mediaSource = mediaSource;
      this.objectUrl = URL.createObjectURL(mediaSource);
      this.video.src = this.objectUrl;

      mediaSource.addEventListener(
        "sourceopen",
        () => {
          if (this.destroyed) {
            resolve(false);
            return;
          }
          try {
            const sourceBuffer = mediaSource.addSourceBuffer(mime);
            sourceBuffer.mode = mode;
            sourceBuffer.addEventListener("updateend", () => this.pump());
            sourceBuffer.addEventListener("error", () =>
              this.onFatal("Playback failed while decoding this video."),
            );
            this.sourceBuffer = sourceBuffer;
          } catch {
            resolve(false);
            return;
          }
          this.applyDuration();
          this.pump();
          resolve(true);
        },
        { once: true },
      );
    });
  }

  /**
   * Publishes the stream's total length, so the scrub bar is usable from
   * the first second rather than only once the file has finished
   * downloading.
   *
   * A MediaSource's duration is NaN until something sets it, and
   * `endOfStream()` only fixes it at the very end — which for a two-hour
   * file means two hours of a player that can't say where it is or be
   * seeked. Every container Lumen remuxes states its length in its header,
   * so that is used the moment it is known.
   */
  setDuration(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    this.pendingDuration = seconds;
    this.applyDuration();
  }

  private pendingDuration: number | null = null;

  private applyDuration(): void {
    const mediaSource = this.mediaSource;
    const seconds = this.pendingDuration;
    if (!mediaSource || seconds === null || mediaSource.readyState !== "open") return;
    // Shortening a MediaSource below what is already buffered throws, and
    // an over-long header is more common than an under-long one.
    if (this.sourceBuffer?.updating) return;
    try {
      mediaSource.duration = seconds;
      this.pendingDuration = null;
    } catch {
      // A header that disagrees with the media isn't worth failing over.
      this.pendingDuration = null;
    }
  }

  /** Queues a segment. Safe to call before the SourceBuffer exists — it drains once open. */
  append(data: Uint8Array): void {
    if (this.destroyed || data.byteLength === 0) return;
    this.queue.push(data);
    this.pump();
  }

  /** Marks the input complete; the stream ends once the queue has drained. */
  endOfInput(): void {
    this.inputEnded = true;
    this.pump();
  }

  private pump(): void {
    const sourceBuffer = this.sourceBuffer;
    if (this.destroyed || !sourceBuffer || sourceBuffer.updating) return;
    if (this.pendingDuration !== null) this.applyDuration();

    const next = this.queue.shift();
    if (next) {
      try {
        sourceBuffer.appendBuffer(next as BufferSource);
      } catch {
        // QuotaExceededError is the common case here: the browser's buffer
        // is full because the viewer is far behind. Requeue and wait for
        // playback to free room rather than dropping media.
        this.queue.unshift(next);
      }
      return;
    }

    if (this.inputEnded && this.mediaSource?.readyState === "open") {
      try {
        this.mediaSource.endOfStream();
      } catch {
        /* already ended */
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.queue = [];
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.sourceBuffer = null;
    this.mediaSource = null;
  }
}
