//! Export and format conversion (SPEC §7.8).
//!
//! Export always writes copies into a chosen folder. It never touches a source
//! file — SPEC §2: "Kitbench reads; it writes only to its own cache and to
//! explicit export destinations."
//!
//! Conversion is the exception rather than the rule here, which is a Phase 0
//! finding rather than a guess. §7.8 assumed a conversion before every hand-off
//! because §11.2 expected Sitala to reject 32-bit float or non-44.1k rates. It
//! rejects neither: it took every format tested, including AIFF. So the default
//! path is a byte-for-byte copy, and ffmpeg is only invoked when the user asks
//! for a specific rate, depth, channel count or gain.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::db;
use crate::paths;

/// Matches the `bundle.externalBin` entry in `tauri.conf.json` (SPEC §3).
const SIDECAR_STEM: &str = "ffmpeg-x86_64-pc-windows-msvc";

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportOptions {
    /// Target rate in Hz, or `None` to leave as-is (the §7.8 default).
    pub sample_rate: Option<u32>,
    /// 16, 24 or 32. `None` leaves the source depth alone.
    pub bit_depth: Option<u16>,
    /// 1 or 2. `None` leaves the channel count alone.
    pub channels: Option<u16>,
    /// Apply each slot's gain offset. Default off (§7.8).
    pub apply_slot_gain: bool,
    /// Match levels on the way out. Default off — export is untouched unless
    /// asked (§7.6).
    pub normalize: bool,
    /// Target for `normalize`, in dBFS RMS.
    pub normalize_target_db: Option<f64>,
}

impl ExportOptions {
    /// True when nothing about the audio changes, so the file can be copied.
    ///
    /// Worth checking: a copy is faster, lossless, and cannot fail for want of
    /// a sidecar that most exports do not need.
    fn is_passthrough(&self) -> bool {
        self.sample_rate.is_none()
            && self.bit_depth.is_none()
            && self.channels.is_none()
            && !self.apply_slot_gain
            && !self.normalize
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedFile {
    pub slot_index: i64,
    pub path: String,
    /// False when the file was copied rather than re-encoded.
    pub converted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedSlot {
    pub slot_index: i64,
    pub reason: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub dest_dir: String,
    pub written: Vec<ExportedFile>,
    /// Empty pads and broken files, each with a reason. An export that quietly
    /// produced eleven files when the user expected sixteen would be worse
    /// than one that says which five it could not write.
    pub skipped: Vec<SkippedSlot>,
}

#[derive(Debug, thiserror::Error)]
pub enum ExportError {
    #[error("{0}")]
    Io(String),
    #[error("could not find the ffmpeg sidecar. Looked for {looked}. \
             Conversion needs it; exporting with every option left as-is does not.")]
    NoSidecar { looked: String },
    #[error("ffmpeg failed on {file}: {message}")]
    Ffmpeg { file: String, message: String },
}

/// Locates the bundled ffmpeg.
///
/// SPEC §3: "Bundled, not assumed present on PATH." Tauri places an
/// `externalBin` next to the executable with the target triple in its name; the
/// plain name is accepted too so a developer can drop one in while testing, and
/// an explicit override wins over both (§7.9).
pub fn find_sidecar(override_path: Option<&str>) -> Option<PathBuf> {
    if let Some(explicit) = override_path.filter(|p| !p.trim().is_empty()) {
        let path = PathBuf::from(explicit);
        return path.is_file().then_some(path);
    }
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    for stem in [SIDECAR_STEM, "ffmpeg"] {
        let candidate = dir.join(format!("{stem}{suffix}"));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn sidecar_search_description() -> String {
    let dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "the application folder".into());
    format!("{SIDECAR_STEM} and ffmpeg in {dir}")
}

/// Strips characters Windows will not accept in a filename.
///
/// Sample packs contain colons and slashes in names more often than you would
/// hope, and a kit export that fails on pad 7 because of a punctuation mark is
/// a bad way to find that out.
fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') { '_' } else { c })
        .collect();
    cleaned.trim().trim_end_matches('.').to_string()
}

/// Writes every filled slot of a kit into `dest_dir`.
///
/// Named `01_KICK_808_deep.wav` … `16_….wav`, so alphabetical order in a file
/// browser matches pad order (SPEC §7.8) — which is what makes the
/// export-and-drag-from-Explorer fallback bearable.
pub fn export_kit(
    conn: &rusqlite::Connection,
    kit_id: i64,
    dest_dir: &str,
    opts: &ExportOptions,
    sidecar_override: Option<&str>,
) -> Result<ExportReport, ExportError> {
    let kit = db::load_kit(conn, kit_id)
        .map_err(|e| ExportError::Io(e.to_string()))?
        .ok_or_else(|| ExportError::Io("no such kit".into()))?;

    let dest = PathBuf::from(dest_dir);
    std::fs::create_dir_all(&dest)
        .map_err(|e| ExportError::Io(format!("could not create {dest_dir}: {e}")))?;

    let mut written = Vec::new();
    let mut skipped = Vec::new();

    for entry in &kit.slots {
        let index = entry.slot.slot_index;
        let Some(sample) = entry.sample.as_ref() else {
            // An empty pad is not an error, but it is worth reporting so the
            // count adds up.
            if entry.slot.sample_id.is_some() {
                skipped.push(SkippedSlot { slot_index: index, reason: "sample no longer in the library".into() });
            }
            continue;
        };
        if sample.removed {
            skipped.push(SkippedSlot {
                slot_index: index,
                reason: format!("file is missing: {}", sample.path),
            });
            continue;
        }

        let stem = sanitize(sample.filename.trim_end_matches(&format!(".{}", sample.ext)));
        let ext = if opts.is_passthrough() { sample.ext.clone() } else { "wav".to_string() };
        let out = dest.join(format!("{:02}_{stem}.{ext}", index + 1));

        let source = paths::for_file_io(&sample.path);
        let result = if opts.is_passthrough() {
            std::fs::copy(&source, &out)
                .map(|_| false)
                .map_err(|e| ExportError::Io(format!("copy failed for slot {}: {e}", index + 1)))
        } else {
            let gain_db = export_gain_db(sample, &entry.slot, opts);
            run_ffmpeg(&source, &out, opts, gain_db, sidecar_override).map(|()| true)
        };

        match result {
            Ok(converted) => written.push(ExportedFile {
                slot_index: index,
                path: out.to_string_lossy().into_owned(),
                converted,
            }),
            // One bad file should not abandon the other fifteen.
            Err(e) => skipped.push(SkippedSlot { slot_index: index, reason: e.to_string() }),
        }
    }

    Ok(ExportReport {
        dest_dir: dest.to_string_lossy().into_owned(),
        written,
        skipped,
    })
}

/// Total gain to bake in, in dB: the slot's offset plus any normalisation.
fn export_gain_db(sample: &db::SampleRow, slot: &db::KitSlot, opts: &ExportOptions) -> f64 {
    let mut gain = if opts.apply_slot_gain { slot.gain_db_offset } else { 0.0 };
    if opts.normalize {
        if let Some(body) = sample.body_rms_db {
            let target = opts.normalize_target_db.unwrap_or(-18.0);
            // Same ±12 dB clamp as preview (SPEC §7.6), for the same reason: a
            // near-silent file should not be blasted.
            gain += (target - body as f64).clamp(-12.0, 12.0);
        }
    }
    gain
}

fn run_ffmpeg(
    source: &Path,
    out: &Path,
    opts: &ExportOptions,
    gain_db: f64,
    sidecar_override: Option<&str>,
) -> Result<(), ExportError> {
    let ffmpeg = find_sidecar(sidecar_override)
        .ok_or_else(|| ExportError::NoSidecar { looked: sidecar_search_description() })?;

    let mut cmd = std::process::Command::new(&ffmpeg);
    cmd.arg("-y").arg("-loglevel").arg("error").arg("-i").arg(source);

    if let Some(rate) = opts.sample_rate {
        cmd.arg("-ar").arg(rate.to_string());
    }
    if let Some(channels) = opts.channels {
        cmd.arg("-ac").arg(channels.to_string());
    }
    if let Some(depth) = opts.bit_depth {
        cmd.arg("-c:a").arg(match depth {
            8 => "pcm_u8",
            24 => "pcm_s24le",
            32 => "pcm_f32le",
            _ => "pcm_s16le",
        });
    }
    if gain_db.abs() > 0.01 {
        cmd.arg("-af").arg(format!("volume={gain_db:.2}dB"));
    }
    cmd.arg(out);

    // No console flash on Windows: this runs from a GUI app, several times per
    // export.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd
        .output()
        .map_err(|e| ExportError::Ffmpeg { file: file_label(source), message: e.to_string() })?;

    if !output.status.success() {
        return Err(ExportError::Ffmpeg {
            file: file_label(source),
            message: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }
    Ok(())
}

fn file_label(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaving_every_option_alone_is_a_passthrough() {
        // The common case after Phase 0: Sitala took every format tested, so a
        // plain copy is both correct and the fast path.
        assert!(ExportOptions::default().is_passthrough());

        let converting = ExportOptions { sample_rate: Some(44_100), ..Default::default() };
        assert!(!converting.is_passthrough());
        let gained = ExportOptions { apply_slot_gain: true, ..Default::default() };
        assert!(!gained.is_passthrough());
    }

    #[test]
    fn filenames_lose_characters_windows_rejects() {
        assert_eq!(sanitize("KICK: deep/hard"), "KICK_ deep_hard");
        assert_eq!(sanitize("name."), "name");
        assert_eq!(sanitize("  padded  "), "padded");
        // Everything else survives, including the non-ASCII Phase 0 proved works.
        assert_eq!(sanitize("kick_ñ_ドラム"), "kick_ñ_ドラム");
    }

    #[test]
    fn normalisation_gain_is_clamped_like_preview() {
        let sample_with_body = |body: f32| db::SampleRow {
            id: 1, root_id: 1, path: String::new(), rel_path: String::new(),
            filename: String::new(), parent_dir: String::new(), ext: String::new(),
            size_bytes: 0, duration_ms: None, sample_rate: None, channels: None,
            bit_depth: None, category: None, true_peak_db: None,
            body_rms_db: Some(body), peaks: None, drag_blocked: None,
            removed: false, probe_error: None,
        };
        let slot = db::KitSlot { slot_index: 0, sample_id: Some(1), gain_db_offset: 3.0, notes: None };
        let opts = ExportOptions {
            apply_slot_gain: true,
            normalize: true,
            normalize_target_db: Some(-18.0),
            ..Default::default()
        };

        // −20 dB body wants +2 dB, plus the slot's +3.
        let gain = export_gain_db(&sample_with_body(-20.0), &slot, &opts);
        assert!((gain - 5.0).abs() < 0.001, "gain was {gain}");

        // A near-silent file asks for 100 dB and gets 12, so an export cannot
        // blast (SPEC §7.6).
        let clamped = export_gain_db(&sample_with_body(-118.0), &slot, &opts);
        assert!((clamped - 15.0).abs() < 0.001, "expected slot gain plus the clamp, got {clamped}");
    }

    #[test]
    fn slot_gain_and_normalisation_are_both_opt_in() {
        let sample = db::SampleRow {
            id: 1, root_id: 1, path: String::new(), rel_path: String::new(),
            filename: String::new(), parent_dir: String::new(), ext: String::new(),
            size_bytes: 0, duration_ms: None, sample_rate: None, channels: None,
            bit_depth: None, category: None, true_peak_db: None,
            body_rms_db: Some(-30.0), peaks: None, drag_blocked: None,
            removed: false, probe_error: None,
        };
        let slot = db::KitSlot { slot_index: 0, sample_id: Some(1), gain_db_offset: 6.0, notes: None };
        // §7.8 defaults both off: an export is a copy unless asked otherwise.
        assert_eq!(export_gain_db(&sample, &slot, &ExportOptions::default()), 0.0);
    }
}
