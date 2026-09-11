//! SQLite index (SPEC §4).

pub mod kit;
pub mod query;

use std::path::Path;

use rusqlite::Connection;

pub use kit::*;
pub use query::*;

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("database error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("could not create the data directory: {0}")]
    DataDir(String),
}

/// Bumped whenever `schema.sql` changes shape. Phase 1 ships version 1; the
/// FTS5 table SPEC §4 defers is an additive migration to version 2 that needs
/// no re-scan, because `search_text` is already populated.
const SCHEMA_VERSION: i64 = 3;

pub fn open(path: &Path) -> Result<Connection, DbError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| DbError::DataDir(e.to_string()))?;
    }
    let conn = Connection::open(path)?;
    configure(&conn)?;
    migrate(&conn)?;
    Ok(conn)
}

/// An in-memory database, for tests.
#[cfg(test)]
pub fn open_in_memory() -> Result<Connection, DbError> {
    let conn = Connection::open_in_memory()?;
    configure(&conn)?;
    migrate(&conn)?;
    Ok(conn)
}

fn configure(conn: &Connection) -> Result<(), DbError> {
    // WAL keeps the UI's reads from blocking behind a scan's writes, which is
    // the whole point of streaming scan progress (SPEC §7.1).
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

fn migrate(conn: &Connection) -> Result<(), DbError> {
    let mut current: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;

    if current == 0 {
        conn.execute_batch(include_str!("schema.sql"))?;
        current = SCHEMA_VERSION;
    }

    // Ordered, additive steps. Each one must leave an existing library intact:
    // a rescan is cheap, but re-tagging and rebuilding kits by hand is not.
    if current < 2 {
        conn.execute_batch(
            "ALTER TABLE sample ADD COLUMN category_user_set INTEGER NOT NULL DEFAULT 0",
        )?;
        current = 2;
    }
    if current < 3 {
        // Defaults to 0, so every kit saved before the chromatic spread
        // reopens at the pitch it was built at.
        conn.execute_batch("ALTER TABLE kit_slot ADD COLUMN semitones REAL NOT NULL DEFAULT 0")?;
        current = 3;
    }

    conn.pragma_update(None, "user_version", current)?;
    Ok(())
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
