/**
 * A minimal Matroska writer, used to generate test fixtures.
 *
 * Building MKVs in-process rather than committing binary fixtures keeps
 * the tests readable — each one states exactly which structures it
 * exercises (lacing mode, track layout, block type) instead of hiding
 * that inside an opaque file.
 */

/** Encodes an EBML element ID, which carries its own length in its leading bits. */
function encodeId(id: number): Uint8Array {
  const bytes: number[] = [];
  let value = id;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value = Math.floor(value / 256);
  }
  return new Uint8Array(bytes);
}

/** Encodes a size as an EBML variable-length integer. */
export function encodeSize(size: number, forcedLength?: number): Uint8Array {
  let length = forcedLength ?? 1;
  if (forcedLength === undefined) {
    while (size >= 2 ** (7 * length) - 1) length += 1;
  }
  const bytes = new Uint8Array(length);
  let remaining = size;
  for (let i = length - 1; i >= 0; i--) {
    bytes[i] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  bytes[0] = bytes[0]! | (0x80 >> (length - 1));
  return bytes;
}

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

export function element(id: number, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  return concat([encodeId(id), encodeSize(body.byteLength), body]);
}

/** An element written with an explicitly unknown size, as real muxers do for Segment. */
export function unknownSizeElement(id: number, ...payload: Uint8Array[]): Uint8Array {
  return concat([encodeId(id), new Uint8Array([0xff]), concat(payload)]);
}

export function uint(value: number, width?: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  do {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  } while (remaining > 0);
  while (width !== undefined && bytes.length < width) bytes.unshift(0);
  return new Uint8Array(bytes);
}

export function float64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value);
  return out;
}

export function str(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/** A syntactically valid avcC record (High profile, level 3.1) with stub parameter sets. */
export function fakeAvcC(): Uint8Array {
  const sps = new Uint8Array([0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40]);
  const pps = new Uint8Array([0x68, 0xeb, 0xe3, 0xcb]);
  return concat([
    new Uint8Array([0x01, 0x64, 0x00, 0x1f, 0xff, 0xe1]),
    new Uint8Array([(sps.length >> 8) & 0xff, sps.length & 0xff]),
    sps,
    new Uint8Array([0x01]),
    new Uint8Array([(pps.length >> 8) & 0xff, pps.length & 0xff]),
    pps,
  ]);
}

/** AudioSpecificConfig for AAC-LC, 48kHz, stereo. */
export function fakeAacAsc(): Uint8Array {
  return new Uint8Array([0x11, 0x90]);
}

export const MKV_ID = {
  EBML: 0x1a45dfa3,
  DocType: 0x4282,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  DefaultDuration: 0x23e383,
  Language: 0x22b59c,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  ReferenceBlock: 0xfb,
} as const;

export interface BlockOptions {
  track: number;
  timestamp: number;
  keyframe?: boolean;
  /** 0 = none, 1 = Xiph, 2 = fixed, 3 = EBML. */
  lacing?: 0 | 1 | 2 | 3;
  frames: Uint8Array[];
}

/** Builds a SimpleBlock payload, encoding frames with the requested lacing mode. */
export function simpleBlockPayload(options: BlockOptions): Uint8Array {
  const { track, timestamp, keyframe = true, lacing = 0, frames } = options;
  const flags = (keyframe ? 0x80 : 0x00) | (lacing << 1);
  const header = concat([
    encodeSize(track),
    new Uint8Array([(timestamp >> 8) & 0xff, timestamp & 0xff]),
    new Uint8Array([flags]),
  ]);

  if (lacing === 0) return concat([header, ...frames]);

  const parts: Uint8Array[] = [header, new Uint8Array([frames.length - 1])];

  if (lacing === 2) {
    // Fixed lacing carries no size table; every frame must be equal length.
    return concat([...parts, ...frames]);
  }

  if (lacing === 1) {
    for (let i = 0; i < frames.length - 1; i++) {
      let size = frames[i]!.byteLength;
      const bytes: number[] = [];
      while (size >= 255) {
        bytes.push(255);
        size -= 255;
      }
      bytes.push(size);
      parts.push(new Uint8Array(bytes));
    }
    return concat([...parts, ...frames]);
  }

  // EBML lacing: first size absolute, then signed deltas.
  parts.push(encodeSize(frames[0]!.byteLength));
  for (let i = 1; i < frames.length - 1; i++) {
    const delta = frames[i]!.byteLength - frames[i - 1]!.byteLength;
    // Signed EBML vint, written in the 1-byte form the tests stay within.
    parts.push(new Uint8Array([0x80 | ((delta + 63) & 0x7f)]));
  }
  return concat([...parts, ...frames]);
}

export interface VideoTrackSpec {
  number: number;
  width: number;
  height: number;
  codecId?: string;
  codecPrivate?: Uint8Array;
  defaultDurationNs?: number;
}

export interface AudioTrackSpec {
  number: number;
  channels: number;
  sampleRate: number;
  codecId?: string;
  codecPrivate?: Uint8Array;
}

export function videoTrackEntry(spec: VideoTrackSpec): Uint8Array {
  return element(
    MKV_ID.TrackEntry,
    element(MKV_ID.TrackNumber, uint(spec.number)),
    element(MKV_ID.TrackType, uint(1)),
    element(MKV_ID.CodecID, str(spec.codecId ?? "V_MPEG4/ISO/AVC")),
    element(MKV_ID.CodecPrivate, spec.codecPrivate ?? fakeAvcC()),
    element(MKV_ID.DefaultDuration, uint(spec.defaultDurationNs ?? 41_666_667)),
    element(MKV_ID.Language, str("eng")),
    element(
      MKV_ID.Video,
      element(MKV_ID.PixelWidth, uint(spec.width)),
      element(MKV_ID.PixelHeight, uint(spec.height)),
    ),
  );
}

export function audioTrackEntry(spec: AudioTrackSpec): Uint8Array {
  return element(
    MKV_ID.TrackEntry,
    element(MKV_ID.TrackNumber, uint(spec.number)),
    element(MKV_ID.TrackType, uint(2)),
    element(MKV_ID.CodecID, str(spec.codecId ?? "A_AAC")),
    element(MKV_ID.CodecPrivate, spec.codecPrivate ?? fakeAacAsc()),
    element(
      MKV_ID.Audio,
      element(MKV_ID.SamplingFrequency, float64(spec.sampleRate)),
      element(MKV_ID.Channels, uint(spec.channels)),
    ),
  );
}

export interface MkvSpec {
  docType?: string;
  timestampScaleNs?: number;
  trackEntries: Uint8Array[];
  clusters: Array<{ timestamp: number; blocks: Uint8Array[] }>;
  /** Real muxers usually write Segment with an unknown size; default true. */
  unknownSizeSegment?: boolean;
}

export function buildMkv(spec: MkvSpec): Uint8Array {
  const header = element(MKV_ID.EBML, element(MKV_ID.DocType, str(spec.docType ?? "matroska")));

  const info = element(
    MKV_ID.Info,
    element(MKV_ID.TimestampScale, uint(spec.timestampScaleNs ?? 1_000_000)),
  );
  const tracks = element(MKV_ID.Tracks, ...spec.trackEntries);
  const clusters = spec.clusters.map((cluster) =>
    element(MKV_ID.Cluster, element(MKV_ID.Timestamp, uint(cluster.timestamp)), ...cluster.blocks),
  );

  const segmentChildren = [info, tracks, ...clusters];
  const segment =
    spec.unknownSizeSegment === false
      ? element(MKV_ID.Segment, ...segmentChildren)
      : unknownSizeElement(MKV_ID.Segment, ...segmentChildren);

  return concat([header, segment]);
}
