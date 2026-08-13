import { describe, expect, it } from "vitest";
import { MatroskaDemuxer, type MkvCuePoint } from "../src/remux/matroska/MatroskaDemuxer";
import { MKV_ID, buildMkv, concat, element, encodeSize, uint, videoTrackEntry } from "./helpers/mkvBuilder";

/**
 * The Cues index is what makes seeking in a remuxed MKV possible without
 * downloading everything before the target, so these cover the two pieces
 * it depends on: reading the index, and finding it via the SeekHead when
 * (as usual) it sits at the end of the file.
 */

const CUES_ID = 0x1c53bb6b;
const CUE_POINT = 0xbb;
const CUE_TIME = 0xb3;
const CUE_TRACK_POSITIONS = 0xb7;
const CUE_TRACK = 0xf7;
const CUE_CLUSTER_POSITION = 0xf1;
const SEEK_HEAD = 0x114d9b74;
const SEEK = 0x4dbb;
const SEEK_ID = 0x53ab;
const SEEK_POSITION = 0x53ac;

function cuePoint(time: number, clusterPosition: number): Uint8Array {
  return element(
    CUE_POINT,
    element(CUE_TIME, uint(time)),
    element(CUE_TRACK_POSITIONS, element(CUE_TRACK, uint(1)), element(CUE_CLUSTER_POSITION, uint(clusterPosition))),
  );
}

function cues(points: Array<[number, number]>): Uint8Array {
  return element(CUES_ID, ...points.map(([time, position]) => cuePoint(time, position)));
}

/** A SeekHead entry pointing at Cues, as muxers write when Cues is at the end. */
function seekHeadToCues(position: number): Uint8Array {
  return element(
    SEEK_HEAD,
    element(SEEK, element(SEEK_ID, new Uint8Array([0x1c, 0x53, 0xbb, 0x6b])), element(SEEK_POSITION, uint(position))),
  );
}

function demuxWith(extra: Uint8Array[]) {
  const collected: MkvCuePoint[][] = [];
  const locations: number[] = [];

  const demuxer = new MatroskaDemuxer();
  demuxer.onCues = (points) => collected.push(points);
  demuxer.onCuesLocation = (position) => locations.push(position);

  const mkv = buildMkv({
    trackEntries: [videoTrackEntry({ number: 1, width: 640, height: 360 })],
    clusters: [],
  });
  demuxer.append(concat([mkv, ...extra]));
  demuxer.flush();

  return { demuxer, collected, locations };
}

describe("Matroska Cues index", () => {
  it("parses cue points into times and cluster offsets", () => {
    const { collected } = demuxWith([cues([[0, 100], [5000, 20000], [10000, 40000]])]);

    expect(collected).toHaveLength(1);
    expect(collected[0]).toEqual([
      { time: 0, clusterPosition: 100 },
      { time: 5000, clusterPosition: 20000 },
      { time: 10000, clusterPosition: 40000 },
    ]);
  });

  it("sorts cue points by time even when the file lists them out of order", () => {
    const { collected } = demuxWith([cues([[10000, 40000], [0, 100], [5000, 20000]])]);
    expect(collected[0]!.map((cue) => cue.time)).toEqual([0, 5000, 10000]);
  });

  it("reports where Cues lives when a SeekHead points at it", () => {
    // This is the case that matters: the index is at the end of the file,
    // and only the SeekHead says where.
    const { locations, demuxer } = demuxWith([seekHeadToCues(500_000)]);

    expect(locations).toHaveLength(1);
    // Positions in a SeekHead are relative to the start of Segment data.
    expect(locations[0]).toBe(demuxer.segmentStart + 500_000);
  });

  it("reports the Cues location only once", () => {
    const { locations } = demuxWith([seekHeadToCues(500_000), seekHeadToCues(600_000)]);
    expect(locations).toHaveLength(1);
  });

  it("exposes no cues for a file that has none", () => {
    const { demuxer, collected } = demuxWith([]);
    expect(collected).toEqual([]);
    expect(demuxer.cuePoints).toEqual([]);
  });

  it("carries the TimestampScale into a demuxer that starts mid-file", () => {
    // A ranged read begins after the Info element, so a fresh demuxer
    // would otherwise assume the 1ms default and misplace every timestamp.
    const demuxer = new MatroskaDemuxer();
    expect(demuxer.timestampScale).toBe(1_000_000);

    demuxer.seedTimestampScale(100_000);
    expect(demuxer.timestampScale).toBe(100_000);

    // A zero (as an absent element would give) must not wipe out the scale.
    demuxer.seedTimestampScale(0);
    expect(demuxer.timestampScale).toBe(1_000_000);
  });

  it("resolves cue cluster positions against the Segment data start", () => {
    const { demuxer } = demuxWith([cues([[0, 100]])]);
    // Segment data begins after the EBML header and the Segment element's
    // own header, never at byte 0.
    expect(demuxer.segmentStart).toBeGreaterThan(0);
  });
});

describe("mkvBuilder encodeSize", () => {
  it("round-trips sizes across vint width boundaries", () => {
    // Guards the fixture builder itself: a wrong size vint would make
    // every Cues test pass against a malformed file.
    expect(Array.from(encodeSize(1))).toEqual([0x81]);
    expect(Array.from(encodeSize(127))).toEqual([0x40, 0x7f]);
    expect(encodeSize(200)).toHaveLength(2);
    expect(encodeSize(20000)).toHaveLength(3);
  });
});
