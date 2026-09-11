//! Pitch-shifted renders of a single sample (the chromatic kit).
//!
//! Not in SPEC §5 or §7: it answers "take one 808 and give me a playable
//! bassline across Sitala's sixteen pads", which the spec never anticipated
//! because it predates seeing a drill library.
//!
//! # This is varispeed, not a pitch shifter
//!
//! Shifting up plays the sample faster and shorter; shifting down plays it
//! slower and longer. That is deliberate, not a shortcut. It is what every
//! hardware sampler from the S950 to the SP-1200 did, it is what a tuned 808
//! is, and formant-preserving time-invariant pitch shifting would need a phase
//! vocoder whose smearing is audible on exactly the transients a drum library
//! is made of. For a bassline off one 808 this is the right algorithm and the
//! wrong one would sound worse.
//!
//! # Interpolation
//!
//! Catmull-Rom cubic. Shifting down only interpolates and cubic is comfortably
//! good enough. Shifting up decimates, which aliases whatever sat above the
//! new Nyquist, and no interpolator fixes that -- it needs a low-pass before
//! the decimation. Left undone on purpose: the sounds this is for (808s, subs,
//! toms) are near-sinusoidal and have nothing up there to fold down, and a
//! pitched-up hi-hat aliasing slightly is the sampler sound people are
//! actually asking for. If it ever needs to be pristine, that is a windowed
//! sinc here, not a rewrite.

use std::path::{Path, PathBuf};

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Two octaves either way.
///
/// Past that a one-shot stops being the same sound: up, it is a click; down, a
/// two-second 808 becomes eight seconds of rumble that will not fit a pad.
/// Bounded rather than free so the UI cannot ask for a render that takes a
/// minute and is useless when it lands.
pub const MIN_SEMITONES: f64 = -24.0;
pub const MAX_SEMITONES: f64 = 24.0;

/// Playback-rate multiplier for a semitone offset. The frontend previews with
/// exactly this number on an `AudioBufferSourceNode`, so what you hear before
/// rendering is what the file comes out as.
pub fn rate_for(semitones: f64) -> f64 {
    2f64.powf(semitones / 12.0)
}

pub fn clamp_semitones(semitones: f64) -> f64 {
    semitones.clamp(MIN_SEMITONES, MAX_SEMITONES)
}

/// True when the offset is close enough to zero that rendering would only copy.
pub fn is_unity(semitones: f64) -> bool {
    semitones.abs() < 1e-6
}

struct Decoded {
    /// Interleaved frames.
    samples: Vec<f32>,
    channels: usize,
    rate: u32,
}

fn decode(path: &Path) -> Result<Decoded, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("open failed: {e}"))?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(&hint, stream, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("unsupported or malformed: {e}"))?;
    let mut format = probed.format;

    let track = format.default_track().ok_or_else(|| "no audio track".to_string())?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("no decoder: {e}"))?;

    let mut samples: Vec<f32> = Vec::new();
    let mut channels = track.codec_params.channels.map_or(1, |c| c.count().max(1));
    let mut rate = track.codec_params.sample_rate.unwrap_or(44_100);
    let mut buffer: Option<SampleBuffer<f32>> = None;

    loop {
        let packet = match format.next_packet() {
            // A truncated file still yields its readable fragment, the same
            // judgement `analyze` makes.
            Err(_) => break,
            Ok(p) => p,
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(e) => return Err(format!("decode failed: {e}")),
        };

        let spec = *decoded.spec();
        channels = spec.channels.count().max(1);
        rate = spec.rate;
        let buf =
            buffer.get_or_insert_with(|| SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
        buf.copy_interleaved_ref(decoded);
        samples.extend_from_slice(buf.samples());
    }

    if samples.is_empty() {
        return Err("no decodable audio".into());
    }
    Ok(Decoded { samples, channels, rate })
}

/// One channel of Catmull-Rom, reading `input` at `position`.
///
/// Clamped at both ends rather than wrapped or zero-padded: a drum one-shot
/// starts at full amplitude, and a zero-padded left neighbour would put a
/// downward step in front of every transient.
fn cubic_at(input: &[f32], channels: usize, channel: usize, position: f64) -> f32 {
    let frames = input.len() / channels;
    let index = position.floor() as isize;
    let t = (position - position.floor()) as f32;

    let at = |i: isize| -> f32 {
        let clamped = i.clamp(0, frames as isize - 1) as usize;
        input[clamped * channels + channel]
    };

    let (p0, p1, p2, p3) = (at(index - 1), at(index), at(index + 1), at(index + 2));
    // Catmull-Rom in Horner form.
    let a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
    let b = p0 - 2.5 * p1 + 2.0 * p2 - 0.5 * p3;
    let c = -0.5 * p0 + 0.5 * p2;
    ((a * t + b) * t + c) * t + p1
}

/// Resamples interleaved audio by `rate` (>1 shortens and raises the pitch).
pub fn resample(input: &[f32], channels: usize, rate: f64) -> Vec<f32> {
    let channels = channels.max(1);
    let frames = input.len() / channels;
    if frames == 0 || rate <= 0.0 {
        return Vec::new();
    }
    // Round, not truncate: at rate 1 this must give back exactly `frames`, and
    // truncation loses the last one to floating-point drift.
    let out_frames = ((frames as f64) / rate).round().max(1.0) as usize;

    let mut out = Vec::with_capacity(out_frames * channels);
    for frame in 0..out_frames {
        let position = frame as f64 * rate;
        for channel in 0..channels {
            out.push(cubic_at(input, channels, channel, position));
        }
    }
    out
}

/// Writes 24-bit PCM.
///
/// 24-bit because the samples arriving here are interpolated floats that were
/// never on a 16-bit grid, so rounding them to one would add dither noise to
/// something that will be layered and processed further. Phase 0 established
/// Sitala takes whatever it is given, so compatibility is not the constraint
/// it would otherwise be.
fn write_wav_24(path: &Path, samples: &[f32], channels: usize, rate: u32) -> Result<(), String> {
    use std::io::Write;

    let channels = channels.max(1) as u16;
    let bits = 24u16;
    let bytes_per_sample = 3usize;
    let data_len = samples.len() * bytes_per_sample;

    // WAV's 32-bit size fields cannot describe more than 4 GB, and a silently
    // truncated header is worse than a refusal.
    if data_len > u32::MAX as usize - 36 {
        return Err("rendered audio is too large for a WAV file".into());
    }

    let mut out: Vec<u8> = Vec::with_capacity(44 + data_len);
    let block_align = channels * bits / 8;
    let byte_rate = rate * u32::from(block_align);

    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((36 + data_len) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVE");

    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&bits.to_le_bytes());

    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data_len as u32).to_le_bytes());

    for &sample in samples {
        // Clamp before scaling. Interpolation overshoots on a steep transient,
        // and a sample that has gone past 1.0 must flatten rather than wrap
        // around to full-scale negative, which is an audible tick.
        let clamped = sample.clamp(-1.0, 1.0);
        let value = (f64::from(clamped) * 8_388_607.0).round() as i32;
        let bytes = value.to_le_bytes();
        out.extend_from_slice(&bytes[0..3]);
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("could not create {parent:?}: {e}"))?;
    }
    let mut file = std::fs::File::create(path).map_err(|e| format!("could not write: {e}"))?;
    file.write_all(&out).map_err(|e| format!("could not write: {e}"))?;
    Ok(())
}

/// A stable short key for one source file's current contents.
///
/// FNV-1a over path, size and mtime rather than a hash of the bytes: this runs
/// per pad on every drag, and reading a whole file to decide whether a render
/// is stale would cost more than the render it is trying to skip.
fn source_key(path: &Path) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |bytes: &[u8]| {
        for &byte in bytes {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    eat(path.to_string_lossy().as_bytes());
    if let Ok(meta) = std::fs::metadata(path) {
        eat(&meta.len().to_le_bytes());
        if let Ok(modified) = meta.modified() {
            if let Ok(since) = modified.duration_since(std::time::UNIX_EPOCH) {
                eat(&since.as_secs().to_le_bytes());
            }
        }
    }
    format!("{hash:016x}")
}

/// `+3` / `-12` / `0`, for a filename a person has to read on a pad.
pub fn semitone_suffix(semitones: f64) -> String {
    let rounded = (semitones * 100.0).round() / 100.0;
    let whole = rounded.round();
    if (rounded - whole).abs() < 1e-6 {
        format!("{:+}", whole as i64)
    } else {
        format!("{rounded:+}")
    }
}

/// Renders `source` shifted by `semitones` into `cache_dir`, returning the file.
///
/// Cached: the same source at the same offset renders once and is reused, which
/// is what makes dragging sixteen pads onto Sitala bearable. The cache lives
/// under the app's own data directory, never beside the user's samples --
/// SPEC §2 is explicit that the library is read-only to us.
pub fn render(source: &Path, semitones: f64, cache_dir: &Path) -> Result<PathBuf, String> {
    let semitones = clamp_semitones(semitones);
    let stem = source.file_stem().map_or_else(|| "sample".into(), |s| s.to_string_lossy());
    // Windows forbids these in a filename and the stem came from one, but the
    // suffix is ours and the join must not be able to escape the directory.
    let safe_stem: String = stem
        .chars()
        .map(|c| if r#"\/:*?"<>|"#.contains(c) { '_' } else { c })
        .collect();

    let dir = cache_dir.join(source_key(source));
    let out = dir.join(format!("{safe_stem} {}st.wav", semitone_suffix(semitones)));
    if out.is_file() {
        return Ok(out);
    }

    let decoded = decode(source)?;
    let shifted = resample(&decoded.samples, decoded.channels, rate_for(semitones));
    write_wav_24(&out, &shifted, decoded.channels, decoded.rate)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_follows_equal_temperament() {
        assert!((rate_for(0.0) - 1.0).abs() < 1e-12);
        assert!((rate_for(12.0) - 2.0).abs() < 1e-12, "an octave up is double rate");
        assert!((rate_for(-12.0) - 0.5).abs() < 1e-12, "an octave down is half");
        // The ratio a fifth is famous for.
        assert!((rate_for(7.0) - 1.4983).abs() < 1e-4);
    }

    #[test]
    fn unity_resampling_returns_the_input_unchanged() {
        // The property that makes "pad 1 is the original" true rather than
        // nearly true: at rate 1 every read lands exactly on a source frame.
        let input: Vec<f32> = (0..64).map(|i| (i as f32 / 64.0) * 2.0 - 1.0).collect();
        let out = resample(&input, 1, 1.0);
        assert_eq!(out.len(), input.len());
        for (got, want) in out.iter().zip(input.iter()) {
            assert!((got - want).abs() < 1e-5, "got {got}, want {want}");
        }
    }

    #[test]
    fn an_octave_up_halves_the_length_and_down_doubles_it() {
        let input: Vec<f32> = vec![0.0; 1000];
        assert_eq!(resample(&input, 1, rate_for(12.0)).len(), 500);
        assert_eq!(resample(&input, 1, rate_for(-12.0)).len(), 2000);
    }

    #[test]
    fn channels_stay_interleaved_and_do_not_bleed() {
        // Left held at +1, right at -1. Any frame-vs-sample confusion in the
        // indexing shows up immediately as one channel leaking into the other.
        let frames = 200;
        let mut input = Vec::with_capacity(frames * 2);
        for _ in 0..frames {
            input.push(1.0f32);
            input.push(-1.0f32);
        }
        let out = resample(&input, 2, rate_for(-5.0));
        assert_eq!(out.len() % 2, 0, "still interleaved stereo");
        for frame in out.chunks(2) {
            assert!((frame[0] - 1.0).abs() < 1e-4, "left stayed +1, got {}", frame[0]);
            assert!((frame[1] + 1.0).abs() < 1e-4, "right stayed -1, got {}", frame[1]);
        }
    }

    /// A pitched sine must come back at the pitched frequency. This is the
    /// test that would catch the ratio being inverted -- a mistake that still
    /// produces plausible-sounding audio, just the wrong way up.
    #[test]
    fn shifting_up_raises_the_frequency() {
        let rate = 48_000.0f64;
        let frames = 48_000;
        let hz = 100.0f64;
        let input: Vec<f32> = (0..frames)
            .map(|i| ((i as f64 / rate) * hz * std::f64::consts::TAU).sin() as f32)
            .collect();

        let up = resample(&input, 1, rate_for(12.0));
        // Count zero crossings: a 100 Hz tone over the shifted duration, an
        // octave up, is 200 Hz for half a second -- 200 crossings either way.
        let crossings = up.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
        assert!((crossings as i64 - 100).abs() <= 2, "expected ~100 cycles, got {crossings}");
    }

    #[test]
    fn suffixes_read_as_a_musician_would_write_them() {
        assert_eq!(semitone_suffix(0.0), "+0");
        assert_eq!(semitone_suffix(3.0), "+3");
        assert_eq!(semitone_suffix(-12.0), "-12");
    }

    #[test]
    fn semitones_are_clamped_to_two_octaves() {
        assert_eq!(clamp_semitones(99.0), MAX_SEMITONES);
        assert_eq!(clamp_semitones(-99.0), MIN_SEMITONES);
        assert_eq!(clamp_semitones(5.0), 5.0);
    }

    #[test]
    fn a_rendered_wav_has_a_readable_header() {
        let dir = std::env::temp_dir().join(format!("kitbench-pitch-{}", std::process::id()));
        let path = dir.join("probe.wav");
        let samples: Vec<f32> = (0..1000).map(|i| ((i as f32) / 50.0).sin() * 0.5).collect();
        write_wav_24(&path, &samples, 2, 44_100).unwrap();

        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        // 24-bit stereo: 3 bytes a sample, and the declared size must match.
        let data_len = u32::from_le_bytes(bytes[40..44].try_into().unwrap()) as usize;
        assert_eq!(data_len, samples.len() * 3);
        assert_eq!(bytes.len(), 44 + data_len);
        // And symphonia -- the decoder the app itself uses -- must accept it.
        let decoded = decode(&path).unwrap();
        assert_eq!(decoded.channels, 2);
        assert_eq!(decoded.rate, 44_100);
        assert_eq!(decoded.samples.len(), samples.len());

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Interpolation overshoots on a steep edge. Unclamped, a sample past 1.0
    /// wraps to full-scale negative in the 24-bit conversion -- a tick on
    /// exactly the transient a drum sample is made of.
    #[test]
    fn samples_past_full_scale_flatten_rather_than_wrap() {
        let dir = std::env::temp_dir().join(format!("kitbench-clip-{}", std::process::id()));
        let path = dir.join("hot.wav");
        write_wav_24(&path, &[0.0, 2.5, -2.5, 0.0], 1, 44_100).unwrap();

        let bytes = std::fs::read(&path).unwrap();
        let sample_at = |i: usize| -> i32 {
            let o = 44 + i * 3;
            // Sign-extend 24-bit little-endian.
            let raw = i32::from(bytes[o]) | i32::from(bytes[o + 1]) << 8 | i32::from(bytes[o + 2]) << 16;
            if raw & 0x80_0000 != 0 { raw | !0xff_ffff } else { raw }
        };
        assert_eq!(sample_at(1), 8_388_607, "positive overshoot pinned to full scale");
        assert_eq!(sample_at(2), -8_388_607, "negative overshoot pinned, not wrapped");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// End to end on a real file: write a WAV, render it, decode the result.
    ///
    /// The unit tests above prove the resampler and the writer separately. This
    /// is the one that would catch them being wired together wrongly -- a
    /// channel count taken from the wrong place, a rate written that does not
    /// match the samples, a cache path that renders to somewhere nothing reads.
    #[test]
    fn rendering_a_file_shifts_its_pitch_and_caches_the_result() {
        let dir = std::env::temp_dir().join(format!("kitbench-render-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        let source = dir.join("sine.wav");

        let rate = 48_000u32;
        let hz = 200.0f64;
        let seconds = 1.0;
        let frames = (f64::from(rate) * seconds) as usize;
        let samples: Vec<f32> = (0..frames)
            .map(|i| ((i as f64 / f64::from(rate)) * hz * std::f64::consts::TAU).sin() as f32 * 0.5)
            .collect();
        write_wav_24(&source, &samples, 1, rate).unwrap();

        let cache = dir.join("cache");
        let out = render(&source, 12.0, &cache).unwrap();
        assert!(out.is_file(), "render produced no file");
        assert!(
            out.to_string_lossy().contains("+12st"),
            "the offset belongs in the name, got {out:?}"
        );
        assert!(out.starts_with(&cache), "renders must stay inside the cache directory");

        let decoded = decode(&out).unwrap();
        assert_eq!(decoded.rate, rate, "the rate is carried, the samples are what changed");
        assert_eq!(decoded.channels, 1);
        // An octave up: half as long.
        let out_frames = decoded.samples.len();
        assert!(
            (out_frames as i64 - (frames / 2) as i64).abs() <= 2,
            "expected ~{} frames, got {out_frames}",
            frames / 2
        );
        // And twice the frequency: 400 Hz for half a second is 200 cycles.
        let crossings = decoded
            .samples
            .windows(2)
            .filter(|w| w[0] <= 0.0 && w[1] > 0.0)
            .count();
        assert!(
            (crossings as i64 - 200).abs() <= 2,
            "expected ~200 cycles at 400 Hz, got {crossings}"
        );

        // Cached: the second call must not rewrite the file.
        let first_written = std::fs::metadata(&out).unwrap().modified().unwrap();
        let again = render(&source, 12.0, &cache).unwrap();
        assert_eq!(again, out);
        assert_eq!(std::fs::metadata(&again).unwrap().modified().unwrap(), first_written);

        // A different offset is a different file, not an overwrite.
        let down = render(&source, -5.0, &cache).unwrap();
        assert_ne!(down, out);
        assert!(down.is_file());

        std::fs::remove_dir_all(&dir).ok();
    }

}
