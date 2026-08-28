/**
 * Opening files from the viewer's own machine.
 *
 * This is the thing a desktop player does that a web player usually
 * can't: drag a file onto it and it plays. Everything Lumen needs is
 * already in the browser — an object URL is a same-origin, range-capable
 * source, which is exactly what the remuxers and the MediaSource pipeline
 * want — so a local MKV takes the same path as a remote one, minus the
 * network.
 */

const MEDIA_EXTENSIONS = new Set([
  "mp4", "m4v", "m4a", "mov", "qt", "mkv", "mka", "webm", "ogg", "ogv", "ogm", "oga",
  "avi", "flv", "f4v", "ts", "m2ts", "mts", "mpg", "mpeg", "mp3", "aac", "flac", "wav",
  "opus", "3gp", "3g2", "wmv", "asf", "m3u8", "mpd",
]);

const SUBTITLE_EXTENSIONS = new Set(["srt", "vtt", "ass", "ssa", "sub", "sbv", "txt"]);

export type FileKind = "media" | "subtitle" | "unknown";

export function extensionOf(name: string): string {
  return name.toLowerCase().split(".").pop() ?? "";
}

/**
 * Classifies a dropped file.
 *
 * The MIME type the OS attaches is consulted first but not trusted alone:
 * it's empty for `.mkv` on most systems and plain `text/plain` for every
 * subtitle format, so the extension has the final say.
 */
export function classifyFile(file: File): FileKind {
  const extension = extensionOf(file.name);
  if (SUBTITLE_EXTENSIONS.has(extension)) return "subtitle";
  if (MEDIA_EXTENSIONS.has(extension)) return "media";
  if (file.type.startsWith("video/") || file.type.startsWith("audio/")) return "media";
  return "unknown";
}

export interface SortedFiles {
  media: File[];
  subtitles: File[];
  rejected: File[];
}

/** Splits a drop or file-picker selection into things Lumen can act on. */
export function sortFiles(files: Iterable<File>): SortedFiles {
  const sorted: SortedFiles = { media: [], subtitles: [], rejected: [] };
  for (const file of files) {
    switch (classifyFile(file)) {
      case "media":
        sorted.media.push(file);
        break;
      case "subtitle":
        sorted.subtitles.push(file);
        break;
      default:
        sorted.rejected.push(file);
    }
  }
  // Natural order, so dropping a season folder queues the episodes the way
  // they're numbered rather than the order the OS handed them over.
  sorted.media.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return sorted;
}

/** A display title from a filename: extension dropped, separators softened. */
export function titleFromFilename(name: string): string {
  return name
    .replace(/\.[^.]+$/, "")
    .replace(/[._]+/g, " ")
    .trim();
}

/** Two-letter language guessed from a subtitle filename like `movie.en.srt`. */
export function languageFromFilename(name: string): string | null {
  const match = name.match(/\.([a-z]{2,3})(?:\.[a-z0-9]+)?$/i);
  if (!match) return null;
  const code = match[1]!.toLowerCase();
  // The extension itself matches the same shape; a subtitle extension is
  // never a language.
  if (SUBTITLE_EXTENSIONS.has(code)) return null;
  return code;
}

/**
 * True when a drag event carries files rather than, say, selected text —
 * checked from `dragover`, where the file list itself is not readable yet.
 */
export function dragHasFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  if (!types) return false;
  return Array.from(types).includes("Files");
}
