#!/usr/bin/env node
/**
 * Builds the AVI test fixture from the MP4 already in `examples/media`.
 *
 * A checked-in AVI is worth having: it is the one container the README
 * used to say couldn't be played at all, so "we play it now" deserves a
 * file anyone can click rather than a claim. Generating it from an
 * existing MP4 — rather than committing a second unrelated video — keeps
 * the repository honest about where the bytes came from, and means the
 * fixture carries real H.264 and AAC that a browser can genuinely decode.
 *
 * The rewrite is a container change only: the same encoded frames are
 * re-framed from MP4's length-prefixed form into AVI's Annex B, which is
 * exactly the transformation Lumen's AVI engine undoes at playback time.
 *
 *   node scripts/make-avi-fixture.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as MP4Box from "mp4box";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = join(root, "examples/media/truncated-sample.mp4");
const OUTPUT = join(root, "examples/media/sample-h264.avi");

// ---------------------------------------------------------------- RIFF

const u32 = (value) => Buffer.from([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff]);
const u16 = (value) => Buffer.from([value & 0xff, (value >> 8) & 0xff]);
const fourcc = (text) => Buffer.from(text.padEnd(4, " ").slice(0, 4), "latin1");

function chunk(id, payload) {
  const parts = [fourcc(id), u32(payload.length), payload];
  if (payload.length & 1) parts.push(Buffer.alloc(1));
  return Buffer.concat(parts);
}

function list(type, children) {
  const body = Buffer.concat([fourcc(type), ...children]);
  return Buffer.concat([fourcc("LIST"), u32(body.length), body]);
}

function strh({ type, handler, scale, rate, length, sampleSize = 0 }) {
  return chunk(
    "strh",
    Buffer.concat([
      fourcc(type),
      fourcc(handler),
      u32(0), // dwFlags
      u16(0), // wPriority
      u16(0), // wLanguage
      u32(0), // dwInitialFrames
      u32(scale),
      u32(rate),
      u32(0), // dwStart
      u32(length),
      u32(0), // dwSuggestedBufferSize
      u32(0), // dwQuality
      u32(sampleSize),
      Buffer.alloc(8), // rcFrame
    ]),
  );
}

// ------------------------------------------------------------- H.264

/** MP4 carries length-prefixed NAL units; AVI carries the Annex B stream. */
function toAnnexB(sample, lengthSize) {
  const parts = [];
  let offset = 0;
  while (offset + lengthSize <= sample.length) {
    let length = 0;
    for (let i = 0; i < lengthSize; i++) length = (length << 8) | sample[offset + i];
    offset += lengthSize;
    if (length <= 0 || offset + length > sample.length) break;
    parts.push(Buffer.from([0, 0, 0, 1]), sample.subarray(offset, offset + length));
    offset += length;
  }
  return Buffer.concat(parts);
}

// -------------------------------------------------------------- main

const mp4 = readFileSync(SOURCE);
const file = MP4Box.createFile();

/**
 * Parses the file and pulls out every sample in one pass.
 *
 * mp4box extracts samples while the buffer is being consumed, so the
 * extraction options have to be registered from `onReady` — which fires
 * during `appendBuffer` — rather than afterwards.
 */
const { info, samplesByTrack } = await new Promise((resolve, reject) => {
  const samplesByTrack = new Map();
  let movieInfo = null;

  file.onReady = (movie) => {
    movieInfo = movie;
    for (const track of [...movie.videoTracks, ...movie.audioTracks]) {
      samplesByTrack.set(track.id, []);
      // Small batches, because the source is deliberately truncated: asking
      // for the whole track would mean nothing is ever delivered.
      file.setExtractionOptions(track.id, null, { nbSamples: 10 });
    }
    file.start();
  };

  file.onSamples = (id, _user, samples) => {
    const collected = samplesByTrack.get(id);
    if (!collected) return;
    for (const sample of samples) {
      collected.push({
        data: Buffer.from(sample.data),
        isSync: sample.is_sync,
        duration: sample.duration,
      });
    }
    // Samples are copied out immediately, so mp4box can release them.
    file.releaseUsedSamples(id, samples[samples.length - 1].number + 1);
  };

  file.onError = (_module, message) => reject(new Error(message));

  const copy = new Uint8Array(mp4).buffer;
  file.appendBuffer(MP4Box.MP4BoxBuffer.fromArrayBuffer(copy, 0));
  file.flush();

  if (!movieInfo) reject(new Error("the source file could not be parsed"));
  else resolve({ info: movieInfo, samplesByTrack });
});

const videoTrack = info.videoTracks[0];
const audioTrack = info.audioTracks[0];
if (!videoTrack) throw new Error("no video track in the source file");

const videoEntry = file.getTrackById(videoTrack.id).mdia.minf.stbl.stsd.entries[0];
const avcC = videoEntry.avcC;
if (!avcC) throw new Error("source video is not H.264");

// mp4box exposes each parameter set as `{ length, data }`.
const parameterSets = Buffer.concat(
  [...avcC.SPS, ...avcC.PPS].flatMap((set) => [Buffer.from([0, 0, 0, 1]), Buffer.from(set.data ?? set.nalu)]),
);
const nalLengthSize = avcC.lengthSizeMinusOne + 1;

/**
 * The source MP4 is truncated on purpose (it backs the resilience demo),
 * so only a second or so of it can be read. Repeating that run gives a
 * fixture long enough to actually watch: every repetition starts on the
 * same IDR frame, and AAC frames are independent, so the result is a
 * valid stream rather than a spliced one.
 */
const REPEATS = 3;
const repeat = (samples) => Array.from({ length: REPEATS }, () => samples).flat();

const videoSamples = repeat(samplesByTrack.get(videoTrack.id) ?? []);
const audioSamples = audioTrack ? repeat(samplesByTrack.get(audioTrack.id) ?? []) : [];

if (videoSamples.length === 0) throw new Error("no video samples could be read");

// Frame rate, as a scale/rate pair AVI can express exactly.
const totalDuration = videoSamples.reduce((sum, sample) => sum + sample.duration, 0);
const meanDuration = Math.round(totalDuration / videoSamples.length) || 1;
const videoScale = meanDuration;
const videoRate = videoTrack.timescale;

const width = videoTrack.video.width;
const height = videoTrack.video.height;

const bitmapInfo = Buffer.concat([
  u32(40), // biSize
  u32(width),
  u32(height),
  u16(1), // biPlanes
  u16(24), // biBitCount
  fourcc("H264"), // biCompression
  u32(width * height * 3),
  u32(0),
  u32(0),
  u32(0),
  u32(0),
  parameterSets, // codec extradata, in Annex B form
]);

const strls = [
  list("strl", [
    strh({ type: "vids", handler: "H264", scale: videoScale, rate: videoRate, length: videoSamples.length }),
    chunk("strf", bitmapInfo),
  ]),
];

let audioSpecificConfig = null;
if (audioTrack && audioSamples.length > 0) {
  const audioEntry = file.getTrackById(audioTrack.id).mdia.minf.stbl.stsd.entries[0];
  // The DecoderSpecificInfo inside the esds descriptor chain.
  const descriptor = audioEntry.esds?.esd?.descs?.[0]?.descs?.[0];
  if (descriptor?.data) audioSpecificConfig = Buffer.from(descriptor.data);
}

if (audioSpecificConfig) {
  const channels = audioTrack.audio.channel_count;
  const sampleRate = audioTrack.audio.sample_rate;
  const waveFormat = Buffer.concat([
    u16(0x00ff), // WAVE_FORMAT_RAW_AAC1
    u16(channels),
    u32(sampleRate),
    u32(Math.round((sampleRate * channels * 2) / 8)),
    u16(1), // nBlockAlign — 1 for a variable-size frame codec
    u16(16),
    u16(audioSpecificConfig.length), // cbSize
    audioSpecificConfig,
  ]);

  strls.push(
    list("strl", [
      strh({
        type: "auds",
        handler: "    ",
        // One AAC frame is 1024 samples; that is the audio "sample" here.
        scale: 1024,
        rate: sampleRate,
        length: audioSamples.length,
      }),
      chunk("strf", waveFormat),
    ]),
  );
}

const avih = chunk(
  "avih",
  Buffer.concat([
    u32(Math.round((videoScale / videoRate) * 1_000_000)),
    u32(0),
    u32(0),
    u32(0x10), // AVIF_HASINDEX
    u32(videoSamples.length),
    u32(0),
    u32(strls.length),
    u32(0),
    u32(width),
    u32(height),
    Buffer.alloc(16),
  ]),
);

// Interleave the streams the way a real muxer does: each video frame
// followed by whatever audio covers the same span of time.
const moviChunks = [];
const index = [];
let moviOffset = 4; // 'movi' fourcc precedes the first chunk
const audioPerFrame = audioSamples.length / videoSamples.length;
let audioCursor = 0;

for (let i = 0; i < videoSamples.length; i++) {
  const annexB = toAnnexB(videoSamples[i].data, nalLengthSize);
  const videoChunk = chunk("00dc", annexB);
  index.push({ id: "00dc", flags: videoSamples[i].isSync ? 0x10 : 0, offset: moviOffset, size: annexB.length });
  moviChunks.push(videoChunk);
  moviOffset += videoChunk.length;

  const target = Math.min(audioSamples.length, Math.round((i + 1) * audioPerFrame));
  while (audioCursor < target) {
    const audioChunk = chunk("01wb", audioSamples[audioCursor].data);
    index.push({ id: "01wb", flags: 0x10, offset: moviOffset, size: audioSamples[audioCursor].data.length });
    moviChunks.push(audioChunk);
    moviOffset += audioChunk.length;
    audioCursor++;
  }
}

const idx1 = chunk(
  "idx1",
  Buffer.concat(index.map((entry) => Buffer.concat([fourcc(entry.id), u32(entry.flags), u32(entry.offset), u32(entry.size)]))),
);

const body = Buffer.concat([fourcc("AVI "), list("hdrl", [avih, ...strls]), list("movi", moviChunks), idx1]);
const avi = Buffer.concat([fourcc("RIFF"), u32(body.length), body]);

writeFileSync(OUTPUT, avi);

console.log(`Wrote ${OUTPUT}`);
console.log(`  ${videoSamples.length} video frames (${width}×${height}, ${(videoRate / videoScale).toFixed(3)} fps)`);
console.log(`  ${audioSamples.length} audio frames${audioSpecificConfig ? " (AAC)" : " (none)"}`);
console.log(`  ${(avi.length / 1024).toFixed(0)} kB`);
