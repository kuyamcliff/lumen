/** ISO-BMFF box-writing primitives shared by the muxer and the sample-entry builders. */

export function u8(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

export function u16(value: number): Uint8Array {
  return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
}

export function u32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

export function i32(value: number): Uint8Array {
  return u32(value | 0);
}

/** 64-bit big-endian. Values stay well under 2^53 for any real media timeline, so number math is safe here. */
export function u64(value: number): Uint8Array {
  const high = Math.floor(value / 2 ** 32);
  const low = value >>> 0;
  return new Uint8Array([...u32(high), ...u32(low)]);
}

export function zeros(length: number): Uint8Array {
  return new Uint8Array(length);
}

export function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Builds `[size][type][payload…]`. */
export function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  return concat([u32(body.byteLength + 8), ascii(type), body]);
}

/** Builds a box whose payload starts with the standard version+flags word. */
export function fullBox(type: string, version: number, flags: number, ...payload: Uint8Array[]): Uint8Array {
  return box(type, u8(version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff), ...payload);
}

/** The unity transformation matrix every well-formed mvhd/tkhd carries. */
export const UNITY_MATRIX = concat([
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x40000000),
]);

/** Packs an ISO-639-2 code into the 15-bit form mdhd uses. Falls back to "und" for anything unexpected. */
export function packLanguage(code: string | undefined): Uint8Array {
  const lang = (code ?? "und").toLowerCase().replace(/[^a-z]/g, "").slice(0, 3).padEnd(3, "d");
  const packed =
    (((lang.charCodeAt(0) - 0x60) & 0x1f) << 10) |
    (((lang.charCodeAt(1) - 0x60) & 0x1f) << 5) |
    ((lang.charCodeAt(2) - 0x60) & 0x1f);
  return u16(packed);
}

/**
 * MPEG-4 descriptor length uses a variable-length "expandable" encoding.
 * Most muxers emit the fixed 4-byte form because it keeps offsets stable
 * regardless of payload size; we do the same.
 */
export function descriptor(tag: number, payload: Uint8Array): Uint8Array {
  const length = payload.byteLength;
  return concat([
    u8(tag),
    u8(0x80 | ((length >> 21) & 0x7f), 0x80 | ((length >> 14) & 0x7f), 0x80 | ((length >> 7) & 0x7f), length & 0x7f),
    payload,
  ]);
}

export function toHex(value: number, digits = 2): string {
  return value.toString(16).padStart(digits, "0");
}
