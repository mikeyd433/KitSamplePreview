//! Kitbench — a drum sample auditioner that sits beside REAPER and feeds Sitala.
//!
//! Phase 1 (SPEC §9): browse and preview. Multi-root scanning with progress, a
//! SQLite index, a virtualized list and folder tree, `LIKE` text search, and
//! auto-preview-on-selection.

pub mod commands;
pub mod db;
pub mod paths;
pub mod scan;
pub mod search;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            commands::set_tags,
            commands::list_tags,
            commands::get_settings,
            commands::set_setting,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kitbench");
}
