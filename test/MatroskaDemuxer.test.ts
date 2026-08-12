import { describe, expect, it } from "vitest";
import { MatroskaDemuxer, type MkvBlock, type MkvTrack } from "../src/remux/matroska/MatroskaDemuxer";
import {
  MKV_ID,
  audioTrackEntry,
  buildMkv,
  element,
  fakeAvcC,
  simpleBlockPayload,
  uint,
  videoTrackEntry,
} from "./helpers/mkvBuilder";

function demux(bytes: Uint8Array, chunkSize?: number) {
  const demuxer = new MatroskaDemuxer();
  const tracks: MkvTrack[] = [];
  const blocks: MkvBlock[] = [];
  const errors: string[] = [];
  let timestampScale = 0;

  demuxer.onTracks = (t, scale) => {
    tracks.push(...t);
    timestampScale = scale;
  };
  demuxer.onBlock = (b) => blocks.push(b);
  demuxer.onError = (message) => errors.push(message);

  if (chunkSize) {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      demuxer.append(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
    }
  } else {
    demuxer.append(bytes);
  }
  demuxer.flush();

  return { tracks, blocks, errors, timestampScale };
}

const frame = (byte: number, length = 4) => new Uint8Array(length).fill(byte);

describe("MatroskaDemuxer", () => {
  it("parses track metadata from an unknown-size Segment, as real muxers write it", () => {
    const mkv = buildMkv({
      trackEntries: [
        videoTrackEntry({ number: 1, width: 1920, height: 1080 }),
        audioTrackEntry({ number: 2, channels: 2, sampleRate: 48000 }),
      ],
      clusters: [],
    });

    const { tracks, timestampScale, errors } = demux(mkv);

    expect(errors).toEqual([]);
    expect(timestampScale).toBe(1_000_000);
    expect(tracks).toHaveLength(2);

    const [video, audio] = tracks;
    expect(video).toMatchObject({
      number: 1,
      type: "video",
      codecId: "V_MPEG4/ISO/AVC",
      width: 1920,
      height: 1080,
      language: "eng",
    });
    expect(video!.codecPrivate).toEqual(fakeAvcC());
    expect(audio).toMatchObject({ number: 2, type: "audio", codecId: "A_AAC", channels: 2, sampleRate: 48000 });
  });

  it("resolves block timestamps against their cluster", () => {
    const mkv = buildMkv({
      trackEntries: [videoTrackEntry({ number: 1, width: 640, height: 360 })],
      clusters: [
        {
          timestamp: 1000,
          blocks: [
            element(MKV_ID.SimpleBlock, simpleBlockPayload({ track: 1, timestamp: 0, frames: [frame(0xaa)] })),
            element(MKV_ID.SimpleBlock, simpleBlockPayload({ track: 1, timestamp: 40, keyframe: false, frames: [frame(0xbb)] })),
            // Negative relative offsets are legal and appear with B-frames.
            element(MKV_ID.SimpleBlock, simpleBlockPayload({ track: 1, timestamp: -20, keyframe: false, frames: [frame(0xcc)] })),
          ],
        },
      ],
    });

    const { blocks } = demux(mkv);

    expect(blocks.map((b) => b.timestamp)).toEqual([1000, 1040, 980]);
    expect(blocks.map((b) => b.keyframe)).toEqual([true, false, false]);
  });

  it("splits frames for every lacing mode", () => {
    const frames = [frame(0x01, 3), frame(0x02, 3), frame(0x03, 3)];

    for (const lacing of [0, 1, 2, 3] as const) {
      const payloadFrames = lacing === 0 ? [frames[0]!] : frames;
      const mkv = buildMkv({
        trackEntries: [audioTrackEntry({ number: 1, channels: 2, sampleRate: 48000 })],
        clusters: [
          {
            timestamp: 0,
            blocks: [
              element(
                MKV_ID.SimpleBlock,
                simpleBlockPayload({ track: 1, timestamp: 0, lacing, frames: payloadFrames }),
              ),
            ],
          },
        ],
      });

      const { blocks, errors } = demux(mkv);
      expect(errors, `lacing ${lacing}`).toEqual([]);
      expect(blocks, `lacing ${lacing}`).toHaveLength(1);
      expect(blocks[0]!.frames, `lacing ${lacing}`).toHaveLength(payloadFrames.length);
      expect(blocks[0]!.frames.map((f) => Array.from(f)), `lacing ${lacing}`).toEqual(
        payloadFrames.map((f) => Array.from(f)),
      );
    }
  });

  it("treats a BlockGroup without a ReferenceBlock as a keyframe and reads its duration", () => {
    const mkv = buildMkv({
      trackEntries: [videoTrackEntry({ number: 1, width: 640, height: 360 })],
      clusters: [
        {
          timestamp: 0,
          blocks: [
            element(
              MKV_ID.BlockGroup,
              element(MKV_ID.Block, simpleBlockPayload({ track: 1, timestamp: 0, frames: [frame(0xaa)] })),
              element(MKV_ID.BlockDuration, uint(40)),
            ),
            element(
              MKV_ID.BlockGroup,
              element(MKV_ID.Block, simpleBlockPayload({ track: 1, timestamp: 40, frames: [frame(0xbb)] })),
              element(MKV_ID.ReferenceBlock, uint(40)),
            ),
          ],
        },
      ],
    });

    const { blocks } = demux(mkv);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ keyframe: true, duration: 40 });
    expect(blocks[1]!.keyframe).toBe(false);
  });

  it("produces identical output when the file arrives in small network-sized chunks", () => {
    const mkv = buildMkv({
      trackEntries: [videoTrackEntry({ number: 1, width: 640, height: 360 })],
      clusters: [
        { timestamp: 0, blocks: [element(MKV_ID.SimpleBlock, simpleBlockPayload({ track: 1, timestamp: 0, frames: [frame(0xaa, 64)] }))] },
        { timestamp: 500, blocks: [element(MKV_ID.SimpleBlock, simpleBlockPayload({ track: 1, timestamp: 0, frames: [frame(0xbb, 64)] }))] },
      ],
    });

    const whole = demux(mkv);
    const streamed = demux(mkv, 7); // deliberately awkward chunk size, splitting mid-element

    expect(streamed.errors).toEqual([]);
    expect(streamed.tracks).toHaveLength(whole.tracks.length);
    expect(streamed.blocks.map((b) => b.timestamp)).toEqual(whole.blocks.map((b) => b.timestamp));
    expect(streamed.blocks.map((b) => Array.from(b.frames[0]!))).toEqual(
      whole.blocks.map((b) => Array.from(b.frames[0]!)),
    );
  });

  it("honours a non-default TimestampScale", () => {
    const mkv = buildMkv({
      timestampScaleNs: 100_000, // 0.1ms ticks
      trackEntries: [videoTrackEntry({ number: 1, width: 640, height: 360 })],
      clusters: [],
    });

    expect(demux(mkv).timestampScale).toBe(100_000);
  });
});
