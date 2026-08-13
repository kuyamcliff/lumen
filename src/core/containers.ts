/**
 * Container detection by magic bytes.
 *
 * File extensions and `Content-Type` headers lie constantly in the real
 * world — object storage serves everything as `application/octet-stream`,
 * users rename `.mkv` to `.mp4` hoping it'll work, and signed CDN URLs
 * often have no extension at all. Sniffing the actual bytes is the only
 * reliable way to know what we're dealing with, and it's what lets Lumen
 * route a file to the right demuxer instead of handing the browser
 * something it will silently refuse.
 */

export type ContainerKind =
  /** MP4, MOV, M4V, 3GP — the whole ISO base media file format family. */
  | "iso-bmff"
  /** Matroska (.mkv/.mka) — needs remuxing, never plays natively. */
  | "matroska"
  /** WebM — Matroska's browser-native subset. */
  | "webm"
  | "ogg"
  | "mpeg-ts"
  | "avi"
  | "asf"
  | "flv"
  | "mpeg-ps"
  | "unknown";

/**
 * Bytes to sniff. Needs to cover the MPEG-TS sync check at offset 376,
 * plus enough of an EBML header to find its DocType.
 */
export const PROBE_BYTES = 1024;

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = "";
  for (let i = start; i < start + length && i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i]!);
  }
  return out;
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, i) => bytes[i] === byte);
}

/** Scans a byte window for an ASCII marker. Used only for EBML DocType, where a full parse isn't worth it just to pick a route. */
function containsAscii(bytes: Uint8Array, needle: string, limit: number): boolean {
  const end = Math.min(bytes.length, limit);
  const first = needle.charCodeAt(0);
  outer: for (let i = 0; i + needle.length <= end; i++) {
    if (bytes[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) {
      if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return true;
  }
  return false;
}

/** Identifies a container from the first bytes of a file. Never throws — unrecognized input is reported as "unknown", not an error. */
export function sniffContainer(head: Uint8Array): ContainerKind {
  if (head.length < 12) return "unknown";

  // ISO-BMFF: a 4-byte box size followed by the 'ftyp' fourcc. The brand
  // that follows distinguishes MP4 from MOV ('qt  ') and 3GP, but all of
  // them share one demuxer, so the family is all we need here.
  if (ascii(head, 4, 4) === "ftyp") return "iso-bmff";

  // EBML magic covers both Matroska and WebM; DocType separates them, and
  // that distinction decides remux-vs-native so it's worth reading.
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) {
    if (containsAscii(head, "webm", 64)) return "webm";
    return "matroska";
  }

  if (ascii(head, 0, 4) === "OggS") return "ogg";

  // MPEG-TS: 0x47 sync byte every 188 bytes. Checking three in a row
  // avoids false positives on files that merely start with 0x47.
  if (head[0] === 0x47 && head[188] === 0x47 && head[376] === 0x47) return "mpeg-ts";

  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "AVI ") return "avi";

  // ASF/WMV header GUID.
  if (startsWith(head, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11])) return "asf";

  if (ascii(head, 0, 3) === "FLV" && head[3] === 0x01) return "flv";

  // MPEG program stream pack header.
  if (startsWith(head, [0x00, 0x00, 0x01, 0xba])) return "mpeg-ps";

  return "unknown";
}

/** Human-readable container name, for error messages shown to end users. */
export function containerLabel(kind: ContainerKind): string {
  switch (kind) {
    case "iso-bmff":
      return "MP4/MOV";
    case "matroska":
      return "Matroska (MKV)";
    case "webm":
      return "WebM";
    case "ogg":
      return "Ogg";
    case "mpeg-ts":
      return "MPEG-TS";
    case "avi":
      return "AVI";
    case "asf":
      return "Windows Media (ASF)";
    case "flv":
      return "Flash Video (FLV)";
    case "mpeg-ps":
      return "MPEG program stream";
    default:
      return "this file";
  }
}

/** Containers Lumen can play, either natively or by remuxing. */
export function isPlayableContainer(kind: ContainerKind): boolean {
  return (
    kind === "iso-bmff" ||
    kind === "matroska" ||
    kind === "webm" ||
    kind === "ogg" ||
    kind === "mpeg-ts" ||
    kind === "unknown" // unknown still gets a native attempt — the browser may know better than us
  );
}

/**
 * Fetches just enough of a URL to identify its container. Uses a Range
 * request, and cancels the stream early if the server ignores it, so this
 * costs a few kB rather than a full download.
 */
export async function probeContainer(url: string): Promise<ContainerKind> {
  try {
    const response = await fetch(url, { headers: { Range: `bytes=0-${PROBE_BYTES - 1}` } });
    if (!response.ok || !response.body) return "unknown";

    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    while (total < PROBE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      parts.push(value);
      total += value.byteLength;
    }
    void reader.cancel().catch(() => {});

    const head = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      head.set(part, offset);
      offset += part.byteLength;
    }
    return sniffContainer(head);
  } catch {
    return "unknown";
  }
}
