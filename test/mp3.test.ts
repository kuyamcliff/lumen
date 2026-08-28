import { describe, expect, it } from "vitest";
import { countMp3Samples, findFirstMp3Frame, parseMp3Header } from "../src/remux/avi/mp3";
import { MP3_FRAME_BYTES, MP3_FRAME_SAMPLES, MP3_SAMPLE_RATE, concat, mp3Frame } from "./helpers/aviBuilder";

describe("MPEG audio frame headers", () => {
  it("reads an MPEG-1 Layer III frame", () => {
    const header = parseMp3Header(mp3Frame())!;

    expect(header.sampleRate).toBe(MP3_SAMPLE_RATE);
    expect(header.samplesPerFrame).toBe(MP3_FRAME_SAMPLES);
    expect(header.frameLength).toBe(MP3_FRAME_BYTES);
    expect(header.bitrateKbps).toBe(128);
    expect(header.channels).toBe(2);
  });

  it("halves the sample count for MPEG-2 Layer III", () => {
    // 0xF3 = MPEG-2 (version bits 10), Layer III; 0x90 keeps bitrate index 9
    // and sample-rate index 0, which is 22050 Hz on MPEG-2.
    const frame = new Uint8Array([0xff, 0xf3, 0x90, 0x00]);
    const header = parseMp3Header(frame)!;

    expect(header.sampleRate).toBe(22050);
    expect(header.samplesPerFrame).toBe(576);
  });

  it("accounts for the padding bit in the frame length", () => {
    const unpadded = parseMp3Header(new Uint8Array([0xff, 0xfb, 0x90, 0x00]))!;
    const padded = parseMp3Header(new Uint8Array([0xff, 0xfb, 0x92, 0x00]))!;

    expect(padded.frameLength).toBe(unpadded.frameLength + 1);
  });

  it("rejects reserved and free-format headers rather than guessing", () => {
    expect(parseMp3Header(new Uint8Array([0xff, 0xfb, 0x00, 0x00]))).toBeNull(); // bitrate index 0
    expect(parseMp3Header(new Uint8Array([0xff, 0xfb, 0xf0, 0x00]))).toBeNull(); // bitrate index 15
    expect(parseMp3Header(new Uint8Array([0xff, 0xfb, 0x9c, 0x00]))).toBeNull(); // sample-rate index 3
    expect(parseMp3Header(new Uint8Array([0xff, 0xeb, 0x90, 0x00]))).toBeNull(); // reserved version
    expect(parseMp3Header(new Uint8Array([0xff, 0xf9, 0x90, 0x00]))).toBeNull(); // reserved layer
  });

  it("rejects anything without the sync word", () => {
    expect(parseMp3Header(new Uint8Array([0x00, 0x00, 0x00, 0x00]))).toBeNull();
    expect(parseMp3Header(new Uint8Array([0xff, 0x0b, 0x90, 0x00]))).toBeNull();
  });
});

describe("frame scanning", () => {
  it("finds a frame that doesn't start at offset zero", () => {
    const padded = concat([new Uint8Array([0x49, 0x44, 0x33, 0x04]), mp3Frame(), mp3Frame()]);
    const found = findFirstMp3Frame(padded)!;

    expect(found.offset).toBe(4);
    expect(found.frameLength).toBe(MP3_FRAME_BYTES);
  });

  it("ignores a false sync that isn't followed by another frame", () => {
    // A lone 0xFF 0xFB pair inside data, with nothing a frame-length later.
    const noise = new Uint8Array(64).fill(0x33);
    noise[10] = 0xff;
    noise[11] = 0xfb;
    noise[12] = 0x90;
    noise[13] = 0x00;
    // The buffer is shorter than one frame, so the "or we ran out of data"
    // branch would accept it; padding past a frame length removes that out.
    const padded = concat([noise, new Uint8Array(1024)]);

    expect(findFirstMp3Frame(padded)).toBeNull();
  });

  it("counts the samples in a run of frames", () => {
    const counted = countMp3Samples(concat([mp3Frame(), mp3Frame(), mp3Frame()]))!;

    expect(counted.sampleRate).toBe(MP3_SAMPLE_RATE);
    expect(counted.samples).toBe(MP3_FRAME_SAMPLES * 3);
  });

  it("returns null for data with no frames in it at all", () => {
    expect(countMp3Samples(new Uint8Array(512).fill(0x7f))).toBeNull();
  });
});
