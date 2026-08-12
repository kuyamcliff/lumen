import { box, concat, descriptor, fullBox, toHex, u16, u32, u8, zeros } from "./boxes";

/**
 * Translates a source track's codec into the MP4 sample entry and RFC 6381
 * codec string that MediaSource needs.
 *
 * The codec string matters as much as the box: `MediaSource.isTypeSupported`
 * is what tells us, before we waste any work, whether the browser can
 * actually decode this stream — which is the line between "container we can
 * remux" and "codec nobody here can play".
 */
export interface CodecConfig {
  kind: "video" | "audio";
  /** Sample entry fourcc, e.g. "avc1". */
  fourcc: string;
  codecString: string;
  /** Codec configuration box embedded in the sample entry (avcC/hvcC/esds/…). */
  configBox: Uint8Array;
}

export interface SourceTrackInfo {
  codecId: string;
  codecPrivate?: Uint8Array;
  width?: number;
  height?: number;
  channels?: number;
  sampleRate?: number;
  bitDepth?: number;
}

/** Builds `avc1.PPCCLL` from the profile/compat/level bytes of an avcC record. */
function avcCodecString(avcC: Uint8Array): string {
  if (avcC.length < 4) return "avc1.42e01e";
  return `avc1.${toHex(avcC[1]!)}${toHex(avcC[2]!)}${toHex(avcC[3]!)}`;
}

/** Reverses the low `width` bits of a value — HEVC codec strings encode the compatibility flags bit-reversed. */
function reverseBits(value: number, width: number): number {
  let out = 0;
  for (let i = 0; i < width; i++) {
    out = (out << 1) | ((value >>> i) & 1);
  }
  return out >>> 0;
}

/** Builds an `hvc1.…` codec string from an hvcC record, per ISO/IEC 14496-15 Annex E. */
function hevcCodecString(hvcC: Uint8Array): string {
  if (hvcC.length < 13) return "hvc1.1.6.L93.B0";

  const profileSpace = (hvcC[1]! >> 6) & 0x03;
  const tierFlag = (hvcC[1]! >> 5) & 0x01;
  const profileIdc = hvcC[1]! & 0x1f;
  const compatFlags = ((hvcC[2]! << 24) | (hvcC[3]! << 16) | (hvcC[4]! << 8) | hvcC[5]!) >>> 0;
  const levelIdc = hvcC[12]!;

  const spacePrefix = ["", "A", "B", "C"][profileSpace] ?? "";
  const compat = reverseBits(compatFlags, 32).toString(16).replace(/0+$/, "") || "0";

  // Constraint bytes, trailing zeros trimmed, each written as its own field.
  const constraints: string[] = [];
  for (let i = 11; i >= 6; i--) {
    if (hvcC[i] !== 0 || constraints.length > 0) constraints.unshift(toHex(hvcC[i]!));
  }

  const tail = constraints.length > 0 ? `.${constraints.join(".")}` : "";
  return `hvc1.${spacePrefix}${profileIdc}.${compat}.${tierFlag ? "H" : "L"}${levelIdc}${tail}`;
}

/**
 * Wraps an AudioSpecificConfig in the descriptor chain an `esds` box needs.
 * objectTypeIndication 0x40 is "MPEG-4 audio"; streamType 0x15 is an audio
 * stream that isn't upstream.
 */
function buildEsds(audioSpecificConfig: Uint8Array, objectTypeIndication = 0x40): Uint8Array {
  const decoderSpecific = descriptor(0x05, audioSpecificConfig);
  const decoderConfig = descriptor(
    0x04,
    concat([
      u8(objectTypeIndication),
      u8(0x15),
      u8(0, 0, 0), // buffer size
      u32(0), // max bitrate
      u32(0), // average bitrate
      decoderSpecific,
    ]),
  );
  const slConfig = descriptor(0x06, u8(0x02));
  const es = descriptor(0x03, concat([u16(0), u8(0), decoderConfig, slConfig]));
  return fullBox("esds", 0, 0, es);
}

/** Reads the AAC audio object type out of an AudioSpecificConfig, including the 5-bit escape form. */
function aacObjectType(asc: Uint8Array): number {
  if (asc.length === 0) return 2;
  const first = (asc[0]! >> 3) & 0x1f;
  if (first !== 31) return first;
  if (asc.length < 2) return 2;
  return 32 + (((asc[0]! & 0x07) << 3) | (asc[1]! >> 5));
}

/**
 * Converts an `OpusHead` block (Matroska's CodecPrivate for Opus) into the
 * `dOps` box MP4 uses. The fields are the same, but OpusHead is
 * little-endian and carries an 8-byte magic that dOps drops.
 */
function buildDops(opusHead: Uint8Array): Uint8Array | null {
  if (opusHead.length < 19) return null;
  const view = new DataView(opusHead.buffer, opusHead.byteOffset, opusHead.byteLength);
  const channelCount = opusHead[9]!;
  const preSkip = view.getUint16(10, true);
  const inputSampleRate = view.getUint32(12, true);
  const outputGain = view.getInt16(16, true);
  const mappingFamily = opusHead[18]!;

  const parts: Uint8Array[] = [
    u8(0), // dOps version
    u8(channelCount),
    u16(preSkip),
    u32(inputSampleRate),
    u16(outputGain & 0xffff),
    u8(mappingFamily),
  ];

  if (mappingFamily !== 0 && opusHead.length >= 21 + channelCount) {
    parts.push(opusHead.subarray(19, 21 + channelCount));
  }

  return box("dOps", ...parts);
}

/**
 * Picks a VP9 level from the picture size.
 *
 * Matroska normally stores no CodecPrivate for VP9, so the `vpcC` box has
 * to be synthesized. Level is a decoder-capability hint derived from
 * resolution and frame rate; resolution alone puts it in the right band,
 * and decoders treat it as advisory.
 */
function vp9Level(width: number, height: number): number {
  const samples = width * height;
  if (samples <= 0) return 10;
  if (samples <= 36864) return 10; // 176x144
  if (samples <= 122880) return 20; // 320x240
  if (samples <= 245760) return 21; // 640x360
  if (samples <= 552960) return 30; // 960x540
  if (samples <= 983040) return 31; // 1280x720
  if (samples <= 2228224) return 40; // 1920x1080
  if (samples <= 8912896) return 50; // 4096x2176
  return 51;
}

/**
 * Builds a `vpcC` box for VP9.
 *
 * Profile 0 (8-bit 4:2:0) covers the overwhelming majority of VP9 in the
 * wild; the colour fields are written as "unspecified" rather than guessed,
 * which leaves the decoder to use the values carried in the bitstream.
 */
function buildVpcC(width: number, height: number): Uint8Array {
  return fullBox(
    "vpcC",
    1,
    0,
    u8(0), // profile
    u8(vp9Level(width, height)),
    u8((8 << 4) | (1 << 1) | 0), // 8-bit, 4:2:0 colocated, limited range
    u8(2), // colour primaries: unspecified
    u8(2), // transfer characteristics: unspecified
    u8(2), // matrix coefficients: unspecified
    u16(0), // no codec initialization data
  );
}

/** Wraps a FLAC STREAMINFO block in the `dfLa` box, as a last (0x80) metadata block of type 0. */
function buildDfla(streamInfo: Uint8Array): Uint8Array {
  const length = streamInfo.byteLength;
  return fullBox(
    "dfLa",
    0,
    0,
    u8(0x80, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff),
    streamInfo,
  );
}

/**
 * Maps a Matroska CodecID to an MP4 codec configuration.
 *
 * Returns null for codecs that have no meaningful MP4 mapping or that no
 * browser can decode (AC-3, DTS, TrueHD, MPEG-2 video, …). Callers treat
 * that as "drop this track", not as a failure — dropping an undecodable
 * audio track and playing the video is far better than refusing the file.
 */
export function codecConfigFromMatroska(track: SourceTrackInfo): CodecConfig | null {
  const codecId = track.codecId.toUpperCase();
  const priv = track.codecPrivate;

  // --- video ---

  if (codecId === "V_MPEG4/ISO/AVC") {
    if (!priv || priv.length < 4) return null;
    // Matroska stores the avcC record verbatim as CodecPrivate, and the
    // frames are already length-prefixed, so samples copy across untouched.
    return {
      kind: "video",
      fourcc: "avc1",
      codecString: avcCodecString(priv),
      configBox: box("avcC", priv),
    };
  }

  if (codecId === "V_MPEGH/ISO/HEVC") {
    if (!priv || priv.length < 13) return null;
    return {
      kind: "video",
      fourcc: "hvc1",
      codecString: hevcCodecString(priv),
      configBox: box("hvcC", priv),
    };
  }

  if (codecId === "V_VP9") {
    const width = track.width ?? 0;
    const height = track.height ?? 0;
    // Every field of a VP9 codec string is two *decimal* digits — unlike
    // AVC/HEVC, which use hex. Writing the level in hex yields a string
    // browsers silently reject.
    const level = String(vp9Level(width, height)).padStart(2, "0");
    return {
      kind: "video",
      fourcc: "vp09",
      codecString: `vp09.00.${level}.08`,
      configBox: buildVpcC(width, height),
    };
  }

  if (codecId === "V_AV1") {
    if (!priv) return null;
    return {
      kind: "video",
      fourcc: "av01",
      // Matroska carries the AV1CodecConfigurationRecord verbatim; deriving
      // a fully precise codec string needs sequence-header parsing, so we
      // use the widely-supported Main profile string and let
      // isTypeSupported() have the final say.
      codecString: "av01.0.05M.08",
      configBox: box("av1C", priv),
    };
  }

  // --- audio ---

  if (codecId === "A_AAC" || codecId.startsWith("A_AAC/")) {
    if (!priv || priv.length === 0) return null;
    return {
      kind: "audio",
      fourcc: "mp4a",
      codecString: `mp4a.40.${aacObjectType(priv)}`,
      configBox: buildEsds(priv),
    };
  }

  if (codecId === "A_OPUS") {
    if (!priv) return null;
    const dops = buildDops(priv);
    if (!dops) return null;
    return { kind: "audio", fourcc: "Opus", codecString: "opus", configBox: dops };
  }

  if (codecId === "A_FLAC") {
    if (!priv) return null;
    return { kind: "audio", fourcc: "fLaC", codecString: "flac", configBox: buildDfla(priv) };
  }

  if (codecId === "A_MPEG/L3") {
    // MP3 in MP4 has an assigned objectTypeIndication but patchy browser
    // support; isTypeSupported() decides whether we keep the track.
    return {
      kind: "audio",
      fourcc: "mp4a",
      codecString: "mp4a.40.34",
      configBox: buildEsds(new Uint8Array([0x2b, 0x92, 0x08, 0x00]), 0x6b),
    };
  }

  // AC-3, E-AC-3, DTS, TrueHD, PCM, Vorbis-in-MP4 and friends: either no
  // browser decodes them or they need a bitstream parse we don't do here.
  return null;
}

/** Builds a VisualSampleEntry (avc1/hvc1/av01/…) wrapping the codec config box. */
export function buildVisualSampleEntry(config: CodecConfig, width: number, height: number): Uint8Array {
  const compressorName = new Uint8Array(32); // length-prefixed, left blank
  return box(
    config.fourcc,
    zeros(6),
    u16(1), // data_reference_index
    u16(0),
    u16(0),
    zeros(12),
    u16(width),
    u16(height),
    u32(0x00480000), // 72 dpi horizontal
    u32(0x00480000), // 72 dpi vertical
    u32(0),
    u16(1), // frame_count
    compressorName,
    u16(0x0018), // depth
    u16(0xffff), // pre_defined
    config.configBox,
  );
}

/** Builds an AudioSampleEntry (mp4a/Opus/fLaC/…) wrapping the codec config box. */
export function buildAudioSampleEntry(
  config: CodecConfig,
  channels: number,
  sampleRate: number,
): Uint8Array {
  return box(
    config.fourcc,
    zeros(6),
    u16(1), // data_reference_index
    zeros(8),
    u16(channels),
    u16(16), // sample size
    u16(0),
    u16(0),
    // 16.16 fixed point; rates above 65535 can't be expressed and are
    // clamped, which matters only for exotic content the browser wouldn't
    // decode anyway.
    u32(Math.min(sampleRate, 65535) << 16),
    config.configBox,
  );
}

/** Convenience wrapper choosing the right sample entry shape for a config. */
export function buildSampleEntry(config: CodecConfig, track: SourceTrackInfo): Uint8Array {
  if (config.kind === "video") {
    return buildVisualSampleEntry(config, track.width ?? 0, track.height ?? 0);
  }
  return buildAudioSampleEntry(config, track.channels ?? 2, Math.round(track.sampleRate ?? 48000));
}
