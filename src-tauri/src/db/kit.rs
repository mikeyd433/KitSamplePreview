//! Kits: sixteen slots, saved by name (SPEC §4, §7.7).
//!
//! Slots reference samples by id and nothing is copied until export. A kit
//! whose underlying file has moved shows the slot as broken rather than
//! silently empty — which is why `sample` rows are marked removed instead of
//! deleted.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::{now_secs, query::SampleRow, DbError};

/// Sitala's grid, and therefore ours (SPEC §7.7).
pub const SLOT_COUNT: usize = 16;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KitSummary {
    pub id: i64,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// Slots holding a sample, so the picker can say "11/16" without loading.
    pub filled: i64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KitSlot {
    pub slot_index: i64,
    pub sample_id: Option<i64>,
    pub gain_db_offset: f64,
    pub notes: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KitSlotDetail {
    #[serde(flatten)]
    pub slot: KitSlot,
    /// The sample, when the slot holds one. Carries `removed` and the
    /// last-known path, so a broken slot can say what it lost (SPEC §7.7).
    pub sample: Option<SampleRow>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KitDetail {
    pub id: i64,
    pub name: String,
    pub slots: Vec<KitSlotDetail>,
}

pub fn list_kits(conn: &Connection) -> Result<Vec<KitSummary>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT k.id, k.name, k.created_at, k.updated_at,
                (SELECT COUNT(*) FROM kit_slot s
                  WHERE s.kit_id = k.id AND s.sample_id IS NOT NULL)
           FROM kit k
          ORDER BY k.updated_at DESC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(KitSummary {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                filled: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Creates a kit, or replaces the slots of one with the same name.
///
/// Saving over a name rather than accumulating near-duplicates: SPEC §7.7 says
/// save/load/duplicate by name, and "Dusty Break" meaning two different kits
/// helps nobody.
pub fn save_kit(conn: &mut Connection, name: &str, slots: &[KitSlot]) -> Result<i64, DbError> {
    let tx = conn.transaction()?;
    let now = now_secs();

    let existing: Option<i64> = tx
        .query_row("SELECT id FROM kit WHERE name = ?1", params![name], |r| r.get(0))
        .optional()?;

    let kit_id = match existing {
        Some(id) => {
            tx.execute("UPDATE kit SET updated_at = ?1 WHERE id = ?2", params![now, id])?;
            tx.execute("DELETE FROM kit_slot WHERE kit_id = ?1", params![id])?;
            id
        }
        None => {
            tx.execute(
                "INSERT INTO kit (name, created_at, updated_at) VALUES (?1, ?2, ?3)",
                params![name, now, now],
            )?;
            tx.last_insert_rowid()
        }
    };

    for slot in slots {
        // Empty slots are not stored: absence is the natural representation of
        // an empty pad, and it keeps a fresh kit from writing sixteen null rows.
        if slot.sample_id.is_none() && slot.gain_db_offset == 0.0 && slot.notes.is_none() {
            continue;
        }
        tx.execute(
            "INSERT INTO kit_slot (kit_id, slot_index, sample_id, gain_db_offset, notes)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![kit_id, slot.slot_index, slot.sample_id, slot.gain_db_offset, slot.notes],
        )?;
    }

    tx.commit()?;
    Ok(kit_id)
}

pub fn load_kit(conn: &Connection, kit_id: i64) -> Result<Option<KitDetail>, DbError> {
    let Some((id, name)) = conn
        .query_row("SELECT id, name FROM kit WHERE id = ?1", params![kit_id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })
        .optional()?
    else {
        return Ok(None);
    };

    let mut slots: Vec<KitSlotDetail> = (0..SLOT_COUNT as i64)
        .map(|slot_index| KitSlotDetail {
            slot: KitSlot { slot_index, sample_id: None, gain_db_offset: 0.0, notes: None },
            sample: None,
        })
        .collect();

    let mut stmt = conn.prepare(
        "SELECT slot_index, sample_id, gain_db_offset, notes FROM kit_slot WHERE kit_id = ?1",
    )?;
    let stored = stmt
        .query_map(params![id], |row| {
            Ok(KitSlot {
                slot_index: row.get(0)?,
                sample_id: row.get(1)?,
                gain_db_offset: row.get(2)?,
                notes: row.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    for slot in stored {
        let index = slot.slot_index;
        if !(0..SLOT_COUNT as i64).contains(&index) {
            continue;
        }
        let sample = match slot.sample_id {
            // A sample the scan has since marked removed still resolves, so the
            // slot can render its error state with the last-known path.
            Some(sample_id) => super::query::get_sample(conn, sample_id)?,
            None => None,
        };
        if let Some(entry) = slots.get_mut(index as usize) {
            *entry = KitSlotDetail { slot, sample };
        }
    }

    Ok(Some(KitDetail { id, name, slots }))
}

pub fn delete_kit(conn: &Connection, kit_id: i64) -> Result<(), DbError> {
    conn.execute("DELETE FROM kit WHERE id = ?1", params![kit_id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn slot(index: i64, sample_id: Option<i64>) -> KitSlot {
        KitSlot { slot_index: index, sample_id, gain_db_offset: 0.0, notes: None }
    }

    #[test]
    fn a_kit_round_trips_through_sixteen_slots() {
        let mut conn = db::open_in_memory().unwrap();
        let slots = vec![slot(0, None), slot(3, None), slot(15, None)];
        let id = save_kit(&mut conn, "Dusty Break", &slots).unwrap();

        let loaded = load_kit(&conn, id).unwrap().expect("kit missing");
        assert_eq!(loaded.name, "Dusty Break");
        // Always sixteen, whatever was stored: the tray is a fixed grid and the
        // UI should never have to invent the gaps.
        assert_eq!(loaded.slots.len(), SLOT_COUNT);
        for (i, entry) in loaded.slots.iter().enumerate() {
            assert_eq!(entry.slot.slot_index, i as i64);
        }
    }

    #[test]
    fn saving_the_same_name_replaces_rather_than_accumulates() {
        let mut conn = db::open_in_memory().unwrap();
        save_kit(&mut conn, "Kit", &[slot(0, None)]).unwrap();
        save_kit(&mut conn, "Kit", &[slot(1, None)]).unwrap();
        assert_eq!(list_kits(&conn).unwrap().len(), 1);
    }

    #[test]
    fn deleting_a_kit_leaves_its_samples_alone() {
        // SPEC §2: Kitbench reads the library; it never reorganises it. A kit
        // is a shortlist, and throwing the shortlist away is not the same as
        // throwing the samples away.
        let mut conn = db::open_in_memory().unwrap();
        conn.execute(
            "INSERT INTO library_root (id, path, label, added_at) VALUES (1, 'C:\\S', 'S', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sample (id, root_id, path, rel_path, filename, parent_dir, ext,
                                 size_bytes, mtime, search_text, scanned_at)
             VALUES (7, 1, 'C:\\S\\k.wav', 'k.wav', 'k.wav', '', 'wav', 10, 0, 'k wav', 0)",
            [],
        )
        .unwrap();

        let id = save_kit(&mut conn, "Kit", &[slot(0, Some(7))]).unwrap();
        delete_kit(&conn, id).unwrap();

        let still_there: i64 = conn
            .query_row("SELECT COUNT(*) FROM sample WHERE id = 7", [], |r| r.get(0))
            .unwrap();
        assert_eq!(still_there, 1);
    }

    #[test]
    fn a_slot_pointing_at_a_removed_sample_still_resolves() {
        // §7.7: a slot whose file has gone missing renders in an error state
        // with its last-known path, rather than quietly emptying.
        let mut conn = db::open_in_memory().unwrap();
        conn.execute(
            "INSERT INTO library_root (id, path, label, added_at) VALUES (1, 'C:\\S', 'S', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sample (id, root_id, path, rel_path, filename, parent_dir, ext,
                                 size_bytes, mtime, search_text, removed_at, scanned_at)
             VALUES (9, 1, 'C:\\S\\gone.wav', 'gone.wav', 'gone.wav', '', 'wav', 10, 0,
                     'gone wav', 123, 0)",
            [],
        )
        .unwrap();

        let id = save_kit(&mut conn, "Kit", &[slot(2, Some(9))]).unwrap();
        let loaded = load_kit(&conn, id).unwrap().unwrap();
        let entry = &loaded.slots[2];
        let sample = entry.sample.as_ref().expect("removed sample should still resolve");
        assert!(sample.removed);
        assert_eq!(sample.path, r"C:\S\gone.wav");
    }
}
