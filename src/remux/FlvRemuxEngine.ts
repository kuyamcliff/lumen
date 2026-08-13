import type { EventEmitter } from "../core/EventEmitter";
import { FlvDemuxer, type FlvSample, type FlvTrackConfig } from "./flv/FlvDemuxer";
import { buildInitSegment, buildMediaSegment, buildMimeType, type MuxSample, type MuxTrack } from "./mp4/Mp4Muxer";
import { buildSampleEntry, codecConfigFromMatroska } from "./mp4/sampleEntries";
import { MseSink } from "./MseSink";

/** FLV timestamps are milliseconds; scaling up avoids per-frame rounding. */
const TIMESCALE = 1000;
const SEGMENT_TARGET_SECONDS = 1;

interface PendingTrack {
  mux: MuxTrack;
  queue: MuxSample[];
}

/**
 * Plays FLV by remuxing to fragmented MP4.
 *
 * Flash is gone but its files aren't — archives, old CMS uploads and
 * legacy recorders are full of `.flv`. Since FLV stores H.264 and AAC in
 * exactly the form MP4 wants, playing one is a container rewrite with no
 * transcoding involved.
 */
export class FlvRemuxEngine {
  private video: HTMLVideoElement;
  private emitter: EventEmitter;
  private demuxer = new FlvDemuxer();
  private sink: MseSink | null = null;
  private tracks = new Map<"video" | "audio", PendingTrack>();
  private pendingConfigs = new Map<"video" | "audio", FlvTrackConfig>();
  private sequenceNumber = 1;
  private started = false;
  private destroyed = false;
  private streamEnded = false;

  constructor(video: HTMLVideoElement, emitter: EventEmitter) {
    this.video = video;
    this.emitter = emitter;
  }

  async attempt(url: string): Promise<boolean> {
    if (typeof MediaSource === "undefined") return false;

    let response: Response;
    try {
      response = await fetch(url);
    } catch {
      return false;
    }
    if (!response.ok || !response.body) return false;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };

      this.demuxer.onError = (message) => {
        if (this.started) this.emitFatal(message);
        else finish(false);
      };

      // FLV declares its tracks through configuration tags rather than a
      // header, so the pipeline can't start until the first one arrives.
      this.demuxer.onVideoConfig = (config) => {
        this.pendingConfigs.set("video", config);
        void this.maybeStart().then((ok) => ok && finish(true));
      };
      this.demuxer.onAudioConfig = (config) => {
        this.pendingConfigs.set("audio", config);
        void this.maybeStart().then((ok) => ok && finish(true));
      };
      this.demuxer.onSample = (sample) => this.onSample(sample);

      void this.pump(response).then(() => finish(this.started));
    });
  }

  private async pump(response: Response): Promise<void> {
    const reader = response.body!.getReader();
    try {
      for (;;) {
        if (this.destroyed) return;
        const { done, value } = await reader.read();
        if (done) break;
        if (value) this.demuxer.append(value);
      }
      this.demuxer.flush();
    } catch {
      this.demuxer.flush();
    }
    this.finishStream();
  }

  /**
   * Starts the MediaSource once the track configuration is known.
   *
   * Video config is what we wait for; audio may arrive a tag later, so a
   * short grace period lets both land in the same init segment rather
   * than starting video-only and losing the audio track.
   */
  private async maybeStart(): Promise<boolean> {
    if (this.started || this.destroyed) return this.started;

    const video = this.pendingConfigs.get("video");
    const audio = this.pendingConfigs.get("audio");
    if (!video && !audio) return false;

    if (video && !audio && !this.audioGraceElapsed) {
      this.audioGraceElapsed = true;
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (this.destroyed) return false;
      return this.maybeStart();
    }
    if (this.started) return true;

    const muxTracks: MuxTrack[] = [];
    const built = new Map<"video" | "audio", PendingTrack>();

    for (const [kind, config] of this.pendingConfigs) {
      // FLV only ever carries H.264 video and AAC audio in a form MP4 can
      // take, so the Matroska codec mapping applies unchanged.
      const codecId = kind === "video" ? "V_MPEG4/ISO/AVC" : "A_AAC";
      const codecConfig = codecConfigFromMatroska({
        codecId,
        codecPrivate: config.codecPrivate,
        width: config.width,
        height: config.height,
        channels: config.channels,
        sampleRate: config.sampleRate,
      });
      if (!codecConfig) continue;

      const mux: MuxTrack = {
        id: muxTracks.length + 1,
        kind,
        timescale: TIMESCALE,
        codecString: codecConfig.codecString,
        sampleEntry: buildSampleEntry(codecConfig, {
          codecId,
          codecPrivate: config.codecPrivate,
          width: config.width,
          height: config.height,
          channels: config.channels,
          sampleRate: config.sampleRate,
        }),
        width: config.width,
        height: config.height,
      };
      muxTracks.push(mux);
      built.set(kind, { mux, queue: [] });
    }

    if (muxTracks.length === 0) {
      this.emitFatal("This FLV uses a codec your browser can't play.");
      return false;
    }

    const mime = buildMimeType(muxTracks);
    if (!MseSink.isSupported(mime)) {
      this.emitFatal("This FLV uses a codec your browser can't play.");
      return false;
    }

    const sink = new MseSink(this.video, (message) => this.emitFatal(message));
    this.sink = sink;
    sink.append(buildInitSegment(muxTracks));
    this.tracks = built;

    const opened = await sink.open(mime, "segments");
    if (!opened || this.destroyed) return false;

    this.started = true;
    return true;
  }

  private audioGraceElapsed = false;

  private onSample(sample: FlvSample): void {
    const track = this.tracks.get(sample.kind);
    if (!track) return;

    track.queue.push({
      data: sample.data,
      dts: sample.dts * (TIMESCALE / 1000),
      pts: sample.pts * (TIMESCALE / 1000),
      duration: 0,
      keyframe: sample.keyframe,
    });

    this.maybeFlush(track);
  }

  private maybeFlush(track: PendingTrack, force = false): void {
    const queue = track.queue;
    // One sample is held back so the previous one's duration can be
    // derived from the gap to it.
    if (queue.length < 2) {
      if (force && queue.length === 1) this.flush(track, true);
      return;
    }

    const span = (queue[queue.length - 1]!.dts - queue[0]!.dts) / TIMESCALE;
    if (!force && span < SEGMENT_TARGET_SECONDS) return;
    this.flush(track, force);
  }

  private flush(track: PendingTrack, force: boolean): void {
    const sink = this.sink;
    if (!sink) return;

    const count = force ? track.queue.length : track.queue.length - 1;
    if (count <= 0) return;

    const samples = track.queue.splice(0, count);
    const next = track.queue[0];

    for (let i = 0; i < samples.length; i++) {
      const current = samples[i]!;
      const following = i + 1 < samples.length ? samples[i + 1]! : next;
      const delta = following ? following.dts - current.dts : 0;
      current.duration = delta > 0 ? delta : (i > 0 ? samples[i - 1]!.duration : 0);
    }

    sink.append(buildMediaSegment(track.mux, samples, this.sequenceNumber++));
  }

  private finishStream(): void {
    if (this.destroyed || this.streamEnded) return;
    this.streamEnded = true;
    for (const track of this.tracks.values()) this.maybeFlush(track, true);
    this.sink?.endOfInput();
  }

  private emitFatal(message: string): void {
    this.emitter.emit("error", { code: "DECODE", message, fatal: true });
  }

  destroy(): void {
    this.destroyed = true;
    this.demuxer.onSample = undefined;
    this.demuxer.onVideoConfig = undefined;
    this.demuxer.onAudioConfig = undefined;
    this.demuxer.onError = undefined;
    this.sink?.destroy();
    this.sink = null;
  }
}
