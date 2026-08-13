import type { EventEmitter } from "./EventEmitter";
import type { DrmController } from "./DrmController";
import type { LumenAudioTrack, LumenQualityLevel } from "../types";

/**
 * Minimal surface of the dash.js player we depend on. Typed locally so
 * dash.js stays a genuinely optional dependency — installing it is not
 * required to build or type-check the player.
 */
interface DashPlayer {
  initialize(view: HTMLElement, source: string, autoplay: boolean): void;
  destroy(): void;
  on(type: string, listener: (event: unknown) => void): void;
  getBitrateInfoListFor(type: string): Array<{ qualityIndex: number; bitrate: number; width: number; height: number }>;
  setQualityFor(type: string, index: number): void;
  getQualityFor(type: string): number;
  updateSettings(settings: unknown): void;
  setProtectionData(data: unknown): void;
  getTracksFor(type: string): Array<{ id?: string; lang?: string; index: number }>;
  setCurrentTrack(track: unknown): void;
  getCurrentTrackFor(type: string): { id?: string; lang?: string; index: number } | null;
}

interface DashModule {
  MediaPlayer(): { create(): DashPlayer };
}

declare global {
  interface Window {
    dashjs?: DashModule;
  }
}

let dashModulePromise: Promise<DashModule | null> | null = null;

/** Resolves dash.js from a global (script tag) or a dynamic import (bundler), cached across players. */
function loadDash(): Promise<DashModule | null> {
  if (dashModulePromise) return dashModulePromise;
  dashModulePromise = (async () => {
    if (typeof window !== "undefined" && window.dashjs) return window.dashjs;
    try {
      const module = await import(/* @vite-ignore */ "dashjs");
      return ((module as { default?: DashModule }).default ?? module) as DashModule;
    } catch {
      return null;
    }
  })();
  return dashModulePromise;
}

/**
 * MPEG-DASH playback via dash.js.
 *
 * DASH is the other half of adaptive streaming: the same job as HLS, a
 * different manifest format, and the format of choice outside Apple's
 * ecosystem. It's wired up exactly like hls.js — optional, lazily loaded,
 * absent from the core bundle — so pages that don't serve DASH pay
 * nothing for it.
 */
export class DashEngine {
  private video: HTMLVideoElement;
  private emitter: EventEmitter;
  private player: DashPlayer | null = null;
  private levels: LumenQualityLevel[] = [];
  private auto = true;

  constructor(video: HTMLVideoElement, emitter: EventEmitter) {
    this.video = video;
    this.emitter = emitter;
  }

  static async isAvailable(): Promise<boolean> {
    return (await loadDash()) !== null;
  }

  /** Returns false if dash.js isn't present, so the caller can report it. */
  async load(src: string, drm: DrmController | null): Promise<boolean> {
    const dashjs = await loadDash();
    if (!dashjs) return false;

    const player = dashjs.MediaPlayer().create();
    this.player = player;

    if (drm?.isConfigured) player.setProtectionData(drm.toDashProtectionData());

    player.on("streamInitialized", () => this.readQualityLevels());
    player.on("qualityChangeRendered", () => this.emitQualityChange());
    player.on("error", (event: unknown) => this.onError(event));

    player.initialize(this.video, src, false);
    return true;
  }

  private readQualityLevels(): void {
    const list = this.player?.getBitrateInfoListFor("video") ?? [];
    this.levels = list.map((entry) => ({
      id: entry.qualityIndex,
      width: entry.width ?? 0,
      height: entry.height ?? 0,
      bitrate: entry.bitrate ?? 0,
      label: entry.height ? `${entry.height}p` : `Level ${entry.qualityIndex}`,
    }));
    this.emitter.emit("qualitieschange", { levels: this.levels });
  }

  private emitQualityChange(): void {
    this.emitter.emit("qualitychange", { level: this.currentQuality, auto: this.auto });
  }

  private onError(event: unknown): void {
    const detail = event as { error?: string; event?: { message?: string } };
    const message =
      detail?.error === "download"
        ? "Reconnecting…"
        : "This stream couldn't be loaded.";
    // dash.js reports download failures it will itself retry, so only a
    // manifest-level failure is treated as fatal here.
    this.emitter.emit("error", {
      code: detail?.error === "download" ? "NETWORK" : "MANIFEST_LOAD",
      message,
      fatal: detail?.error !== "download",
      raw: event,
    });
  }

  get qualityLevels(): LumenQualityLevel[] {
    return this.levels;
  }

  get currentQuality(): LumenQualityLevel | null {
    const index = this.player?.getQualityFor("video") ?? -1;
    return this.levels.find((level) => level.id === index) ?? null;
  }

  get isAutoQuality(): boolean {
    return this.auto;
  }

  setQuality(id: number | "auto"): void {
    if (!this.player) return;
    this.auto = id === "auto";
    this.player.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: this.auto } } } });
    if (id !== "auto") this.player.setQualityFor("video", id);
    this.emitQualityChange();
  }

  get audioTracks(): LumenAudioTrack[] {
    const tracks = this.player?.getTracksFor("audio") ?? [];
    const current = this.player?.getCurrentTrackFor("audio");
    return tracks.map((track, index) => ({
      id: String(track.id ?? track.index ?? index),
      label: track.lang || `Track ${index + 1}`,
      language: track.lang ?? "",
      active: current ? (current.id ?? current.index) === (track.id ?? track.index) : index === 0,
    }));
  }

  setAudioTrack(id: string): void {
    const track = (this.player?.getTracksFor("audio") ?? []).find(
      (candidate, index) => String(candidate.id ?? candidate.index ?? index) === id,
    );
    if (track) this.player?.setCurrentTrack(track);
  }

  destroy(): void {
    try {
      this.player?.destroy();
    } catch {
      /* dash.js throws if it was never fully initialized */
    }
    this.player = null;
  }
}
