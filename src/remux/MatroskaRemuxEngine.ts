import type { EventEmitter } from "../core/EventEmitter";
import type { LumenAudioTrack } from "../types";
import { MatroskaDemuxer, type MkvBlock, type MkvCuePoint, type MkvTrack } from "./matroska/MatroskaDemuxer";
import { buildInitSegment, buildMediaSegment, buildMimeType, type MuxSample, type MuxTrack } from "./mp4/Mp4Muxer";
import { buildSampleEntry, codecConfigFromMatroska } from "./mp4/sampleEntries";
import { MseSink } from "./MseSink";

/**
 * Timestamps are scaled up from Matroska's ticks (1ms by default) to
 * microsecond resolution. Matroska stores absolute timestamps per block,
 * so this doesn't accumulate drift — it just stops per-frame rounding
 * from audibly shortening AAC frames, whose true duration (21.333ms at
 * 48kHz) isn't a whole number of milliseconds.
 */
const TIMESCALE_MULTIPLIER = 1000;

/** How much media to accumulate per track before emitting a fragment. */
const SEGMENT_TARGET_SECONDS = 1;

interface PendingTrack {
  mux: MuxTrack;
  source: MkvTrack;
  queue: MuxSample[];
  /** Nominal duration in the mux timescale, used for the very last sample. */
  defaultDuration: number;
  reorderable: boolean;
}

/**
 * Plays Matroska (.mkv) by remuxing it into fragmented MP4 for MediaSource.
 *
 * No browser plays Matroska natively, but the codecs inside one usually
 * are decodable — H.264/HEVC video with AAC/Opus/FLAC audio. Since
 * Matroska and MP4 both carry those as plain elementary streams, the
 * frames can be copied across untouched and only the container is
 * rebuilt: no transcoding, no WASM decoder, no quality loss.
 */
export class MatroskaRemuxEngine {
  private video: HTMLVideoElement;
  private emitter: EventEmitter;
  private demuxer: MatroskaDemuxer = new MatroskaDemuxer();
  private sink: MseSink | null = null;
  private tracks = new Map<number, PendingTrack>();
  private textTracks = new Map<number, TextTrack>();
  private subtitleTracks = new Map<number, MkvTrack>();
  private sequenceNumber = 1;
  private muxTimescale = 1000;
  private destroyed = false;
  private started = false;
  /** Every decodable audio track in the file, whether or not it's selected. */
  private candidateAudio: MkvTrack[] = [];
  private selectedAudioNumber: number | null = null;
  private sourceUrl = "";
  private cues: MkvCuePoint[] = [];
  private seeking = false;
  private abortController: AbortController | null = null;
  private boundOnSeeking = () => this.onSeeking();
  private _mimeType: string | null = null;

  constructor(video: HTMLVideoElement, emitter: EventEmitter) {
    this.video = video;
    this.emitter = emitter;
  }

  /** The MediaSource MIME the browser accepted, for the media-info panel. */
  get mimeType(): string | null {
    return this._mimeType;
  }

  get audioTracks(): LumenAudioTrack[] {
    return this.candidateAudio.map((track) => ({
      id: String(track.number),
      label: track.name || track.language || `Track ${track.number}`,
      language: track.language ?? "",
      active: track.number === this.selectedAudioNumber,
    }));
  }

  /**
   * Switches the active audio track.
   *
   * A fragmented-MP4 SourceBuffer is initialized with a fixed set of
   * tracks, so changing them means rebuilding the MediaSource — which in
   * turn means re-reading the file. Playback resumes at the same position,
   * but this is a heavier operation than an HLS audio switch, which just
   * changes which segments get fetched.
   */
  async selectAudioTrack(id: string): Promise<void> {
    const number = Number(id);
    if (!this.candidateAudio.some((track) => track.number === number)) return;
    if (number === this.selectedAudioNumber) return;

    const resumeAt = this.video.currentTime;
    const wasPlaying = !this.video.paused;

    this.preferredAudioNumber = number;
    this.resetForReload();

    const ok = await this.attempt(this.sourceUrl);
    if (!ok || this.destroyed) return;

    const restore = () => {
      this.video.currentTime = resumeAt;
      if (wasPlaying) void this.video.play().catch(() => {});
    };
    if (this.video.readyState >= 1) restore();
    else this.video.addEventListener("loadedmetadata", restore, { once: true });
  }

  private preferredAudioNumber: number | null = null;

  private resetForReload(): void {
    this.sink?.destroy();
    this.sink = null;
    this.demuxer = new MatroskaDemuxer();
    this.tracks.clear();
    this.textTracks.clear();
    this.subtitleTracks.clear();
    this.sequenceNumber = 1;
    this.started = false;
  }

  /** Returns true once playback has been handed off to a MediaSource. */
  async attempt(url: string): Promise<boolean> {
    if (typeof MediaSource === "undefined") return false;
    this.sourceUrl = url;

    let response: Response;
    try {
      response = await fetch(url);
    } catch {
      return false;
    }
    if (!response.ok || !response.body) return false;

    const ready = new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };

      this.demuxer.onError = (message) => {
        if (!this.started) finish(false);
        else this.fail(message);
      };

      this.demuxer.onTracks = (tracks, timestampScaleNs) => {
        void this.onTracks(tracks, timestampScaleNs).then(finish);
      };

      this.demuxer.onBlock = (block) => this.onBlock(block);
      this.demuxer.onCues = (cues) => {
        this.cues = cues;
      };
      // Cues normally live at the end of the file; the SeekHead tells us
      // where, so the index can be fetched on its own instead of by
      // downloading everything in front of it.
      this.demuxer.onCuesLocation = (position) => void this.fetchCues(position);

      void this.pump(response, 0).catch(() => finish(false));
    });

    return ready;
  }

  private async pump(response: Response, fileOffset: number): Promise<void> {
    const reader = response.body!.getReader();
    const generation = ++this.pumpGeneration;
    this.demuxer.fileOffset = fileOffset;

    try {
      for (;;) {
        // A seek starts a new pump; the old one must stop feeding the
        // demuxer or the two reads would interleave into nonsense.
        if (this.destroyed || generation !== this.pumpGeneration) return;
        const { done, value } = await reader.read();
        if (done) break;
        if (value) this.demuxer.append(value);
      }
      this.demuxer.flush();
    } catch {
      // A mid-stream network failure still leaves everything already
      // demuxed playable, so finish cleanly rather than tearing down.
      this.demuxer.flush();
    }
    if (generation === this.pumpGeneration) this.finishStream();
  }

  private pumpGeneration = 0;

  /**
   * Fetches just the Cues element, using the position from the SeekHead.
   * A few kB of index buys random access to a file that might be gigabytes.
   */
  private async fetchCues(position: number): Promise<void> {
    try {
      const response = await fetch(this.sourceUrl, { headers: { Range: `bytes=${position}-` } });
      // A server that ignores Range replies 200 with the whole file, which
      // would defeat the purpose; only a real partial response is useful.
      if (response.status !== 206) return;

      const bytes = new Uint8Array(await response.arrayBuffer());
      const indexDemuxer = new MatroskaDemuxer();
      indexDemuxer.fileOffset = position;
      indexDemuxer.onCues = (cues) => {
        this.cues = cues;
        this.enableSeeking();
      };
      indexDemuxer.append(bytes);
      indexDemuxer.flush();
    } catch {
      // No index means seeking stays limited to buffered ranges, which is
      // a degradation rather than a failure.
    }
  }

  private enableSeeking(): void {
    if (this.seekEnabled || this.cues.length === 0) return;
    this.seekEnabled = true;
    this.video.addEventListener("seeking", this.boundOnSeeking);
  }

  private seekEnabled = false;

  /**
   * Restarts the pipeline from the cluster covering the seek target.
   *
   * Only unbuffered seeks need this: if the target is already in the
   * SourceBuffer the browser handles it with no work from us.
   */
  private onSeeking(): void {
    if (this.destroyed || this.seeking || this.cues.length === 0) return;

    const target = this.video.currentTime;
    if (isBuffered(this.video, target)) return;

    const cue = cueForTime(this.cues, target * this.ticksPerSecond());
    if (!cue) return;

    this.seeking = true;
    void this.restartFrom(this.demuxer.segmentStart + cue.clusterPosition).finally(() => {
      this.seeking = false;
    });
  }

  private ticksPerSecond(): number {
    return 1_000_000_000 / (this.demuxer.timestampScale || 1_000_000);
  }

  /** Re-reads the file from a byte offset, reusing the existing SourceBuffer. */
  private async restartFrom(position: number): Promise<void> {
    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;

    let response: Response;
    try {
      response = await fetch(this.sourceUrl, {
        headers: { Range: `bytes=${position}-` },
        signal: controller.signal,
      });
    } catch {
      return;
    }
    if (response.status !== 206 || !response.body || this.destroyed) return;

    // The demuxer restarts mid-file, so it needs the track definitions it
    // already parsed but not another init segment — the SourceBuffer keeps
    // the one it has, and fMP4 fragments carry absolute timestamps.
    const previous = this.demuxer;
    this.demuxer = new MatroskaDemuxer();
    this.demuxer.onBlock = (block) => this.onBlock(block);
    this.demuxer.onError = previous.onError;
    this.demuxer.seedTimestampScale(previous.timestampScale);

    for (const track of this.tracks.values()) track.queue = [];

    await this.pump(response, position);
  }

  private async onTracks(sourceTracks: MkvTrack[], timestampScaleNs: number): Promise<boolean> {
    const ticksPerSecond = 1_000_000_000 / (timestampScaleNs || 1_000_000);
    this.muxTimescale = Math.round(ticksPerSecond * TIMESCALE_MULTIPLIER);

    const playable: PendingTrack[] = [];
    const droppedCodecs: string[] = [];
    this.candidateAudio = [];

    // A file can carry several audio languages, but a fragmented-MP4
    // SourceBuffer takes one of each kind — so every decodable audio track
    // is catalogued for the UI, and exactly one is muxed in.
    const audioSources = sourceTracks.filter((track) => track.type === "audio");
    const decodableAudio = audioSources.filter((track) => codecConfigFromMatroska(track) !== null);
    this.candidateAudio = decodableAudio;

    // Audio we can't decode is recorded here rather than in the loop below,
    // which only ever visits the one selected audio track.
    for (const track of audioSources) {
      if (!decodableAudio.includes(track)) droppedCodecs.push(track.codecId);
    }

    const chosenAudio =
      decodableAudio.find((track) => track.number === this.preferredAudioNumber) ??
      decodableAudio.find((track) => track.isDefault) ??
      decodableAudio[0];
    this.selectedAudioNumber = chosenAudio?.number ?? null;

    for (const source of sourceTracks) {
      if (source.type === "subtitle") {
        this.subtitleTracks.set(source.number, source);
        continue;
      }
      if (source.type !== "video" && source.type !== "audio") continue;
      if (source.type === "audio" && source !== chosenAudio) continue;

      const config = codecConfigFromMatroska(source);
      if (!config) {
        droppedCodecs.push(source.codecId);
        continue;
      }

      const mux: MuxTrack = {
        id: playable.length + 1,
        kind: config.kind,
        timescale: this.muxTimescale,
        codecString: config.codecString,
        sampleEntry: buildSampleEntry(config, source),
        width: source.width,
        height: source.height,
        language: source.language,
      };

      playable.push({
        mux,
        source,
        queue: [],
        defaultDuration: source.defaultDuration
          ? Math.round((source.defaultDuration / 1_000_000_000) * this.muxTimescale)
          : 0,
        // Only video carries B-frames, so only video needs DTS reordering.
        reorderable: config.kind === "video",
      });
    }

    const selected = this.selectSupported(playable, droppedCodecs);
    if (selected.length === 0) {
      this.emitFatal(
        "This video uses a codec your browser can't play. Converting it to H.264/AAC MP4 will fix it.",
      );
      return false;
    }

    const mime = buildMimeType(selected.map((t) => t.mux));
    this._mimeType = mime;
    const sink = new MseSink(this.video, (message) => this.emitFatal(message));
    this.sink = sink;

    // The init segment has to be queued before any media fragment can be.
    // Opening the sink is asynchronous, and the demuxer keeps delivering
    // blocks synchronously while we wait — so registering the tracks (which
    // is what lets blocks start queueing) must happen strictly after this.
    sink.append(buildInitSegment(selected.map((t) => t.mux)));
    for (const track of selected) this.tracks.set(track.source.number, track);

    // The file's own stated length, so the scrub bar works from the start
    // rather than only once the whole file has been read.
    sink.setDuration(this.demuxer.durationSeconds);

    const opened = await sink.open(mime, "segments");
    if (!opened || this.destroyed) return false;

    this.attachSubtitleTracks();
    this.started = true;
    return true;
  }

  /**
   * Keeps the tracks the browser can actually decode.
   *
   * Undecodable audio (AC-3, DTS, TrueHD — common in film rips) is dropped
   * rather than treated as fatal: a silent picture beats a dead player,
   * and the viewer is told what happened.
   */
  private selectSupported(tracks: PendingTrack[], droppedCodecs: string[]): PendingTrack[] {
    if (tracks.length === 0) return [];

    const full = buildMimeType(tracks.map((t) => t.mux));
    if (MseSink.isSupported(full)) {
      if (droppedCodecs.length > 0) this.warnDroppedAudio(droppedCodecs);
      return tracks;
    }

    const video = tracks.filter((t) => t.mux.kind === "video");
    const audio = tracks.filter((t) => t.mux.kind === "audio");

    // Try video alone before giving up — that isolates an unsupported
    // audio codec from an unsupported video one.
    if (video.length > 0 && MseSink.isSupported(buildMimeType(video.map((t) => t.mux)))) {
      this.warnDroppedAudio([...droppedCodecs, ...audio.map((t) => t.source.codecId)]);
      return video;
    }

    if (audio.length > 0 && MseSink.isSupported(buildMimeType(audio.map((t) => t.mux)))) {
      return audio;
    }

    return [];
  }

  private warnDroppedAudio(codecIds: string[]): void {
    const names = codecIds.filter(Boolean);
    if (names.length === 0) return;
    this.emitter.emit("error", {
      code: "DECODE",
      message: `Playing video only — this file's audio (${names.join(", ")}) isn't supported by your browser.`,
      fatal: false,
    });
  }

  /**
   * Exposes embedded Matroska subtitles as real text tracks, so MKV
   * subtitles flow into the same captions UI as external WebVTT files.
   */
  private attachSubtitleTracks(): void {
    for (const [number, source] of this.subtitleTracks) {
      const codec = source.codecId.toUpperCase();
      if (!codec.startsWith("S_TEXT/")) continue; // bitmap subs (VOBSUB/PGS) can't render as text
      try {
        const track = this.video.addTextTrack(
          "subtitles",
          source.name || source.language || "Subtitles",
          source.language || "und",
        );
        this.textTracks.set(number, track);
        this.emitter.emit("embeddedtexttrack", { track });
      } catch {
        // addTextTrack is unavailable in some embedding contexts; subtitles
        // simply won't appear, which shouldn't stop the video from playing.
      }
    }
  }

  private onBlock(block: MkvBlock): void {
    if (this.destroyed) return;

    const subtitle = this.textTracks.get(block.trackNumber);
    if (subtitle) {
      this.addSubtitleCue(subtitle, block);
      return;
    }

    const track = this.tracks.get(block.trackNumber);
    if (!track) return;

    const timestamp = block.timestamp * TIMESCALE_MULTIPLIER;
    for (const frame of block.frames) {
      track.queue.push({
        data: frame,
        dts: timestamp,
        pts: timestamp,
        duration: 0,
        keyframe: block.keyframe,
      });
    }

    this.maybeFlush(track);
  }

  private addSubtitleCue(track: TextTrack, block: MkvBlock): void {
    const durationTicks = block.duration ?? 0;
    if (durationTicks <= 0) return;

    const scale = 1000 / (1_000_000_000 / (this.demuxer.timestampScale || 1_000_000));
    const start = (block.timestamp * scale) / 1000;
    const end = start + (durationTicks * scale) / 1000;

    for (const frame of block.frames) {
      const text = decodeSubtitle(frame, block.trackNumber, this.subtitleTracks);
      if (!text) continue;
      try {
        track.addCue(new VTTCue(start, end, text));
      } catch {
        /* malformed cue — skip it rather than break the track */
      }
    }
  }

  /** Emits a fragment once a track has buffered roughly SEGMENT_TARGET_SECONDS. */
  private maybeFlush(track: PendingTrack, force = false): void {
    const queue = track.queue;
    // One sample is always held back: its duration isn't known until the
    // next one arrives, and Matroska rarely states durations explicitly.
    if (queue.length < 2) {
      if (force) this.flush(track, true);
      return;
    }

    const spanTicks = queue[queue.length - 1]!.dts - queue[0]!.dts;
    const spanSeconds = spanTicks / this.muxTimescale;
    if (!force && spanSeconds < SEGMENT_TARGET_SECONDS) return;

    this.flush(track, force);
  }

  private flush(track: PendingTrack, force: boolean): void {
    const sink = this.sink;
    if (!sink) return;

    const queue = track.queue;
    const count = force ? queue.length : queue.length - 1;
    if (count <= 0) return;

    const samples = queue.splice(0, count);
    if (samples.length === 0) return;

    this.assignTimestamps(samples, track, force ? undefined : queue[0]);
    sink.append(buildMediaSegment(track.mux, samples, this.sequenceNumber++));
  }

  /**
   * Fills in decode timestamps and durations.
   *
   * Matroska block timestamps are presentation times. MP4 needs decode
   * order plus a composition offset, so for reorderable (video) tracks the
   * DTS values are the same timestamps sorted ascending — that recovers a
   * monotonic decode timeline for B-frames, with the difference carried in
   * each sample's signed composition offset.
   */
  private assignTimestamps(samples: MuxSample[], track: PendingTrack, next: MuxSample | undefined): void {
    if (track.reorderable) {
      const sorted = samples.map((sample) => sample.pts).sort((a, b) => a - b);
      samples.forEach((sample, index) => {
        sample.dts = sorted[index]!;
      });
    }

    for (let i = 0; i < samples.length; i++) {
      const current = samples[i]!;
      const following = i + 1 < samples.length ? samples[i + 1]! : next;
      const delta = following ? following.dts - current.dts : 0;
      current.duration =
        delta > 0 ? delta : track.defaultDuration || (i > 0 ? samples[i - 1]!.duration : 0);
    }
  }

  private finishStream(): void {
    if (this.destroyed) return;
    for (const track of this.tracks.values()) {
      this.maybeFlush(track, true);
    }
    this.sink?.endOfInput();
  }

  private emitFatal(message: string): void {
    this.emitter.emit("error", { code: "DECODE", message, fatal: true });
  }

  private fail(message: string): void {
    this.emitFatal(message);
    this.destroy();
  }

  destroy(): void {
    this.destroyed = true;
    this.abortController?.abort();
    this.video.removeEventListener("seeking", this.boundOnSeeking);
    this.demuxer.onBlock = undefined;
    this.demuxer.onTracks = undefined;
    this.demuxer.onError = undefined;
    this.sink?.destroy();
    this.sink = null;
  }
}

/** True when a time already sits inside a buffered range. */
function isBuffered(video: HTMLVideoElement, time: number): boolean {
  const buffered = video.buffered;
  for (let i = 0; i < buffered.length; i++) {
    if (time >= buffered.start(i) && time <= buffered.end(i)) return true;
  }
  return false;
}

/** The last cue at or before a target time — where decoding must restart. */
function cueForTime(cues: MkvCuePoint[], ticks: number): MkvCuePoint | null {
  let match: MkvCuePoint | null = null;
  for (const cue of cues) {
    if (cue.time <= ticks) match = cue;
    else break;
  }
  return match ?? cues[0] ?? null;
}

/** Extracts displayable text from a subtitle block, handling SRT-style and ASS/SSA payloads. */
function decodeSubtitle(
  frame: Uint8Array,
  trackNumber: number,
  sources: Map<number, MkvTrack>,
): string {
  const raw = new TextDecoder().decode(frame).trim();
  if (!raw) return "";

  const codec = sources.get(trackNumber)?.codecId.toUpperCase() ?? "";
  if (!codec.includes("ASS") && !codec.includes("SSA")) return raw;

  // ASS block payloads are the Dialogue fields with the text last, after
  // ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect.
  const fields = raw.split(",");
  const text = fields.length > 8 ? fields.slice(8).join(",") : raw;
  return text
    .replace(/\{[^}]*\}/g, "") // drawing/override tags
    .replace(/\\[Nn]/g, "\n")
    .trim();
}
