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

/// A pattern is either a whole token or a substring of the joined text.
enum Pattern {
    /// Matches one complete token. For short codes, where a substring match
    /// would be a false-positive machine: `sd` inside "sidestick", `bd` inside
    /// "bdrum-ish" names, `hh` inside almost anything.
    Token(&'static str),
    /// Matches anywhere. For words long enough to be unambiguous.
    Contains(&'static str),
}

use Pattern::{Contains, Token};

/// Ordered: the first category that matches wins.
///
/// Order resolves the genuine ambiguities, and two of them are worth stating.
///
/// fx comes first because words like `reverse`, `riser` and `swell` describe
/// what was done to a sound rather than what made it. A reverse cymbal swell
/// is transition material, not something anyone maps to a cymbal pad, and
/// filing it under cymbal would pollute the chip that exists to find cymbals.
///
/// hat precedes cymbal because `HH_foot_splash` is a hi-hat before it is a
/// splash. Beyond that nothing here is principled: it is a heuristic feeding a
/// filter chip, and SPEC §7.1 expects it to be wrong sometimes.
const CATEGORIES: &[(&str, &[Pattern])] = &[
    ("fx", &[
        Token("fx"), Contains("riser"), Contains("impact"), Contains("sweep"),
        Contains("swell"), Contains("reverse"), Contains("downlifter"), Contains("uplifter"),
    ]),
    ("kick", &[Contains("kick"), Token("bd"), Contains("bassdrum"), Contains("bass drum")]),
    ("snare", &[Contains("snare"), Token("sd"), Contains("rimshot"), Token("rim")]),
    ("clap", &[Contains("clap"), Token("cp")]),
    ("hat", &[Contains("hihat"), Contains("hat"), Token("hh")]),
    ("tom", &[Contains("tom"), Token("floor")]),
    ("cymbal", &[
        Contains("cymbal"), Contains("crash"), Contains("ride"),
        Contains("china"), Contains("splash"), Contains("gong"),
    ]),
    ("perc", &[
        Contains("perc"), Contains("shaker"), Contains("tamb"), Contains("conga"),
        Contains("bongo"), Contains("cowbell"), Contains("clave"), Contains("block"),
        Contains("triangle"), Contains("agogo"), Contains("cabasa"), Contains("guiro"),
    ]),
];

fn matches(text: &str, patterns: &[Pattern]) -> bool {
    patterns.iter().any(|pattern| match pattern {
        Contains(needle) => text.contains(needle),
        Token(needle) => text.split(' ').any(|token| token == *needle),
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

    #[test]
    fn unrecognised_names_stay_uncategorised() {
        // Better an empty category than a confidently wrong chip: the user can
        // override, but only if the tool admits it does not know.
        assert_eq!(infer_path("Untitled-1.wav"), None);
        assert_eq!(infer_path("loop_92bpm.wav"), None);
        assert_eq!(infer_path("take 04.wav"), None);
    }
}
