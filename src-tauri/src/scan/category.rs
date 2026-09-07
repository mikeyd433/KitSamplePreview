//! Filename-pattern category inference (SPEC §7.1).
//!
//! "Deliberately dumb... It will be wrong sometimes. It exists to power the
//! quick-filter chips, and the user can override it. Do not attempt
//! audio-content classification in v1."
//!
//! Runs on the normalised search text (see `search.rs`), so the tokens are
//! already lowercased and split — which is what lets short codes like `bd` and
//! `hh` be matched as whole words rather than as substrings that would fire on
//! any filename containing those two letters.

/// How a pattern matches against the normalised search text.
enum Pattern {
    /// One complete token, or its simple plural. Sample packs name folders
    /// "Rims" and "Sticks" as often as "Rim" and "Stick", and matching those as
    /// substrings would fire on "trim" and "lipstick".
    Word(&'static str),
    /// One complete token exactly. For two-letter codes, where even a plural
    /// would be wrong: `sd`, `bd`, `hh`.
    Token(&'static str),
    /// Anywhere in the text. For words long and distinctive enough that a
    /// substring match cannot plausibly be something else.
    Contains(&'static str),
}

use Pattern::{Contains, Token, Word};

/// Ordered: the first category that matches wins.
///
/// The order carries most of the accuracy, and three placements are deliberate.
///
/// fx leads because words like `reverse`, `riser` and `transition` describe
/// what was done to a sound rather than what made it. A reverse cymbal swell is
/// transition material, and putting it in the cymbal chip spoils the one filter
/// that exists to find cymbals.
///
/// 808 comes last, as a fallback. `KICK_808_deep` and `SNARE_808_tight` are a
/// kick and a snare that happen to be 808s; a file called `Deep 808` is an 808
/// because nothing more specific fits. Trap packs put "808" in nearly every
/// filename, so any earlier placement reclassifies half the library.
///
/// hat precedes cymbal because `HH_foot_splash` is a hi-hat before it is a
/// splash.
///
/// Beyond that this is a heuristic feeding a filter chip, and SPEC §7.1 expects
/// it to be wrong sometimes -- which is why a wrong answer can be corrected and
/// the correction survives a rescan.
const CATEGORIES: &[(&str, &[Pattern])] = &[
    ("fx", &[
        Token("fx"), Contains("riser"), Contains("impact"), Contains("sweep"),
        Contains("swell"), Contains("reverse"), Word("transition"), Contains("downlifter"),
        Contains("uplifter"), Contains("whoosh"), Word("drone"), Contains("ambience"),
    ]),
    ("kick", &[Contains("kick"), Token("bd"), Contains("bassdrum"), Contains("bass drum")]),
    ("snare", &[Contains("snare"), Token("sd"), Contains("rimshot"), Word("rim")]),
    ("clap", &[Contains("clap"), Token("cp")]),
    ("hat", &[Contains("hihat"), Contains("hat"), Token("hh")]),
    ("tom", &[Word("tom"), Contains("floor tom")]),
    ("cymbal", &[
        Contains("cymbal"), Contains("crash"), Word("ride"), Word("china"),
        Contains("splash"), Word("gong"),
    ]),
    ("perc", &[
        Contains("perc"), Contains("shaker"), Contains("tamb"), Contains("conga"),
        Contains("bongo"), Contains("cowbell"), Contains("clave"), Word("block"),
        Contains("triangle"), Contains("agogo"), Contains("cabasa"), Contains("guiro"),
        Word("stick"), Word("woodblock"), Contains("castanet"),
    ]),
    // Last, as a fallback: an 808 is whatever was not identifiable as a
    // specific drum. Trap packs put "808" in nearly every filename, so placing
    // this any earlier reclassifies every 808-named snare, hat and clap in the
    // library -- which the tests caught it doing.
    //
    // Its own category rather than folded into kick, because the packs ship a
    // folder of them and an 808 is played as a bass line as often as a kick. A
    // deviation from SPEC §7.3's chip list, which predates seeing a real
    // library.
    ("808", &[Word("808"), Contains("sub bass")]),
    ("vox", &[
        Word("vox"), Contains("vocal"), Word("voice"), Contains("adlib"), Contains("ad lib"),
        Word("chant"), Contains("phrase"),
    ]),
];

fn matches(text: &str, patterns: &[Pattern]) -> bool {
    patterns.iter().any(|pattern| match pattern {
        Contains(needle) => text.contains(needle),
        Token(needle) => text.split(' ').any(|token| token == *needle),
        Word(needle) => text.split(' ').any(|token| {
            token == *needle
                // "rims", "sticks", "toms" -- and "boxes" for the -es plural.
                || token.strip_suffix('s').is_some_and(|stem| stem == *needle)
                || token.strip_suffix("es").is_some_and(|stem| stem == *needle)
        }),
    })
}

fn first_match(text: &str) -> Option<&'static str> {
    CATEGORIES
        .iter()
        .find(|(_, patterns)| matches(text, patterns))
        .map(|(name, _)| *name)
}

/// Infers a category from a sample's filename, falling back to its folders.
///
/// Filename first, deliberately. A snare living in a folder called `Kicks`
/// is a snare — the more specific name should win, and checking the whole path
/// at once would let the folder outvote it.
pub fn infer(filename_text: &str, full_text: &str) -> Option<String> {
    first_match(filename_text)
        .or_else(|| first_match(full_text))
        .map(str::to_string)
}

/// Bumped whenever the patterns above change.
///
/// The app re-infers on launch when this differs from what the library was last
/// filed under, so improved rules reach existing rows. Without it the only way
/// to benefit would be a full rescan, which re-reads every byte of every file
/// to recompute waveforms that have not changed.
pub const RULES_VERSION: i64 = 2;

/// Re-files every sample whose category is still a guess.
///
/// Reads nothing from disk: `rel_path` and `filename` are already in the index,
/// and they are all inference ever looked at. Corrections are left alone --
/// that is what `category_user_set` is for.
pub fn reinfer_all(conn: &mut rusqlite::Connection) -> Result<usize, rusqlite::Error> {
    let rows: Vec<(i64, String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT id, filename, rel_path FROM sample WHERE category_user_set = 0",
        )?;
        let mapped = stmt.query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
        mapped.collect::<Result<Vec<_>, _>>()?
    };

    let tx = conn.transaction()?;
    let mut changed = 0;
    {
        let mut update = tx.prepare("UPDATE sample SET category = ?1 WHERE id = ?2")?;
        for (id, filename, rel_path) in rows {
            let category = infer(
                &crate::search::search_text(&filename),
                &crate::search::search_text(&rel_path),
            );
            changed += update.execute(rusqlite::params![category, id])?;
        }
    }
    tx.commit()?;
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::search_text;

    fn infer_path(rel_path: &str) -> Option<String> {
        let filename = crate::paths::file_name(rel_path);
        infer(&search_text(filename), &search_text(rel_path))
    }

    #[test]
    fn recognises_the_obvious_names() {
        for (path, expected) in [
            (r"KICK_808_deep.wav", "kick"),
            (r"BD_ludwig_hard.wav", "kick"),
            (r"bass drum 01.wav", "kick"),
            (r"SNARE_808_tight.wav", "snare"),
            (r"SD_ludwig_center.wav", "snare"),
            (r"SD_ludwig_rimshot.wav", "snare"),
            (r"HH_808_closed.wav", "hat"),
            (r"hihat_808_pedal.wav", "hat"),
            (r"CLAP_vinyl.wav", "clap"),
            (r"TOM_mid_01.wav", "tom"),
            (r"CRASH_18in.wav", "cymbal"),
            (r"RIDE_bell.wav", "cymbal"),
            (r"conga_high.wav", "perc"),
            (r"tamb_hit.wav", "perc"),
            (r"riser_short.wav", "fx"),
            (r"reverse_cymbal_swell.wav", "fx"),
        ] {
            assert_eq!(infer_path(path).as_deref(), Some(expected), "path: {path}");
        }
    }

    #[test]
    fn the_filename_outvotes_the_folder() {
        // A snare in a folder called Kicks is a snare.
        assert_eq!(infer_path(r"808s\Kicks\snare_ghost.wav").as_deref(), Some("snare"));
        // But a folder is better than nothing when the name says little.
        assert_eq!(infer_path(r"808s\Kicks\01.wav").as_deref(), Some("kick"));
        assert_eq!(infer_path(r"Acoustic\Snares\02.wav").as_deref(), Some("snare"));
    }

    #[test]
    fn short_codes_match_whole_tokens_only() {
        // The reason `bd`, `sd`, `hh` and `cp` are tokens and not substrings.
        // Each of these contains the letters and means nothing of the sort.
        assert_eq!(infer_path("sidestick.wav"), None);
        assert_eq!(infer_path("bdrum_like_name.wav"), None);
        assert_eq!(infer_path("cposition.wav"), None);
        // And the codes still work when they are genuinely their own word.
        assert_eq!(infer_path("BD_01.wav").as_deref(), Some("kick"));
        assert_eq!(infer_path("SD-02.wav").as_deref(), Some("snare"));
    }

    #[test]
    fn priority_resolves_the_genuine_ambiguities() {
        // A foot splash is a hi-hat before it is a cymbal.
        assert_eq!(infer_path("HH_foot_splash.wav").as_deref(), Some("hat"));
        // A kick with a clap layered on is filed as a kick.
        assert_eq!(infer_path("kick_with_clap_layer.wav").as_deref(), Some("kick"));
        // Processing words win over the source instrument: these are
        // transition sounds, and the cymbal chip is for finding cymbals.
        assert_eq!(infer_path("reverse_cymbal_swell.wav").as_deref(), Some("fx"));
        assert_eq!(infer_path("impact_boom.wav").as_deref(), Some("fx"));
        // But an ordinary cymbal is still a cymbal.
        assert_eq!(infer_path("CRASH_18in.wav").as_deref(), Some("cymbal"));
    }

    /// The folder names from three real packs, each with its own convention.
    /// This is the case the heuristic exists to survive: the same drum lives in
    /// "1. KICK", "Kicks" and "-Kick Textures" depending on who made the pack.
    #[test]
    fn handles_real_pack_folder_conventions() {
        for (folder, expected) in [
            // Numbered, shouted.
            ("1. KICK", "kick"),
            ("2. SNARE", "snare"),
            ("3. HI-HAT", "hat"),
            ("4. OPEN HAT", "hat"),
            ("5. PERC", "perc"),
            ("6. 808", "808"),
            ("7. CLAP", "clap"),
            ("8. VOX", "vox"),
            ("9. FX", "fx"),
            ("10. TRANSITIONS", "fx"),
            // Plain plurals, from another pack.
            ("808s", "808"),
            ("Claps", "clap"),
            ("Hi Hats", "hat"),
            ("Kicks", "kick"),
            ("Open Hi Hats", "hat"),
            ("Percs", "perc"),
            ("Snares", "snare"),
            ("FX", "fx"),
            // Dashed subfolders, from a third.
            ("-Kick Textures", "kick"),
            ("- Secondary Snares", "snare"),
            ("- Rims", "snare"),
            ("- Shakers", "perc"),
            ("- Sticks", "perc"),
            ("- Triangles", "perc"),
        ] {
            let path = format!(r"{folder}\something.wav");
            assert_eq!(
                infer_path(&path).as_deref(),
                Some(expected),
                "folder: {folder}"
            );
        }
    }

    #[test]
    fn an_808_named_kick_is_still_a_kick() {
        // The ordering that matters most in a trap library: nearly every kick
        // has "808" in its name, and filing them all as 808 would empty the
        // kick chip.
        assert_eq!(infer_path("KICK_808_deep.wav").as_deref(), Some("kick"));
        assert_eq!(infer_path("808 Kick Punchy.wav").as_deref(), Some("kick"));
        // But an 808 that is not called a kick is an 808.
        assert_eq!(infer_path("Deep 808.wav").as_deref(), Some("808"));
        assert_eq!(infer_path(r"6. 808\Reese.wav").as_deref(), Some("808"));
    }

    #[test]
    fn plurals_match_without_letting_substrings_in() {
        // The reason short words are Word and not Contains.
        assert_eq!(infer_path("Rims.wav").as_deref(), Some("snare"));
        assert_eq!(infer_path("Sticks.wav").as_deref(), Some("perc"));
        assert_eq!(infer_path("Toms.wav").as_deref(), Some("tom"));
        // None of these are drums.
        assert_eq!(infer_path("trim the top.wav"), None);
        assert_eq!(infer_path("lipstick.wav"), None);
        assert_eq!(infer_path("custom bounce.wav"), None);
        assert_eq!(infer_path("override take.wav"), None);
        assert_eq!(infer_path("bride march.wav"), None);
    }

    #[test]
    fn a_nested_folder_inherits_from_its_parent() {
        // "3. HI-HAT\1 - Trap\loop.wav": the leaf says nothing, the path does.
        assert_eq!(infer_path(r"3. HI-HAT\1 - Trap\01.wav").as_deref(), Some("hat"));
        assert_eq!(infer_path(r"5. PERC\- Shakers\02.wav").as_deref(), Some("perc"));
        assert_eq!(infer_path(r"2. SNARE\- Secondary Snares\x.wav").as_deref(), Some("snare"));
    }

    /// Re-filing must reach stale guesses and leave corrections alone. If it
    /// got this backwards, improving the patterns would silently discard every
    /// correction the user had made.
    #[test]
    fn reinference_updates_guesses_and_respects_corrections() {
        let mut conn = crate::db::open_in_memory().unwrap();
        conn.execute(
            "INSERT INTO library_root (id, path, label, added_at) VALUES (1, 'C:\\P', 'P', 0)",
            [],
        )
        .unwrap();

        let insert = |conn: &rusqlite::Connection, id: i64, rel: &str, cat: Option<&str>, user: i64| {
            conn.execute(
                "INSERT INTO sample (id, root_id, path, rel_path, filename, parent_dir, ext,
                                     size_bytes, mtime, search_text, category,
                                     category_user_set, scanned_at)
                 VALUES (?1, 1, ?2, ?3, ?4, '', 'wav', 10, 0, ?5, ?6, ?7, 0)",
                rusqlite::params![
                    id,
                    format!(r"C:\P\{rel}"),
                    rel,
                    crate::paths::file_name(rel),
                    crate::search::search_text(rel),
                    cat,
                    user,
                ],
            )
            .unwrap();
        };

        // A guess the old rules could not place, which the new ones can.
        insert(&conn, 1, r"5. PERC\- Rims\Rim 01.wav", None, 0);
        // A guess that was wrong and should be revised.
        insert(&conn, 2, r"6. 808\Deep 808.wav", Some("kick"), 0);
        // A correction, which must survive.
        insert(&conn, 3, r"1. KICK\Blight Kick.wav", Some("perc"), 1);

        let changed = reinfer_all(&mut conn).unwrap();
        assert_eq!(changed, 2, "only the two guesses should be rewritten");

        let category = |id: i64| -> Option<String> {
            conn.query_row("SELECT category FROM sample WHERE id = ?1", [id], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(category(1).as_deref(), Some("snare"), "Rims now files as snare");
        assert_eq!(category(2).as_deref(), Some("808"), "a stale guess is revised");
        assert_eq!(category(3).as_deref(), Some("perc"), "the correction is untouched");
    }

    #[test]
    fn unrecognised_names_stay_uncategorised() {
        // Better an empty category than a confidently wrong chip: the user can
        // override, but only if the tool admits it does not know.
        assert_eq!(infer_path("Untitled-1.wav"), None);
        assert_eq!(infer_path("loop_92bpm.wav"), None);
        assert_eq!(infer_path("take 04.wav"), None);
    }
}
