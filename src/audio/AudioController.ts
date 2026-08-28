import { EQ_BAND_COUNT, EQ_GAIN_LIMIT, findPreset, presetIdForGains } from "./presets";
import type { AudioGraph } from "./AudioGraph";
import { getItem, setItem } from "../utils/storage";
import { clamp } from "../utils/time";

/** How the two input channels are routed to the two output channels. */
export type StereoMode = "stereo" | "mono" | "left" | "right" | "swap";

export interface AudioEffectState {
  /** Master switch for the equalizer bank. Bands stay editable while off. */
  equalizer: boolean;
  /** Preamp in dB, applied ahead of the bands. */
  preamp: number;
  /** Ten band gains in dB, ordered to match `EQ_FREQUENCIES`. */
  bands: number[];
  /** Id of the matching preset, or null when the curve is custom. */
  preset: string | null;
  /** Output gain as a multiplier: 1 = 100%, 2 = 200%. */
  boost: number;
  /**
   * Audio delay in milliseconds, 0–2000, playing audio *later* than video.
   *
   * Only one direction is possible: a DelayNode can hold audio back, but
   * nothing can hold back a video element's own rendering, so "audio
   * earlier than video" has no browser equivalent.
   */
  delayMs: number;
  stereo: StereoMode;
  /** Dynamic-range compression, the equivalent of VLC's volume normalizer. */
  normalize: boolean;
}

export const DEFAULT_AUDIO_EFFECTS: AudioEffectState = {
  equalizer: false,
  preamp: 0,
  bands: new Array(EQ_BAND_COUNT).fill(0),
  preset: "flat",
  boost: 1,
  delayMs: 0,
  stereo: "stereo",
  normalize: false,
};

/** Widest delay the UI offers, and the ceiling the DelayNode is built for. */
export const MAX_AUDIO_DELAY_MS = 2000;
/** 300% matches the top of VLC's volume slider. */
export const MAX_BOOST = 3;

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * True when a MediaElementAudioSourceNode would produce audible output for
 * this element.
 *
 * Web Audio silences cross-origin media that wasn't fetched with CORS —
 * the node exists, the graph runs, and every sample is zero. Detecting
 * that after the fact is impossible (silence is a legitimate signal), and
 * the routing can't be undone once created, so the check happens up front
 * and the effects stay unavailable rather than muting the video.
 */
export function canRouteThroughWebAudio(video: HTMLVideoElement): boolean {
  if (!audioContextCtor()) return false;

  const src = video.currentSrc || video.src;
  if (!src) return true; // nothing loaded yet — decide again when it is

  // blob: (MediaSource, local files) and data: URLs are same-origin by
  // construction, which is what every remuxed format ends up using.
  if (src.startsWith("blob:") || src.startsWith("data:")) return true;

  if (video.crossOrigin) return true;

  try {
    return new URL(src, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * The audio effects: equalizer, preamp, volume boost beyond 100%,
 * audio/video sync delay, stereo routing and a normalizer — the contents
 * of VLC's "Audio Effects" tab.
 *
 * This half owns only the *state*, which is what the public API and the UI
 * read, and it is deliberately synchronous. The Web Audio graph that acts
 * on that state lives in a separate module loaded the moment an effect
 * first leaves its default — so a page that never touches one pays
 * nothing, in bytes or in an AudioContext, and routing an element through
 * Web Audio (which is permanent, and breaks AirPlay handoff) never happens
 * behind the viewer's back.
 */
export class AudioController {
  private video: HTMLVideoElement;
  private onUnavailable: () => void;

  private context: AudioContext | null = null;
  private graph: AudioGraph | null = null;
  private loading: Promise<AudioGraph | null> | null = null;
  private failed = false;
  private destroyed = false;

  private state: AudioEffectState;

  constructor(video: HTMLVideoElement, onUnavailable: () => void = () => {}) {
    this.video = video;
    this.onUnavailable = onUnavailable;
    const stored = getItem<Partial<AudioEffectState>>("audio-effects", {});
    this.state = {
      ...DEFAULT_AUDIO_EFFECTS,
      ...stored,
      // A stored array of the wrong length would desynchronise the filter
      // bank from the band list, so it is rebuilt rather than trusted.
      bands: normalizeBands(stored.bands),
    };
  }

  /** A copy of the current settings — mutating it does nothing. */
  get effects(): AudioEffectState {
    return { ...this.state, bands: [...this.state.bands] };
  }

  /** True once the graph exists, i.e. some effect has actually been engaged. */
  get isActive(): boolean {
    return this.graph !== null;
  }

  /** True when this element's audio can legally be routed through Web Audio. */
  get isAvailable(): boolean {
    return !this.failed && canRouteThroughWebAudio(this.video);
  }

  /**
   * Applies a patch. Only engages the audio graph if the patch actually
   * asks for something other than passthrough, so reading state back or
   * resetting to defaults never routes the element through Web Audio.
   */
  set(patch: Partial<AudioEffectState>): void {
    const next: AudioEffectState = {
      ...this.state,
      ...patch,
      bands: patch.bands ? normalizeBands(patch.bands) : this.state.bands,
    };

    next.preamp = clamp(next.preamp, -EQ_GAIN_LIMIT, EQ_GAIN_LIMIT);
    next.bands = next.bands.map((gain) => clamp(gain, -EQ_GAIN_LIMIT, EQ_GAIN_LIMIT));
    next.boost = clamp(next.boost, 0, MAX_BOOST);
    next.delayMs = clamp(next.delayMs, 0, MAX_AUDIO_DELAY_MS);
    // Only an explicit preset id survives; any other edit re-derives it, so
    // nudging one band away from "Rock" reports "Custom" rather than lying.
    if (patch.preset === undefined) {
      next.preset = presetIdForGains(next.bands, next.preamp);
    }

    this.state = next;
    setItem("audio-effects", next);

    if (this.graph) this.graph.apply(next);
    else if (!this.isPassthrough()) void this.engage();
  }

  /** Loads a named preset's preamp and band curve. */
  setPreset(id: string): boolean {
    const preset = findPreset(id);
    if (!preset) return false;
    this.set({ preset: preset.id, preamp: preset.preamp, bands: [...preset.gains], equalizer: true });
    return true;
  }

  /** Restores every effect to its default without tearing the graph down. */
  reset(): void {
    this.set({ ...DEFAULT_AUDIO_EFFECTS, bands: [...DEFAULT_AUDIO_EFFECTS.bands] });
  }

  /** True when every setting is at its default, i.e. the graph is a wire. */
  isPassthrough(): boolean {
    const s = this.state;
    return (
      (!s.equalizer || (s.preamp === 0 && s.bands.every((gain) => gain === 0))) &&
      s.boost === 1 &&
      s.delayMs === 0 &&
      s.stereo === "stereo" &&
      !s.normalize
    );
  }

  /**
   * Copies frequency-domain data into `target` for a spectrum display.
   * Returns false when no graph exists yet, so callers can skip drawing.
   */
  getFrequencyData(target: Uint8Array): boolean {
    const analyser = this.graph?.analyser;
    if (!analyser) return false;
    // The DOM types model this as Uint8Array<ArrayBuffer>; a caller-owned
    // view over any ArrayBufferLike is equally valid at runtime.
    analyser.getByteFrequencyData(target as Uint8Array<ArrayBuffer>);
    return true;
  }

  /** Number of frequency bins `getFrequencyData` expects. */
  get frequencyBinCount(): number {
    return this.graph?.analyser.frequencyBinCount ?? 0;
  }

  /**
   * Resumes a context the browser suspended (autoplay policy). Cheap and
   * idempotent, so it's safe to call from any user gesture.
   */
  resume(): void {
    if (this.context?.state === "suspended") void this.context.resume().catch(() => {});
  }

  /** Builds the audio graph, once, on first real use. */
  private async engage(): Promise<void> {
    if (this.graph || this.failed || this.destroyed) return;

    const Ctor = audioContextCtor();
    if (!Ctor || !canRouteThroughWebAudio(this.video)) {
      this.failed = true;
      this.onUnavailable();
      return;
    }

    if (!this.loading) {
      this.loading = import("./AudioGraph")
        .then(({ AudioGraph }) => {
          const context = new Ctor();
          const graph = new AudioGraph(context, this.video, this.state);
          this.context = context;
          this.graph = graph;
          this.resume();
          return graph;
        })
        .catch(() => {
          // A browser that refuses the context or the source node (an
          // already-routed element, no output device) leaves playback
          // exactly as it was; only the effects are lost.
          this.failed = true;
          this.onUnavailable();
          return null;
        });
    }

    const graph = await this.loading;
    // The player may have been destroyed while the chunk was in flight.
    if (this.destroyed) {
      graph?.destroy();
      return;
    }
    // State may have moved on in the meantime, too.
    graph?.apply(this.state);
  }

  destroy(): void {
    this.destroyed = true;
    try {
      this.graph?.destroy();
      void this.context?.close().catch(() => {});
    } catch {
      /* already torn down */
    }
    this.context = null;
    this.graph = null;
  }
}

function normalizeBands(bands: number[] | undefined): number[] {
  const out = new Array<number>(EQ_BAND_COUNT).fill(0);
  if (!Array.isArray(bands)) return out;
  for (let i = 0; i < EQ_BAND_COUNT; i++) {
    const value = bands[i];
    if (typeof value === "number" && Number.isFinite(value)) {
      out[i] = clamp(value, -EQ_GAIN_LIMIT, EQ_GAIN_LIMIT);
    }
  }
  return out;
}
