//! Full-body analysis: peaks for drawing, levels for gain matching.
//!
//! A distinct step from probing (SPEC §11.4), so the "metadata only, skip
//! analysis" mode stays available without restructuring the pipeline. This is
//! the step that reads every byte of every file, and the one that will hurt
//! first on a network share.

use std::path::Path;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Buckets per file, regardless of duration (SPEC §7.4). A min/max pair of
/// `i8` each, so 800 bytes per sample — 4 MB across a 5,000-file library.
pub const BUCKETS: usize = 400;

/// The window §7.6 measures body level over.
const BODY_WINDOW_MS: usize = 300;

/// Floor for a level in dB. Silence has no logarithm, and `-inf` does not
/// survive a round trip through JSON.
pub const SILENCE_DB: f32 = -120.0;

pub struct Analysis {
    /// Loudest single sample across every channel, in dBFS.
    pub true_peak_db: f32,
    /// RMS of the loudest 300 ms window, in dBFS (SPEC §7.6).
    pub body_rms_db: f32,
    /// `BUCKETS` interleaved (min, max) pairs, normalised to the file's own
    /// peak. See the note on `peaks` below for why per-file and not absolute.
    pub peaks: Vec<u8>,
}

fn to_db(amplitude: f32) -> f32 {
    if amplitude <= 0.0 {
        SILENCE_DB
    } else {
        (20.0 * amplitude.log10()).max(SILENCE_DB)
    }
}

/// Decodes the whole file and measures it.
///
/// Returns `Err` with a displayable message rather than panicking. A malformed
/// file is a row with an error on it, not a dead scan (SPEC §15).
pub fn analyze(path: &Path) -> Result<Analysis, String> {
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
    let rate = track.codec_params.sample_rate.unwrap_or(44_100) as usize;

    // Downmix, for shape and for perceived level. True peak is taken across
    // every channel separately, because averaging would under-report a
    // hard-panned transient — and that transient is exactly what peak-matching
    // needs to know about (SPEC §7.6).
    let mut mono: Vec<f32> = Vec::new();
    let mut true_peak = 0.0f32;
    let mut buffer: Option<SampleBuffer<f32>> = None;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            // Clean end of stream, or a truncated file. Either way, measure
            // what was actually readable rather than discarding it: Phase 0
            // established that a truncated WAV still decodes its fragment.
            Err(_) => break,
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            // One bad packet should not lose the rest of the file.
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(e) => return Err(format!("decode failed: {e}")),
        };

        let spec = *decoded.spec();
        let buf = buffer.get_or_insert_with(|| {
            SampleBuffer::<f32>::new(decoded.capacity() as u64, spec)
        });
        buf.copy_interleaved_ref(decoded);

        let channels = spec.channels.count().max(1);
        for frame in buf.samples().chunks(channels) {
            let mut sum = 0.0f32;
            for &sample in frame {
                true_peak = true_peak.max(sample.abs());
                sum += sample;
            }
            mono.push(sum / channels as f32);
        }
    }

    if mono.is_empty() {
        return Err("no decodable audio".into());
    }

    Ok(Analysis {
        true_peak_db: to_db(true_peak),
        body_rms_db: to_db(loudest_window_rms(&mono, rate)),
        peaks: bucket_peaks(&mono, true_peak),
    })
}

/// RMS of the loudest `BODY_WINDOW_MS` window (SPEC §7.6).
///
/// Why not LUFS: gated integrated loudness needs 400 ms blocks and a gating
/// window a 200 ms hi-hat one-shot simply does not fill, so it returns garbage
/// or nothing. A sliding RMS behaves sensibly across the 50 ms – 3 s range drum
/// one-shots actually occupy.
///
/// A prefix sum of squares makes each window position O(1), so this stays
/// linear no matter how fine the hop.
fn loudest_window_rms(mono: &[f32], rate: usize) -> f32 {
    // A file shorter than the window is measured whole. Padding it with
    // silence would report a 200 ms hat as quieter than it is.
    let window = (rate * BODY_WINDOW_MS / 1000).clamp(1, mono.len());

    let mut prefix = Vec::with_capacity(mono.len() + 1);
    prefix.push(0.0f64);
    for &sample in mono {
        let last = prefix[prefix.len() - 1];
        prefix.push(last + (sample as f64) * (sample as f64));
    }

    // 1 ms hop: fine enough that the true maximum is not missed by a
    // meaningful margin, coarse enough to stay cheap on a 30 s file.
    let hop = (rate / 1000).max(1);
    let mut best = 0.0f64;
    let mut start = 0;
    while start + window <= mono.len() {
        let sum = prefix[start + window] - prefix[start];
        best = best.max(sum / window as f64);
        start += hop;
    }
    // The tail can hold the loudest window when the file is not a whole number
    // of hops long — a short decaying one-shot is exactly that shape.
    if mono.len() >= window {
        let sum = prefix[mono.len()] - prefix[mono.len() - window];
        best = best.max(sum / window as f64);
    }

    (best.sqrt()) as f32
}

/// Downsamples to `BUCKETS` min/max pairs.
///
/// Normalised to the file's own peak rather than to full scale. The thumbnail's
/// job is telling a kick from a hat at a glance, and an absolute scale would
/// draw a −30 dB sample as a flat line — unreadable exactly where shape matters
/// most. Level is not lost by this: it is reported numerically as peak and body
/// dB, and applied by gain matching (SPEC §7.6).
fn bucket_peaks(mono: &[f32], true_peak: f32) -> Vec<u8> {
    let mut out = vec![0u8; BUCKETS * 2];
    if mono.is_empty() {
        return out;
    }
    // Silence stays flat rather than becoming a divide by zero.
    let scale = if true_peak > 0.0 { 127.0 / true_peak } else { 0.0 };

    for bucket in 0..BUCKETS {
        let start = bucket * mono.len() / BUCKETS;
        let end = (((bucket + 1) * mono.len()) / BUCKETS).max(start + 1).min(mono.len());
        let slice = &mono[start..end.max(start + 1).min(mono.len())];
        if slice.is_empty() {
            continue;
        }
        let mut lo = f32::MAX;
        let mut hi = f32::MIN;
        for &sample in slice {
            lo = lo.min(sample);
            hi = hi.max(sample);
        }
        out[bucket * 2] = ((lo * scale).clamp(-127.0, 127.0) as i8) as u8;
        out[bucket * 2 + 1] = ((hi * scale).clamp(-127.0, 127.0) as i8) as u8;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Writes a 16-bit mono WAV of `samples` and analyses it, so the test
    /// exercises the real decode path rather than a shortcut into the maths.
    fn analyze_samples(name: &str, rate: u32, samples: &[f32]) -> Analysis {
        let mut data = Vec::with_capacity(samples.len() * 2);
        for &s in samples {
            data.extend(((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
        }
        let mut fmt = Vec::new();
        fmt.extend(1u16.to_le_bytes());
        fmt.extend(1u16.to_le_bytes());
        fmt.extend(rate.to_le_bytes());
        fmt.extend((rate * 2).to_le_bytes());
        fmt.extend(2u16.to_le_bytes());
        fmt.extend(16u16.to_le_bytes());

        let mut body = Vec::new();
        for (id, chunk) in [(b"fmt ", &fmt), (b"data", &data)] {
            body.extend(id);
            body.extend((chunk.len() as u32).to_le_bytes());
            body.extend(chunk.iter());
        }
        let mut file = b"RIFF".to_vec();
        file.extend(((body.len() + 4) as u32).to_le_bytes());
        file.extend(b"WAVE");
        file.extend(body);

        let path = std::env::temp_dir().join(format!("kitbench-analyze-{name}.wav"));
        std::fs::File::create(&path).unwrap().write_all(&file).unwrap();
        let result = analyze(&path);
        let _ = std::fs::remove_file(&path);
        result.expect("analysis failed")
    }

    fn sine(rate: u32, ms: usize, freq: f32, amplitude: f32) -> Vec<f32> {
        let n = rate as usize * ms / 1000;
        (0..n)
            .map(|i| amplitude * (2.0 * std::f32::consts::PI * freq * i as f32 / rate as f32).sin())
            .collect()
    }

    /// SPEC §15's second named test: "against generated WAVs with known
    /// content: a full-scale sine, a −20 dB sine, a click, silence. Assert the
    /// computed values are what the math says they should be."
    #[test]
    fn full_scale_sine_measures_zero_peak_and_minus_three_rms() {
        let a = analyze_samples("fs-sine", 44_100, &sine(44_100, 1000, 440.0, 1.0));
        // A sine's RMS is its amplitude over root two: 20*log10(1/√2) = −3.01 dB.
        assert!(a.true_peak_db.abs() < 0.1, "peak was {}", a.true_peak_db);
        assert!((a.body_rms_db - -3.01).abs() < 0.15, "rms was {}", a.body_rms_db);
    }

    #[test]
    fn minus_twenty_db_sine_measures_twenty_db_down() {
        // 0.1 amplitude is exactly −20 dBFS; its RMS is −23.01 dB.
        let a = analyze_samples("q-sine", 44_100, &sine(44_100, 1000, 440.0, 0.1));
        assert!((a.true_peak_db - -20.0).abs() < 0.15, "peak was {}", a.true_peak_db);
        assert!((a.body_rms_db - -23.01).abs() < 0.15, "rms was {}", a.body_rms_db);
    }

    #[test]
    fn the_gap_between_peak_and_body_is_what_gain_matching_uses() {
        // The whole point of §7.6: two files 20 dB apart in level must come out
        // 20 dB apart in both measures, so either normalisation mode lines them
        // up. If this drifts, gain matching silently stops working.
        let loud = analyze_samples("gm-loud", 44_100, &sine(44_100, 500, 220.0, 1.0));
        let quiet = analyze_samples("gm-quiet", 44_100, &sine(44_100, 500, 220.0, 0.1));
        assert!((loud.true_peak_db - quiet.true_peak_db - 20.0).abs() < 0.2);
        assert!((loud.body_rms_db - quiet.body_rms_db - 20.0).abs() < 0.2);
    }

    #[test]
    fn a_click_peaks_full_scale_but_has_almost_no_body() {
        // One full-scale sample in a second of silence. This is the case §7.6
        // says peak-matching gets wrong and body-matching gets right: the peak
        // reads 0 dB, but there is essentially nothing there to hear.
        let mut samples = vec![0.0f32; 44_100];
        samples[100] = 1.0;
        let a = analyze_samples("click", 44_100, &samples);
        assert!(a.true_peak_db.abs() < 0.1, "peak was {}", a.true_peak_db);
        // Energy of one sample spread over a 300 ms window: 20*log10(1/√13230)
        // is about −41 dB.
        assert!(a.body_rms_db < -35.0, "rms was {}", a.body_rms_db);
        assert!(
            a.true_peak_db - a.body_rms_db > 35.0,
            "a click should show a huge peak-to-body gap"
        );
    }

    #[test]
    fn silence_floors_rather_than_returning_infinity() {
        let a = analyze_samples("silence", 44_100, &vec![0.0f32; 44_100]);
        assert_eq!(a.true_peak_db, SILENCE_DB);
        assert_eq!(a.body_rms_db, SILENCE_DB);
        assert!(a.true_peak_db.is_finite(), "-inf does not survive JSON");
        // A flat file draws a flat line, not a divide by zero.
        assert!(a.peaks.iter().all(|&b| b == 0));
    }

    #[test]
    fn peaks_are_normalised_to_the_files_own_level() {
        // A quiet file and a loud one of the same shape draw the same
        // thumbnail. Shape is what the list is for; level is reported
        // separately and applied by gain matching.
        let loud = analyze_samples("pk-loud", 44_100, &sine(44_100, 200, 100.0, 1.0));
        let quiet = analyze_samples("pk-quiet", 44_100, &sine(44_100, 200, 100.0, 0.05));
        assert_eq!(loud.peaks.len(), BUCKETS * 2);

        let extreme = |peaks: &[u8]| {
            peaks.iter().map(|&b| (b as i8).unsigned_abs()).max().unwrap_or(0)
        };
        assert!(extreme(&loud.peaks) >= 126);
        // Within rounding of the same full-height drawing.
        assert!(extreme(&quiet.peaks) >= 120, "quiet drew at {}", extreme(&quiet.peaks));
    }

    #[test]
    fn short_files_are_measured_whole_rather_than_padded() {
        // A 50 ms one-shot does not fill a 300 ms window. Padding it with
        // silence would report it as roughly 8 dB quieter than it sounds.
        let a = analyze_samples("short", 44_100, &sine(44_100, 50, 440.0, 1.0));
        assert!((a.body_rms_db - -3.01).abs() < 0.3, "rms was {}", a.body_rms_db);
    }
}
