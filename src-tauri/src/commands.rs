//! The SPEC §5 command surface.
//!
//! Every command returns `Result<T, String>` carrying a message the UI can
//! display (SPEC §15). Nothing here unwraps on filesystem or user data.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::convert;
use crate::db;
use crate::paths;
use crate::pitch;
use crate::scan;

pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    pub scan_seq: AtomicU64,
}

impl AppState {
    pub fn new(conn: Connection) -> Self {
        Self { db: Arc::new(Mutex::new(conn)), scan_seq: AtomicU64::new(1) }
    }
}

type CmdResult<T> = Result<T, String>;

fn to_msg(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Opens the asset protocol onto a folder.
///
/// SPEC §3: roots are chosen at runtime, so the scope has to be widened through
/// the runtime API rather than declared in `tauri.conf.json`, and a scope miss
/// surfaces in the webview as a bare fetch failure that looks exactly like a
/// decode bug. Phase 0's decode bench confirmed this call works and that
/// `convertFileSrc` + `fetch` + `decodeAudioData` is sound on WebView2.
fn allow_asset_access(app: &AppHandle, path: &str) -> Result<(), String> {
    app.asset_protocol_scope()
        .allow_directory(paths::for_file_io(path), true)
        .map_err(|e| format!("could not open the asset protocol onto {path}: {e}"))
}

// ---------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_roots(state: State<'_, AppState>) -> CmdResult<Vec<db::LibraryRoot>> {
    let conn = state.db.lock().map_err(to_msg)?;
    db::list_roots(&conn).map_err(to_msg)
}

#[tauri::command]
pub fn add_root(app: AppHandle, state: State<'_, AppState>, path: String) -> CmdResult<i64> {
    let raw = std::path::PathBuf::from(&path);
    if !raw.is_dir() {
        return Err(format!("not a folder: {path}"));
    }
    let canonical = paths::canonicalize(&raw);
    let label = paths::file_name(&canonical).to_string();

    allow_asset_access(&app, &canonical)?;
    let conn = state.db.lock().map_err(to_msg)?;
    db::add_root(&conn, &canonical, &label).map_err(to_msg)
}

#[tauri::command]
pub fn remove_root(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let conn = state.db.lock().map_err(to_msg)?;
    db::remove_root(&conn, id).map_err(to_msg)
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/// Starts a scan and returns immediately with its id.
///
/// The work runs on a background thread and reports through `scan:progress`
/// and `scan:complete`, because SPEC §7.1 is explicit that a 5,000-file library
/// must not present a frozen window.
#[tauri::command]
pub fn scan_roots(
    app: AppHandle,
    state: State<'_, AppState>,
    roots: Vec<String>,
    force: bool,
) -> CmdResult<u64> {
    let scan_id = state.scan_seq.fetch_add(1, Ordering::SeqCst);
    let db = Arc::clone(&state.db);

    // Resolve the requested root paths to ids up front, so a bad path is an
    // error the caller sees rather than a silent no-op in a detached thread.
    let root_ids: Vec<i64> = {
        let conn = db.lock().map_err(to_msg)?;
        let all = db::list_roots(&conn).map_err(to_msg)?;
        if roots.is_empty() {
            Vec::new() // empty means every root
        } else {
            let wanted: Vec<String> =
                roots.iter().map(|r| paths::canonicalize(std::path::Path::new(r))).collect();
            let ids: Vec<i64> =
                all.iter().filter(|r| wanted.contains(&r.path)).map(|r| r.id).collect();
            if ids.is_empty() {
                return Err("none of the given paths are library roots".into());
            }
            ids
        }
    };

    let max_duration_ms = {
        let conn = db.lock().map_err(to_msg)?;
        db::get_setting(&conn, "scan.maxDurationMs")
            .map_err(to_msg)?
            .and_then(|v| v.parse().ok())
            .unwrap_or(scan::DEFAULT_MAX_DURATION_MS)
    };

    std::thread::spawn(move || {
        // Analysis stays on: SPEC §11.4's metadata-only mode is the pressure
        // valve for a large library on a slow disk, not something to reach for
        // at current scale.
        let opts = scan::ScanOptions { force, max_duration_ms, analyze: true };
        if let Err(e) = scan::run(&app, &db, scan_id, &root_ids, opts) {
            use tauri::Emitter;
            let _ = app.emit("scan:error", format!("scan failed: {e}"));
        }
    });

    Ok(scan_id)
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/// SPEC §5 sketches this as returning `Vec<SampleRow>`; it returns a page
/// carrying the unpaginated total alongside the rows, because §7.3 wants the
/// result count visible at all times and counting client-side is impossible
/// once pagination is real.
#[tauri::command]
pub fn list_samples(
    state: State<'_, AppState>,
    query: db::SampleQuery,
) -> CmdResult<db::SamplePage> {
    let conn = state.db.lock().map_err(to_msg)?;
    db::list_samples(&conn, &query).map_err(to_msg)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleDetail {
    #[serde(flatten)]
    pub row: db::SampleRow,
    pub tags: Vec<String>,
}

#[tauri::command]
pub fn get_sample(state: State<'_, AppState>, id: i64) -> CmdResult<Option<SampleDetail>> {
    let conn = state.db.lock().map_err(to_msg)?;
    let Some(row) = db::get_sample(&conn, id).map_err(to_msg)? else {
        return Ok(None);
    };
    let tags = db::tags_for(&conn, id).map_err(to_msg)?;
    Ok(Some(SampleDetail { row, tags }))
}

/// Folders holding at least one sample, flat; the UI nests them (SPEC §6).
#[tauri::command]
pub fn folder_tree(
    state: State<'_, AppState>,
    root_id: Option<i64>,
) -> CmdResult<Vec<db::FolderNode>> {
    let conn = state.db.lock().map_err(to_msg)?;
    db::folder_tree(&conn, root_id).map_err(to_msg)
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Playable {
    /// The file the webview should fetch. Today always the original; once the
    /// ffmpeg sidecar lands (Phase 3) this becomes the cached transcode for
    /// formats WebView2 will not decode.
    pub path: String,
    /// True when `path` is a transcode rather than the user's file.
    pub transcoded: bool,
}

/// Resolves a sample to something the webview can decode (SPEC §5, §8).
///
/// Returns a path rather than a URL: `convertFileSrc` lives in the JS API, and
/// having Rust hand-assemble `http://asset.localhost/...` would duplicate
/// Tauri's own encoding rules for no gain. The decision the command exists to
/// make — original file or transcode — stays here.
///
/// Phase 0 measured what actually needs transcoding: WebView2 decodes every WAV
/// variant tested, and refuses AIFF and AIFC. Nothing else. So this is a
/// pass-through until Phase 3, and it reports `transcoded: false` honestly
/// rather than pretending to have done work.
#[tauri::command]
pub fn resolve_playable(state: State<'_, AppState>, id: i64) -> CmdResult<Playable> {
    let conn = state.db.lock().map_err(to_msg)?;
    let row = db::get_sample(&conn, id).map_err(to_msg)?.ok_or("no such sample")?;
    if row.removed {
        return Err(format!("file is missing: {}", row.path));
    }
    // The file-I/O spelling, not the stored one. They differ for a path over
    // MAX_PATH, where the asset protocol handler needs the `\\?\` prefix to open
    // the file at all — so returning the stored form would make exactly the
    // deeply-nested samples SPEC §3 warns about unpreviewable.
    Ok(Playable {
        path: paths::for_file_io(&row.path).to_string_lossy().into_owned(),
        transcoded: false,
    })
}

/// Renders a sample at a semitone offset and returns the file.
///
/// Needed because a pitch that exists only as a playback rate cannot be dragged
/// anywhere: Sitala is handed a path, so a pitched pad has to become a real
/// file before it leaves the app. Cached under the app's data directory, so
/// dragging the same pad twice renders once -- and never beside the user's
/// samples, which SPEC §2 keeps read-only.
///
/// At unity it returns the source untouched rather than rendering a copy: pad 1
/// of a chromatic spread is the original sample and should drag as itself.
#[tauri::command]
pub fn render_pitched(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
    semitones: f64,
) -> CmdResult<Playable> {
    let source = {
        let conn = state.db.lock().map_err(to_msg)?;
        let row = db::get_sample(&conn, id).map_err(to_msg)?.ok_or("no such sample")?;
        if row.removed {
            return Err(format!("file is missing: {}", row.path));
        }
        row.path
    };
    let source = paths::for_file_io(&source);

    if pitch::is_unity(semitones) {
        return Ok(Playable {
            path: source.to_string_lossy().into_owned(),
            transcoded: false,
        });
    }

    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("no cache directory: {e}"))?
        .join("pitched");
    let out = pitch::render(&source, semitones, &cache)?;
    Ok(Playable { path: out.to_string_lossy().into_owned(), transcoded: true })
}

// ---------------------------------------------------------------------------
// Tags and settings
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppVersion {
    pub version: String,
    /// Short commit this binary was built from; a trailing "+" means the
    /// working tree was dirty.
    pub commit: String,
    pub built_at: i64,
}

/// What is actually running.
///
/// Not in SPEC §5's surface. It earns a command because the app is updated by
/// rebuilding from a branch, which makes "is this the latest?" a real question
/// with no other way to answer it — and a stale build that looks current is the
/// kind of thing that costs an hour before anyone suspects it.
#[tauri::command]
pub fn app_version() -> AppVersion {
    AppVersion {
        // Cargo.toml is the single source of truth for the version;
        // tauri.conf.json inherits it rather than repeating it.
        version: env!("CARGO_PKG_VERSION").to_string(),
        commit: env!("KITBENCH_COMMIT").to_string(),
        built_at: env!("KITBENCH_BUILT_AT").parse().unwrap_or(0),
    }
}

/// The update script this build was made from, if it is still there.
fn update_script() -> Option<std::path::PathBuf> {
    let repo = env!("KITBENCH_REPO_DIR");
    if repo.is_empty() {
        return None;
    }
    let script = std::path::Path::new(repo).join("scripts").join("update-kitbench.ps1");
    script.is_file().then_some(script)
}

/// Whether in-app updating is possible from this build.
#[tauri::command]
pub fn can_update() -> bool {
    cfg!(windows) && update_script().is_some()
}

/// Rebuilds from the latest commit and relaunches.
///
/// Necessarily a hand-off rather than an in-place update: Windows will not let
/// a running executable be overwritten, so the app cannot rebuild itself. It
/// starts the same PowerShell script the Desktop shortcut was made by, in its
/// own console window so a multi-minute build is visible rather than looking
/// like a hang, and then quits so the build can replace the binary. The script
/// relaunches when it finishes.
///
/// If the build fails the app simply does not come back, and the old binary is
/// still on disk — the Desktop icon still works. The console stays open with
/// the error.
#[tauri::command]
pub fn update_and_restart(app: AppHandle) -> CmdResult<()> {
    let script = update_script()
        .ok_or("this build has no update script beside it — use the Desktop shortcut")?;

    let mut cmd = std::process::Command::new("powershell");
    cmd.arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(&script)
        .arg("-Relaunch");

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Its own console: the build takes minutes and needs to be watchable.
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        cmd.creation_flags(CREATE_NEW_CONSOLE);
    }

    cmd.spawn().map_err(|e| format!("could not start the updater: {e}"))?;

    // Quit only once the updater is actually running, so a failure to launch
    // leaves the app open with an error rather than closing into nothing.
    app.exit(0);
    Ok(())
}

// ---------------------------------------------------------------------------
// Kits (SPEC §7.7)
// ---------------------------------------------------------------------------
//
// SPEC §5 does not name these. §15 says a new command probably belongs as a
// parameter on an existing one — but a kit is not a filter over samples, and
// save/load/delete are three genuinely different verbs.

#[tauri::command]
pub fn list_kits(state: State<'_, AppState>) -> CmdResult<Vec<db::KitSummary>> {
    let conn = state.db.lock().map_err(to_msg)?;
    db::list_kits(&conn).map_err(to_msg)
}

#[tauri::command]
pub fn save_kit(
    state: State<'_, AppState>,
    name: String,
    slots: Vec<db::KitSlot>,
) -> CmdResult<i64> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("a kit needs a name".into());
    }
    let mut conn = state.db.lock().map_err(to_msg)?;
    db::save_kit(&mut conn, &name, &slots).map_err(to_msg)
}

#[tauri::command]
pub fn load_kit(state: State<'_, AppState>, id: i64) -> CmdResult<Option<db::KitDetail>> {
    let conn = state.db.lock().map_err(to_msg)?;
    db::load_kit(&conn, id).map_err(to_msg)
}

#[tauri::command]
pub fn delete_kit(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let conn = state.db.lock().map_err(to_msg)?;
    db::delete_kit(&conn, id).map_err(to_msg)
}

// ---------------------------------------------------------------------------
// Export (SPEC §7.8)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn export_kit(
    app: AppHandle,
    state: State<'_, AppState>,
    kit_id: i64,
    dest_dir: String,
    options: convert::ExportOptions,
) -> CmdResult<convert::ExportReport> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("no cache directory: {e}"))?
        .join("pitched");
    let conn = state.db.lock().map_err(to_msg)?;
    let override_path = db::get_setting(&conn, "export.ffmpegPath").map_err(to_msg)?;
    convert::export_kit(&conn, kit_id, &dest_dir, &options, override_path.as_deref(), &cache)
        .map_err(to_msg)
}

/// Whether format conversion is available.
///
/// The export dialog asks up front rather than letting the user pick a sample
/// rate, press go, and only then discover the sidecar is missing. With every
/// option left as-is the export is a copy and needs no ffmpeg at all — which,
/// after Phase 0, is the normal case.
#[tauri::command]
pub fn ffmpeg_available(state: State<'_, AppState>) -> CmdResult<bool> {
    let conn = state.db.lock().map_err(to_msg)?;
    let override_path = db::get_setting(&conn, "export.ffmpegPath").map_err(to_msg)?;
    Ok(convert::find_sidecar(override_path.as_deref()).is_some())
}

#[tauri::command]
pub fn set_tags(state: State<'_, AppState>, sample_id: i64, tags: Vec<String>) -> CmdResult<()> {
    let conn = state.db.lock().map_err(to_msg)?;
    db::set_tags(&conn, sample_id, &tags).map_err(to_msg)
}

/// Takes the same query as `list_samples` so the counts describe what is in
/// view, not what is in the library. Its own category filter is ignored; see
/// `db::category_counts`.
#[tauri::command]
pub fn category_counts(
    state: State<'_, AppState>,
    query: db::SampleQuery,
) -> CmdResult<Vec<db::CategoryCount>> {
    let conn = state.db.lock().map_err(to_msg)?;
    db::category_counts(&conn, &query).map_err(to_msg)
}

/// Corrects the category on one sample or a whole selection.
///
/// `category: None` files them as uncategorised; `clear` hands them back to
/// inference instead, so a bad correction is undoable without guessing what the
/// guess would have been.
#[tauri::command]
pub fn set_category(
    state: State<'_, AppState>,
    ids: Vec<i64>,
    category: Option<String>,
    clear: bool,
) -> CmdResult<usize> {
    let mut conn = state.db.lock().map_err(to_msg)?;
    if clear {
        return db::clear_category_override(&mut conn, &ids).map_err(to_msg);
    }
    db::set_category(&mut conn, &ids, category.as_deref()).map_err(to_msg)
}

#[tauri::command]
pub fn list_tags(state: State<'_, AppState>) -> CmdResult<Vec<db::TagCount>> {
    let conn = state.db.lock().map_err(to_msg)?;
    db::list_tags(&conn).map_err(to_msg)
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> CmdResult<serde_json::Value> {
    let conn = state.db.lock().map_err(to_msg)?;
    let max_duration = db::get_setting(&conn, "scan.maxDurationMs")
        .map_err(to_msg)?
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(scan::DEFAULT_MAX_DURATION_MS);
    // SPEC §7.9 keeps settings in the database rather than localStorage, so the
    // view survives a reinstall along with everything else.
    let view_mode = db::get_setting(&conn, "view.mode")
        .map_err(to_msg)?
        .unwrap_or_else(|| "list".to_string());
    let number = |key: &str, fallback: f64| -> Result<f64, String> {
        Ok(db::get_setting(&conn, key)
            .map_err(to_msg)?
            .and_then(|v| v.parse().ok())
            .unwrap_or(fallback))
    };
    Ok(serde_json::json!({
        "scanMaxDurationMs": max_duration,
        "viewMode": view_mode,
        // Body match is the SPEC §7.6 default.
        "normalizeMode": db::get_setting(&conn, "preview.normalizeMode")
            .map_err(to_msg)?
            .unwrap_or_else(|| "body".to_string()),
        "targetPeakDb": number("preview.targetPeakDb", -1.0)?,
        "targetRmsDb": number("preview.targetRmsDb", -18.0)?,
    }))
}

#[tauri::command]
pub fn set_setting(state: State<'_, AppState>, key: String, value: String) -> CmdResult<()> {
    let conn = state.db.lock().map_err(to_msg)?;
    db::set_setting(&conn, &key, &value).map_err(to_msg)
}
