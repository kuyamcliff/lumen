/** Formats seconds as `h:mm:ss` or `m:ss`, matching common player conventions. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";

  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  const pad = (n: number) => String(n).padStart(2, "0");

  if (h > 0) {
    return `${h}:${pad(m)}:${pad(s)}`;
  }
  return `${m}:${pad(s)}`;
}

/** Clamp a value between min and max. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Returns the fraction (0-1) of `buffered` that is contiguous from currentTime. */
export function bufferedAhead(buffered: TimeRanges, currentTime: number): number {
  for (let i = 0; i < buffered.length; i++) {
    if (buffered.start(i) <= currentTime && buffered.end(i) >= currentTime) {
      return buffered.end(i) - currentTime;
    }
  }
  return 0;
}

/** Furthest contiguous buffered end time reachable from currentTime, else 0. */
export function bufferedEnd(buffered: TimeRanges): number {
  return buffered.length > 0 ? buffered.end(buffered.length - 1) : 0;
}
