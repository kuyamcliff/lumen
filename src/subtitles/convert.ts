/**
 * Subtitle format conversion.
 *
 * Browsers load exactly one subtitle format: WebVTT. Everything a viewer
 * actually has on disk — the `.srt` that came with the file, the `.ass`
 * a fansub group shipped, the `.sub` from a decade-old rip — is refused
 * by `<track>` without a word of explanation. VLC opens all of them, so
 * Lumen converts them in the browser and hands the result to the same
 * text-track pipeline external WebVTT uses.
 *
 * Conversion is text-only: ASS positioning, karaoke timing and drawing
 * commands are dropped, because WebVTT has no equivalent and a garbled
 * override tag on screen is worse than clean text.
 */

export type SubtitleFormat = "vtt" | "srt" | "ass" | "microdvd" | "subviewer" | "unknown";

export interface ConvertOptions {
  /**
   * Frame rate for frame-based formats (MicroDVD). Ignored by every other
   * format. Defaults to the value in the file, then to 23.976.
   */
  frameRate?: number;
}

/** MicroDVD stores frame numbers, so without a rate the timings are meaningless. */
const DEFAULT_MICRODVD_FPS = 23.976;

/** Identifies a subtitle format from its content, with the filename as a hint. */
export function detectSubtitleFormat(text: string, filename = ""): SubtitleFormat {
  const head = text.slice(0, 4096);

  if (/^﻿?WEBVTT/.test(head)) return "vtt";
  if (/^\s*\[Script Info\]/i.test(head) || /^\s*\[V4\+? Styles\]/im.test(head)) return "ass";
  // An SRT cue is a timestamp line with a comma before the milliseconds.
  if (/\d{1,2}:\d{2}:\d{2},\d{1,3}\s*-->/.test(head)) return "srt";
  if (/^\s*\{\d+\}\{\d*\}/m.test(head)) return "microdvd";
  if (/^\[INFORMATION\]/im.test(head) || /^\d{2}:\d{2}:\d{2}\.\d{2},\d{2}:\d{2}:\d{2}\.\d{2}/m.test(head)) {
    return "subviewer";
  }

  const extension = filename.toLowerCase().match(/\.([a-z0-9]+)(?:$|\?)/)?.[1];
  switch (extension) {
    case "vtt":
      return "vtt";
    case "srt":
      return "srt";
    case "ass":
    case "ssa":
      return "ass";
    case "sub":
      return "microdvd";
    default:
      return "unknown";
  }
}

/**
 * Converts any supported subtitle text to WebVTT. WebVTT input is returned
 * with only its line endings normalised; unrecognised input is treated as
 * SRT, which is by far the most likely thing an unlabelled file is.
 */
export function toWebVtt(text: string, filename = "", options: ConvertOptions = {}): string {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const format = detectSubtitleFormat(normalized, filename);

  switch (format) {
    case "vtt":
      return normalized;
    case "ass":
      return assToVtt(normalized);
    case "microdvd":
      return microDvdToVtt(normalized, options.frameRate);
    case "subviewer":
      return subViewerToVtt(normalized);
    case "srt":
    case "unknown":
    default:
      return srtToVtt(normalized);
  }
}

/** Wraps converted cues in a WebVTT file body. */
function wrap(cues: string[]): string {
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

/** Formats seconds as WebVTT's `HH:MM:SS.mmm`. */
export function formatVttTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const secs = Math.floor(clamped % 60);
  const millis = Math.round((clamped - Math.floor(clamped)) * 1000);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}.${pad(millis, 3)}`;
}

// ------------------------------------------------------------------ SRT

/**
 * SubRip → WebVTT.
 *
 * The differences are small but all fatal to a browser parser: a decimal
 * comma instead of a point, a leading sequence number, and hours that are
 * sometimes omitted.
 */
export function srtToVtt(text: string): string {
  const cues: string[] = [];
  const blocks = text.split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.trim() !== "");
    if (lines.length === 0) continue;

    // A bare number on its own line is SubRip's cue counter, which WebVTT
    // treats as a cue identifier — harmless, but dropping it is cleaner.
    let index = 0;
    if (/^\d+$/.test(lines[0]!.trim())) index = 1;

    const timing = lines[index];
    if (!timing) continue;
    const match = timing.match(
      /(\d{1,3}:)?(\d{1,2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,3}:)?(\d{1,2}):(\d{2})[,.](\d{1,3})/,
    );
    if (!match) continue;

    const start = hmsToSeconds(match[1], match[2]!, match[3]!, match[4]!);
    const end = hmsToSeconds(match[5], match[6]!, match[7]!, match[8]!);
    const body = lines.slice(index + 1).join("\n");
    if (!body.trim()) continue;

    cues.push(`${formatVttTime(start)} --> ${formatVttTime(end)}\n${sanitizeInlineTags(body)}`);
  }

  return wrap(cues);
}

function hmsToSeconds(hours: string | undefined, minutes: string, seconds: string, fraction: string): number {
  const h = hours ? Number(hours.replace(":", "")) : 0;
  // "1" means 100 ms, "12" means 120 ms — pad rather than parse as an int.
  const millis = Number(fraction.padEnd(3, "0"));
  return h * 3600 + Number(minutes) * 60 + Number(seconds) + millis / 1000;
}

// ------------------------------------------------------------- ASS/SSA

/**
 * Advanced SubStation Alpha → WebVTT.
 *
 * The field order of a `Dialogue:` line is declared by the `Format:` line
 * above it and genuinely varies between files, so it's read rather than
 * assumed.
 */
export function assToVtt(text: string): string {
  const lines = text.split("\n");
  const cues: string[] = [];

  let startIndex = 1;
  let endIndex = 2;
  let textIndex = 9;
  let inEvents = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^\[/.test(trimmed)) {
      inEvents = /^\[events\]/i.test(trimmed);
      continue;
    }
    if (!inEvents) continue;

    if (/^format\s*:/i.test(trimmed)) {
      const fields = trimmed
        .slice(trimmed.indexOf(":") + 1)
        .split(",")
        .map((field) => field.trim().toLowerCase());
      const find = (name: string, fallback: number) => {
        const index = fields.indexOf(name);
        return index === -1 ? fallback : index;
      };
      startIndex = find("start", 1);
      endIndex = find("end", 2);
      textIndex = find("text", fields.length - 1);
      continue;
    }

    if (!/^dialogue\s*:/i.test(trimmed)) continue;

    // Text is always the last field and may itself contain commas, so the
    // split is limited to the fields before it.
    const payload = trimmed.slice(trimmed.indexOf(":") + 1);
    const parts = payload.split(",");
    if (parts.length <= textIndex) continue;

    const start = parseAssTime(parts[startIndex]?.trim() ?? "");
    const end = parseAssTime(parts[endIndex]?.trim() ?? "");
    if (start === null || end === null || end <= start) continue;

    const body = stripAssTags(parts.slice(textIndex).join(","));
    if (!body.trim()) continue;

    cues.push(`${formatVttTime(start)} --> ${formatVttTime(end)}\n${body}`);
  }

  return wrap(cues);
}

/** Parses ASS's `H:MM:SS.cc` (centiseconds, single-digit hours). */
export function parseAssTime(value: string): number | null {
  const match = value.match(/^(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
  if (!match) return null;
  const centis = Number(match[4]!.padEnd(2, "0").slice(0, 2));
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + centis / 100;
}

/**
 * Reduces an ASS line to plain text.
 *
 * `{\pos(…)}`-style override blocks, drawing commands and karaoke timing
 * have no WebVTT equivalent; italic/bold/underline overrides do, so those
 * are translated instead of dropped.
 */
export function stripAssTags(text: string): string {
  let out = text;

  // Vector drawing blocks paint shapes, not words: their coordinate lists
  // would otherwise render as a wall of numbers.
  out = out.replace(/\{[^}]*\\p[1-9][^}]*\}[^{]*(\{[^}]*\\p0[^}]*\})?/g, "");

  const tagged = { i: false, b: false, u: false };
  out = out.replace(/\{([^}]*)\}/g, (_match, block: string) => {
    let replacement = "";
    for (const [, tag, value] of block.matchAll(/\\([ibu])([01])/g)) {
      const key = tag as "i" | "b" | "u";
      const on = value === "1";
      if (on === tagged[key]) continue;
      tagged[key] = on;
      replacement += on ? `<${key}>` : `</${key}>`;
    }
    return replacement;
  });

  // Close anything the line left open, so a stray tag can't leak into the
  // next cue when the overlay renders them.
  for (const key of ["i", "b", "u"] as const) {
    if (tagged[key]) out += `</${key}>`;
  }

  return out
    .replace(/\\[Nn]/g, "\n")
    .replace(/\\h/g, " ")
    .trim();
}

// -------------------------------------------------------------- MicroDVD

/**
 * MicroDVD (`.sub`) → WebVTT.
 *
 * Timings are frame numbers, so they mean nothing without a frame rate.
 * The convention is that the first cue carries it as its only text, and
 * that's honoured before falling back to the caller's value.
 */
export function microDvdToVtt(text: string, frameRate?: number): string {
  const lines = text.split("\n");
  const cues: string[] = [];
  let fps = frameRate && frameRate > 0 ? frameRate : 0;

  for (const line of lines) {
    const match = line.match(/^\s*\{(\d+)\}\{(\d*)\}(.*)$/);
    if (!match) continue;

    const startFrame = Number(match[1]);
    const endFrame = Number(match[2] || match[1]);
    const body = match[3] ?? "";

    // `{1}{1}25.000` — the frame-rate declaration, not a subtitle.
    if (!fps && startFrame <= 1 && /^\d+([.,]\d+)?$/.test(body.trim())) {
      const declared = Number(body.trim().replace(",", "."));
      if (declared > 0 && declared < 1000) {
        fps = declared;
        continue;
      }
    }
    if (!fps) fps = DEFAULT_MICRODVD_FPS;

    const cleaned = stripMicroDvdTags(body);
    if (!cleaned.trim()) continue;

    cues.push(`${formatVttTime(startFrame / fps)} --> ${formatVttTime(endFrame / fps)}\n${cleaned}`);
  }

  return wrap(cues);
}

/** Strips MicroDVD's `{y:i}`-style control codes and expands its line breaks. */
export function stripMicroDvdTags(text: string): string {
  return text
    .replace(/\{[a-zA-Z]:[^}]*\}/g, "")
    .replace(/\|/g, "\n")
    .trim();
}

// ------------------------------------------------------------- SubViewer

/** SubViewer 2.0 (`00:00:01.00,00:00:04.00` followed by `[br]`-joined text). */
export function subViewerToVtt(text: string): string {
  const cues: string[] = [];
  const blocks = text.split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.split("\n");
    const timingLine = lines.find((line) =>
      /^\d{1,2}:\d{2}:\d{2}\.\d{1,3},\d{1,2}:\d{2}:\d{2}\.\d{1,3}/.test(line.trim()),
    );
    if (!timingLine) continue;

    const [rawStart, rawEnd] = timingLine.trim().split(",");
    const start = parseSubViewerTime(rawStart ?? "");
    const end = parseSubViewerTime(rawEnd ?? "");
    if (start === null || end === null) continue;

    const body = lines
      .slice(lines.indexOf(timingLine) + 1)
      .join("\n")
      .replace(/\[br\]/gi, "\n")
      .trim();
    if (!body) continue;

    cues.push(`${formatVttTime(start)} --> ${formatVttTime(end)}\n${sanitizeInlineTags(body)}`);
  }

  return wrap(cues);
}

function parseSubViewerTime(value: string): number | null {
  const match = value.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})\.(\d{1,3})$/);
  if (!match) return null;
  const fraction = match[4]!;
  // SubViewer writes centiseconds; some tools write milliseconds.
  const divisor = fraction.length >= 3 ? 1000 : 100;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(fraction) / divisor;
}

/**
 * Keeps the inline tags WebVTT understands and drops the rest, including
 * SubRip's `{\an8}` positioning and its non-standard `<font>` colours.
 */
function sanitizeInlineTags(text: string): string {
  return text
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/<\/?font[^>]*>/gi, "")
    .trim();
}

/**
 * Turns subtitle text of any supported format into a blob URL a `<track>`
 * element can load. The caller owns the URL and should revoke it when the
 * track goes away.
 */
export function toWebVttUrl(text: string, filename = "", options: ConvertOptions = {}): string {
  const vtt = toWebVtt(text, filename, options);
  return URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
}
