export interface SnapshotOptions {
  /** Output MIME type. PNG keeps text sharp; JPEG is smaller. */
  type?: "image/png" | "image/jpeg" | "image/webp";
  /** 0–1, JPEG/WebP only. */
  quality?: number;
  /** Output width; height follows the frame's aspect ratio. Defaults to the native size. */
  width?: number;
}

export class SnapshotError extends Error {
  constructor(
    message: string,
    /** `tainted` when the frame can't be read because of cross-origin rules. */
    readonly reason: "no-frame" | "tainted" | "unsupported",
  ) {
    super(message);
    this.name = "SnapshotError";
  }
}

/**
 * Captures the frame currently on screen, VLC's Shift+S.
 *
 * The frame is read straight off the video element into a canvas, which
 * means it reflects what the decoder produced — not what CSS filters make
 * it look like. Lumen's own adjustments are re-applied to the canvas
 * context so a snapshot matches the picture the viewer is actually
 * watching.
 */
export function captureFrame(
  video: HTMLVideoElement,
  options: SnapshotOptions & { cssFilter?: string } = {},
): HTMLCanvasElement {
  const nativeWidth = video.videoWidth;
  const nativeHeight = video.videoHeight;
  if (!nativeWidth || !nativeHeight) {
    throw new SnapshotError("There's no frame to capture yet.", "no-frame");
  }

  const width = Math.round(options.width ?? nativeWidth);
  const height = Math.round((width / nativeWidth) * nativeHeight);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) throw new SnapshotError("This browser can't capture frames.", "unsupported");

  // Canvas filters take the same syntax as the CSS property, so the colour
  // adjustments carry over verbatim — except the SVG `url(#…)` reference,
  // which a detached canvas can't resolve.
  if (options.cssFilter && options.cssFilter !== "none") {
    const withoutSvgRefs = options.cssFilter.replace(/url\(#[^)]*\)/g, "").trim();
    if (withoutSvgRefs) context.filter = withoutSvgRefs;
  }

  context.drawImage(video, 0, 0, width, height);
  return canvas;
}

/**
 * Encodes a captured frame. Rejects with a `tainted` SnapshotError when the
 * media is cross-origin without CORS, which is the one failure a caller
 * can actually explain to a viewer.
 */
export function encodeSnapshot(
  canvas: HTMLCanvasElement,
  options: SnapshotOptions = {},
): Promise<Blob> {
  const type = options.type ?? "image/png";
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new SnapshotError("The frame couldn't be encoded.", "unsupported"));
        },
        type,
        options.quality,
      );
    } catch {
      reject(
        new SnapshotError(
          "This video is cross-origin, so its frames can't be saved. Add the crossorigin attribute and serve CORS headers.",
          "tainted",
        ),
      );
    }
  });
}

/** Builds a filename in VLC's `lumen-snapshot-<date>-<time>` style. */
export function snapshotFilename(type = "image/png"): string {
  const extension = type.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
  const stamp = new Date()
    .toISOString()
    .replace(/[:T]/g, "-")
    .replace(/\..+$/, "");
  return `lumen-snapshot-${stamp}.${extension}`;
}

/** Prompts the browser to save a blob under `filename`. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next tick: revoking synchronously races the download in
  // Safari, which reads the URL after the click handler returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
