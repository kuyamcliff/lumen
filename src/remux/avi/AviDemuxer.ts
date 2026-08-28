/**
 * A streaming RIFF/AVI demuxer.
 *
 * AVI is the format people are most often told is simply impossible on the
 * web. It isn't: the container is a flat list of length-prefixed chunks,
 * the header block sits at the front, and the media inside is ordinary
 * elementary-stream data. What's genuinely impossible is decoding the
 * codecs most AVIs carry (MPEG-4 ASP — DivX and Xvid — which no browser
 * ships), and that limit belongs to the decoder, not the container. So
 * this parses the container properly and lets the codec check decide,
 * which turns "AVI doesn't work" into either playback or a specific,
 * actionable reason.
 *
 * The parse is incremental: bytes arrive from a `fetch` stream and chunks
 * are emitted as soon as they're complete, so playback starts while the
 * file is still downloading.
 */

export type AviStreamKind = "video" | "audio" | "other";

export interface AviStreamInfo {
  index: number;
  kind: AviStreamKind;
  /** `biCompression` for video, or the stream handler fourcc. */
  handler: string;
  /** Timebase numerator: one sample lasts `scale / rate` seconds. */
  scale: number;
  rate: number;
  /** Bytes per sample for constant-rate streams; 0 for frame-based ones. */
  sampleSize: number;
  width?: number;
  height?: number;
  /** WAVEFORMATEX `wFormatTag`, audio only. */
  formatTag?: number;
  channels?: number;
  sampleRate?: number;
  bitsPerSample?: number;
  /** Codec-private bytes following the format structure. */
  extradata?: Uint8Array;
}

export interface AviChunkSample {
  streamIndex: number;
  data: Uint8Array;
  /** Ordinal of this chunk within its stream. */
  chunkIndex: number;
  /** Bytes of this stream emitted before this chunk. */
  streamByteOffset: number;
}

const FOURCC_LIST = 0x4c495354; // "LIST"
const FOURCC_RIFF = 0x52494646; // "RIFF"

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0
  );
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

/** AVI chunk ids are `<2-digit stream><2-char type>`, e.g. `00dc`, `01wb`. */
function parseStreamChunkId(id: string): { stream: number; type: string } | null {
  if (!/^\d\d/.test(id)) return null;
  const stream = Number(id.slice(0, 2));
  if (!Number.isInteger(stream)) return null;
  return { stream, type: id.slice(2).toLowerCase() };
}

/** Chunk types that carry media rather than palettes, text or padding. */
const MEDIA_CHUNK_TYPES = new Set(["dc", "db", "wb", "ac"]);

export class AviDemuxer {
  onStreams?: (streams: AviStreamInfo[]) => void;
  onSample?: (sample: AviChunkSample) => void;
  onError?: (message: string) => void;

  private buffer: Uint8Array = new Uint8Array(0);
  /** Absolute file offset of `buffer[0]`, for skipping past large chunks. */
  private consumed = 0;
  private skipRemaining = 0;
  private riffParsed = false;
  private headerParsed = false;
  private inMovi = false;
  private failed = false;
  private streams: AviStreamInfo[] = [];
  private chunkCounts = new Map<number, number>();
  private byteCounts = new Map<number, number>();

  append(bytes: Uint8Array): void {
    if (this.failed) return;
    if (bytes.byteLength === 0) return;

    if (this.skipRemaining > 0) {
      const skipped = Math.min(this.skipRemaining, bytes.byteLength);
      this.skipRemaining -= skipped;
      bytes = bytes.subarray(skipped);
      this.consumed += skipped;
      if (bytes.byteLength === 0) return;
    }

    this.buffer = this.buffer.byteLength === 0 ? bytes.slice() : concatBytes(this.buffer, bytes);
    this.parse();
  }

  /** Called once the stream ends; nothing is buffered across the end. */
  flush(): void {
    this.parse();
  }

  get streamInfo(): AviStreamInfo[] {
    return this.streams;
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = true;
    this.onError?.(message);
  }

  private parse(): void {
    if (!this.headerParsed && !this.parseHeader()) return;
    if (this.inMovi) this.parseMovi();
  }

  /**
   * Consumes the RIFF header and every top-level chunk before `movi`.
   *
   * Returns false while the header block is still incomplete — the whole
   * `hdrl` list has to be buffered before any stream can be described, but
   * it is only a few hundred bytes.
   */
  private parseHeader(): boolean {
    const buffer = this.buffer;

    // The RIFF preamble is checked once: skipping past a large pre-movi
    // chunk clears the buffer, so on the next pass the bytes at offset 0
    // are ordinary chunks rather than the file header.
    if (!this.riffParsed) {
      if (buffer.byteLength < 12) return false;
      if (u32be(buffer, 0) !== FOURCC_RIFF) {
        this.fail("This file isn't a RIFF/AVI container.");
        return false;
      }
      if (fourcc(buffer, 8) !== "AVI ") {
        this.fail("This RIFF file isn't an AVI.");
        return false;
      }
      this.riffParsed = true;
      this.dropBefore(12);
    }

    let offset = 0;

    while (offset + 8 <= this.buffer.byteLength) {
      const buffer = this.buffer;
      const size = u32le(buffer, offset + 4);
      const padded = size + (size & 1);

      if (u32be(buffer, offset) === FOURCC_LIST) {
        if (offset + 12 > buffer.byteLength) return false;
        const listType = fourcc(buffer, offset + 8);

        if (listType === "movi") {
          // The media list is the rest of the file; step inside it rather
          // than waiting for its (possibly gigabyte-sized) contents.
          this.dropBefore(offset + 12);
          this.headerParsed = true;
          this.inMovi = true;
          this.emitStreams();
          return true;
        }

        if (listType === "hdrl") {
          if (offset + 8 + padded > buffer.byteLength) return false; // wait for the whole header
          this.parseHeaderList(buffer.subarray(offset + 12, offset + 8 + size));
          offset += 8 + padded;
          continue;
        }

        // INFO and friends: skipped whole, once buffered.
        if (offset + 8 + padded > buffer.byteLength) {
          this.dropBefore(offset);
          this.skipRemaining = 8 + padded - this.buffer.byteLength;
          this.buffer = new Uint8Array(0);
          return false;
        }
        offset += 8 + padded;
        continue;
      }

      // A plain chunk before movi (JUNK, and some muxers put idx1-adjacent
      // padding here) — skip it, streaming past it if it's oversized.
      if (offset + 8 + padded > buffer.byteLength) {
        this.dropBefore(offset);
        this.skipRemaining = 8 + padded - this.buffer.byteLength;
        this.buffer = new Uint8Array(0);
        return false;
      }
      offset += 8 + padded;
    }

    this.dropBefore(offset);
    return false;
  }

  /** Walks `hdrl`, collecting one `AviStreamInfo` per `strl` it contains. */
  private parseHeaderList(hdrl: Uint8Array): void {
    let offset = 0;
    while (offset + 8 <= hdrl.byteLength) {
      const size = u32le(hdrl, offset + 4);
      const padded = size + (size & 1);

      if (u32be(hdrl, offset) === FOURCC_LIST && offset + 12 <= hdrl.byteLength) {
        const listType = fourcc(hdrl, offset + 8);
        if (listType === "strl") {
          const stream = this.parseStreamList(hdrl.subarray(offset + 12, Math.min(offset + 8 + size, hdrl.byteLength)));
          if (stream) this.streams.push(stream);
        }
      }
      offset += 8 + padded;
      if (padded === 0) break; // malformed zero-length chunk: stop rather than spin
    }
  }

  /** Reads one stream's `strh` (timing/type) and `strf` (format) chunks. */
  private parseStreamList(strl: Uint8Array): AviStreamInfo | null {
    let header: { kind: AviStreamKind; handler: string; scale: number; rate: number; sampleSize: number } | null = null;
    let format: Uint8Array | null = null;

    let offset = 0;
    while (offset + 8 <= strl.byteLength) {
      const id = fourcc(strl, offset);
      const size = u32le(strl, offset + 4);
      const padded = size + (size & 1);
      const body = strl.subarray(offset + 8, Math.min(offset + 8 + size, strl.byteLength));

      if (id === "strh" && body.byteLength >= 48) {
        const type = fourcc(body, 0);
        header = {
          kind: type === "vids" ? "video" : type === "auds" ? "audio" : "other",
          handler: fourcc(body, 4),
          scale: u32le(body, 20) || 1,
          rate: u32le(body, 24) || 1,
          sampleSize: u32le(body, 44),
        };
      } else if (id === "strf") {
        format = body;
      }

      offset += 8 + padded;
      if (padded === 0) break;
    }

    if (!header) return null;
    const index = this.streams.length;

    if (header.kind === "video" && format && format.byteLength >= 40) {
      // BITMAPINFOHEADER: biSize, biWidth, biHeight, …, biCompression at 16.
      const structureSize = u32le(format, 0);
      return {
        index,
        kind: "video",
        // biCompression is the codec, and it is more reliable than the
        // stream handler, which several muxers leave blank.
        handler: fourcc(format, 16).trim() || header.handler,
        scale: header.scale,
        rate: header.rate,
        sampleSize: header.sampleSize,
        width: u32le(format, 4),
        // A negative height means a bottom-up bitmap; the magnitude is
        // still the picture size.
        height: Math.abs(int32le(format, 8)),
        extradata: structureSize < format.byteLength ? format.subarray(structureSize) : undefined,
      };
    }

    if (header.kind === "audio" && format && format.byteLength >= 16) {
      // WAVEFORMATEX: wFormatTag, nChannels, nSamplesPerSec, nAvgBytesPerSec,
      // nBlockAlign, wBitsPerSample, cbSize.
      const cbSize = format.byteLength >= 18 ? u16le(format, 16) : 0;
      const extradata = cbSize > 0 && format.byteLength >= 18 + cbSize ? format.subarray(18, 18 + cbSize) : undefined;
      return {
        index,
        kind: "audio",
        handler: header.handler,
        scale: header.scale,
        rate: header.rate,
        sampleSize: header.sampleSize,
        formatTag: u16le(format, 0),
        channels: u16le(format, 2),
        sampleRate: u32le(format, 4),
        bitsPerSample: u16le(format, 14),
        extradata,
      };
    }

    return { index, kind: header.kind, handler: header.handler, scale: header.scale, rate: header.rate, sampleSize: header.sampleSize };
  }

  private emitStreams(): void {
    if (this.streams.length === 0) {
      this.fail("This AVI declares no streams.");
      return;
    }
    this.onStreams?.(this.streams);
  }

  /** Emits every complete media chunk currently buffered. */
  private parseMovi(): void {
    const buffer = this.buffer;
    let offset = 0;

    while (offset + 8 <= buffer.byteLength) {
      const id = fourcc(buffer, offset);
      const size = u32le(buffer, offset + 4);
      const padded = size + (size & 1);

      // `rec ` groups bundle the chunks belonging to one frame; they carry
      // no data of their own, so stepping inside is all that's needed.
      if (u32be(buffer, offset) === FOURCC_LIST) {
        if (offset + 12 > buffer.byteLength) break;
        offset += 12;
        continue;
      }

      const stream = parseStreamChunkId(id);
      const isMedia = stream !== null && MEDIA_CHUNK_TYPES.has(stream.type);

      if (!isMedia) {
        // idx1, JUNK, palette changes: skipped, streaming past if oversized.
        if (offset + 8 + padded > buffer.byteLength) {
          this.dropBefore(offset);
          this.skipRemaining = 8 + padded - this.buffer.byteLength;
          this.buffer = new Uint8Array(0);
          return;
        }
        offset += 8 + padded;
        continue;
      }

      if (offset + 8 + size > buffer.byteLength) break; // wait for the rest

      const data = buffer.subarray(offset + 8, offset + 8 + size);
      const index = stream!.stream;
      const chunkIndex = this.chunkCounts.get(index) ?? 0;
      const byteOffset = this.byteCounts.get(index) ?? 0;
      this.chunkCounts.set(index, chunkIndex + 1);
      this.byteCounts.set(index, byteOffset + size);

      // A zero-length chunk is AVI's "dropped frame" marker: it advances
      // the frame counter (and so the timeline) but carries no picture.
      if (size > 0) {
        this.onSample?.({
          streamIndex: index,
          data: data.slice(),
          chunkIndex,
          streamByteOffset: byteOffset,
        });
      }

      offset += 8 + padded;
    }

    this.dropBefore(offset);
  }

  /** Releases bytes the parser is finished with. */
  private dropBefore(offset: number): void {
    if (offset <= 0) return;
    this.consumed += offset;
    this.buffer = this.buffer.subarray(offset).slice();
  }
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0
  );
}

function int32le(bytes: Uint8Array, offset: number): number {
  return u32le(bytes, offset) | 0;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}
