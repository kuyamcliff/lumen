import { box, u16, u8, concat } from "../mp4/boxes";

/**
 * H.264 bitstream helpers for containers that carry Annex B.
 *
 * MP4 wants each NAL unit prefixed with its length; AVI (like MPEG-TS and
 * raw `.264` files) carries the Annex B byte stream, where units are
 * separated by `00 00 01` start codes instead. Converting between the two
 * is a rewrite of the framing only — the encoded slices are copied
 * untouched — which is exactly what makes remuxing lossless.
 */

/** NAL unit types that matter to the remuxer. */
const NAL_IDR = 5;
const NAL_SPS = 7;
const NAL_PPS = 8;

/** True when `data` looks like an Annex B byte stream rather than an avcC record. */
export function isAnnexB(data: Uint8Array): boolean {
  if (data.length < 4) return false;
  // An avcC record always starts with configurationVersion = 1 followed by
  // a profile byte; an Annex B stream always starts with a start code.
  if (data[0] === 0 && data[1] === 0 && (data[2] === 1 || (data[2] === 0 && data[3] === 1))) return true;
  return false;
}

/**
 * Splits an Annex B byte stream into NAL units, dropping the start codes.
 *
 * Both the three- and four-byte start-code forms appear in the wild, often
 * in the same file, so the scan handles either.
 */
export function splitAnnexB(data: Uint8Array): Uint8Array[] {
  const units: Uint8Array[] = [];
  let start = -1;
  let i = 0;

  while (i + 2 < data.length) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) {
        // A four-byte start code is a three-byte one with a leading zero,
        // which belongs to the separator rather than the previous unit.
        let end = i;
        if (end > start && data[end - 1] === 0) end--;
        if (end > start) units.push(data.subarray(start, end));
      }
      start = i + 3;
      i += 3;
      continue;
    }
    i++;
  }

  if (start >= 0 && start < data.length) units.push(data.subarray(start));
  return units;
}

/** Type field of a NAL unit header. */
export function nalType(unit: Uint8Array): number {
  return (unit[0] ?? 0) & 0x1f;
}

/** True when this access unit can be decoded without any earlier frame. */
export function containsKeyframe(units: Uint8Array[]): boolean {
  return units.some((unit) => nalType(unit) === NAL_IDR);
}

export interface ParameterSets {
  sps: Uint8Array | null;
  pps: Uint8Array | null;
}

/** Picks the first sequence and picture parameter sets out of a NAL list. */
export function findParameterSets(units: Uint8Array[]): ParameterSets {
  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;
  for (const unit of units) {
    const type = nalType(unit);
    if (type === NAL_SPS && !sps) sps = unit;
    else if (type === NAL_PPS && !pps) pps = unit;
  }
  return { sps, pps };
}

/**
 * Builds an `AVCDecoderConfigurationRecord` from parameter sets.
 *
 * The record's profile/compatibility/level bytes are copied straight out
 * of the SPS, which is where a decoder would read them anyway, and the
 * length size is fixed at 4 bytes to match what `toLengthPrefixed` writes.
 */
export function buildAvcC(sps: Uint8Array, pps: Uint8Array): Uint8Array | null {
  if (sps.length < 4) return null;
  return concat([
    u8(1), // configurationVersion
    u8(sps[1]!), // AVCProfileIndication
    u8(sps[2]!), // profile_compatibility
    u8(sps[3]!), // AVCLevelIndication
    u8(0xff), // 6 reserved bits + lengthSizeMinusOne = 3 (4-byte lengths)
    u8(0xe1), // 3 reserved bits + numOfSequenceParameterSets = 1
    u16(sps.length),
    sps,
    u8(1), // numOfPictureParameterSets
    u16(pps.length),
    pps,
  ]);
}

/** Wraps an avcC record in the `avcC` box a sample entry needs. */
export function avcCBox(record: Uint8Array): Uint8Array {
  return box("avcC", record);
}

/**
 * Rewrites an Annex B access unit as MP4's length-prefixed form.
 *
 * Parameter sets are dropped: MP4 carries them once in the sample entry,
 * and repeating them in every keyframe (which AVI encoders habitually do)
 * makes some decoders reject the stream.
 */
export function toLengthPrefixed(units: Uint8Array[]): Uint8Array {
  const payload = units.filter((unit) => {
    const type = nalType(unit);
    return type !== NAL_SPS && type !== NAL_PPS && unit.length > 0;
  });

  let total = 0;
  for (const unit of payload) total += unit.length + 4;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const unit of payload) {
    view.setUint32(offset, unit.length);
    out.set(unit, offset + 4);
    offset += unit.length + 4;
  }
  return out;
}

/**
 * Reads the NAL length size out of an existing avcC record.
 *
 * Some AVI muxers store an avcC in the stream format header and then write
 * already-length-prefixed samples, so the framing has to be read rather
 * than assumed.
 */
export function nalLengthSizeFromAvcC(record: Uint8Array): number {
  if (record.length < 5) return 4;
  return (record[4]! & 0x03) + 1;
}

/**
 * Re-frames length-prefixed samples to 4-byte lengths.
 *
 * A record declaring 2-byte lengths is legal but not what `buildAvcC`
 * writes, so anything narrower is widened rather than left to mismatch
 * the configuration the browser was given.
 */
export function widenNalLengths(data: Uint8Array, lengthSize: number): Uint8Array {
  if (lengthSize === 4) return data;

  const units: Uint8Array[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  while (offset + lengthSize <= data.length) {
    let length = 0;
    for (let i = 0; i < lengthSize; i++) length = (length << 8) | view.getUint8(offset + i);
    offset += lengthSize;
    if (length <= 0 || offset + length > data.length) break;
    units.push(data.subarray(offset, offset + length));
    offset += length;
  }
  return toLengthPrefixed(units);
}

/** True when a length-prefixed access unit contains an IDR slice. */
export function lengthPrefixedHasKeyframe(data: Uint8Array, lengthSize: number): boolean {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  while (offset + lengthSize < data.length) {
    let length = 0;
    for (let i = 0; i < lengthSize; i++) length = (length << 8) | view.getUint8(offset + i);
    offset += lengthSize;
    if (length <= 0 || offset + length > data.length) break;
    if ((data[offset]! & 0x1f) === NAL_IDR) return true;
    offset += length;
  }
  return false;
}
