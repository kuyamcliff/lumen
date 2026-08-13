import { describe, expect, it } from "vitest";
import { FlvDemuxer, type FlvSample, type FlvTrackConfig } from "../src/remux/flv/FlvDemuxer";
import { fakeAacAsc, fakeAvcC } from "./helpers/mkvBuilder";

/** Builds an FLV tag: type, timestamp, and body, with the required size prefix. */
function tag(type: number, timestamp: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + 11 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0); // previous tag size
  out[4] = type;
  out[5] = (body.length >> 16) & 0xff;
  out[6] = (body.length >> 8) & 0xff;
  out[7] = body.length & 0xff;
  out[8] = (timestamp >> 16) & 0xff;
  out[9] = (timestamp >> 8) & 0xff;
  out[10] = timestamp & 0xff;
  out[11] = (timestamp >> 24) & 0xff;
  out.set(body, 15);
  return out;
}

function videoBody(frameType: number, packetType: number, compositionTime: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = (frameType << 4) | 7; // codecId 7 = AVC
  out[1] = packetType;
  out[2] = (compositionTime >> 16) & 0xff;
  out[3] = (compositionTime >> 8) & 0xff;
  out[4] = compositionTime & 0xff;
  out.set(payload, 5);
  return out;
}

function audioBody(packetType: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + payload.length);
  out[0] = (10 << 4) | (3 << 2) | 0x02 | 0x01; // AAC, 44kHz, 16-bit, stereo
  out[1] = packetType;
  out.set(payload, 2);
  return out;
}

/** An AMF0 `onMetaData` script tag carrying width and height. */
function metadataBody(width: number, height: number): Uint8Array {
  const parts: number[] = [];
  const pushString = (text: string) => {
    parts.push((text.length >> 8) & 0xff, text.length & 0xff);
    for (const char of text) parts.push(char.charCodeAt(0));
  };
  const pushNumber = (value: number) => {
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setFloat64(0, value);
    parts.push(...new Uint8Array(buffer));
  };

  parts.push(0x02);
  pushString("onMetaData");
  parts.push(0x08, 0, 0, 0, 2); // ECMA array with 2 entries
  pushString("width");
  parts.push(0x00);
  pushNumber(width);
  pushString("height");
  parts.push(0x00);
  pushNumber(height);
  parts.push(0, 0, 0x09); // object end
  return new Uint8Array(parts);
}

function buildFlv(tags: Uint8Array[]): Uint8Array {
  const header = new Uint8Array([0x46, 0x4c, 0x56, 0x01, 0x05, 0, 0, 0, 9]);
  const total = tags.reduce((sum, t) => sum + t.length, header.length);
  const out = new Uint8Array(total);
  out.set(header, 0);
  let offset = header.length;
  for (const t of tags) {
    out.set(t, offset);
    offset += t.length;
  }
  return out;
}

function demux(bytes: Uint8Array, chunkSize?: number) {
  const demuxer = new FlvDemuxer();
  const samples: FlvSample[] = [];
  const configs: FlvTrackConfig[] = [];
  const errors: string[] = [];

  demuxer.onVideoConfig = (c) => configs.push(c);
  demuxer.onAudioConfig = (c) => configs.push(c);
  demuxer.onSample = (s) => samples.push(s);
  demuxer.onError = (m) => errors.push(m);

  if (chunkSize) {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      demuxer.append(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
    }
  } else {
    demuxer.append(bytes);
  }
  demuxer.flush();
  return { samples, configs, errors };
}

const frame = (byte: number, length = 16) => new Uint8Array(length).fill(byte);

describe("FlvDemuxer", () => {
  it("extracts the avcC record and AudioSpecificConfig from configuration tags", () => {
    const flv = buildFlv([
      tag(18, 0, metadataBody(1280, 720)),
      tag(9, 0, videoBody(1, 0, 0, fakeAvcC())),
      tag(8, 0, audioBody(0, fakeAacAsc())),
    ]);

    const { configs, errors } = demux(flv);

    expect(errors).toEqual([]);
    expect(configs).toHaveLength(2);

    const video = configs.find((c) => c.kind === "video")!;
    expect(Array.from(video.codecPrivate)).toEqual(Array.from(fakeAvcC()));
    // Dimensions come from the metadata tag — FLV's AVC config has none.
    expect(video.width).toBe(1280);
    expect(video.height).toBe(720);

    const audio = configs.find((c) => c.kind === "audio")!;
    expect(Array.from(audio.codecPrivate)).toEqual(Array.from(fakeAacAsc()));
    expect(audio.channels).toBe(2);
    expect(audio.sampleRate).toBe(44100);
  });

  it("reads sample timestamps and keyframe flags", () => {
    const flv = buildFlv([
      tag(9, 0, videoBody(1, 0, 0, fakeAvcC())),
      tag(9, 0, videoBody(1, 1, 0, frame(0xaa))),
      tag(9, 40, videoBody(2, 1, 0, frame(0xbb))),
    ]);

    const { samples } = demux(flv);

    expect(samples).toHaveLength(2);
    expect(samples[0]).toMatchObject({ kind: "video", dts: 0, pts: 0, keyframe: true });
    expect(samples[1]).toMatchObject({ kind: "video", dts: 40, pts: 40, keyframe: false });
  });

  it("applies the signed composition offset that B-frames need", () => {
    const flv = buildFlv([
      tag(9, 0, videoBody(1, 0, 0, fakeAvcC())),
      tag(9, 100, videoBody(2, 1, 0xffffe2, frame(0xcc))), // -30 as signed 24-bit
      tag(9, 200, videoBody(2, 1, 40, frame(0xdd))),
    ]);

    const { samples } = demux(flv);

    expect(samples[0]!.pts - samples[0]!.dts).toBe(-30);
    expect(samples[1]!.pts - samples[1]!.dts).toBe(40);
  });

  it("interleaves audio and video samples in file order", () => {
    const flv = buildFlv([
      tag(9, 0, videoBody(1, 0, 0, fakeAvcC())),
      tag(8, 0, audioBody(0, fakeAacAsc())),
      tag(9, 0, videoBody(1, 1, 0, frame(0x11))),
      tag(8, 20, audioBody(1, frame(0x22, 8))),
      tag(9, 40, videoBody(2, 1, 0, frame(0x33))),
    ]);

    const { samples } = demux(flv);
    expect(samples.map((s) => s.kind)).toEqual(["video", "audio", "video"]);
  });

  it("skips codecs with no MP4 mapping instead of emitting broken samples", () => {
    // codecId 2 is Sorenson H.263, soundFormat 2 is MP3 — neither belongs
    // in the fragmented MP4 we generate.
    const sorenson = new Uint8Array([0x12, 0x00, 0x00, 0x00, 0x00, 0xaa]);
    const mp3 = new Uint8Array([0x2f, 0x01, 0xbb]);
    const flv = buildFlv([tag(9, 0, sorenson), tag(8, 0, mp3)]);

    const { samples, configs, errors } = demux(flv);
    expect(samples).toEqual([]);
    expect(configs).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("rejects a file that isn't FLV at all", () => {
    const { errors } = demux(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]));
    expect(errors[0]).toContain("isn't a valid FLV");
  });

  it("produces identical output when the file arrives in small chunks", () => {
    const flv = buildFlv([
      tag(9, 0, videoBody(1, 0, 0, fakeAvcC())),
      tag(8, 0, audioBody(0, fakeAacAsc())),
      tag(9, 0, videoBody(1, 1, 0, frame(0x11, 64))),
      tag(9, 40, videoBody(2, 1, 0, frame(0x22, 64))),
      tag(8, 20, audioBody(1, frame(0x33, 32))),
    ]);

    const whole = demux(flv);
    const streamed = demux(flv, 5); // splits mid-tag repeatedly

    expect(streamed.errors).toEqual([]);
    expect(streamed.configs).toHaveLength(whole.configs.length);
    expect(streamed.samples.map((s) => [s.kind, s.dts])).toEqual(whole.samples.map((s) => [s.kind, s.dts]));
  });
});
