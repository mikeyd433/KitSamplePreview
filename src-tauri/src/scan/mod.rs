//! Library scanning (SPEC §7.1).
//!
//! Three distinct steps, on purpose (SPEC §11.4):
//!
//!   walk  -> collect candidate files, cheaply, from the directory tree
//!   probe -> read each file's header, in parallel
//!   write -> fold the results into the index, serially, in one transaction
//!
//! Keeping probing out of the walk is what leaves room for the "metadata only,
//! skip analysis" mode §11.4 holds in reserve, and for Phase 2's full-body peak
//! analysis to slot in as a fourth step rather than a rewrite.

pub mod probe;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rayon::prelude::*;
use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

use crate::db::{self, SampleUpsert};
use crate::paths;
use crate::search;

/// Extensions worth opening. Anything else in a sample folder is not audio.
pub const AUDIO_EXTS: &[&str] = &[
    "wav", "wave", "bwf", "flac", "mp3", "ogg", "oga", "opus", "aif", "aiff", "aifc", "m4a", "aac",
];

/// SPEC §7.1: "anything over a configurable duration ceiling (default 30s — a
/// sample library full of 4-minute loops isn't what this tool is for, but the
/// ceiling is a setting, not a hard rule)".
pub const DEFAULT_MAX_DURATION_MS: i64 = 30_000;

#[derive(Clone, Copy)]
pub struct ScanOptions {
    /// Re-probe everything, ignoring the `(path, size, mtime)` fingerprint.
    pub force: bool,
    pub max_duration_ms: i64,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self { force: false, max_duration_ms: DEFAULT_MAX_DURATION_MS }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub scan_id: u64,
    pub done: usize,
    pub total: usize,
    pub current_path: String,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanComplete {
    pub scan_id: u64,
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub skipped: usize,
    /// Files that could not be probed. They are still indexed, carrying their
    /// error, so a broken file is visible rather than absent.
    pub failed: usize,
    pub elapsed_ms: u64,
}

struct Candidate {
    path: PathBuf,
    canonical: String,
    rel_path: String,
    size_bytes: i64,
    mtime: i64,
}

/// Walks one root, applying the §7.1 skip rules.
fn walk(root: &Path, root_canonical: &str) -> Vec<Candidate> {
    WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            // §7.1 skips: hidden files and anything under __MACOSX.
            if name == "__MACOSX" {
                return false;
            }
            !name.starts_with('.')
        })
        // A directory that cannot be read is skipped, not fatal: a permissions
        // hiccup partway through a library must not abandon the rest of it.
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter_map(|entry| {
            let path = entry.path();
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !AUDIO_EXTS.contains(&ext.as_str()) {
                return None;
            }
            let meta = entry.metadata().ok()?;
            // §7.1 skips zero-byte files.
            if meta.len() == 0 {
                return None;
            }
            let canonical = paths::canonicalize(path);
            let rel_path = relative_to(&canonical, root_canonical);
            Some(Candidate {
                path: path.to_path_buf(),
                canonical,
                rel_path,
                size_bytes: meta.len() as i64,
                mtime: meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0),
            })
        })
        .collect()
}

/// Strips the root prefix, leaving the path the folder tree and search text use.
fn relative_to(canonical: &str, root_canonical: &str) -> String {
    canonical
        .strip_prefix(root_canonical)
        .map(|rest| rest.trim_start_matches('\\').to_string())
        .unwrap_or_else(|| canonical.to_string())
}

fn parent_of(rel_path: &str) -> String {
    match rel_path.rfind('\\') {
        Some(i) => rel_path[..i].to_string(),
        None => String::new(),
    }
}

/// Runs a scan to completion on the calling thread, streaming progress.
pub fn run(
    app: &AppHandle,
    db: &Arc<Mutex<Connection>>,
    scan_id: u64,
    root_ids: &[i64],
    opts: ScanOptions,
) -> Result<ScanComplete, db::DbError> {
    let started = std::time::Instant::now();
    let mut report = ScanComplete { scan_id, ..Default::default() };

    let roots: Vec<db::LibraryRoot> = {
        let conn = db.lock().expect("db mutex poisoned");
        db::list_roots(&conn)?
            .into_iter()
            .filter(|r| root_ids.is_empty() || root_ids.contains(&r.id))
            .collect()
    };

    for root in roots {
        // ---- walk ------------------------------------------------------
        let candidates = walk(&paths::for_file_io(&root.path), &root.path);
        let total = candidates.len();

        let known = {
            let conn = db.lock().expect("db mutex poisoned");
            db::fingerprints(&conn, root.id)?
        };

        // ---- probe (parallel) ------------------------------------------
        // SPEC §13 wants no parallelism beyond wrapping the walk in rayon;
        // this is that one line. Progress is emitted from the fold so the UI
        // sees movement on a 5,000-file library rather than a frozen window.
        let done = std::sync::atomic::AtomicUsize::new(0);
        let probed: Vec<(Candidate, Option<probe::Probed>, Option<String>)> = candidates
            .into_par_iter()
            .map(|candidate| {
                let unchanged = !opts.force
                    && known
                        .get(&candidate.canonical)
                        .is_some_and(|(size, mtime)| {
                            *size == candidate.size_bytes && *mtime == candidate.mtime
                        });

                let outcome = if unchanged {
                    (candidate, None, None)
                } else {
                    match probe::probe(&paths::for_file_io(
                        &paths::canonicalize(&candidate.path),
                    )) {
                        Ok(p) => (candidate, Some(p), None),
                        Err(e) => (candidate, None, Some(e)),
                    }
                };

                let n = done.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                // Emitting every file would flood the IPC channel on a large
                // library; the UI only needs a moving number.
                if n % 25 == 0 || n == total {
                    let _ = app.emit(
                        "scan:progress",
                        ScanProgress {
                            scan_id,
                            done: n,
                            total,
                            current_path: outcome.0.canonical.clone(),
                        },
                    );
                }
                outcome
            })
            .collect();

        // ---- write (serial, one transaction) ---------------------------
        let mut conn = db.lock().expect("db mutex poisoned");
        let tx = conn.transaction()?;
        let mut seen: Vec<String> = Vec::with_capacity(probed.len());

        for (candidate, probe_result, probe_error) in probed {
            seen.push(candidate.canonical.clone());

            let Some(_) = probe_result.as_ref().map(|_| ()).or(probe_error.as_ref().map(|_| ()))
            else {
                // Unchanged since the last scan: nothing to write.
                report.skipped += 1;
                continue;
            };

            // The duration ceiling is applied after probing, because duration
            // is not knowable before it. A file over the ceiling is left out of
            // the index entirely rather than indexed and hidden.
            if let Some(duration) = probe_result.as_ref().and_then(|p| p.duration_ms) {
                if duration > opts.max_duration_ms {
                    report.skipped += 1;
                    seen.pop();
                    continue;
                }
            }

            let is_new = !known.contains_key(&candidate.canonical);
            if probe_error.is_some() {
                report.failed += 1;
            }
            if is_new {
                report.added += 1;
            } else {
                report.updated += 1;
            }

            let filename = Path::new(&candidate.rel_path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| candidate.rel_path.clone());
            let probed = probe_result.unwrap_or_default();

            db::upsert_sample(
                &tx,
                &SampleUpsert {
                    root_id: root.id,
                    search_text: search::search_text(&candidate.rel_path),
                    parent_dir: parent_of(&candidate.rel_path),
                    ext: Path::new(&filename)
                        .extension()
                        .and_then(|e| e.to_str())
                        .unwrap_or("")
                        .to_ascii_lowercase(),
                    filename,
                    path: candidate.canonical,
                    rel_path: candidate.rel_path,
                    size_bytes: candidate.size_bytes,
                    mtime: candidate.mtime,
                    duration_ms: probed.duration_ms,
                    sample_rate: probed.sample_rate,
                    channels: probed.channels,
                    bit_depth: probed.bit_depth,
                    probe_error,
                },
            )?;
        }

        // Everything under this root the walk did not reach is gone.
        let seen_set: Vec<String> = seen.into_iter().collect::<HashSet<_>>().into_iter().collect();
        report.removed += db::mark_missing(&tx, root.id, &seen_set)?;
        tx.commit()?;
    }

    report.elapsed_ms = started.elapsed().as_millis() as u64;
    let _ = app.emit("scan:complete", report.clone());
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_are_stripped_to_the_root() {
        assert_eq!(
            relative_to(r"C:\Samples\808s\kick.wav", r"C:\Samples"),
            r"808s\kick.wav"
        );
        assert_eq!(relative_to(r"C:\Samples\kick.wav", r"C:\Samples"), "kick.wav");
        // A path outside the root keeps its full spelling rather than becoming
        // a misleading relative one.
        assert_eq!(relative_to(r"D:\Other\kick.wav", r"C:\Samples"), r"D:\Other\kick.wav");
    }

    #[test]
    fn parent_dir_is_the_folder_tree_key() {
        assert_eq!(parent_of(r"808s\Vinyl\kick.wav"), r"808s\Vinyl");
        assert_eq!(parent_of("kick.wav"), "");
    }
}
