import { ID, MASTER_IDS, readFloat, readSignedVint, readString, readUint, readVint } from "./ebml";

export type MkvTrackType = "video" | "audio" | "subtitle" | "other";

export interface MkvTrack {
  number: number;
  type: MkvTrackType;
  codecId: string;
  codecPrivate?: Uint8Array;
  /** Nominal frame duration in nanoseconds, when the file declares one. */
  defaultDuration?: number;
  language?: string;
  name?: string;
  isDefault: boolean;
  width?: number;
  height?: number;
  channels?: number;
  sampleRate?: number;
  bitDepth?: number;
}

/** One entry of the Cues index: a time, and where its cluster begins. */
export interface MkvCuePoint {
  /** Timestamp in TimestampScale ticks. */
  time: number;
  /** Byte offset of the cluster, relative to the start of Segment data. */
  clusterPosition: number;
}

export interface MkvBlock {
  trackNumber: number;
  /** Absolute timestamp, in TimestampScale ticks. */
  timestamp: number;
  /** Explicit duration in ticks, when a BlockGroup provides one. */
  duration?: number;
  keyframe: boolean;
  /** Lacing means one block can carry several frames that share a timestamp. */
  frames: Uint8Array[];
}

/** Default TimestampScale: 1ms per tick. */
const DEFAULT_TIMESTAMP_SCALE_NS = 1_000_000;

/**
 * Streaming Matroska demuxer.
 *
 * Bytes are pushed in as they arrive from the network and parsed
 * incrementally: as soon as the Tracks element is complete the consumer
 * can build an init segment, and each Cluster yields blocks as it lands.
 * That's what makes an MKV start playing before it has finished
 * downloading, rather than after.
 */
export class MatroskaDemuxer {
  onTracks?: (tracks: MkvTrack[], timestampScaleNs: number) => void;
  onBlock?: (block: MkvBlock) => void;
  onCues?: (cues: MkvCuePoint[]) => void;
  /** Fires when a SeekHead points at a Cues element we haven't read yet. */
  onCuesLocation?: (absolutePosition: number) => void;
  onError?: (message: string) => void;

  // Typed as ArrayBufferLike-backed so chunks handed over by fetch() can be
  // adopted without an extra copy.
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  /** Absolute file offset of buffer[0], used only for diagnostics. */
  private consumed = 0;
  private position = 0;
  private timestampScaleNs = DEFAULT_TIMESTAMP_SCALE_NS;
  private durationTicks = 0;
  private clusterTimestamp = 0;
  private tracks: MkvTrack[] = [];
  private tracksEmitted = false;
  private failed = false;
  private cues: MkvCuePoint[] = [];
  /** Absolute file offset where Segment *data* begins; Cues positions are relative to it. */
  private segmentDataStart = 0;
  private cuesLocationReported = false;

  /**
   * Byte offset in the file that buffer[0] corresponds to. Set when the
   * demuxer is fed a range that doesn't start at the beginning of the file,
   * which is how seeking works.
   */
  fileOffset = 0;

  append(chunk: Uint8Array): void {
    if (this.failed) return;
    this.buffer = this.buffer.length === 0 ? chunk : concatBytes(this.buffer, chunk);
    this.parse();
  }

  /** Signals end of input; any trailing complete elements are parsed. */
  flush(): void {
    if (this.failed) return;
    this.parse();
  }

  get trackList(): MkvTrack[] {
    return this.tracks;
  }

  get timestampScale(): number {
    return this.timestampScaleNs;
  }

  /** The file's own stated length in seconds, or 0 when it declares none. */
  get durationSeconds(): number {
    if (!this.durationTicks) return 0;
    return (this.durationTicks * this.timestampScaleNs) / 1_000_000_000;
  }

  /**
   * Carries the TimestampScale over to a demuxer that starts mid-file.
   * A ranged read begins after the Info element, so it would otherwise
   * fall back to the default and misplace every timestamp.
   */
  seedTimestampScale(scaleNs: number): void {
    this.timestampScaleNs = scaleNs || DEFAULT_TIMESTAMP_SCALE_NS;
  }

  private fail(message: string): void {
    this.failed = true;
    this.onError?.(message);
  }

  /** Drops already-parsed bytes so the buffer doesn't grow to the size of the file. */
  private compact(): void {
    if (this.position === 0) return;
    this.buffer = this.buffer.subarray(this.position);
    this.consumed += this.position;
    this.position = 0;
  }

  private parse(): void {
    while (!this.failed) {
      const start = this.position;
      const id = readVint(this.buffer, this.position, false);
      if (!id) break;

      const size = readVint(this.buffer, this.position + id.length, true);
      if (!size) break;

      const headerLength = id.length + size.length;
      const contentStart = this.position + headerLength;

      // Master elements we care about get descended into rather than
      // buffered whole — notably Segment, which is routinely written with
      // an unknown size and can be gigabytes long.
      if (id.value === ID.Segment) {
        this.segmentDataStart = this.fileOffset + this.consumed + contentStart;
        this.position = contentStart;
        continue;
      }

      if (size.unknown) {
        // Any other unknown-size element would need us to scan for the next
        // sibling ID to find its end. That shape only shows up in live
        // muxing, not in files, so we stop cleanly instead of guessing.
        this.fail("This Matroska stream uses unknown-size elements, which Lumen can't parse.");
        return;
      }

      const contentEnd = contentStart + size.value;

      // Clusters and Tracks are parsed as complete units; wait for the rest.
      if (contentEnd > this.buffer.length) {
        this.position = start;
        this.compact();
        return;
      }

      switch (id.value) {
        case ID.Info:
          this.parseInfo(contentStart, contentEnd);
          break;
        case ID.Tracks:
          this.parseTracks(contentStart, contentEnd);
          break;
        case ID.Cluster:
          this.parseCluster(contentStart, contentEnd);
          break;
        case ID.Cues:
          this.parseCues(contentStart, contentEnd);
          break;
        case ID.SeekHead:
          this.parseSeekHead(contentStart, contentEnd);
          break;
        default:
          break; // Cues, Tags, Chapters, SeekHead, Attachments — skipped
      }

      this.position = contentEnd;
    }

    this.compact();
  }

  private parseInfo(start: number, end: number): void {
    this.forEachChild(start, end, (id, contentStart, length) => {
      if (id === ID.TimestampScale) {
        this.timestampScaleNs = readUint(this.buffer, contentStart, length) || DEFAULT_TIMESTAMP_SCALE_NS;
      } else if (id === ID.Duration) {
        // Stored as a float in TimestampScale ticks, not seconds.
        this.durationTicks = readFloat(this.buffer, contentStart, length);
      }
    });
  }

  private parseTracks(start: number, end: number): void {
    const tracks: MkvTrack[] = [];
    this.forEachChild(start, end, (id, contentStart, length) => {
      if (id !== ID.TrackEntry) return;
      const track = this.parseTrackEntry(contentStart, contentStart + length);
      if (track) tracks.push(track);
    });

    this.tracks = tracks;
    if (!this.tracksEmitted && tracks.length > 0) {
      this.tracksEmitted = true;
      this.onTracks?.(tracks, this.timestampScaleNs);
    }
  }

  private parseTrackEntry(start: number, end: number): MkvTrack | null {
    const track: MkvTrack = { number: 0, type: "other", codecId: "", isDefault: false };

    this.forEachChild(start, end, (id, contentStart, length) => {
      switch (id) {
        case ID.TrackNumber:
          track.number = readUint(this.buffer, contentStart, length);
          break;
        case ID.TrackType:
          track.type = trackTypeFromCode(readUint(this.buffer, contentStart, length));
          break;
        case ID.CodecID:
          track.codecId = readString(this.buffer, contentStart, length);
          break;
        case ID.CodecPrivate:
          track.codecPrivate = this.buffer.slice(contentStart, contentStart + length);
          break;
        case ID.DefaultDuration:
          track.defaultDuration = readUint(this.buffer, contentStart, length);
          break;
        case ID.Language:
          track.language = readString(this.buffer, contentStart, length);
          break;
        case ID.Name:
          track.name = readString(this.buffer, contentStart, length);
          break;
        case ID.FlagDefault:
          track.isDefault = readUint(this.buffer, contentStart, length) === 1;
          break;
        case ID.Video:
          this.forEachChild(contentStart, contentStart + length, (vid, vStart, vLength) => {
            if (vid === ID.PixelWidth) track.width = readUint(this.buffer, vStart, vLength);
            else if (vid === ID.PixelHeight) track.height = readUint(this.buffer, vStart, vLength);
          });
          break;
        case ID.Audio:
          this.forEachChild(contentStart, contentStart + length, (aid, aStart, aLength) => {
            if (aid === ID.SamplingFrequency) track.sampleRate = readFloat(this.buffer, aStart, aLength);
            else if (aid === ID.Channels) track.channels = readUint(this.buffer, aStart, aLength);
            else if (aid === ID.BitDepth) track.bitDepth = readUint(this.buffer, aStart, aLength);
          });
          break;
        default:
          break;
      }
    });

    return track.number > 0 && track.codecId ? track : null;
  }

  /**
   * Reads the Cues index — the table that makes seeking possible without
   * downloading everything before the target.
   */
  private parseCues(start: number, end: number): void {
    const cues: MkvCuePoint[] = [];

    this.forEachChild(start, end, (id, contentStart, length) => {
      if (id !== ID.CuePoint) return;

      let time = -1;
      let clusterPosition = -1;
      this.forEachChild(contentStart, contentStart + length, (cueId, cueStart, cueLength) => {
        if (cueId === ID.CueTime) {
          time = readUint(this.buffer, cueStart, cueLength);
        } else if (cueId === ID.CueTrackPositions) {
          this.forEachChild(cueStart, cueStart + cueLength, (posId, posStart, posLength) => {
            // The first track's position is enough: clusters are shared,
            // so every track in a cue points at the same cluster.
            if (posId === ID.CueClusterPosition && clusterPosition < 0) {
              clusterPosition = readUint(this.buffer, posStart, posLength);
            }
          });
        }
      });

      if (time >= 0 && clusterPosition >= 0) cues.push({ time, clusterPosition });
    });

    if (cues.length === 0) return;
    cues.sort((a, b) => a.time - b.time);
    this.cues = cues;
    this.onCues?.(cues);
  }

  /**
   * Reads a SeekHead to find where Cues lives.
   *
   * Muxers usually write Cues at the *end* of the file, so without this
   * pointer the index would only be discoverable by downloading
   * everything — precisely what the index exists to avoid.
   */
  private parseSeekHead(start: number, end: number): void {
    if (this.cuesLocationReported) return;

    this.forEachChild(start, end, (id, contentStart, length) => {
      if (id !== ID.Seek) return;

      let seekId = 0;
      let seekPosition = -1;
      this.forEachChild(contentStart, contentStart + length, (childId, childStart, childLength) => {
        if (childId === ID.SeekID) {
          seekId = readUint(this.buffer, childStart, childLength);
        } else if (childId === ID.SeekPosition) {
          seekPosition = readUint(this.buffer, childStart, childLength);
        }
      });

      if (seekId === ID.Cues && seekPosition >= 0) {
        this.cuesLocationReported = true;
        this.onCuesLocation?.(this.segmentDataStart + seekPosition);
      }
    });
  }

  get cuePoints(): MkvCuePoint[] {
    return this.cues;
  }

  get segmentStart(): number {
    return this.segmentDataStart;
  }

  private parseCluster(start: number, end: number): void {
    this.forEachChild(start, end, (id, contentStart, length) => {
      switch (id) {
        case ID.Timestamp:
          this.clusterTimestamp = readUint(this.buffer, contentStart, length);
          break;
        case ID.SimpleBlock: {
          const block = this.parseBlock(contentStart, contentStart + length, true);
          if (block) this.onBlock?.(block);
          break;
        }
        case ID.BlockGroup:
          this.parseBlockGroup(contentStart, contentStart + length);
          break;
        default:
          break;
      }
    });
  }

  private parseBlockGroup(start: number, end: number): void {
    let block: MkvBlock | null = null;
    let duration: number | undefined;
    // A BlockGroup with no ReferenceBlock is a keyframe; that's how
    // non-simple blocks express what SimpleBlock puts in a flag bit.
    let hasReference = false;

    this.forEachChild(start, end, (id, contentStart, length) => {
      if (id === ID.Block) {
        block = this.parseBlock(contentStart, contentStart + length, false);
      } else if (id === ID.BlockDuration) {
        duration = readUint(this.buffer, contentStart, length);
      } else if (id === ID.ReferenceBlock) {
        hasReference = true;
      }
    });

    if (block) {
      const resolved = block as MkvBlock;
      resolved.keyframe = !hasReference;
      if (duration !== undefined) resolved.duration = duration;
      this.onBlock?.(resolved);
    }
  }

  private parseBlock(start: number, end: number, isSimple: boolean): MkvBlock | null {
    const trackVint = readVint(this.buffer, start, true);
    if (!trackVint) return null;

    let position = start + trackVint.length;
    if (position + 3 > end) return null;

    // Relative timestamp is a signed 16-bit offset from the cluster's.
    const relative = (this.buffer[position]! << 8) | this.buffer[position + 1]!;
    const signedRelative = relative > 0x7fff ? relative - 0x10000 : relative;
    position += 2;

    const flags = this.buffer[position]!;
    position += 1;

    const lacing = (flags >> 1) & 0x03;
    const frames = this.readLacedFrames(position, end, lacing);
    if (!frames) return null;

    return {
      trackNumber: trackVint.value,
      timestamp: this.clusterTimestamp + signedRelative,
      keyframe: isSimple ? (flags & 0x80) !== 0 : true,
      frames,
    };
  }

  /**
   * Splits a block payload into frames according to its lacing mode.
   * Lacing packs several small frames (typically audio) into one block to
   * save overhead, and AAC in Matroska uses it routinely — skipping it
   * would corrupt the audio of a large share of real files.
   */
  private readLacedFrames(start: number, end: number, lacing: number): Uint8Array[] | null {
    if (lacing === 0) {
      return [this.buffer.slice(start, end)];
    }

    if (start >= end) return null;
    const frameCount = this.buffer[start]! + 1;
    let position = start + 1;
    const sizes: number[] = [];

    if (lacing === 2) {
      // Fixed-size lacing: the remaining bytes divide evenly.
      const total = end - position;
      if (total % frameCount !== 0) return null;
      const size = total / frameCount;
      for (let i = 0; i < frameCount; i++) sizes.push(size);
    } else if (lacing === 1) {
      // Xiph lacing: sizes as runs of 0xFF terminated by a smaller byte.
      for (let i = 0; i < frameCount - 1; i++) {
        let size = 0;
        for (;;) {
          if (position >= end) return null;
          const byte = this.buffer[position]!;
          position += 1;
          size += byte;
          if (byte !== 0xff) break;
        }
        sizes.push(size);
      }
    } else {
      // EBML lacing: first size absolute, the rest signed deltas.
      const first = readVint(this.buffer, position, true);
      if (!first) return null;
      position += first.length;
      sizes.push(first.value);
      let previous = first.value;
      for (let i = 1; i < frameCount - 1; i++) {
        const delta = readSignedVint(this.buffer, position);
        if (!delta) return null;
        position += delta.length;
        previous += delta.value;
        sizes.push(previous);
      }
    }

    const frames: Uint8Array[] = [];
    for (const size of sizes) {
      if (position + size > end) return null;
      frames.push(this.buffer.slice(position, position + size));
      position += size;
    }
    // Every lacing mode but fixed leaves the final frame's size implicit.
    if (lacing !== 2) {
      frames.push(this.buffer.slice(position, end));
    }
    return frames;
  }

  /** Walks the direct children of a master element, invoking `visit` for each. */
  private forEachChild(
    start: number,
    end: number,
    visit: (id: number, contentStart: number, length: number) => void,
  ): void {
    let position = start;
    while (position < end) {
      const id = readVint(this.buffer, position, false);
      if (!id) return;
      const size = readVint(this.buffer, position + id.length, true);
      if (!size) return;

      const contentStart = position + id.length + size.length;
      if (size.unknown) return;
      const contentEnd = contentStart + size.value;
      if (contentEnd > end) return;

      visit(id.value, contentStart, size.value);
      position = MASTER_IDS.has(id.value) && id.value === ID.Segment ? contentStart : contentEnd;
    }
  }
}

function trackTypeFromCode(code: number): MkvTrackType {
  switch (code) {
    case 1:
      return "video";
    case 2:
      return "audio";
    case 17:
      return "subtitle";
    default:
      return "other";
  }
}

function concatBytes(a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}
