import { describe, expect, it } from "vitest";
import { buildSampleEntry, codecConfigFromMatroska } from "../src/remux/mp4/sampleEntries";
import { fakeAacAsc, fakeAvcC } from "./helpers/mkvBuilder";

function fourccAt(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

function containsBox(bytes: Uint8Array, type: string): boolean {
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (fourccAt(bytes, i) === type) return true;
  }
  return false;
}

describe("codecConfigFromMatroska", () => {
  it("derives an AVC codec string from the profile/compat/level bytes of avcC", () => {
    const config = codecConfigFromMatroska({ codecId: "V_MPEG4/ISO/AVC", codecPrivate: fakeAvcC() });
    expect(config).toMatchObject({ kind: "video", fourcc: "avc1", codecString: "avc1.64001f" });
    expect(containsBox(config!.configBox, "avcC")).toBe(true);
  });

  it("derives an AAC codec string from the AudioSpecificConfig object type", () => {
    const config = codecConfigFromMatroska({ codecId: "A_AAC", codecPrivate: fakeAacAsc() });
    expect(config).toMatchObject({ kind: "audio", fourcc: "mp4a", codecString: "mp4a.40.2" });
    expect(containsBox(config!.configBox, "esds")).toBe(true);
  });

  it("writes VP9 levels in decimal, not hex", () => {
    // Regression: level 21 rendered as hex ("15") produces a codec string
    // browsers reject, and the video track gets silently dropped in favour
    // of audio-only playback. Every field of a VP9 codec string is decimal.
    const config = codecConfigFromMatroska({ codecId: "V_VP9", width: 640, height: 360 });
    expect(config?.codecString).toBe("vp09.00.21.08");
    expect(containsBox(config!.configBox, "vpcC")).toBe(true);
  });

  it("scales the VP9 level with the picture size", () => {
    const level = (width: number, height: number) =>
      codecConfigFromMatroska({ codecId: "V_VP9", width, height })?.codecString;

    expect(level(1280, 720)).toBe("vp09.00.31.08");
    expect(level(1920, 1080)).toBe("vp09.00.40.08");
    expect(level(3840, 2160)).toBe("vp09.00.50.08");
  });

  it("converts an OpusHead into a big-endian dOps box", () => {
    // OpusHead is little-endian; dOps is big-endian. preSkip 312 (0x0138)
    // and sample rate 48000 must come back out byte-swapped.
    const opusHead = new Uint8Array(19);
    opusHead.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // "OpusHead"
    opusHead[8] = 1; // version
    opusHead[9] = 2; // channels
    new DataView(opusHead.buffer).setUint16(10, 312, true);
    new DataView(opusHead.buffer).setUint32(12, 48000, true);

    const config = codecConfigFromMatroska({ codecId: "A_OPUS", codecPrivate: opusHead });
    expect(config).toMatchObject({ kind: "audio", fourcc: "Opus", codecString: "opus" });

    const dops = config!.configBox;
    const view = new DataView(dops.buffer, dops.byteOffset, dops.byteLength);
    expect(dops[8]).toBe(0); // dOps version
    expect(dops[9]).toBe(2); // channel count
    expect(view.getUint16(10)).toBe(312); // big-endian pre-skip
    expect(view.getUint32(12)).toBe(48000);
  });

  it("returns null for codecs no browser can decode, so the track is dropped rather than fatal", () => {
    for (const codecId of ["A_AC3", "A_DTS", "A_TRUEHD", "A_PCM/INT/LIT", "V_MPEG2"]) {
      expect(codecConfigFromMatroska({ codecId }), codecId).toBeNull();
    }
  });

  it("returns null when required CodecPrivate is missing rather than emitting a broken box", () => {
    expect(codecConfigFromMatroska({ codecId: "V_MPEG4/ISO/AVC" })).toBeNull();
    expect(codecConfigFromMatroska({ codecId: "A_AAC" })).toBeNull();
    expect(codecConfigFromMatroska({ codecId: "V_MPEGH/ISO/HEVC", codecPrivate: new Uint8Array(4) })).toBeNull();
  });
});

describe("buildSampleEntry", () => {
  it("builds a VisualSampleEntry carrying the picture size", () => {
    const config = codecConfigFromMatroska({ codecId: "V_MPEG4/ISO/AVC", codecPrivate: fakeAvcC() })!;
    const entry = buildSampleEntry(config, { codecId: "V_MPEG4/ISO/AVC", width: 1920, height: 1080 });

    expect(fourccAt(entry, 4)).toBe("avc1");
    const view = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
    expect(view.getUint16(8 + 24)).toBe(1920); // width, after the 24-byte visual preamble
    expect(view.getUint16(8 + 26)).toBe(1080);
  });

  it("builds an AudioSampleEntry carrying channel count and sample rate", () => {
    const config = codecConfigFromMatroska({ codecId: "A_AAC", codecPrivate: fakeAacAsc() })!;
    const entry = buildSampleEntry(config, { codecId: "A_AAC", channels: 2, sampleRate: 44100 });

    expect(fourccAt(entry, 4)).toBe("mp4a");
    const view = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
    expect(view.getUint16(8 + 16)).toBe(2); // channel count
    expect(view.getUint16(8 + 24)).toBe(44100); // integer part of the 16.16 sample rate
  });
});
