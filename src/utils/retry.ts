/**
 * Backoff schedule (ms) used by the resilience layer when recovering from
 * network hiccups or decode errors on progressive/HLS sources. Kept short —
 * users are staring at a stalled video, not a background job.
 */
export const RETRY_BACKOFF_MS = [500, 1500, 4000];

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
