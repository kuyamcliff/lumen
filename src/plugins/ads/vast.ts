/**
 * VAST 2–4 parsing, limited to linear video ads.
 *
 * VAST is a large spec whose useful core is small: find a playable media
 * file, know when to fire which tracking beacon, and know where the
 * click-through goes. Companion banners, non-linear overlays and the
 * industry's more baroque extensions are deliberately out of scope.
 */

export interface VastMediaFile {
  url: string;
  type: string;
  width: number;
  height: number;
  bitrate: number;
}

export type VastTrackingEvent =
  | "start"
  | "firstQuartile"
  | "midpoint"
  | "thirdQuartile"
  | "complete"
  | "pause"
  | "resume"
  | "skip"
  | "mute"
  | "unmute";

export interface VastAd {
  id: string;
  /** Ad duration in seconds, as declared by the creative. */
  duration: number;
  mediaFiles: VastMediaFile[];
  clickThrough?: string;
  clickTracking: string[];
  impressions: string[];
  tracking: Partial<Record<VastTrackingEvent, string[]>>;
  /** Seconds before the skip button appears; undefined means unskippable. */
  skipOffset?: number;
  /** Set when the response is a wrapper pointing at another VAST document. */
  wrapperUrl?: string;
}

/** Parses `HH:MM:SS(.mmm)` as used by VAST duration and skipoffset. */
export function parseVastTime(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return undefined;
  return (
    Number(match[1]) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    (match[4] ? Number(`0.${match[4]}`) : 0)
  );
}

/** Resolves a skipoffset, which may be a timestamp or a percentage of the ad. */
export function parseSkipOffset(value: string | null, duration: number): number | undefined {
  if (!value) return undefined;
  if (value.endsWith("%")) {
    const percent = Number(value.slice(0, -1));
    return Number.isFinite(percent) ? (percent / 100) * duration : undefined;
  }
  return parseVastTime(value);
}

function text(node: Element | null): string {
  return node?.textContent?.trim() ?? "";
}

function allText(root: Element, selector: string): string[] {
  return Array.from(root.querySelectorAll(selector))
    .map((node) => text(node))
    .filter(Boolean);
}

/**
 * Parses a VAST document into the subset the player acts on.
 *
 * Returns null for anything unparseable rather than throwing: an ad that
 * fails to load must never take the content with it.
 */
export function parseVast(xml: string): VastAd | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, "text/xml");
  } catch {
    return null;
  }
  if (doc.querySelector("parsererror")) return null;

  const ad = doc.querySelector("Ad");
  if (!ad) return null;

  const wrapper = ad.querySelector("Wrapper");
  if (wrapper) {
    const wrapperUrl = text(wrapper.querySelector("VASTAdTagURI"));
    if (!wrapperUrl) return null;
    return {
      id: ad.getAttribute("id") ?? "",
      duration: 0,
      mediaFiles: [],
      clickTracking: allText(wrapper, "ClickTracking"),
      impressions: allText(wrapper, "Impression"),
      tracking: collectTracking(wrapper),
      wrapperUrl,
    };
  }

  const linear = ad.querySelector("Linear");
  if (!linear) return null;

  const duration = parseVastTime(text(linear.querySelector("Duration"))) ?? 0;

  const mediaFiles: VastMediaFile[] = Array.from(linear.querySelectorAll("MediaFile"))
    .map((node) => ({
      url: text(node),
      type: node.getAttribute("type") ?? "",
      width: Number(node.getAttribute("width")) || 0,
      height: Number(node.getAttribute("height")) || 0,
      bitrate: Number(node.getAttribute("bitrate")) || 0,
    }))
    .filter((file) => file.url);

  return {
    id: ad.getAttribute("id") ?? "",
    duration,
    mediaFiles,
    clickThrough: text(linear.querySelector("ClickThrough")) || undefined,
    clickTracking: allText(linear, "ClickTracking"),
    impressions: allText(ad, "Impression"),
    tracking: collectTracking(linear),
    skipOffset: parseSkipOffset(linear.getAttribute("skipoffset"), duration),
  };
}

function collectTracking(root: Element): Partial<Record<VastTrackingEvent, string[]>> {
  const tracking: Partial<Record<VastTrackingEvent, string[]>> = {};
  for (const node of Array.from(root.querySelectorAll("Tracking"))) {
    const event = node.getAttribute("event") as VastTrackingEvent | null;
    const url = text(node);
    if (!event || !url) continue;
    (tracking[event] ??= []).push(url);
  }
  return tracking;
}

/**
 * Picks the best media file the browser can actually play, preferring the
 * highest bitrate that fits the player's width — the same trade-off a
 * quality ladder makes, applied to a single creative.
 */
export function selectMediaFile(files: VastMediaFile[], playerWidth: number): VastMediaFile | null {
  const probe = document.createElement("video");
  const playable = files.filter((file) => {
    if (!file.type) return true;
    return probe.canPlayType(file.type) !== "";
  });
  if (playable.length === 0) return null;

  const fitting = playable.filter((file) => file.width === 0 || file.width <= playerWidth * 1.5);
  const pool = fitting.length > 0 ? fitting : playable;
  return pool.reduce((best, file) => (file.bitrate > best.bitrate ? file : best), pool[0]!);
}

/**
 * Fires a tracking beacon.
 *
 * Beacons are fire-and-forget and must never block or break playback, so
 * failures are swallowed. `keepalive` lets them survive a page unload,
 * which is exactly when `complete` tends to fire.
 */
export function fireBeacon(url: string): void {
  try {
    void fetch(url, { method: "GET", mode: "no-cors", keepalive: true }).catch(() => {});
  } catch {
    /* beacons are best-effort by definition */
  }
}

export function fireBeacons(urls: string[] | undefined): void {
  for (const url of urls ?? []) fireBeacon(url);
}
