/**
 * FLV demuxer.
 *
 * FLV is a thin wrapper: its video tags carry H.264 already in
 * length-prefixed AVCC form with the avcC record delivered as a
 * configuration tag, and its audio tags carry raw AAC with the
 * AudioSpecificConfig delivered the same way. That's exactly the shape MP4
 * wants, so remuxing is a copy — which is why a format the browser buried
 * with Flash is trivially playable again.
 */

export interface FlvTrackConfig {
  kind: "video" | "audio";
  /** avcC record for video, AudioSpecificConfig for audio. */
  codecPrivate: Uint8Array;
  width?: number;
  height?: number;
  channels?: number;
  sampleRate?: number;
}

export interface FlvSample {
  kind: "video" | "audio";
  data: Uint8Array;
  /** Decode timestamp in milliseconds. */
  dts: number;
  /** Presentation timestamp in milliseconds. */
  pts: number;
  keyframe: boolean;
}

const TAG_AUDIO = 8;
const TAG_VIDEO = 9;
const TAG_SCRIPT = 18;

const CODEC_AVC = 7;
const SOUND_FORMAT_AAC = 10;

/** FLV's 4-bit sample-rate field maps to these fixed rates. */
const SOUND_RATES = [5500, 11025, 22050, 44100];

export class FlvDemuxer {
  onVideoConfig?: (config: FlvTrackConfig) => void;
  onAudioConfig?: (config: FlvTrackConfig) => void;
  onSample?: (sample: FlvSample) => void;
  onError?: (message: string) => void;

  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private position = 0;
  private headerParsed = false;
  private failed = false;
  /** Filled from the onMetaData script tag, which precedes the first video tag. */
  private metadata: { width?: number; height?: number; audiochannels?: number; audiosamplerate?: number } = {};

  append(chunk: Uint8Array): void {
    if (this.failed) return;
    this.buffer = this.buffer.length === 0 ? chunk : concat(this.buffer, chunk);
    this.parse();
  }

  flush(): void {
    if (!this.failed) this.parse();
  }

  private fail(message: string): void {
    this.failed = true;
    this.onError?.(message);
  }

  private compact(): void {
    if (this.position === 0) return;
    this.buffer = this.buffer.subarray(this.position);
    this.position = 0;
  }

  private parse(): void {
    if (!this.headerParsed) {
      if (this.buffer.length < 9) return;
      if (this.buffer[0] !== 0x46 || this.buffer[1] !== 0x4c || this.buffer[2] !== 0x56) {
        this.fail("This file isn't a valid FLV.");
        return;
      }
      const dataOffset = readU32(this.buffer, 5);
      this.position = dataOffset;
      this.headerParsed = true;
    }

    for (;;) {
      // Each tag is preceded by the size of the previous one.
      const tagStart = this.position + 4;
      if (tagStart + 11 > this.buffer.length) break;

      const tagType = this.buffer[tagStart]!;
      const dataSize = readU24(this.buffer, tagStart + 1);
      // Timestamps are 24-bit with a separate high byte, giving 32 bits
      // in an oddly split layout.
      const timestamp = readU24(this.buffer, tagStart + 4) | (this.buffer[tagStart + 7]! << 24);

      const bodyStart = tagStart + 11;
      const bodyEnd = bodyStart + dataSize;
      if (bodyEnd > this.buffer.length) break;

      switch (tagType) {
        case TAG_VIDEO:
          this.parseVideoTag(bodyStart, bodyEnd, timestamp);
          break;
        case TAG_AUDIO:
          this.parseAudioTag(bodyStart, bodyEnd, timestamp);
          break;
        case TAG_SCRIPT:
          this.parseScriptTag(bodyStart, bodyEnd);
          break;
        default:
          break;
      }

      this.position = bodyEnd;
    }

    this.compact();
  }

  private parseVideoTag(start: number, end: number, timestamp: number): void {
    if (start + 5 > end) return;

    const header = this.buffer[start]!;
    const frameType = (header >> 4) & 0x0f;
    const codecId = header & 0x0f;
    if (codecId !== CODEC_AVC) return; // Sorenson/VP6 have no MP4 mapping

    const packetType = this.buffer[start + 1]!;
    // Composition offset is a signed 24-bit value: PTS - DTS.
    const compositionTime = signed24(readU24(this.buffer, start + 2));
    const payload = this.buffer.slice(start + 5, end);

    if (packetType === 0) {
      // AVCDecoderConfigurationRecord — byte-for-byte an avcC payload.
      this.onVideoConfig?.({
        kind: "video",
        codecPrivate: payload,
        width: this.metadata.width,
        height: this.metadata.height,
      });
      return;
    }

    if (packetType === 1) {
      this.onSample?.({
        kind: "video",
        data: payload,
        dts: timestamp,
        pts: timestamp + compositionTime,
        keyframe: frameType === 1,
      });
    }
  }

  private parseAudioTag(start: number, end: number, timestamp: number): void {
    if (start + 2 > end) return;

    const header = this.buffer[start]!;
    const soundFormat = (header >> 4) & 0x0f;
    if (soundFormat !== SOUND_FORMAT_AAC) return; // MP3/Nellymoser/etc. skipped

    const packetType = this.buffer[start + 1]!;
    const payload = this.buffer.slice(start + 2, end);

    if (packetType === 0) {
      this.onAudioConfig?.({
        kind: "audio",
        codecPrivate: payload,
        channels: this.metadata.audiochannels ?? ((header & 0x01) === 1 ? 2 : 1),
        sampleRate: this.metadata.audiosamplerate ?? SOUND_RATES[(header >> 2) & 0x03] ?? 44100,
      });
      return;
    }

    this.onSample?.({
      kind: "audio",
      data: payload,
      dts: timestamp,
      pts: timestamp,
      keyframe: true,
    });
  }

  /**
   * Reads the `onMetaData` script tag for dimensions and audio parameters.
   * FLV's AVC config doesn't carry display size, so without this the
   * generated MP4 track header would be 0×0.
   */
  private parseScriptTag(start: number, end: number): void {
    const values = readAmf0Metadata(this.buffer, start, end);
    if (!values) return;
    for (const key of ["width", "height", "audiochannels", "audiosamplerate"] as const) {
      const value = values[key];
      if (typeof value === "number") this.metadata[key] = value;
    }
  }
}

function concat(a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

function readU24(buffer: Uint8Array, position: number): number {
  return (buffer[position]! << 16) | (buffer[position + 1]! << 8) | buffer[position + 2]!;
}

function readU32(buffer: Uint8Array, position: number): number {
  return (
    ((buffer[position]! << 24) | (buffer[position + 1]! << 16) | (buffer[position + 2]! << 8) | buffer[position + 3]!) >>>
    0
  );
}

function signed24(value: number): number {
  return value > 0x7fffff ? value - 0x1000000 : value;
}

/**
 * Reads the numeric properties of an AMF0 `onMetaData` object.
 *
 * Only the shapes that appear in an FLV metadata object are handled —
 * this is a metadata reader, not a general AMF0 decoder.
 */
function readAmf0Metadata(
  buffer: Uint8Array,
  start: number,
  end: number,
): Record<string, number | string | boolean> | null {
  let position = start;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const readString = (): string | null => {
    if (position + 2 > end) return null;
    const length = view.getUint16(position);
    position += 2;
    if (position + length > end) return null;
    let out = "";
    for (let i = 0; i < length; i++) out += String.fromCharCode(buffer[position + i]!);
    position += length;
    return out;
  };

  // The tag begins with the event name ("onMetaData"), then its payload.
  if (position >= end || buffer[position] !== 0x02) return null;
  position += 1;
  if (readString() === null) return null;

  if (position >= end) return null;
  const payloadType = buffer[position]!;
  position += 1;
  // 0x08 = ECMA array (length-prefixed), 0x03 = plain object.
  if (payloadType === 0x08) position += 4;
  else if (payloadType !== 0x03) return null;

  const result: Record<string, number | string | boolean> = {};
  while (position < end) {
    const key = readString();
    if (key === null) break;
    if (position >= end) break;

    const valueType = buffer[position]!;
    position += 1;

    if (valueType === 0x00) {
      if (position + 8 > end) break;
      result[key] = view.getFloat64(position);
      position += 8;
    } else if (valueType === 0x01) {
      if (position >= end) break;
      result[key] = buffer[position] !== 0;
      position += 1;
    } else if (valueType === 0x02) {
      const value = readString();
      if (value === null) break;
      result[key] = value;
    } else if (valueType === 0x09) {
      break; // object end marker
    } else {
      // Nested arrays/objects aren't needed for the fields we read.
      break;
    }
  }

  return result;
}
