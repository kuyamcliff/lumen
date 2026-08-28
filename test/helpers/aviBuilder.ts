/**
 * A minimal RIFF/AVI writer, used to generate test fixtures.
 *
 * Like the Matroska builder next door, this keeps fixtures readable:
 * every test states the stream layout it exercises — in-band vs in-header
 * parameter sets, `rec ` grouping, an index at the tail — instead of
 * hiding it inside an opaque binary blob.
 */

export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function u32le(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff]);
}

export function u16le(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >> 8) & 0xff]);
}

export function fourcc(text: string): Uint8Array {
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** `[id][size][payload]`, word-aligned as RIFF requires. */
export function chunk(id: string, payload: Uint8Array): Uint8Array {
  const padding = payload.byteLength & 1 ? new Uint8Array(1) : new Uint8Array(0);
  return concat([fourcc(id), u32le(payload.byteLength), payload, padding]);
}

/** `LIST` with a type fourcc followed by nested chunks. */
export function list(type: string, ...children: Uint8Array[]): Uint8Array {
  const body = concat([fourcc(type), ...children]);
  return concat([fourcc("LIST"), u32le(body.byteLength), body]);
}

export interface StreamHeaderOptions {
  type: "vids" | "auds";
  handler: string;
  scale: number;
  rate: number;
  sampleSize?: number;
  length?: number;
}

/** An `AVIStreamHeader` (`strh`), all 56 bytes of it. */
export function strh(options: StreamHeaderOptions): Uint8Array {
  return chunk(
    "strh",
    concat([
      fourcc(options.type),
      fourcc(options.handler),
      u32le(0), // dwFlags
      u16le(0), // wPriority
      u16le(0), // wLanguage
      u32le(0), // dwInitialFrames
      u32le(options.scale),
      u32le(options.rate),
      u32le(0), // dwStart
      u32le(options.length ?? 0),
      u32le(0), // dwSuggestedBufferSize
      u32le(0), // dwQuality
      u32le(options.sampleSize ?? 0),
      new Uint8Array(8), // rcFrame
    ]),
  );
}

/** A `BITMAPINFOHEADER` (`strf`) plus any codec extradata. */
export function videoFormat(width: number, height: number, compression: string, extradata?: Uint8Array): Uint8Array {
  const header = concat([
    u32le(40), // biSize
    u32le(width),
    u32le(height),
    u16le(1), // biPlanes
    u16le(24), // biBitCount
    fourcc(compression),
    u32le(width * height * 3), // biSizeImage
    u32le(0),
    u32le(0),
    u32le(0),
    u32le(0),
  ]);
  return chunk("strf", extradata ? concat([header, extradata]) : header);
}

/** A `WAVEFORMATEX` (`strf`) plus any codec extradata. */
export function audioFormat(
  formatTag: number,
  channels: number,
  sampleRate: number,
  bitsPerSample = 16,
  extradata?: Uint8Array,
): Uint8Array {
  const blockAlign = (channels * bitsPerSample) / 8;
  const base = concat([
    u16le(formatTag),
    u16le(channels),
    u32le(sampleRate),
    u32le(sampleRate * blockAlign), // nAvgBytesPerSec
    u16le(blockAlign),
    u16le(bitsPerSample),
    u16le(extradata?.byteLength ?? 0), // cbSize
  ]);
  return chunk("strf", extradata ? concat([base, extradata]) : base);
}

/** The `avih` main header. Only width/height/streams are read back. */
export function avih(width: number, height: number, streams: number, microSecPerFrame = 40000): Uint8Array {
  return chunk(
    "avih",
    concat([
      u32le(microSecPerFrame),
      u32le(0), // dwMaxBytesPerSec
      u32le(0), // dwPaddingGranularity
      u32le(0x10), // dwFlags: AVIF_HASINDEX
      u32le(0), // dwTotalFrames
      u32le(0), // dwInitialFrames
      u32le(streams),
      u32le(0), // dwSuggestedBufferSize
      u32le(width),
      u32le(height),
      new Uint8Array(16), // dwReserved
    ]),
  );
}

export function buildAvi(hdrlChildren: Uint8Array[], moviChildren: Uint8Array[], tail: Uint8Array[] = []): Uint8Array {
  const body = concat([fourcc("AVI "), list("hdrl", ...hdrlChildren), list("movi", ...moviChildren), ...tail]);
  return concat([fourcc("RIFF"), u32le(body.byteLength), body]);
}

// ---------------------------------------------------------------- H.264

/** An Annex B NAL unit with a four-byte start code. */
export function annexB(...units: Uint8Array[]): Uint8Array {
  return concat(units.flatMap((unit) => [new Uint8Array([0, 0, 0, 1]), unit]));
}

/** A baseline-profile SPS: the profile/compat/level bytes are what avcC copies. */
export const SPS = new Uint8Array([0x67, 0x42, 0x00, 0x1e, 0xd9, 0x00, 0xf0, 0x11, 0x7e, 0xf0, 0x11, 0x00, 0x00, 0x03, 0x00, 0x01]);
export const PPS = new Uint8Array([0x68, 0xce, 0x38, 0x80]);

/** An IDR slice — the NAL type that makes a frame a keyframe. */
export function idrFrame(length = 64): Uint8Array {
  const nal = new Uint8Array(length).fill(0x11);
  nal[0] = 0x65;
  return nal;
}

/** A non-IDR slice: decodable only after a keyframe. */
export function interFrame(length = 32): Uint8Array {
  const nal = new Uint8Array(length).fill(0x22);
  nal[0] = 0x41;
  return nal;
}

// ------------------------------------------------------------------ MP3

/**
 * One MPEG-1 Layer III frame: 128 kbit/s, 44.1 kHz, no padding.
 * That works out to 417 bytes carrying 1152 samples.
 */
export function mp3Frame(): Uint8Array {
  const frame = new Uint8Array(417);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x00;
  return frame;
}

export const MP3_FRAME_BYTES = 417;
export const MP3_FRAME_SAMPLES = 1152;
export const MP3_SAMPLE_RATE = 44100;

/** A `00dc`/`01wb`-style media chunk for stream `index`. */
export function mediaChunk(index: number, type: "dc" | "wb", payload: Uint8Array): Uint8Array {
  return chunk(`${String(index).padStart(2, "0")}${type}`, payload);
}
