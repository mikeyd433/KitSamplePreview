//! Header probing (SPEC §7.1).
//!
//! Reads format metadata only. Full-body analysis for peaks and RMS (§7.4,
//! §7.6) is a separate step arriving in Phase 2 — SPEC §11.4 asks for exactly
//! that separation, so that a "metadata only, skip analysis" mode can be added
//! later without restructuring the pipeline.

use std::path::Path;

use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

#[derive(Debug, Default, Clone)]
pub struct Probed {
    pub duration_ms: Option<i64>,
    pub sample_rate: Option<i64>,
    pub channels: Option<i64>,
    pub bit_depth: Option<i64>,
}

/// Probes one file.
///
/// Returns `Err` with a displayable message rather than panicking: SPEC §15 is
/// explicit that a malformed WAV must not sink the scan, and the caller stores
/// the message on the row so the file shows up as visibly broken instead of
/// silently missing.
pub fn probe(path: &Path) -> Result<Probed, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("open failed: {e}"))?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(&hint, stream, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("unsupported or malformed: {e}"))?;

    let track = probed
        .format
        .default_track()
        .ok_or_else(|| "no audio track".to_string())?;
    let params = &track.codec_params;

    let sample_rate = params.sample_rate.map(i64::from);
    let duration_ms = match (params.n_frames, sample_rate) {
        (Some(frames), Some(rate)) if rate > 0 => Some((frames as i64) * 1000 / rate),
        _ => None,
    };

    Ok(Probed {
        duration_ms,
        sample_rate,
        channels: params.channels.map(|c| c.count() as i64),
        bit_depth: params.bits_per_sample.map(i64::from),
    })
}
