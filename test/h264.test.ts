import { describe, expect, it } from "vitest";
import {
  buildAvcC,
  containsKeyframe,
  findParameterSets,
  isAnnexB,
  lengthPrefixedHasKeyframe,
  nalLengthSizeFromAvcC,
  nalType,
  splitAnnexB,
  toLengthPrefixed,
  widenNalLengths,
} from "../src/remux/avi/h264";
import { PPS, SPS, annexB, idrFrame, interFrame } from "./helpers/aviBuilder";

describe("Annex B parsing", () => {
  it("recognises a byte stream by its start code", () => {
    expect(isAnnexB(new Uint8Array([0, 0, 0, 1, 0x67]))).toBe(true);
    expect(isAnnexB(new Uint8Array([0, 0, 1, 0x67, 0x42]))).toBe(true);
    // An avcC record starts with configurationVersion = 1.
    expect(isAnnexB(new Uint8Array([1, 0x42, 0x00, 0x1e]))).toBe(false);
  });

  it("splits units written with either start-code length", () => {
    const stream = new Uint8Array([
      0, 0, 0, 1, 0x67, 0xaa, // four-byte start code
      0, 0, 1, 0x68, 0xbb, 0xcc, // three-byte start code
    ]);
    const units = splitAnnexB(stream);

    expect(units).toHaveLength(2);
    expect(Array.from(units[0]!)).toEqual([0x67, 0xaa]);
    expect(Array.from(units[1]!)).toEqual([0x68, 0xbb, 0xcc]);
  });

  it("does not fold a four-byte start code's leading zero into the previous unit", () => {
    const units = splitAnnexB(annexB(new Uint8Array([0x67, 1, 2]), new Uint8Array([0x68, 3])));
    expect(Array.from(units[0]!)).toEqual([0x67, 1, 2]);
  });

  it("reads NAL types and spots IDR slices", () => {
    expect(nalType(new Uint8Array([0x65]))).toBe(5);
    expect(nalType(new Uint8Array([0x41]))).toBe(1);
    expect(containsKeyframe([interFrame(), idrFrame()])).toBe(true);
    expect(containsKeyframe([interFrame(), interFrame()])).toBe(false);
  });

  it("finds the parameter sets in a mixed access unit", () => {
    const { sps, pps } = findParameterSets(splitAnnexB(annexB(SPS, PPS, idrFrame())));
    expect(sps).not.toBeNull();
    expect(pps).not.toBeNull();
    expect(nalType(sps!)).toBe(7);
    expect(nalType(pps!)).toBe(8);
  });
});

describe("avcC construction", () => {
  it("copies profile, compatibility and level from the SPS", () => {
    const record = buildAvcC(SPS, PPS)!;

    expect(record[0]).toBe(1); // configurationVersion
    expect(record[1]).toBe(SPS[1]); // profile
    expect(record[2]).toBe(SPS[2]); // constraint flags
    expect(record[3]).toBe(SPS[3]); // level
    expect(record[4]! & 0x03).toBe(3); // four-byte NAL lengths
  });

  it("embeds both parameter sets with their lengths", () => {
    const record = buildAvcC(SPS, PPS)!;
    const spsLength = (record[6]! << 8) | record[7]!;

    expect(spsLength).toBe(SPS.length);
    expect(Array.from(record.subarray(8, 8 + SPS.length))).toEqual(Array.from(SPS));

    const ppsCountOffset = 8 + SPS.length;
    expect(record[ppsCountOffset]).toBe(1);
    const ppsLength = (record[ppsCountOffset + 1]! << 8) | record[ppsCountOffset + 2]!;
    expect(ppsLength).toBe(PPS.length);
  });

  it("refuses a truncated SPS rather than writing a bogus record", () => {
    expect(buildAvcC(new Uint8Array([0x67, 0x42]), PPS)).toBeNull();
  });

  it("reads the NAL length size back out of a record", () => {
    expect(nalLengthSizeFromAvcC(buildAvcC(SPS, PPS)!)).toBe(4);
    // lengthSizeMinusOne = 1 means two-byte lengths.
    expect(nalLengthSizeFromAvcC(new Uint8Array([1, 0x42, 0, 0x1e, 0xfd]))).toBe(2);
  });
});

describe("Annex B → length-prefixed conversion", () => {
  it("prefixes each unit with its 32-bit length", () => {
    const idr = idrFrame(10);
    const out = toLengthPrefixed([idr]);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

    expect(view.getUint32(0)).toBe(10);
    expect(out.byteLength).toBe(14);
    expect(out[4]).toBe(0x65);
  });

  it("drops parameter sets, which MP4 carries in the sample entry instead", () => {
    const units = splitAnnexB(annexB(SPS, PPS, idrFrame(8)));
    const out = toLengthPrefixed(units);

    // Only the slice survives: 4 bytes of length plus 8 of payload.
    expect(out.byteLength).toBe(12);
    expect(out[4]).toBe(0x65);
  });

  it("widens narrower NAL lengths to four bytes", () => {
    // Two 2-byte-prefixed units.
    const narrow = new Uint8Array([0, 3, 0x41, 1, 2, 0, 2, 0x41, 9]);
    const wide = widenNalLengths(narrow, 2);
    const view = new DataView(wide.buffer, wide.byteOffset, wide.byteLength);

    expect(view.getUint32(0)).toBe(3);
    expect(view.getUint32(7)).toBe(2);
    expect(wide.byteLength).toBe(13);
  });

  it("leaves already-four-byte framing untouched", () => {
    const data = new Uint8Array([0, 0, 0, 2, 0x41, 7]);
    expect(widenNalLengths(data, 4)).toBe(data);
  });

  it("detects keyframes in length-prefixed data", () => {
    const key = new Uint8Array([0, 0, 0, 2, 0x65, 1]);
    const inter = new Uint8Array([0, 0, 0, 2, 0x41, 1]);

    expect(lengthPrefixedHasKeyframe(key, 4)).toBe(true);
    expect(lengthPrefixedHasKeyframe(inter, 4)).toBe(false);
  });

  it("stops cleanly on a truncated unit instead of reading past the end", () => {
    const truncated = new Uint8Array([0, 0, 0, 99, 0x65, 1, 2]);
    expect(lengthPrefixedHasKeyframe(truncated, 4)).toBe(false);
    expect(widenNalLengths(truncated, 2).byteLength).toBeGreaterThanOrEqual(0);
  });
});
