-- Kitbench schema (SPEC §4).
--
-- The full shape is created up front even though Phase 1 populates only part of
-- it. SPEC §13: schema is expensive to change later, thresholds are not — so
-- `peaks`, `true_peak_db`, `body_rms_db` and `category` sit here unpopulated
-- until Phase 2 rather than arriving as a migration that has to touch every row.

CREATE TABLE IF NOT EXISTS library_root (
  id         INTEGER PRIMARY KEY,
  path       TEXT NOT NULL UNIQUE,   -- canonical, see paths.rs
  label      TEXT NOT NULL,
  added_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sample (
  id           INTEGER PRIMARY KEY,
  root_id      INTEGER NOT NULL REFERENCES library_root(id) ON DELETE CASCADE,
  path         TEXT NOT NULL UNIQUE,  -- absolute, canonical
  rel_path     TEXT NOT NULL,         -- relative to root; drives the folder tree
  filename     TEXT NOT NULL,
  parent_dir   TEXT NOT NULL,
  ext          TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  mtime        INTEGER NOT NULL,      -- with (path, size) decides incremental rescan
  duration_ms  INTEGER,
  sample_rate  INTEGER,
  channels     INTEGER,
  bit_depth    INTEGER,               -- null for compressed formats
  true_peak_db REAL,                  -- Phase 2
  body_rms_db  REAL,                  -- Phase 2, RMS of the loudest 300ms window
  peaks        BLOB,                  -- Phase 2, 400 min/max i8 pairs
  category     TEXT,                  -- Phase 2, inferred, user-overridable
  search_text  TEXT NOT NULL,         -- normalised; see search.rs
  -- Set when a scan no longer finds the file. Rows are marked, never deleted,
  -- so a kit slot pointing at it can say "missing" instead of silently emptying
  -- (SPEC §7.1, §4).
  removed_at   INTEGER,
  -- Non-null when the file could not be probed: a malformed WAV must not sink
  -- the scan, it must land as a visible row carrying its reason (SPEC §15).
  probe_error  TEXT,
  scanned_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sample_root_idx    ON sample(root_id);
CREATE INDEX IF NOT EXISTS sample_parent_idx  ON sample(parent_dir);
CREATE INDEX IF NOT EXISTS sample_category_idx ON sample(category);
CREATE INDEX IF NOT EXISTS sample_ext_idx     ON sample(ext);
CREATE INDEX IF NOT EXISTS sample_removed_idx ON sample(removed_at);
-- Ordering index: the list is sorted by name within a subtree and paginated.
CREATE INDEX IF NOT EXISTS sample_sort_idx    ON sample(root_id, rel_path);

CREATE TABLE IF NOT EXISTS tag (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS sample_tag (
  sample_id INTEGER NOT NULL REFERENCES sample(id) ON DELETE CASCADE,
  tag_id    INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  PRIMARY KEY (sample_id, tag_id)
);

CREATE INDEX IF NOT EXISTS sample_tag_tag_idx ON sample_tag(tag_id);

CREATE TABLE IF NOT EXISTS kit (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kit_slot (
  kit_id         INTEGER NOT NULL REFERENCES kit(id) ON DELETE CASCADE,
  slot_index     INTEGER NOT NULL CHECK (slot_index BETWEEN 0 AND 15),
  -- Slots reference samples by id; nothing is copied until export (SPEC §4).
  sample_id      INTEGER REFERENCES sample(id) ON DELETE SET NULL,
  gain_db_offset REAL NOT NULL DEFAULT 0,
  notes          TEXT,
  PRIMARY KEY (kit_id, slot_index)
);

-- Settings live here rather than in localStorage (SPEC §7.9).
CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
