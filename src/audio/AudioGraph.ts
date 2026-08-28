import { EQ_BAND_COUNT, EQ_FREQUENCIES, bandQ } from "./presets";
import type { AudioEffectState } from "./AudioController";
import { MAX_AUDIO_DELAY_MS } from "./AudioController";

/**
 * The Web Audio graph behind the effects panel.
 *
 * Split out of `AudioController` so it loads only when an effect is
 * actually engaged: the controller keeps the state (which is what the API
 * and the UI read), and this builds the nodes that act on it. A page that
 * never touches an equalizer slider never downloads any of this, and
 * never constructs an AudioContext.
 *
 *   source → delay → preamp → 10 × biquad → [stereo matrix] →
 *            [compressor] → boost → analyser → destination
 *
 * Sections in brackets are patched out of the chain entirely when they're
 * at their defaults, so the common case is a handful of nodes.
 */
export class AudioGraph {
  private context: AudioContext;
  private source: MediaElementAudioSourceNode;
  private delayNode: DelayNode;
  private preampNode: GainNode;
  private filters: BiquadFilterNode[];
  private splitter: ChannelSplitterNode;
  private merger: ChannelMergerNode;
  private leftGain: GainNode;
  private rightGain: GainNode;
  private compressor: DynamicsCompressorNode;
  private boostNode: GainNode;
  private analyserNode: AnalyserNode;
  /** Last node before the stereo/normalize/boost tail. */
  private chainTail: AudioNode;
  private state: AudioEffectState;

  constructor(context: AudioContext, video: HTMLVideoElement, state: AudioEffectState) {
    this.context = context;
    this.state = state;
    this.source = context.createMediaElementSource(video);

    this.delayNode = context.createDelay(MAX_AUDIO_DELAY_MS / 1000);
    this.preampNode = context.createGain();
    this.boostNode = context.createGain();

    this.analyserNode = context.createAnalyser();
    this.analyserNode.fftSize = 1024;
    this.analyserNode.smoothingTimeConstant = 0.75;

    this.filters = EQ_FREQUENCIES.map((frequency, index) => {
      const filter = context.createBiquadFilter();
      // Shelves at the ends, peaks in between: a peaking filter at 60 Hz
      // leaves everything below it untouched, which is not what someone
      // dragging the bass slider expects.
      filter.type = index === 0 ? "lowshelf" : index === EQ_BAND_COUNT - 1 ? "highshelf" : "peaking";
      filter.frequency.value = frequency;
      filter.Q.value = bandQ(index);
      filter.gain.value = 0;
      return filter;
    });

    this.compressor = context.createDynamicsCompressor();
    // A gentle, broadcast-style curve: enough to even out a quiet dialogue
    // scene against a loud one without audibly pumping.
    this.compressor.threshold.value = -24;
    this.compressor.knee.value = 30;
    this.compressor.ratio.value = 8;
    this.compressor.attack.value = 0.005;
    this.compressor.release.value = 0.25;

    this.splitter = context.createChannelSplitter(2);
    this.merger = context.createChannelMerger(2);
    this.leftGain = context.createGain();
    this.rightGain = context.createGain();

    this.source.connect(this.delayNode);
    this.delayNode.connect(this.preampNode);
    let node: AudioNode = this.preampNode;
    for (const filter of this.filters) {
      node.connect(filter);
      node = filter;
    }
    this.chainTail = node;

    this.apply(state);
  }

  get analyser(): AnalyserNode {
    return this.analyserNode;
  }

  /** Pushes a state onto the graph, reshaping the tail where needed. */
  apply(state: AudioEffectState): void {
    this.state = state;
    const now = this.context.currentTime;
    // Short ramps rather than instant jumps: stepping a gain
    // discontinuously is exactly how you get a click in the output.
    const ramp = (param: AudioParam, value: number) => param.setTargetAtTime(value, now, 0.015);

    const eqOn = state.equalizer;
    ramp(this.preampNode.gain, dbToGain(eqOn ? state.preamp : 0));
    this.filters.forEach((filter, index) => {
      // A BiquadFilterNode's gain is already in dB for these filter types.
      ramp(filter.gain, eqOn ? state.bands[index] ?? 0 : 0);
    });

    ramp(this.boostNode.gain, state.boost);
    // Delay is a time, not a level; ramping it would resample the audio.
    this.delayNode.delayTime.value = state.delayMs / 1000;

    this.routeTail();
  }

  /**
   * (Re)connects everything after the equalizer: the stereo matrix, the
   * normalizer and the output stage. Web Audio has no way to swap a node
   * in place, so a shape change means rewiring this section.
   */
  private routeTail(): void {
    for (const node of [
      this.chainTail,
      this.splitter,
      this.leftGain,
      this.rightGain,
      this.merger,
      this.compressor,
      this.boostNode,
      this.analyserNode,
    ]) {
      try {
        node.disconnect();
      } catch {
        /* never connected yet */
      }
    }

    let node: AudioNode = this.chainTail;

    // The splitter is bypassed entirely in plain stereo: it up-mixes
    // discretely, which would silence one channel of a mono source.
    if (this.state.stereo !== "stereo") {
      const { splitter, merger, leftGain: left, rightGain: right } = this;
      node.connect(splitter);
      splitter.connect(left, 0);
      splitter.connect(right, 1);

      switch (this.state.stereo) {
        case "mono":
          // Halved so summing the two channels doesn't add 6 dB.
          left.gain.value = 0.5;
          right.gain.value = 0.5;
          left.connect(merger, 0, 0);
          left.connect(merger, 0, 1);
          right.connect(merger, 0, 0);
          right.connect(merger, 0, 1);
          break;
        case "left":
          left.gain.value = 1;
          right.gain.value = 0;
          left.connect(merger, 0, 0);
          left.connect(merger, 0, 1);
          break;
        case "right":
          left.gain.value = 0;
          right.gain.value = 1;
          right.connect(merger, 0, 0);
          right.connect(merger, 0, 1);
          break;
        case "swap":
          left.gain.value = 1;
          right.gain.value = 1;
          left.connect(merger, 0, 1);
          right.connect(merger, 0, 0);
          break;
      }
      node = merger;
    }

    if (this.state.normalize) {
      node.connect(this.compressor);
      node = this.compressor;
    }

    node.connect(this.boostNode);
    this.boostNode.connect(this.analyserNode);
    this.analyserNode.connect(this.context.destination);
  }

  destroy(): void {
    try {
      this.source.disconnect();
    } catch {
      /* already torn down */
    }
  }
}

/** dB → linear amplitude. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}
