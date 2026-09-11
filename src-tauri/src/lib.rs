//! Kitbench — a drum sample auditioner that sits beside REAPER and feeds Sitala.
//!
//! Phase 1 (SPEC §9): browse and preview. Multi-root scanning with progress, a
//! SQLite index, a virtualized list and folder tree, `LIKE` text search, and
//! auto-preview-on-selection.

pub mod commands;
pub mod convert;
pub mod db;
pub mod paths;
pub mod pitch;
pub mod scan;
pub mod search;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // SPEC §7.8's drag-out. The JS side calls the plugin directly from a
        // real mouse event; see the note in the frontend's drag module for why
        // it is not wrapped in a command of our own.
        .plugin(tauri_plugin_drag::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let conn = db::open(&data_dir.join("kitbench.sqlite3"))?;

            // Re-open the asset protocol onto every known root at startup.
            // The scope is runtime state, not persisted config, so it has to be
            // rebuilt each launch or preview silently fails for every existing
            // root (SPEC §3).
            for root in db::list_roots(&conn)? {
                if let Err(e) = app
                    .asset_protocol_scope()
                    .allow_directory(paths::for_file_io(&root.path), true)
                {
                    // A root on a disconnected drive should not stop the app
                    // from starting; the rest of the library still works.
                    eprintln!("could not restore asset scope for {}: {e}", root.path);
                }
            }

            // Re-file guesses when the inference rules have changed since this
            // library was last scanned. Costs one pass over the index and no
            // disk reads, which is why it can run unprompted -- the alternative
            // is asking for a full rescan that re-analyses every file to
            // recompute waveforms that have not moved.
            let mut conn = conn;
            let filed_under: i64 = db::get_setting(&conn, "category.rulesVersion")?
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            if filed_under != scan::category::RULES_VERSION {
                match scan::category::reinfer_all(&mut conn) {
                    Ok(changed) => {
                        eprintln!("re-filed {changed} samples under category rules v{}",
                                  scan::category::RULES_VERSION);
                        db::set_setting(
                            &conn,
                            "category.rulesVersion",
                            &scan::category::RULES_VERSION.to_string(),
                        )?;
                    }
                    // A failure here must not stop the app opening; the
                    // categories simply stay as they were.
                    Err(e) => eprintln!("could not re-file categories: {e}"),
                }
            }

            app.manage(commands::AppState::new(conn));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_roots,
            commands::add_root,
            commands::remove_root,
            commands::scan_roots,
            commands::list_samples,
            commands::get_sample,
            commands::folder_tree,
            commands::resolve_playable,
            commands::render_pitched,
            commands::set_tags,
            commands::list_tags,
            commands::category_counts,
            commands::set_category,
            commands::get_settings,
            commands::set_setting,
            commands::list_kits,
            commands::save_kit,
            commands::load_kit,
            commands::delete_kit,
            commands::export_kit,
            commands::ffmpeg_available,
            commands::app_version,
            commands::can_update,
            commands::update_and_restart,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kitbench");
}
