/**
 * Just enough MPEG audio parsing to time an MP3 track exactly.
 *
 * AVI describes an MP3 stream in blocks whose size the header only
 * approximates, so deriving timestamps from the stream header drifts —
 * audibly, within a minute or two, on a long file. Every MP3 frame
 * announces its own sample rate and sample count, so counting frames gives
 * a timeline that can't drift at all.
 */

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V1_L2 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0];
const BITRATES_V1_L1 = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0];
const BITRATES_V2_L1 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0];
const BITRATES_V2_L23 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];

const SAMPLE_RATES = [
  [11025, 12000, 8000], // MPEG 2.5
  [0, 0, 0], // reserved
  [22050, 24000, 16000], // MPEG 2
  [44100, 48000, 32000], // MPEG 1
];

export interface Mp3FrameHeader {
  sampleRate: number;
  channels: number;
  /** Samples this frame decodes to — 1152, 576 or 384 depending on layer. */
  samplesPerFrame: number;
  /** Total frame size in bytes, including the header. */
  frameLength: number;
  bitrateKbps: number;
}

/**
 * Parses an MPEG audio frame header at `offset`. Returns null when the
 * bytes there aren't a valid header, which is how the scanner below
 * distinguishes a real frame from a coincidental sync pattern.
 */
export function parseMp3Header(data: Uint8Array, offset = 0): Mp3FrameHeader | null {
  if (offset + 4 > data.length) return null;

  const b0 = data[offset]!;
  const b1 = data[offset + 1]!;
  const b2 = data[offset + 2]!;
  const b3 = data[offset + 3]!;

  // 11-bit sync word.
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;

  const versionBits = (b1 >> 3) & 0x03;
  const layerBits = (b1 >> 1) & 0x03;
  if (versionBits === 1 || layerBits === 0) return null; // reserved

  const bitrateIndex = (b2 >> 4) & 0x0f;
  const sampleRateIndex = (b2 >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null;

  const padding = (b2 >> 1) & 0x01;
  const channelMode = (b3 >> 6) & 0x03;

  const sampleRate = SAMPLE_RATES[versionBits]?.[sampleRateIndex] ?? 0;
  if (!sampleRate) return null;

  const isVersion1 = versionBits === 3;
  const layer = 4 - layerBits; // layerBits 3 = Layer I, 2 = Layer II, 1 = Layer III

  let bitrateKbps: number;
  if (isVersion1) {
    bitrateKbps = (layer === 1 ? BITRATES_V1_L1 : layer === 2 ? BITRATES_V1_L2 : BITRATES_V1_L3)[bitrateIndex] ?? 0;
  } else {
    bitrateKbps = (layer === 1 ? BITRATES_V2_L1 : BITRATES_V2_L23)[bitrateIndex] ?? 0;
  }
  if (!bitrateKbps) return null;

  // Layer I is 384 samples per frame; Layer II is always 1152; Layer III
  // is 1152 on MPEG-1 but halves to 576 on MPEG-2 and 2.5.
  const samplesPerFrame = layer === 1 ? 384 : layer === 2 ? 1152 : isVersion1 ? 1152 : 576;

  const frameLength =
    layer === 1
      ? (Math.floor((12 * bitrateKbps * 1000) / sampleRate) + padding) * 4
      : Math.floor((samplesPerFrame / 8) * ((bitrateKbps * 1000) / sampleRate)) + padding;

  if (frameLength <= 4) return null;

  return {
    sampleRate,
    channels: channelMode === 3 ? 1 : 2,
    samplesPerFrame,
    frameLength,
    bitrateKbps,
  };
}

/** The first valid frame header in a buffer, with its offset. */
export function findFirstMp3Frame(data: Uint8Array, limit = 4096): (Mp3FrameHeader & { offset: number }) | null {
  const end = Math.min(data.length, limit);
  for (let i = 0; i + 4 <= end; i++) {
    if (data[i] !== 0xff) continue;
    const header = parseMp3Header(data, i);
    if (!header) continue;
    // One sync pattern can appear by chance inside compressed data; a
    // second header exactly one frame later almost never does.
    const next = parseMp3Header(data, i + header.frameLength);
    if (next || i + header.frameLength >= data.length) return { ...header, offset: i };
  }
  return null;
}

/**
 * Counts the decoded samples in a chunk of MP3 data by walking its frames.
 * Falls back to a single-frame estimate if the chunk doesn't parse, so a
 * damaged chunk costs one frame of drift rather than the whole timeline.
 */
export function countMp3Samples(data: Uint8Array): { samples: number; sampleRate: number } | null {
  const first = findFirstMp3Frame(data, Math.min(data.length, 1024));
  if (!first) return null;

  let samples = 0;
  let offset = first.offset;
  while (offset + 4 <= data.length) {
    const header = parseMp3Header(data, offset);
    if (!header) break;
    samples += header.samplesPerFrame;
    offset += header.frameLength;
  }

  if (samples === 0) samples = first.samplesPerFrame;
  return { samples, sampleRate: first.sampleRate };
}
