//! Typed queries over the index. The §5 command surface is a thin shell on top.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use super::{now_secs, DbError};

// ---------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LibraryRoot {
    pub id: i64,
    pub path: String,
    pub label: String,
    pub added_at: i64,
    pub sample_count: i64,
}

pub fn list_roots(conn: &Connection) -> Result<Vec<LibraryRoot>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT r.id, r.path, r.label, r.added_at,
                (SELECT COUNT(*) FROM sample s
                  WHERE s.root_id = r.id AND s.removed_at IS NULL)
           FROM library_root r
          ORDER BY r.label COLLATE NOCASE",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(LibraryRoot {
                id: row.get(0)?,
                path: row.get(1)?,
                label: row.get(2)?,
                added_at: row.get(3)?,
                sample_count: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Adds a root, or returns the existing one. Idempotent because the canonical
/// path is unique: adding `C:\Samples\` twice, or once as `c:/samples`, is one
/// root (SPEC §3).
pub fn add_root(conn: &Connection, canonical_path: &str, label: &str) -> Result<i64, DbError> {
    if let Some(id) = conn
        .query_row(
            "SELECT id FROM library_root WHERE path = ?1",
            params![canonical_path],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
    {
        return Ok(id);
    }
    conn.execute(
        "INSERT INTO library_root (path, label, added_at) VALUES (?1, ?2, ?3)",
        params![canonical_path, label, now_secs()],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn remove_root(conn: &Connection, id: i64) -> Result<(), DbError> {
    // Samples cascade; kit slots referencing them become NULL rather than
    // vanishing, so a kit can still show which pad lost its file.
    conn.execute("DELETE FROM library_root WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SampleRow {
    pub id: i64,
    pub root_id: i64,
    pub path: String,
    pub rel_path: String,
    pub filename: String,
    pub parent_dir: String,
    pub ext: String,
    pub size_bytes: i64,
    pub duration_ms: Option<i64>,
    pub sample_rate: Option<i64>,
    pub channels: Option<i64>,
    pub bit_depth: Option<i64>,
    pub category: Option<String>,
    pub removed: bool,
    /// Why the file could not be probed. A row with this set still appears in
    /// the list — a broken file the user cannot see is a file they cannot fix.
    pub probe_error: Option<String>,
}

fn sample_row_from(row: &Row<'_>) -> rusqlite::Result<SampleRow> {
    Ok(SampleRow {
        id: row.get(0)?,
        root_id: row.get(1)?,
        path: row.get(2)?,
        rel_path: row.get(3)?,
        filename: row.get(4)?,
        parent_dir: row.get(5)?,
        ext: row.get(6)?,
        size_bytes: row.get(7)?,
        duration_ms: row.get(8)?,
        sample_rate: row.get(9)?,
        channels: row.get(10)?,
        bit_depth: row.get(11)?,
        category: row.get(12)?,
        removed: row.get::<_, Option<i64>>(13)?.is_some(),
        probe_error: row.get(14)?,
    })
}

const SAMPLE_COLUMNS: &str = "id, root_id, path, rel_path, filename, parent_dir, ext, \
     size_bytes, duration_ms, sample_rate, channels, bit_depth, category, removed_at, probe_error";

/// What the scan hands back for one file.
pub struct SampleUpsert {
    pub root_id: i64,
    pub path: String,
    pub rel_path: String,
    pub filename: String,
    pub parent_dir: String,
    pub ext: String,
    pub size_bytes: i64,
    pub mtime: i64,
    pub duration_ms: Option<i64>,
    pub sample_rate: Option<i64>,
    pub channels: Option<i64>,
    pub bit_depth: Option<i64>,
    pub search_text: String,
    pub probe_error: Option<String>,
}

/// Inserts or refreshes one sample.
///
/// Clears `removed_at`, so a file that comes back after being deleted returns
/// to life on the same row — and any kit slot pointing at it starts working
/// again instead of staying broken.
pub fn upsert_sample(conn: &Connection, s: &SampleUpsert) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO sample (root_id, path, rel_path, filename, parent_dir, ext, size_bytes,
                             mtime, duration_ms, sample_rate, channels, bit_depth, search_text,
                             probe_error, removed_at, scanned_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, NULL, ?15)
         ON CONFLICT(path) DO UPDATE SET
             root_id = excluded.root_id,
             rel_path = excluded.rel_path,
             filename = excluded.filename,
             parent_dir = excluded.parent_dir,
             ext = excluded.ext,
             size_bytes = excluded.size_bytes,
             mtime = excluded.mtime,
             duration_ms = excluded.duration_ms,
             sample_rate = excluded.sample_rate,
             channels = excluded.channels,
             bit_depth = excluded.bit_depth,
             search_text = excluded.search_text,
             probe_error = excluded.probe_error,
             removed_at = NULL,
             scanned_at = excluded.scanned_at",
        params![
            s.root_id, s.path, s.rel_path, s.filename, s.parent_dir, s.ext, s.size_bytes,
            s.mtime, s.duration_ms, s.sample_rate, s.channels, s.bit_depth, s.search_text,
            s.probe_error, now_secs()
        ],
    )?;
    Ok(())
}

/// `path -> (size, mtime)` for one root, so the scan can skip unchanged files.
///
/// SPEC §13 keeps this: a dozen lines now, and the thing that makes a
/// 20,000-file rescan bearable later.
pub fn fingerprints(conn: &Connection, root_id: i64) -> Result<HashMap<String, (i64, i64)>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT path, size_bytes, mtime FROM sample WHERE root_id = ?1 AND removed_at IS NULL",
    )?;
    let mut out = HashMap::new();
    let rows = stmt.query_map(params![root_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?))
    })?;
    for row in rows {
        let (path, size, mtime) = row?;
        out.insert(path, (size, mtime));
    }
    Ok(out)
}

/// Marks everything under a root that this scan did not see.
///
/// Marked, not deleted (SPEC §7.1): a kit slot whose file has moved reports
/// "missing" with its last-known path rather than silently emptying.
pub fn mark_missing(conn: &Connection, root_id: i64, seen: &[String]) -> Result<usize, DbError> {
    let mut stmt = conn.prepare(
        "SELECT path FROM sample WHERE root_id = ?1 AND removed_at IS NULL",
    )?;
    let existing = stmt
        .query_map(params![root_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    let seen: std::collections::HashSet<&str> = seen.iter().map(String::as_str).collect();
    let now = now_secs();
    let mut marked = 0;
    for path in existing {
        if !seen.contains(path.as_str()) {
            conn.execute(
                "UPDATE sample SET removed_at = ?1 WHERE path = ?2",
                params![now, path],
            )?;
            marked += 1;
        }
    }
    Ok(marked)
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct SampleQuery {
    pub root_id: Option<i64>,
    /// `rel_path` prefix, from the folder tree.
    pub subtree: Option<String>,
    pub text: Option<String>,
    pub category: Option<String>,
    pub tags: Vec<String>,
    pub min_duration_ms: Option<i64>,
    pub max_duration_ms: Option<i64>,
    pub exts: Vec<String>,
    pub include_removed: bool,
    /// Paginated even though v1 asks for everything, so the call site does not
    /// change when it stops being able to (SPEC §13).
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SamplePage {
    /// Total matching the filters, ignoring pagination — §7.3 wants the count
    /// visible at all times, because going from 2,000 files to 12 is the point.
    pub total: i64,
    pub rows: Vec<SampleRow>,
}

/// Escapes a user's search term for `LIKE ... ESCAPE '\'`.
fn like_pattern(term: &str) -> String {
    let mut out = String::with_capacity(term.len() + 2);
    out.push('%');
    for c in term.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

/// Builds the shared WHERE clause and its bound parameters.
fn where_clause(q: &SampleQuery) -> (String, Vec<Box<dyn rusqlite::ToSql>>) {
    let mut clauses: Vec<String> = Vec::new();
    let mut binds: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if !q.include_removed {
        clauses.push("s.removed_at IS NULL".into());
    }
    if let Some(root_id) = q.root_id {
        binds.push(Box::new(root_id));
        clauses.push(format!("s.root_id = ?{}", binds.len()));
    }
    if let Some(subtree) = q.subtree.as_deref().filter(|s| !s.is_empty()) {
        // Prefix match on the relative path, with the separator appended so
        // that "Kicks" does not also match "Kicks Extra".
        binds.push(Box::new(format!("{}\\%", subtree.trim_end_matches('\\'))));
        clauses.push(format!("s.rel_path LIKE ?{} ESCAPE '\\'", binds.len()));
    }
    if let Some(text) = q.text.as_deref() {
        // One AND-ed LIKE per whitespace-separated term, so "808 kick" matches
        // in any order (SPEC §4, §7.3).
        for term in crate::search::query_terms(text) {
            binds.push(Box::new(like_pattern(&term)));
            clauses.push(format!("s.search_text LIKE ?{} ESCAPE '\\'", binds.len()));
        }
    }
    if let Some(category) = q.category.as_deref().filter(|c| !c.is_empty()) {
        binds.push(Box::new(category.to_string()));
        clauses.push(format!("s.category = ?{}", binds.len()));
    }
    if let Some(min) = q.min_duration_ms {
        binds.push(Box::new(min));
        clauses.push(format!("s.duration_ms >= ?{}", binds.len()));
    }
    if let Some(max) = q.max_duration_ms {
        binds.push(Box::new(max));
        clauses.push(format!("s.duration_ms <= ?{}", binds.len()));
    }
    if !q.exts.is_empty() {
        let mut placeholders = Vec::new();
        for ext in &q.exts {
            binds.push(Box::new(ext.to_lowercase()));
            placeholders.push(format!("?{}", binds.len()));
        }
        clauses.push(format!("s.ext IN ({})", placeholders.join(", ")));
    }
    // AND semantics: a sample must carry every selected tag (SPEC §7.3).
    for tag in &q.tags {
        binds.push(Box::new(tag.to_string()));
        clauses.push(format!(
            "EXISTS (SELECT 1 FROM sample_tag st JOIN tag t ON t.id = st.tag_id
                      WHERE st.sample_id = s.id AND t.name = ?{})",
            binds.len()
        ));
    }

    let sql = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };
    (sql, binds)
}

pub fn list_samples(conn: &Connection, q: &SampleQuery) -> Result<SamplePage, DbError> {
    let (where_sql, binds) = where_clause(q);
    let bind_refs: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|b| b.as_ref()).collect();

    let total: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM sample s{where_sql}"),
        bind_refs.as_slice(),
        |row| row.get(0),
    )?;

    let limit = q.limit.unwrap_or(-1);
    let offset = q.offset.unwrap_or(0);
    let sql = format!(
        "SELECT {SAMPLE_COLUMNS} FROM sample s{where_sql}
          ORDER BY s.rel_path COLLATE NOCASE
          LIMIT {limit} OFFSET {offset}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(bind_refs.as_slice(), sample_row_from)?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(SamplePage { total, rows })
}

pub fn get_sample(conn: &Connection, id: i64) -> Result<Option<SampleRow>, DbError> {
    let row = conn
        .query_row(
            &format!("SELECT {SAMPLE_COLUMNS} FROM sample s WHERE s.id = ?1"),
            params![id],
            sample_row_from,
        )
        .optional()?;
    Ok(row)
}

// ---------------------------------------------------------------------------
// Folder tree
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderNode {
    pub root_id: i64,
    /// Directory relative to its root. Empty string means the root itself.
    pub rel_dir: String,
    /// Samples directly in this folder, not counting subfolders.
    pub sample_count: i64,
}

/// Every folder that holds at least one sample.
///
/// Returned flat and nested by the UI: the tree is small even for a large
/// library, and a flat list keeps the recursion in one place.
pub fn folder_tree(conn: &Connection, root_id: Option<i64>) -> Result<Vec<FolderNode>, DbError> {
    let mut sql = String::from(
        "SELECT root_id, parent_dir, COUNT(*) FROM sample WHERE removed_at IS NULL",
    );
    if root_id.is_some() {
        sql.push_str(" AND root_id = ?1");
    }
    sql.push_str(" GROUP BY root_id, parent_dir ORDER BY parent_dir COLLATE NOCASE");

    let mut stmt = conn.prepare(&sql)?;
    let map = |row: &Row<'_>| {
        Ok(FolderNode {
            root_id: row.get(0)?,
            rel_dir: row.get(1)?,
            sample_count: row.get(2)?,
        })
    };
    let rows = match root_id {
        Some(id) => stmt.query_map(params![id], map)?.collect::<Result<Vec<_>, _>>()?,
        None => stmt.query_map([], map)?.collect::<Result<Vec<_>, _>>()?,
    };
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

pub fn set_tags(conn: &Connection, sample_id: i64, tags: &[String]) -> Result<(), DbError> {
    conn.execute("DELETE FROM sample_tag WHERE sample_id = ?1", params![sample_id])?;
    for name in tags {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        conn.execute("INSERT OR IGNORE INTO tag (name) VALUES (?1)", params![name])?;
        let tag_id: i64 = conn.query_row(
            "SELECT id FROM tag WHERE name = ?1",
            params![name],
            |r| r.get(0),
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO sample_tag (sample_id, tag_id) VALUES (?1, ?2)",
            params![sample_id, tag_id],
        )?;
    }
    Ok(())
}

pub fn tags_for(conn: &Connection, sample_id: i64) -> Result<Vec<String>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT t.name FROM tag t JOIN sample_tag st ON st.tag_id = t.id
          WHERE st.sample_id = ?1 ORDER BY t.name COLLATE NOCASE",
    )?;
    let rows = stmt
        .query_map(params![sample_id], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub name: String,
    pub sample_count: i64,
}

pub fn list_tags(conn: &Connection) -> Result<Vec<TagCount>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT t.name, COUNT(st.sample_id)
           FROM tag t LEFT JOIN sample_tag st ON st.tag_id = t.id
          GROUP BY t.id ORDER BY t.name COLLATE NOCASE",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(TagCount { name: row.get(0)?, sample_count: row.get(1)? })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Settings (SPEC §7.9)
// ---------------------------------------------------------------------------

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>, DbError> {
    Ok(conn
        .query_row("SELECT value FROM setting WHERE key = ?1", params![key], |r| r.get(0))
        .optional()?)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO setting (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}
