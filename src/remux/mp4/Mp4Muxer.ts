import {
  UNITY_MATRIX,
  ascii,
  box,
  concat,
  fullBox,
  i32,
  packLanguage,
  u16,
  u32,
  u64,
  u8,
  zeros,
} from "./boxes";

/** A track as it will appear in the generated fragmented MP4. */
export interface MuxTrack {
  id: number;
  kind: "video" | "audio";
  /** Ticks per second for this track's timestamps. */
  timescale: number;
  /** RFC 6381 codec string, used to build the MediaSource MIME type. */
  codecString: string;
  /** Fully built sample entry box (avc1, hvc1, mp4a, Opus, …). */
  sampleEntry: Uint8Array;
  width?: number;
  height?: number;
  language?: string;
}

export interface MuxSample {
  data: Uint8Array;
  /** Decode timestamp, in the track's timescale. */
  dts: number;
  /** Presentation timestamp, in the track's timescale. */
  pts: number;
  duration: number;
  keyframe: boolean;
}

// Sample flags per ISO/IEC 14496-12. A sync sample depends on nothing and
// is not marked "non-sync"; everything else is the inverse.
const SAMPLE_FLAGS_KEY = 0x02000000;
const SAMPLE_FLAGS_NON_KEY = 0x01010000;

const TRUN_DATA_OFFSET = 0x000001;
const TRUN_SAMPLE_DURATION = 0x000100;
const TRUN_SAMPLE_SIZE = 0x000200;
const TRUN_SAMPLE_FLAGS = 0x000400;
const TRUN_SAMPLE_CTS = 0x000800;

/** Timescale for the movie header itself; individual tracks carry their own. */
const MOVIE_TIMESCALE = 1000;

function ftyp(): Uint8Array {
  return box(
    "ftyp",
    ascii("isom"),
    u32(0x200),
    ascii("isom"),
    ascii("iso2"),
    ascii("avc1"),
    ascii("mp41"),
    ascii("iso5"),
    ascii("iso6"),
    ascii("mp42"),
  );
}

function mvhd(nextTrackId: number): Uint8Array {
  return fullBox(
    "mvhd",
    0,
    0,
    u32(0), // creation time
    u32(0), // modification time
    u32(MOVIE_TIMESCALE),
    u32(0), // duration — 0, because a fragmented file's length isn't known up front
    u32(0x00010000), // rate 1.0
    u16(0x0100), // volume 1.0
    zeros(10),
    UNITY_MATRIX,
    zeros(24), // pre_defined
    u32(nextTrackId),
  );
}

function tkhd(track: MuxTrack): Uint8Array {
  const isVideo = track.kind === "video";
  return fullBox(
    "tkhd",
    0,
    0x7, // enabled | in movie | in preview
    u32(0),
    u32(0),
    u32(track.id),
    zeros(4),
    u32(0), // duration
    zeros(8),
    u16(0), // layer
    u16(0), // alternate group
    u16(isVideo ? 0 : 0x0100), // volume
    zeros(2),
    UNITY_MATRIX,
    u32(isVideo ? (track.width ?? 0) << 16 : 0), // 16.16 fixed point
    u32(isVideo ? (track.height ?? 0) << 16 : 0),
  );
}

function mdhd(track: MuxTrack): Uint8Array {
  return fullBox(
    "mdhd",
    0,
    0,
    u32(0),
    u32(0),
    u32(track.timescale),
    u32(0), // duration
    packLanguage(track.language),
    u16(0),
  );
}

function hdlr(track: MuxTrack): Uint8Array {
  const handler = track.kind === "video" ? "vide" : "soun";
  const name = track.kind === "video" ? "VideoHandler" : "SoundHandler";
  return fullBox("hdlr", 0, 0, u32(0), ascii(handler), zeros(12), ascii(name), u8(0));
}

function dinf(): Uint8Array {
  // A single self-contained data reference: sample data lives in this file.
  return box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)));
}

function stbl(track: MuxTrack): Uint8Array {
  return box(
    "stbl",
    fullBox("stsd", 0, 0, u32(1), track.sampleEntry),
    // The sample tables stay empty — every sample is described in a moof.
    fullBox("stts", 0, 0, u32(0)),
    fullBox("stsc", 0, 0, u32(0)),
    fullBox("stsz", 0, 0, u32(0), u32(0)),
    fullBox("stco", 0, 0, u32(0)),
  );
}

function minf(track: MuxTrack): Uint8Array {
  const header =
    track.kind === "video"
      ? fullBox("vmhd", 0, 1, u16(0), zeros(6))
      : fullBox("smhd", 0, 0, u16(0), u16(0));
  return box("minf", header, dinf(), stbl(track));
}

function trak(track: MuxTrack): Uint8Array {
  return box("trak", tkhd(track), box("mdia", mdhd(track), hdlr(track), minf(track)));
}

function trex(track: MuxTrack): Uint8Array {
  return fullBox(
    "trex",
    0,
    0,
    u32(track.id),
    u32(1), // default_sample_description_index
    u32(0),
    u32(0),
    u32(0),
  );
}

/**
 * Builds the initialization segment (`ftyp` + `moov`) describing every
 * track. This is what a SourceBuffer must receive before any media data.
 */
export function buildInitSegment(tracks: MuxTrack[]): Uint8Array {
  const maxId = tracks.reduce((max, t) => Math.max(max, t.id), 0);
  const moov = box(
    "moov",
    mvhd(maxId + 1),
    ...tracks.map(trak),
    box("mvex", ...tracks.map(trex)),
  );
  return concat([ftyp(), moov]);
}

/**
 * Builds one media segment (`moof` + `mdat`) for a single track.
 *
 * Composition offsets are written with trun version 1 (signed), which is
 * what makes B-frame reordering work: with DTS derived from sorted PTS,
 * some samples legitimately need a negative offset, and the version 0 box
 * can only express unsigned ones.
 */
export function buildMediaSegment(
  track: MuxTrack,
  samples: MuxSample[],
  sequenceNumber: number,
): Uint8Array {
  if (samples.length === 0) return new Uint8Array(0);

  const baseMediaDecodeTime = samples[0]!.dts;

  const sampleRows = samples.map((sample) =>
    concat([
      u32(sample.duration),
      u32(sample.data.byteLength),
      u32(sample.keyframe ? SAMPLE_FLAGS_KEY : SAMPLE_FLAGS_NON_KEY),
      i32(sample.pts - sample.dts),
    ]),
  );

  const trunFlags =
    TRUN_DATA_OFFSET | TRUN_SAMPLE_DURATION | TRUN_SAMPLE_SIZE | TRUN_SAMPLE_FLAGS | TRUN_SAMPLE_CTS;

  const trun = fullBox(
    "trun",
    1,
    trunFlags,
    u32(samples.length),
    i32(0), // data_offset — patched below, once the moof size is known
    ...sampleRows,
  );

  // 0x020000 = default-base-is-moof, so data_offset is relative to the
  // start of this moof rather than the start of the file.
  const tfhd = fullBox("tfhd", 0, 0x020000, u32(track.id));
  const tfdt = fullBox("tfdt", 1, 0, u64(baseMediaDecodeTime));
  const traf = box("traf", tfhd, tfdt, trun);
  const mfhd = fullBox("mfhd", 0, 0, u32(sequenceNumber));
  const moof = box("moof", mfhd, traf);

  // Walk to the data_offset field: moof header + mfhd + traf header +
  // tfhd + tfdt + trun header + version/flags + sample_count.
  const dataOffsetPosition =
    8 + mfhd.byteLength + 8 + tfhd.byteLength + tfdt.byteLength + 8 + 4 + 4;
  const dataOffset = moof.byteLength + 8; // mdat payload starts after its header
  moof.set(u32(dataOffset), dataOffsetPosition);

  const mdat = box("mdat", ...samples.map((sample) => sample.data));
  return concat([moof, mdat]);
}

/** Assembles the MediaSource MIME type for a set of tracks. */
export function buildMimeType(tracks: MuxTrack[]): string {
  const codecs = tracks.map((track) => track.codecString).filter(Boolean);
  return `video/mp4; codecs="${codecs.join(",")}"`;
}
