import type { EventEmitter } from "../core/EventEmitter";
import { AviDemuxer, type AviChunkSample, type AviStreamInfo } from "./avi/AviDemuxer";
import {
  avcCBox,
  buildAvcC,
  containsKeyframe,
  findParameterSets,
  isAnnexB,
  lengthPrefixedHasKeyframe,
  nalLengthSizeFromAvcC,
  splitAnnexB,
  toLengthPrefixed,
  widenNalLengths,
} from "./avi/h264";
import { countMp3Samples } from "./avi/mp3";
import { buildInitSegment, buildMediaSegment, buildMimeType, type MuxSample, type MuxTrack } from "./mp4/Mp4Muxer";
import { buildAudioSampleEntry, buildVisualSampleEntry, codecConfigFromMatroska, type CodecConfig } from "./mp4/sampleEntries";
import { MseSink } from "./MseSink";

/** Fine enough for 23.976 fps to land on whole ticks. */
const TIMESCALE = 90000;
const SEGMENT_TARGET_SECONDS = 1;

/** `biCompression` values that mean H.264, across the muxers that write AVIs. */
const H264_FOURCCS = new Set(["H264", "h264", "X264", "x264", "AVC1", "avc1", "DAVC", "VSSH", "H.264"]);

/** WAVEFORMATEX tags Lumen can hand to a browser. */
const WAVE_FORMAT_MPEGLAYER3 = 0x0055;
const WAVE_FORMAT_MPEG = 0x0050;
const WAVE_FORMAT_AAC = 0x00ff;
const WAVE_FORMAT_AAC_ALT = 0x1600;

interface PendingTrack {
  mux: MuxTrack;
  stream: AviStreamInfo;
  queue: MuxSample[];
  /** Set for H.264 streams already carrying length-prefixed NAL units. */
  nalLengthSize: number | null;
  /** Sample-accurate audio clock, in the track timescale. */
  audioTicks: number;
  /** True once the first keyframe has been queued. */
  started: boolean;
}

/**
 * Plays AVI by remuxing it to fragmented MP4.
 *
 * The README used to list AVI as "detected, not played", which was only
 * half true: the container is trivially parseable, and an AVI carrying
 * H.264 and MP3 — which every modern re-encode and every camera-to-AVI
 * tool produces — holds exactly the elementary streams MP4 wants. The
 * genuinely unplayable case is MPEG-4 ASP (DivX/Xvid), and that one now
 * gets named in the error instead of hiding behind the container.
 */
export class AviRemuxEngine {
  private video: HTMLVideoElement;
  private emitter: EventEmitter;
  private demuxer = new AviDemuxer();
  private sink: MseSink | null = null;
  private tracks = new Map<number, PendingTrack>();
  private sequenceNumber = 1;
  private started = false;
  private destroyed = false;
  private streamEnded = false;
  private _mimeType: string | null = null;
  /** Streams recognised but dropped, so the viewer can be told which. */
  private droppedCodecs: string[] = [];
  /** Video parameter sets, held until the first keyframe supplies them. */
  private pendingVideo: { stream: AviStreamInfo; samples: AviChunkSample[] } | null = null;

  constructor(video: HTMLVideoElement, emitter: EventEmitter) {
    this.video = video;
    this.emitter = emitter;
  }

  get mimeType(): string | null {
    return this._mimeType;
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

      this.demuxer.onStreams = (streams) => {
        void this.start(streams).then((ok) => {
          if (!ok) finish(false);
          else finish(true);
        });
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
   * Builds the MP4 tracks once the AVI header has described the streams.
   *
   * H.264 whose parameter sets live only in the bitstream can't be
   * described yet — those files start the pipeline lazily, once the first
   * keyframe arrives, which is what `pendingVideo` holds samples for.
   */
  private async start(streams: AviStreamInfo[]): Promise<boolean> {
    if (this.destroyed || this.started) return this.started;

    const muxTracks: MuxTrack[] = [];
    const built = new Map<number, PendingTrack>();

    for (const stream of streams) {
      if (stream.kind === "video") {
        const handler = stream.handler.trim();
        if (!H264_FOURCCS.has(handler)) {
          this.emitFatal(
            `This AVI's video is ${describeVideoCodec(handler)}, which no browser can decode. Converting it to H.264 MP4 will fix it.`,
          );
          return false;
        }

        const built264 = this.buildH264Track(stream, muxTracks.length + 1);
        if (!built264) {
          // Parameter sets are in-band; wait for the first keyframe.
          this.pendingVideo = { stream, samples: [] };
          continue;
        }
        muxTracks.push(built264.mux);
        built.set(stream.index, built264);
        continue;
      }

      if (stream.kind === "audio") {
        const audio = this.buildAudioTrack(stream, muxTracks.length + 1);
        if (!audio) {
          this.droppedCodecs.push(describeAudioCodec(stream.formatTag ?? 0));
          continue;
        }
        muxTracks.push(audio.mux);
        built.set(stream.index, audio);
      }
    }

    // A video track is still coming: hold the sink closed rather than
    // opening an audio-only one that would have to be torn down again.
    if (this.pendingVideo) {
      this.tracks = built;
      return true;
    }

    if (muxTracks.length === 0) {
      this.emitFatal("This AVI's streams use codecs your browser can't decode.");
      return false;
    }

    return this.openSink(muxTracks, built);
  }

  private async openSink(muxTracks: MuxTrack[], built: Map<number, PendingTrack>): Promise<boolean> {
    const mime = buildMimeType(muxTracks);
    if (!MseSink.isSupported(mime)) {
      this.emitFatal("This AVI uses a codec your browser can't play.");
      return false;
    }
    this._mimeType = mime;

    const sink = new MseSink(this.video, (message) => this.emitFatal(message));
    this.sink = sink;
    sink.append(buildInitSegment(muxTracks));
    this.tracks = built;

    const opened = await sink.open(mime, "segments");
    if (!opened || this.destroyed) return false;

    this.started = true;
    if (this.droppedCodecs.length > 0) this.warnDroppedAudio();
    return true;
  }

  /** Describes an H.264 stream from its extradata, when it carries any. */
  private buildH264Track(stream: AviStreamInfo, id: number): PendingTrack | null {
    const extradata = stream.extradata;
    if (!extradata || extradata.byteLength < 4) return null;

    let record: Uint8Array | null = null;
    let nalLengthSize: number | null = null;

    if (isAnnexB(extradata)) {
      // Parameter sets stored as an Annex B stream: rebuild them as avcC.
      const { sps, pps } = findParameterSets(splitAnnexB(extradata));
      if (!sps || !pps) return null;
      record = buildAvcC(sps, pps);
    } else if (extradata[0] === 1) {
      // Already an avcC record; the samples are length-prefixed to match.
      record = extradata;
      nalLengthSize = nalLengthSizeFromAvcC(extradata);
    }

    if (!record) return null;
    return this.trackFromAvcC(stream, id, record, nalLengthSize);
  }

  private trackFromAvcC(
    stream: AviStreamInfo,
    id: number,
    record: Uint8Array,
    nalLengthSize: number | null,
  ): PendingTrack {
    const config: CodecConfig = {
      kind: "video",
      fourcc: "avc1",
      codecString: `avc1.${hex(record[1])}${hex(record[2])}${hex(record[3])}`,
      configBox: avcCBox(record),
    };

    const mux: MuxTrack = {
      id,
      kind: "video",
      timescale: TIMESCALE,
      codecString: config.codecString,
      sampleEntry: buildVisualSampleEntry(config, stream.width ?? 0, stream.height ?? 0),
      width: stream.width,
      height: stream.height,
    };

    return { mux, stream, queue: [], nalLengthSize, audioTicks: 0, started: false };
  }

  /**
   * Describes an audio stream, or returns null when the browser has no
   * chance with it (PCM, AC-3, and the long tail of Windows codecs).
   */
  private buildAudioTrack(stream: AviStreamInfo, id: number): PendingTrack | null {
    const tag = stream.formatTag ?? 0;
    let config: CodecConfig | null = null;

    if (tag === WAVE_FORMAT_MPEGLAYER3 || tag === WAVE_FORMAT_MPEG) {
      config = codecConfigFromMatroska({ codecId: "A_MPEG/L3" });
    } else if (tag === WAVE_FORMAT_AAC || tag === WAVE_FORMAT_AAC_ALT) {
      if (!stream.extradata || stream.extradata.byteLength === 0) return null;
      config = codecConfigFromMatroska({ codecId: "A_AAC", codecPrivate: stream.extradata });
    }

    if (!config) return null;

    const mux: MuxTrack = {
      id,
      kind: "audio",
      timescale: stream.sampleRate && stream.sampleRate > 0 ? stream.sampleRate : TIMESCALE,
      codecString: config.codecString,
      sampleEntry: buildAudioSampleEntry(config, stream.channels ?? 2, stream.sampleRate ?? 48000),
    };

    return { mux, stream, queue: [], nalLengthSize: null, audioTicks: 0, started: false };
  }

  // ------------------------------------------------------------ samples

  private onSample(sample: AviChunkSample): void {
    if (this.destroyed) return;

    if (this.pendingVideo && sample.streamIndex === this.pendingVideo.stream.index) {
      this.collectPendingVideo(sample);
      return;
    }

    const track = this.tracks.get(sample.streamIndex);
    if (!track) return;

    if (track.mux.kind === "video") this.queueVideo(track, sample);
    else this.queueAudio(track, sample);

    this.maybeFlush(track);
  }

  /**
   * Buffers video samples until a keyframe carrying SPS/PPS shows up.
   *
   * AVIs written by hardware encoders often leave the format header empty
   * and repeat the parameter sets in-band instead, so the track can only
   * be described once the stream itself has been seen.
   */
  private collectPendingVideo(sample: AviChunkSample): void {
    const pending = this.pendingVideo!;
    pending.samples.push(sample);

    const { sps, pps } = findParameterSets(splitAnnexB(sample.data));
    if (!sps || !pps) {
      // Give up rather than buffer a whole file that will never describe
      // itself; two seconds of frames is far more than any real stream needs.
      if (pending.samples.length > 120) {
        this.pendingVideo = null;
        this.emitFatal("This AVI's H.264 stream carries no decodable configuration.");
      }
      return;
    }

    const record = buildAvcC(sps, pps);
    if (!record) return;

    const stream = pending.stream;
    const samples = pending.samples;
    this.pendingVideo = null;

    // Video is track 1 by convention, so any audio track built earlier is
    // renumbered around it.
    const track = this.trackFromAvcC(stream, 1, record, null);
    const built = new Map<number, PendingTrack>([[stream.index, track]]);
    const muxTracks: MuxTrack[] = [track.mux];

    let nextId = 2;
    for (const [index, entry] of this.tracks) {
      if (index === stream.index) continue;
      const renumbered = { ...entry, mux: { ...entry.mux, id: nextId++ } };
      built.set(index, renumbered);
      muxTracks.push(renumbered.mux);
    }

    void this.openSink(muxTracks, built).then((ok) => {
      if (!ok || this.destroyed) return;
      for (const buffered of samples) this.onSample(buffered);
    });
  }

  /** Queues one video access unit, converting its NAL framing if needed. */
  private queueVideo(track: PendingTrack, sample: AviChunkSample): void {
    let data: Uint8Array;
    let keyframe: boolean;

    if (track.nalLengthSize !== null) {
      keyframe = lengthPrefixedHasKeyframe(sample.data, track.nalLengthSize);
      data = widenNalLengths(sample.data, track.nalLengthSize);
    } else {
      const units = splitAnnexB(sample.data);
      if (units.length === 0) return;
      keyframe = containsKeyframe(units);
      data = toLengthPrefixed(units);
    }

    if (data.byteLength === 0) return;
    // A SourceBuffer can only start at a keyframe, so anything before the
    // first one is dropped rather than appended and rejected.
    if (!track.started && !keyframe) return;
    track.started = true;

    const ticks = Math.round((sample.chunkIndex * track.stream.scale * TIMESCALE) / track.stream.rate);
    track.queue.push({ data, dts: ticks, pts: ticks, duration: 0, keyframe });
  }

  /**
   * Queues one audio chunk.
   *
   * MP3 chunks are timed by counting the samples their frames decode to,
   * which is exact; everything else falls back to the stream header's
   * declared rate.
   */
  private queueAudio(track: PendingTrack, sample: AviChunkSample): void {
    const stream = track.stream;
    const timescale = track.mux.timescale;
    let ticks = track.audioTicks;
    let duration = 0;

    const tag = stream.formatTag ?? 0;
    if (tag === WAVE_FORMAT_MPEGLAYER3 || tag === WAVE_FORMAT_MPEG) {
      const counted = countMp3Samples(sample.data);
      if (counted) {
        duration = Math.round((counted.samples * timescale) / counted.sampleRate);
      }
    }

    if (duration === 0) {
      if (stream.sampleSize > 0) {
        // Constant-rate stream: the byte offset *is* the sample index.
        ticks = Math.round(((sample.streamByteOffset / stream.sampleSize) * stream.scale * timescale) / stream.rate);
        duration = Math.round(((sample.data.byteLength / stream.sampleSize) * stream.scale * timescale) / stream.rate);
      } else {
        duration = Math.round((stream.scale * timescale) / stream.rate);
      }
    }

    track.audioTicks = ticks + duration;
    track.started = true;
    track.queue.push({ data: sample.data, dts: ticks, pts: ticks, duration, keyframe: true });
  }

  private maybeFlush(track: PendingTrack, force = false): void {
    const queue = track.queue;
    if (queue.length === 0) return;

    // One sample is held back so the one before it can take its duration
    // from the gap — except for audio, whose durations are already known.
    const needsLookahead = track.mux.kind === "video";
    if (needsLookahead && queue.length < 2) {
      if (force && queue.length === 1) this.flush(track, true);
      return;
    }

    const span = (queue[queue.length - 1]!.dts - queue[0]!.dts) / track.mux.timescale;
    if (!force && span < SEGMENT_TARGET_SECONDS) return;
    this.flush(track, force);
  }

  private flush(track: PendingTrack, force: boolean): void {
    const sink = this.sink;
    if (!sink) return;

    const needsLookahead = track.mux.kind === "video";
    const count = force || !needsLookahead ? track.queue.length : track.queue.length - 1;
    if (count <= 0) return;

    const samples = track.queue.splice(0, count);
    const next = track.queue[0];

    if (needsLookahead) {
      for (let i = 0; i < samples.length; i++) {
        const current = samples[i]!;
        const following = i + 1 < samples.length ? samples[i + 1]! : next;
        const delta = following ? following.dts - current.dts : 0;
        current.duration = delta > 0 ? delta : i > 0 ? samples[i - 1]!.duration : 0;
      }
    }

    sink.append(buildMediaSegment(track.mux, samples, this.sequenceNumber++));
  }

  private finishStream(): void {
    if (this.destroyed || this.streamEnded) return;
    this.streamEnded = true;
    for (const track of this.tracks.values()) this.maybeFlush(track, true);
    this.sink?.endOfInput();
  }

  private warnDroppedAudio(): void {
    this.emitter.emit("error", {
      code: "DECODE",
      message: `Playing video only — this file's audio (${this.droppedCodecs.join(", ")}) isn't supported by your browser.`,
      fatal: false,
    });
  }

  private emitFatal(message: string): void {
    this.emitter.emit("error", { code: "CONTAINER_UNSUPPORTED", message, fatal: true });
  }

  destroy(): void {
    this.destroyed = true;
    this.demuxer.onSample = undefined;
    this.demuxer.onStreams = undefined;
    this.demuxer.onError = undefined;
    this.sink?.destroy();
    this.sink = null;
  }
}

function hex(value: number | undefined): string {
  return (value ?? 0).toString(16).padStart(2, "0");
}

/** Names the codec behind a `biCompression` fourcc, for the error message. */
function describeVideoCodec(handler: string): string {
  const upper = handler.toUpperCase();
  if (["XVID", "DIVX", "DX50", "MP4V", "FMP4", "DIV3", "MP43"].includes(upper)) {
    return `MPEG-4 ASP (${handler})`;
  }
  if (upper === "MJPG") return "Motion JPEG";
  if (upper === "HFYU" || upper === "FFVH") return "HuffYUV";
  if (upper === "MPEG" || upper === "MPG2") return "MPEG-2";
  if (upper === "WMV3" || upper === "WVC1") return "Windows Media Video";
  if (upper === "" || upper === "    ") return "uncompressed";
  return `${handler}-coded`;
}

function describeAudioCodec(tag: number): string {
  switch (tag) {
    case 0x0001:
      return "PCM";
    case 0x0002:
      return "MS ADPCM";
    case 0x0161:
    case 0x0162:
      return "Windows Media Audio";
    case 0x2000:
      return "AC-3";
    case 0x2001:
      return "DTS";
    default:
      return `format 0x${tag.toString(16)}`;
  }
}
