import type { LumenPlayer } from "../../LumenPlayer";
import type { LumenPlugin } from "../types";
import {
  fireBeacon,
  fireBeacons,
  parseVast,
  selectMediaFile,
  type VastAd,
  type VastTrackingEvent,
} from "./vast";

export interface AdBreak {
  /** `"pre"`, `"post"`, or a time in seconds for a mid-roll. */
  offset: "pre" | "post" | number;
  /** VAST tag URL for this break. */
  tagUrl: string;
}

export interface AdsOptions {
  /** Shorthand for a single pre-roll. */
  tagUrl?: string;
  breaks?: AdBreak[];
  /** How long to wait for a VAST response before skipping the break. */
  timeoutMs?: number;
  /** Maximum wrapper redirects to follow. */
  maxRedirects?: number;
  /** Text for the skip button; `{seconds}` is replaced with the countdown. */
  skipText?: string;
  skipCountdownText?: string;
  adLabel?: string;
}

const DEFAULTS = {
  timeoutMs: 8000,
  maxRedirects: 3,
  skipText: "Skip ad",
  skipCountdownText: "Skip in {seconds}s",
  adLabel: "Ad",
};

/** Quartile beacons, and the fraction of the ad at which each one fires. */
const QUARTILES: Array<[number, VastTrackingEvent]> = [
  [0.25, "firstQuartile"],
  [0.5, "midpoint"],
  [0.75, "thirdQuartile"],
];

/**
 * VAST linear ads: pre-roll, mid-roll and post-roll.
 *
 * Ads play in a separate video element stacked over the player rather
 * than by swapping the content source. That keeps the content's buffer,
 * position and decoder state completely untouched, so returning from an
 * ad is instant instead of a re-buffer — and a broken ad can never
 * corrupt the content's playback state.
 */
export function ads(options: AdsOptions): LumenPlugin {
  const config = { ...DEFAULTS, ...options };
  const breaks: AdBreak[] = options.breaks
    ? [...options.breaks]
    : options.tagUrl
      ? [{ offset: "pre", tagUrl: options.tagUrl }]
      : [];

  return {
    name: "ads",
    setup(player) {
      const controller = new AdController(player, breaks, config);
      return () => controller.destroy();
    },
  };
}

type ResolvedConfig = AdsOptions & typeof DEFAULTS;

class AdController {
  private player: LumenPlayer;
  private breaks: AdBreak[];
  private config: ResolvedConfig;
  private played = new Set<AdBreak>();
  private container: HTMLElement;
  private adVideo: HTMLVideoElement;
  private skipButton: HTMLButtonElement;
  private label: HTMLElement;
  private playing = false;
  private destroyed = false;
  private currentAd: VastAd | null = null;
  private firedQuartiles = new Set<VastTrackingEvent>();
  private cleanups: Array<() => void> = [];

  constructor(player: LumenPlayer, breaks: AdBreak[], config: ResolvedConfig) {
    this.player = player;
    this.breaks = breaks;
    this.config = config;

    const { container, adVideo, skipButton, label } = buildAdUi(config);
    this.container = container;
    this.adVideo = adVideo;
    this.skipButton = skipButton;
    this.label = label;
    player.appendChild(container);

    this.bind();
    void this.maybePlay("pre");
  }

  private bind(): void {
    const onTimeUpdate = () => {
      if (this.playing) return;
      const time = this.player.currentTime;
      const due = this.breaks.find(
        (candidate) => typeof candidate.offset === "number" && time >= candidate.offset && !this.played.has(candidate),
      );
      if (due) void this.playBreak(due);
    };

    const onEnded = () => {
      if (!this.playing) void this.maybePlay("post");
    };

    this.cleanups.push(this.player.on("timeupdate", onTimeUpdate));
    this.cleanups.push(this.player.on("ended", onEnded));

    this.skipButton.addEventListener("click", () => this.skip());
    this.adVideo.addEventListener("ended", () => this.complete());
    this.adVideo.addEventListener("error", () => this.complete());
    this.adVideo.addEventListener("timeupdate", () => this.onAdProgress());
    this.container.addEventListener("click", (event) => {
      if (event.target === this.skipButton) return;
      this.onClickThrough();
    });
  }

  private async maybePlay(offset: "pre" | "post"): Promise<void> {
    const slot = this.breaks.find((candidate) => candidate.offset === offset && !this.played.has(candidate));
    if (slot) await this.playBreak(slot);
  }

  private async playBreak(slot: AdBreak): Promise<void> {
    // Marked as played up front: a break that fails to load must not be
    // retried on every subsequent timeupdate.
    this.played.add(slot);

    const ad = await this.resolve(slot.tagUrl, this.config.maxRedirects);
    if (!ad || this.destroyed) return;

    const media = selectMediaFile(ad.mediaFiles, this.player.clientWidth || 640);
    if (!media) return;

    this.currentAd = ad;
    this.firedQuartiles.clear();
    this.playing = true;

    const wasPlaying = !this.player.paused;
    // Recorded before anything can await: the ad may end (or fail) between
    // here and the play() below, and finish() reads this.
    this.resumeAfterAd = wasPlaying;
    this.player.pause();

    this.container.hidden = false;
    this.updateSkipButton(0);
    this.adVideo.src = media.url;

    try {
      await this.adVideo.play();
    } catch {
      // Autoplay policy blocked the ad; return to content rather than
      // stalling behind an ad the viewer can't dismiss.
      this.finish(wasPlaying);
      return;
    }

    fireBeacons(ad.impressions);
    fireBeacons(ad.tracking.start);
  }

  private resumeAfterAd = false;

  /** Follows VAST wrapper redirects up to the configured limit. */
  private async resolve(tagUrl: string, redirectsLeft: number): Promise<VastAd | null> {
    if (redirectsLeft < 0) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(tagUrl, { signal: controller.signal });
      if (!response.ok) return null;
      const ad = parseVast(await response.text());
      if (!ad) return null;

      if (ad.wrapperUrl) {
        const inner = await this.resolve(ad.wrapperUrl, redirectsLeft - 1);
        if (!inner) return null;
        // A wrapper's own beacons fire alongside the wrapped ad's.
        return {
          ...inner,
          impressions: [...ad.impressions, ...inner.impressions],
          clickTracking: [...ad.clickTracking, ...inner.clickTracking],
          tracking: mergeTracking(ad.tracking, inner.tracking),
        };
      }
      return ad;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private onAdProgress(): void {
    const ad = this.currentAd;
    if (!ad) return;

    const duration = this.adVideo.duration || ad.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;

    const progress = this.adVideo.currentTime / duration;
    for (const [fraction, event] of QUARTILES) {
      if (progress >= fraction && !this.firedQuartiles.has(event)) {
        this.firedQuartiles.add(event);
        fireBeacons(ad.tracking[event]);
      }
    }

    this.updateSkipButton(this.adVideo.currentTime);
  }

  private updateSkipButton(currentTime: number): void {
    const skipOffset = this.currentAd?.skipOffset;
    if (skipOffset === undefined) {
      this.skipButton.hidden = true;
      return;
    }

    this.skipButton.hidden = false;
    const remaining = Math.ceil(skipOffset - currentTime);
    if (remaining > 0) {
      this.skipButton.disabled = true;
      this.skipButton.textContent = this.config.skipCountdownText.replace("{seconds}", String(remaining));
    } else {
      this.skipButton.disabled = false;
      this.skipButton.textContent = this.config.skipText;
    }
  }

  private skip(): void {
    fireBeacons(this.currentAd?.tracking.skip);
    this.finish(this.resumeAfterAd);
  }

  private complete(): void {
    fireBeacons(this.currentAd?.tracking.complete);
    this.finish(this.resumeAfterAd);
  }

  private onClickThrough(): void {
    const ad = this.currentAd;
    if (!ad?.clickThrough) return;
    fireBeacons(ad.clickTracking);
    window.open(ad.clickThrough, "_blank", "noopener");
  }

  private finish(resume: boolean): void {
    this.playing = false;
    this.currentAd = null;
    this.container.hidden = true;
    this.adVideo.removeAttribute("src");
    this.adVideo.load();
    if (resume && !this.destroyed) void this.player.play().catch(() => {});
  }

  destroy(): void {
    this.destroyed = true;
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
    this.container.remove();
  }
}

function mergeTracking(
  a: VastAd["tracking"],
  b: VastAd["tracking"],
): VastAd["tracking"] {
  const merged: VastAd["tracking"] = { ...b };
  for (const [event, urls] of Object.entries(a) as Array<[VastTrackingEvent, string[]]>) {
    merged[event] = [...urls, ...(merged[event] ?? [])];
  }
  return merged;
}

function buildAdUi(config: ResolvedConfig): {
  container: HTMLElement;
  adVideo: HTMLVideoElement;
  skipButton: HTMLButtonElement;
  label: HTMLElement;
} {
  const container = document.createElement("div");
  container.hidden = true;
  container.style.cssText =
    "position:absolute;inset:0;z-index:10;background:#000;display:flex;align-items:center;justify-content:center;cursor:pointer";

  const adVideo = document.createElement("video");
  adVideo.playsInline = true;
  adVideo.style.cssText = "width:100%;height:100%;object-fit:contain";
  container.appendChild(adVideo);

  const label = document.createElement("span");
  label.textContent = config.adLabel;
  label.style.cssText =
    "position:absolute;top:12px;left:12px;padding:4px 8px;border-radius:4px;background:rgba(0,0,0,0.7);color:#fff;font:600 12px/1 system-ui,sans-serif;letter-spacing:0.04em;text-transform:uppercase";
  container.appendChild(label);

  const skipButton = document.createElement("button");
  skipButton.type = "button";
  skipButton.hidden = true;
  skipButton.style.cssText =
    "position:absolute;bottom:24px;right:24px;padding:10px 16px;border:1px solid rgba(255,255,255,0.4);border-radius:8px;background:rgba(0,0,0,0.7);color:#fff;font:500 14px/1 system-ui,sans-serif;cursor:pointer;min-height:44px";
  container.appendChild(skipButton);

  return { container, adVideo, skipButton, label };
}
