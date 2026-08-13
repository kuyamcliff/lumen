/**
 * Owns a MediaSource and its SourceBuffer, and serializes appends.
 *
 * SourceBuffer.appendBuffer() throws if called while an earlier append is
 * still in flight, so every producer needs the same little queue. Both
 * remux paths (mp4box.js for ISO-BMFF, the Matroska remuxer) share this
 * rather than each growing their own copy.
 */
/** How long to wait before retrying an append the browser refused. */
const RETRY_DELAY_MS = 250;

export class MseSink {
  private video: HTMLVideoElement;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private objectUrl: string | null = null;
  private queue: Uint8Array[] = [];
  private inputEnded = false;
  private destroyed = false;
  private retryTimer: number | null = null;
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
          this.pump();
          resolve(true);
        },
        { once: true },
      );
    });
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

    const next = this.queue.shift();
    if (next) {
      try {
        sourceBuffer.appendBuffer(next as BufferSource);
      } catch {
        // QuotaExceededError is the common case: the browser's buffer is
        // full because the viewer is far behind. Requeue rather than drop
        // media — but a failed append fires no `updateend`, so without an
        // explicit retry nothing would ever pump the queue again and
        // playback would stall permanently at the buffer's edge.
        this.queue.unshift(next);
        this.scheduleRetry();
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

  /**
   * Retries a rejected append shortly.
   *
   * Space frees up as playback advances past buffered media, so a short
   * fixed delay is the right shape here — this is waiting on the viewer,
   * not on the network.
   */
  private scheduleRetry(): void {
    if (this.retryTimer !== null || this.destroyed) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.pump();
    }, RETRY_DELAY_MS);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.queue = [];
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.sourceBuffer = null;
    this.mediaSource = null;
  }
}
