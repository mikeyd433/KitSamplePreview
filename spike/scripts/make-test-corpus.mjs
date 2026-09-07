#!/usr/bin/env node
/**
 * Generates the awkward files and awkward paths the Phase 0 matrix needs.
 *
 *   node scripts/make-test-corpus.mjs [target-dir]
 *
 * Default target is `spike/test-corpus/`, which is gitignored.
 *
 * Two things this is NOT. It is not the sample library — SPEC §15 says build
 * against real WAVs from a real sample pack, and that still holds for every
 * phase after this one. And it is not a substitute for real files in the drag
 * rows: rows 1, 2, 6, 7 and 8 should use samples you actually recognise by ear,
 * because "did Sitala load it" is judged by listening.
 *
 * What it IS: format torture for the decode bench, and three paths that are
 * tedious to build by hand (spaces, non-ASCII, over-MAX_PATH). SPEC §14 asks
 * for exactly this — "throw a folder of odd files at it" — and the point of
 * synthesising them is that their headers are known, so a refusal is
 * attributable to a specific container/codec/bit-depth combination rather than
 * to whatever happened to be lying around.
 *
 * Every generated file peaks at exactly 0.500. That is a free correctness
 * check: the bench's decoded-peak column should read 0.500 for anything that
 * decoded properly. A file that decodes to 0.000 or to something else came back
 * wrong, which is a subtler failure than an outright refusal and easy to miss.
 *
 * No dependencies. MP3/FLAC/OGG are the exception — those need an encoder, so
 * they are produced only if `ffmpeg` happens to be on PATH, and skipped with a
 * note otherwise. That is a convenience here, unrelated to the bundled ffmpeg
 * sidecar SPEC §3 specifies for the real app.
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const PEAK = 0.5;

// ---------------------------------------------------------------------------
// Signal
// ---------------------------------------------------------------------------

/**
 * A short percussive blip: decaying sine plus a noise transient. Drum-shaped on
 * purpose — these get dragged onto Sitala pads, and a 440 Hz test tone tells
 * you nothing about whether the right sample landed on the right pad.
 *
 * Deterministic: a seeded PRNG rather than Math.random, so regenerating the
 * corpus produces byte-identical files and a rescan has nothing to diff.
 */
function blip({ rate, ms, freq, noise = 0.25, decay = 22 }) {
  const n = Math.round((rate * ms) / 1000);
  const out = new Float64Array(n);
  let seed = Math.round(freq * 1000) >>> 0;
  const rand = () => {
    // xorshift32
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >> 17;
    seed ^= seed << 5;  seed >>>= 0;
    return (seed / 0xffffffff) * 2 - 1;
  };

  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = Math.exp(-decay * t);
    // Pitch drop over the first few ms reads as a drum hit rather than a beep.
    const sweep = freq * (1 + 1.4 * Math.exp(-60 * t));
    out[i] = env * (Math.sin(2 * Math.PI * sweep * t) * (1 - noise) + rand() * noise * Math.exp(-90 * t));
  }

  let max = 0;
  for (const v of out) max = Math.max(max, Math.abs(v));
  if (max > 0) for (let i = 0; i < n; i++) out[i] = (out[i] / max) * PEAK;
  return out;
}

/** Interleaves mono into `channels`, detuning the right side so stereo is audible. */
function toChannels(mono, channels, rate) {
  if (channels === 1) return mono;
  const out = new Float64Array(mono.length * channels);
  for (let i = 0; i < mono.length; i++) {
    for (let c = 0; c < channels; c++) {
      // A few samples of delay on the right — enough to hear, too little to smear.
      const src = c === 0 ? i : Math.max(0, i - Math.round(rate * 0.0004));
      out[i * channels + c] = mono[src] * (c === 0 ? 1 : 0.92);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// RIFF/WAVE
// ---------------------------------------------------------------------------

function riffChunk(id, body) {
  const head = Buffer.alloc(8);
  head.write(id, 0, 4, "ascii");
  head.writeUInt32LE(body.length, 4);
  // RIFF chunks are word-aligned; an odd body takes a pad byte that is not
  // counted in the size field.
  return body.length % 2 === 1
    ? Buffer.concat([head, body, Buffer.alloc(1)])
    : Buffer.concat([head, body]);
}

function riff(chunks) {
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, 4, "ascii");
  head.writeUInt32LE(body.length + 4, 4);
  head.write("WAVE", 8, 4, "ascii");
  return Buffer.concat([head, body]);
}

function pcmBody(samples, bits, float) {
  const bytes = bits / 8;
  const buf = Buffer.alloc(samples.length * bytes);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    const o = i * bytes;
    if (float) {
      buf.writeFloatLE(v, o);
    } else if (bits === 8) {
      // 8-bit WAV is unsigned, offset by 128. The one bit depth that changes
      // sign convention, and a classic source of "it decoded to noise".
      buf.writeUInt8(Math.max(0, Math.min(255, Math.round(v * 127) + 128)), o);
    } else if (bits === 16) {
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), o);
    } else if (bits === 24) {
      const s = Math.max(-8388608, Math.min(8388607, Math.round(v * 8388607)));
      const u = s < 0 ? s + 0x1000000 : s;
      buf.writeUIntLE(u, o, 3);
    } else if (bits === 32) {
      buf.writeInt32LE(Math.max(-2147483648, Math.min(2147483647, Math.round(v * 2147483647))), o);
    }
  }
  return buf;
}

function fmtChunk({ channels, rate, bits, float, extensible }) {
  const align = (channels * bits) / 8;
  if (!extensible) {
    const b = Buffer.alloc(16);
    b.writeUInt16LE(float ? 3 : 1, 0);
    b.writeUInt16LE(channels, 2);
    b.writeUInt32LE(rate, 4);
    b.writeUInt32LE(rate * align, 8);
    b.writeUInt16LE(align, 12);
    b.writeUInt16LE(bits, 14);
    return b;
  }
  // WAVE_FORMAT_EXTENSIBLE. This is what a DAW writes for float and for
  // anything above 2 channels, and a reader that stops at the 0xFFFE tag
  // without following the SubFormat GUID mislabels every one of them.
  const b = Buffer.alloc(40);
  b.writeUInt16LE(0xfffe, 0);
  b.writeUInt16LE(channels, 2);
  b.writeUInt32LE(rate, 4);
  b.writeUInt32LE(rate * align, 8);
  b.writeUInt16LE(align, 12);
  b.writeUInt16LE(bits, 14);
  b.writeUInt16LE(22, 16);      // cbSize
  b.writeUInt16LE(bits, 18);    // valid bits per sample
  b.writeUInt32LE(channels === 1 ? 0x4 : 0x3, 20); // channel mask
  b.writeUInt16LE(float ? 3 : 1, 24);              // SubFormat GUID, first field
  Buffer.from([0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00,
               0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]).copy(b, 26);
  return b;
}

function wav({ rate, ms, freq, channels, bits, float = false, extensible = false, junk = false }) {
  const samples = toChannels(blip({ rate, ms, freq }), channels, rate);
  const chunks = [];
  if (junk) {
    // Leading metadata is what real DAW output looks like. The odd-length LIST
    // is deliberate: miss the word-alignment pad and every later chunk header
    // is read one byte off.
    chunks.push(riffChunk("JUNK", Buffer.alloc(512)));
    chunks.push(riffChunk("LIST", Buffer.from("INFOISFTKitbench corpus, odd length", "ascii")));
    chunks.push(riffChunk("bext", Buffer.alloc(602)));
  }
  chunks.push(riffChunk("fmt ", fmtChunk({ channels, rate, bits, float, extensible })));
  chunks.push(riffChunk("data", pcmBody(samples, bits, float)));
  return riff(chunks);
}

// ---------------------------------------------------------------------------
// AIFF / AIFC
// ---------------------------------------------------------------------------

/** Encodes a sample rate as the 80-bit IEEE 754 extended float AIFF insists on. */
function extended80(rate) {
  const b = Buffer.alloc(10);
  if (rate === 0) return b;
  let exp = 16383;
  let m = rate;
  while (m >= 1) { m /= 2; exp++; }
  while (m < 0.5) { m *= 2; exp--; }
  exp--; // the loop above overshoots by one
  m *= 2;
  b.writeUInt16BE(exp, 0);
  // 63-bit mantissa with the explicit leading 1.
  const mant = BigInt(Math.round(m * 2 ** 63));
  b.writeBigUInt64BE(mant, 2);
  return b;
}

function aiffChunk(id, body) {
  const head = Buffer.alloc(8);
  head.write(id, 0, 4, "ascii");
  head.writeUInt32BE(body.length, 4);
  return body.length % 2 === 1
    ? Buffer.concat([head, body, Buffer.alloc(1)])
    : Buffer.concat([head, body]);
}

function aiff({ rate, ms, freq, channels, bits, sowt = false }) {
  const samples = toChannels(blip({ rate, ms, freq }), channels, rate);
  const frames = samples.length / channels;
  const bytes = bits / 8;

  const audio = Buffer.alloc(samples.length * bytes);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    const o = i * bytes;
    if (bits === 16) {
      const s = Math.round(v * 32767);
      // 'sowt' is byte-swapped (little-endian) AIFC — common from macOS tools.
      if (sowt) audio.writeInt16LE(s, o);
      else audio.writeInt16BE(s, o);
    } else {
      const s = Math.max(-8388608, Math.min(8388607, Math.round(v * 8388607)));
      const u = s < 0 ? s + 0x1000000 : s;
      audio.writeUIntBE(u, o, 3);
    }
  }

  const comm = Buffer.concat([
    (() => {
      const b = Buffer.alloc(8);
      b.writeUInt16BE(channels, 0);
      b.writeUInt32BE(frames, 2);
      b.writeUInt16BE(bits, 6);
      return b;
    })(),
    extended80(rate),
    ...(sowt ? [Buffer.from("sowt", "ascii"), Buffer.from([0x00, 0x00])] : []),
  ]);

  const ssnd = Buffer.concat([Buffer.alloc(8), audio]); // offset + blockSize
  const chunks = [];
  if (sowt) {
    const fver = Buffer.alloc(4);
    fver.writeUInt32BE(0xa2805140, 0); // AIFC version 1
    chunks.push(aiffChunk("FVER", fver));
  }
  chunks.push(aiffChunk("COMM", comm), aiffChunk("SSND", ssnd));

  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write("FORM", 0, 4, "ascii");
  head.writeUInt32BE(body.length + 4, 4);
  head.write(sowt ? "AIFC" : "AIFF", 8, 4, "ascii");
  return Buffer.concat([head, body]);
}

// ---------------------------------------------------------------------------
// Writing, with the Windows long-path escape hatch
// ---------------------------------------------------------------------------

/**
 * Node's fs refuses paths over MAX_PATH on Windows unless they are given in
 * `\\?\` verbatim form. Row 9 exists specifically to make an over-260-char
 * path, so writing it needs the prefix even though the row itself should be
 * tested with the plain string.
 */
function longSafe(p) {
  if (process.platform !== "win32") return p;
  if (p.length < 250 || p.startsWith("\\\\?\\")) return p;
  return "\\\\?\\" + resolve(p);
}

const written = [];
function put(path, buf) {
  mkdirSync(longSafe(path.slice(0, path.lastIndexOf(sep))), { recursive: true });
  writeFileSync(longSafe(path), buf);
  written.push({ path, bytes: buf.length });
  return path;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const target = resolve(process.argv[2] ?? join(process.cwd(), "test-corpus"));
console.log(`Kitbench Phase 0 test corpus → ${target}\n`);
rmSync(longSafe(target), { recursive: true, force: true });

const decode = join(target, "decode");

// Bit depths and rates. Each row of the decode bench should come back peak
// 0.500; anything else is the finding.
put(join(decode, "wav_u8_44k_mono.wav"),        wav({ rate: 44100, ms: 220, freq: 60,  channels: 1, bits: 8 }));
put(join(decode, "wav_s16_44k_mono.wav"),       wav({ rate: 44100, ms: 220, freq: 55,  channels: 1, bits: 16 }));
put(join(decode, "wav_s16_44k_stereo.wav"),     wav({ rate: 44100, ms: 260, freq: 180, channels: 2, bits: 16 }));
put(join(decode, "wav_s24_44k_stereo.wav"),     wav({ rate: 44100, ms: 260, freq: 200, channels: 2, bits: 24 }));
put(join(decode, "wav_s24_96k_stereo.wav"),     wav({ rate: 96000, ms: 240, freq: 320, channels: 2, bits: 24 }));
put(join(decode, "wav_s32_48k_mono.wav"),       wav({ rate: 48000, ms: 200, freq: 90,  channels: 1, bits: 32 }));
put(join(decode, "wav_f32_48k_mono.wav"),       wav({ rate: 48000, ms: 200, freq: 70,  channels: 1, bits: 32, float: true }));
put(join(decode, "wav_f32_ext_96k_stereo.wav"), wav({ rate: 96000, ms: 240, freq: 420, channels: 2, bits: 32, float: true, extensible: true }));
put(join(decode, "wav_s16_ext_44k_stereo.wav"), wav({ rate: 44100, ms: 220, freq: 240, channels: 2, bits: 16, extensible: true }));
put(join(decode, "wav_s16_44k_junk_chunks.wav"),wav({ rate: 44100, ms: 220, freq: 150, channels: 1, bits: 16, junk: true }));
put(join(decode, "wav_s16_8k_mono.wav"),        wav({ rate: 8000,  ms: 300, freq: 40,  channels: 1, bits: 16 }));

put(join(decode, "aiff_s16_44k_stereo.aiff"),   aiff({ rate: 44100, ms: 240, freq: 210, channels: 2, bits: 16 }));
put(join(decode, "aiff_s24_44k_mono.aiff"),     aiff({ rate: 44100, ms: 220, freq: 65,  channels: 1, bits: 24 }));
put(join(decode, "aifc_sowt_s16_44k_stereo.aifc"), aiff({ rate: 44100, ms: 240, freq: 300, channels: 2, bits: 16, sowt: true }));

// Broken files. SPEC §15: sample libraries are full of these and a scan must
// survive them. Here they confirm the bench reports a failure instead of
// hanging or crashing.
const truncated = wav({ rate: 44100, ms: 220, freq: 100, channels: 1, bits: 16 });
put(join(decode, "broken_truncated.wav"), truncated.subarray(0, 200));
put(join(decode, "broken_zero_bytes.wav"), Buffer.alloc(0));
put(join(decode, "broken_header_only.wav"), truncated.subarray(0, 44));

// Compressed formats need an encoder; generate them only if one is to hand.
const haveFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
if (haveFfmpeg) {
  const src = join(decode, "wav_s16_44k_stereo.wav");
  for (const [name, args] of [
    ["mp3_44k_stereo.mp3", ["-codec:a", "libmp3lame", "-b:a", "192k"]],
    ["flac_44k_stereo.flac", ["-codec:a", "flac"]],
    ["ogg_vorbis_44k_stereo.ogg", ["-codec:a", "libvorbis", "-q:a", "5"]],
  ]) {
    const out = join(decode, name);
    const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", src, ...args, out], { stdio: "inherit" });
    if (r.status === 0) written.push({ path: out, bytes: null });
    else console.log(`  ! ffmpeg could not produce ${name} (codec missing?) — skipped`);
  }
} else {
  console.log("  ! ffmpeg not on PATH — no MP3/FLAC/OGG generated.");
  console.log("    Copy a few real compressed files into decode/ instead; they matter,");
  console.log("    since SPEC §8 expects decodeAudioData to handle all three.\n");
}

// Awkward paths for drag rows 3, 4 and 9.
const paths = join(target, "paths");
const spacey = put(join(paths, "Sample Packs", "Dusty Breaks", "kick 01.wav"),
  wav({ rate: 44100, ms: 240, freq: 58, channels: 1, bits: 16 }));
const unicode = put(join(paths, "Café_Ünïcode_日本語", "kick_ñ_ドラム.wav"),
  wav({ rate: 44100, ms: 240, freq: 62, channels: 1, bits: 16 }));

// Row 9: nest until the full path clears MAX_PATH by a comfortable margin.
let deep = join(paths, "deep");
while (join(deep, "kick.wav").length < 300) {
  deep = join(deep, "nested_sample_pack_folder_x");
}
let longPath = null;
try {
  longPath = put(join(deep, "kick.wav"), wav({ rate: 44100, ms: 240, freq: 68, channels: 1, bits: 16 }));
} catch (e) {
  console.log(`  ! could not create the over-MAX_PATH file: ${e.message}`);
  console.log("    Enable Win32 long paths (Group Policy, or the LongPathsEnabled");
  console.log("    registry value) and re-run, or note row 9 as skipped.\n");
}

// ---------------------------------------------------------------------------
// Manifest and instructions
// ---------------------------------------------------------------------------

const manifest = [
  "# Phase 0 test corpus",
  "",
  "Generated by `scripts/make-test-corpus.mjs`. Throwaway, like the spike.",
  "",
  "Every file peaks at **0.500**. The decode bench's peak column should agree;",
  "0.000 means it decoded to silence and any other value means it decoded wrong,",
  "both of which are quieter failures than an outright refusal.",
  "",
  "## decode/",
  "",
  "Point the bench's folder field here.",
  "",
  "| file | what it is there for |",
  "|---|---|",
  "| `wav_u8_44k_mono.wav` | 8-bit WAV is *unsigned*; the one depth with a different sign convention |",
  "| `wav_s16_44k_mono.wav`, `..._stereo.wav` | the baseline that must work |",
  "| `wav_s24_44k_stereo.wav`, `wav_s24_96k_stereo.wav` | 24-bit, and 24-bit at 96 kHz |",
  "| `wav_s32_48k_mono.wav` | 32-bit *integer*, routinely confused with float |",
  "| `wav_f32_48k_mono.wav` | 32-bit float, plain tag 3 |",
  "| `wav_f32_ext_96k_stereo.wav` | 32-bit float as WAVE_FORMAT_EXTENSIBLE — what a DAW actually bounces |",
  "| `wav_s16_ext_44k_stereo.wav` | extensible wrapping ordinary PCM |",
  "| `wav_s16_44k_junk_chunks.wav` | JUNK/LIST/bext before `fmt `, including an odd-length chunk |",
  "| `wav_s16_8k_mono.wav` | an unusually low rate |",
  "| `aiff_s16_44k_stereo.aiff`, `aiff_s24_44k_mono.aiff` | big-endian AIFF, SPEC §8's prime suspect |",
  "| `aifc_sowt_s16_44k_stereo.aifc` | byte-swapped AIFC, common from macOS tools |",
  "| `broken_*.wav` | truncated, zero-byte, header-only: these must fail cleanly, not hang |",
  haveFfmpeg
    ? "| `mp3_*`, `flac_*`, `ogg_*` | compressed formats SPEC §8 expects to work |"
    : "| _(no mp3/flac/ogg)_ | ffmpeg was not on PATH — add real ones by hand |",
  "",
  "## paths/",
  "",
  "Paste these into the drag matrix:",
  "",
  `- **Row 3** (spaces): \`${spacey}\``,
  `- **Row 4** (non-ASCII): \`${unicode}\``,
  longPath === null
    ? "- **Row 9** (over MAX_PATH): not created — see the script's output"
    : `- **Row 9** (over MAX_PATH, ${longPath.length} chars): \`${longPath}\``,
  "",
  "**Row 5 (UNC) cannot be generated.** Copy any of these onto a share and use",
  "its `\\\\server\\share\\...` path, or note the row as skipped — guessing at it is",
  "worse than leaving it blank.",
  "",
  "Rows 1, 2, 6, 7 and 8 should use real samples you know by ear. Whether Sitala",
  "loaded the right thing is judged by listening, and a synthetic blip makes that",
  "harder, not easier.",
  "",
].join("\n");

writeFileSync(join(target, "MANIFEST.md"), manifest);

const total = written.reduce((n, w) => n + (w.bytes ?? 0), 0);
console.log(`  ${written.length} files, ${(total / 1024).toFixed(0)} KB\n`);
console.log("Paste into the spike:");
console.log(`  decode bench folder   ${decode}`);
console.log(`  row 3 (spaces)        ${spacey}`);
console.log(`  row 4 (non-ASCII)     ${unicode}`);
console.log(`  row 9 (MAX_PATH)      ${longPath ?? "(not created)"}`);
console.log(`\nFull notes: ${join(target, "MANIFEST.md")}`);
