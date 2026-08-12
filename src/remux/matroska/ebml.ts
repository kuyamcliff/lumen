/** EBML primitives — the variable-length integer encoding Matroska is built on. */

export interface Vint {
  value: number;
  length: number;
  /** True when every value bit is set, EBML's "size unknown" marker. */
  unknown: boolean;
}

/**
 * Reads a variable-length integer.
 *
 * Element IDs keep their leading marker bit (that's part of the ID);
 * sizes strip it. Returns null when the buffer doesn't yet hold the whole
 * integer, which is how the streaming parser knows to wait for more data.
 */
export function readVint(buffer: Uint8Array, position: number, stripMarker: boolean): Vint | null {
  if (position >= buffer.length) return null;

  const first = buffer[position]!;
  if (first === 0) return null; // lengths beyond 8 bytes aren't valid Matroska

  let length = 1;
  let mask = 0x80;
  while (!(first & mask)) {
    mask >>= 1;
    length += 1;
  }
  if (position + length > buffer.length) return null;

  let value = stripMarker ? first & (mask - 1) : first;
  for (let i = 1; i < length; i++) {
    value = value * 256 + buffer[position + i]!;
  }

  const unknown = stripMarker && value === 2 ** (7 * length) - 1;
  return { value, length, unknown };
}

/** Reads an EBML signed variable-length integer, used by EBML lacing for size deltas. */
export function readSignedVint(buffer: Uint8Array, position: number): Vint | null {
  const raw = readVint(buffer, position, true);
  if (!raw) return null;
  return { ...raw, value: raw.value - (2 ** (7 * raw.length - 1) - 1) };
}

/** Reads a big-endian unsigned integer of arbitrary width, as EBML uint elements are stored. */
export function readUint(buffer: Uint8Array, position: number, length: number): number {
  let value = 0;
  for (let i = 0; i < length; i++) {
    value = value * 256 + buffer[position + i]!;
  }
  return value;
}

/** Reads an EBML float element (4 or 8 bytes; other widths are treated as 0). */
export function readFloat(buffer: Uint8Array, position: number, length: number): number {
  const view = new DataView(buffer.buffer, buffer.byteOffset + position, length);
  if (length === 4) return view.getFloat32(0);
  if (length === 8) return view.getFloat64(0);
  return 0;
}

/** Reads an EBML string element, stopping at the first NUL as the spec allows trailing padding. */
export function readString(buffer: Uint8Array, position: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    const byte = buffer[position + i]!;
    if (byte === 0) break;
    out += String.fromCharCode(byte);
  }
  return out;
}

/** Matroska element IDs, with their marker bits intact. */
export const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  DefaultDuration: 0x23e383,
  Language: 0x22b59c,
  Name: 0x536e,
  FlagDefault: 0x88,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  DisplayWidth: 0x54b0,
  DisplayHeight: 0x54ba,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  BitDepth: 0x6264,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  ReferenceBlock: 0xfb,
} as const;

/** Element IDs whose children we descend into rather than skipping over. */
export const MASTER_IDS = new Set<number>([
  ID.Segment,
  ID.Info,
  ID.Tracks,
  ID.TrackEntry,
  ID.Video,
  ID.Audio,
  ID.Cluster,
  ID.BlockGroup,
]);
