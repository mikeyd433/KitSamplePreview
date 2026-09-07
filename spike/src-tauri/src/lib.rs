//! Kitbench Phase 0 spike -- THROWAWAY (SPEC §14).
//!
//! Answers one question: can a file be dragged from a Tauri v2 window onto a
//! Sitala pad inside REAPER on Windows and be accepted? Everything here exists
//! to make that question answerable and its answer recordable. None of it is
//! Kitbench: no SQLite, no scan pipeline, no audio engine.

mod sniff;

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{ipc::Response, AppHandle, Manager};

use sniff::FormatSniff;

/// Refuse to slurp anything absurd over IPC. The decode bench feeds one-shots.
const MAX_IPC_READ_BYTES: u64 = 128 * 1024 * 1024;

const AUDIO_EXTS: &[&str] = &[
    "wav", "wave", "bwf", "flac", "mp3", "ogg", "oga", "opus", "aif", "aiff", "aifc", "m4a", "aac",
];

#[derive(Debug, thiserror::Error)]
enum SpikeError {
    #[error("{0}")]
    Io(String),
    #[error("not a directory: {0}")]
    NotADirectory(String),
    #[error("file is {size} bytes, over the {max} byte IPC ceiling")]
    TooLarge { size: u64, max: u64 },
    // NB: not named `source` -- thiserror treats a field of that name as the
    // error source and requires it to implement std::error::Error.
    #[error("could not extend the asset protocol scope to {path}: {reason}. \
             Without this the webview cannot fetch anything under that folder (SPEC §3).")]
    AssetScope { path: String, reason: String },
}

/// SPEC §15: commands return a message the UI can actually display.
type CmdResult<T> = Result<T, String>;

fn io(context: &str, e: std::io::Error) -> SpikeError {
    SpikeError::Io(format!("{context}: {e}"))
}

// ---------------------------------------------------------------------------
// Path pre-flight
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PathCheck {
    input: String,
    exists: bool,
    is_file: bool,
    size_bytes: Option<u64>,
    /// What `dunce::canonicalize` makes of the input.
    ///
    /// This matters more than it looks: drag-rs canonicalizes every path with
    /// dunce before handing it to the shell, so THIS is the string that
    /// actually gets dragged -- not what is typed in the box. It is also the
    /// spike's cheapest look at the SPEC §3 path questions (UNC, MAX_PATH,
    /// non-ASCII) before a drag is even attempted.
    canonical: Option<String>,
    /// Set when canonicalization failed. drag-rs surfaces this as a drag error;
    /// a path that fails here will never reach Sitala.
    error: Option<String>,
    /// True when canonicalize returned a `\\?\`-prefixed verbatim path, which
    /// dunce only does when the path cannot be expressed in normal form --
    /// i.e. this is the MAX_PATH case, and a plausible drop-target tripwire.
    verbatim: bool,
    char_len: usize,
}

/// Pre-flight the paths in a drag row.
///
/// Worth doing before every drag: drag-rs's Windows path does
/// `get_file_data_object(&paths).unwrap()` on an `Option`, so a path that
/// canonicalizes but yields a null shell item id can panic the whole app rather
/// than returning an error. Checking first turns that crash into a red row.
#[tauri::command]
fn check_paths(paths: Vec<String>) -> Vec<PathCheck> {
    paths
        .into_iter()
        .map(|input| {
            let p = Path::new(&input);
            let meta = std::fs::metadata(p);
            let (exists, is_file, size_bytes) = match &meta {
                Ok(m) => (true, m.is_file(), Some(m.len())),
                Err(_) => (false, false, None),
            };
            let (canonical, error) = match dunce::canonicalize(p) {
                Ok(c) => (Some(c.to_string_lossy().into_owned()), None),
                Err(e) => (None, Some(e.to_string())),
            };
            let verbatim = canonical.as_deref().is_some_and(|c| c.starts_with(r"\\?\"));
            let char_len = canonical.as_deref().unwrap_or(&input).chars().count();
            PathCheck { input, exists, is_file, size_bytes, canonical, error, verbatim, char_len }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Decode bench (SPEC §14, "second, unrelated test")
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioFile {
    path: String,
    name: String,
    ext: String,
    size_bytes: u64,
    format: FormatSniff,
}

/// Lists audio files in one folder (non-recursive) and opens the asset protocol
/// scope onto it.
///
/// The scope call is the point of this command as much as the listing is. SPEC
/// §3 flags it: roots are chosen at runtime, so the scope has to be widened
/// through the runtime API rather than declared in `tauri.conf.json`, and when
/// it is missing the webview's `fetch` fails in a way that looks exactly like a
/// decode bug. Doing it here means the spike proves out the Phase 1 mechanism
/// for free.
#[tauri::command]
fn scan_decode_dir(app: AppHandle, dir: String) -> CmdResult<Vec<AudioFile>> {
    let root = PathBuf::from(&dir);
    if !root.is_dir() {
        return Err(SpikeError::NotADirectory(dir).to_string());
    }

    app.asset_protocol_scope()
        .allow_directory(&root, false)
        .map_err(|e| {
            SpikeError::AssetScope { path: dir.clone(), reason: e.to_string() }.to_string()
        })?;

    let entries = std::fs::read_dir(&root)
        .map_err(|e| io("read_dir", e).to_string())?;

    let mut out = Vec::new();
    for entry in entries {
        // A single unreadable entry must not sink the listing (SPEC §15).
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !AUDIO_EXTS.contains(&ext.as_str()) {
            continue;
        }
        let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(AudioFile {
            name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
            format: sniff::sniff(&path),
            path: path.to_string_lossy().into_owned(),
            ext,
            size_bytes,
        });
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

/// Hands raw file bytes to the webview over IPC.
///
/// This is the decode bench's control arm, not something Kitbench would ship.
/// If `decodeAudioData` refuses a file fetched through the asset protocol but
/// accepts the same bytes delivered this way, the fault is the protocol or its
/// scope; if both refuse, the decoder genuinely does not support the format.
/// Without both arms a failure is ambiguous and costs the afternoon SPEC §3
/// warns about.
#[tauri::command]
fn read_file_bytes(path: String) -> CmdResult<Response> {
    let p = PathBuf::from(&path);
    let meta = std::fs::metadata(&p).map_err(|e| io("stat", e).to_string())?;
    if meta.len() > MAX_IPC_READ_BYTES {
        return Err(SpikeError::TooLarge { size: meta.len(), max: MAX_IPC_READ_BYTES }.to_string());
    }
    let bytes = std::fs::read(&p).map_err(|e| io("read", e).to_string())?;
    Ok(Response::new(bytes))
}

// ---------------------------------------------------------------------------
// Environment, for the report
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvInfo {
    os: String,
    arch: String,
    tauri_version: String,
    webview_version: String,
    drag_plugin_note: String,
}

/// Fills in the header of RESULTS.md so the findings are attributable to a
/// specific WebView2 build -- "decodeAudioData refused AIFF" means little
/// without one.
#[tauri::command]
fn env_info() -> EnvInfo {
    EnvInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        tauri_version: tauri::VERSION.to_string(),
        webview_version: tauri::webview_version()
            .unwrap_or_else(|e| format!("unavailable: {e}")),
        drag_plugin_note: concat!(
            "tauri-plugin-drag 2.x -> drag-rs. On Windows it builds a shell IDataObject via ",
            "SHCreateShellItemArrayFromIDLists + BHID_DataObject and calls DoDragDrop with ",
            "DROPEFFECT_COPY, serving CF_HDROP (fWide=1, UTF-16). That is the same data object ",
            "Explorer produces, so a drop target cannot tell the two apart."
        )
        .to_string(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_drag::init())
        .invoke_handler(tauri::generate_handler![
            check_paths,
            scan_decode_dir,
            read_file_bytes,
            env_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Kitbench spike");
}
