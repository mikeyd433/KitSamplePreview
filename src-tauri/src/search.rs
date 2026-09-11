//! Search text normalisation (SPEC §4).
//!
//! `sample.search_text` holds the path relative to its library root, lowercased
//! and broken into words at separators and camelCase boundaries, so that
//! `Vinyl_808s/KICK_808_deep-02.wav` becomes `vinyl 808s kick 808 deep 02 wav`
//! and an AND-ed `LIKE '%term%'` per search word matches in any order.
//!
//! Doing the work here rather than in the query is what makes §4's eventual
//! FTS5 upgrade additive: the tokens are already in the column, so adding a
//! virtual table over it needs no re-scan and no re-analysis.
//!
//! Relative to the root, not absolute, deliberately. An absolute path drags
//! every row's drive letter and home directory into the index — harmless for
//! precision under AND semantics, but it bloats the column and lets a stray
//! search for "users" match the entire library.

/// Normalises one relative path into space-separated search tokens.
pub fn search_text(relative_path: &str) -> String {
    let mut words: Vec<String> = Vec::new();
    let mut current = String::new();

    let flush = |current: &mut String, words: &mut Vec<String>| {
        if !current.is_empty() {
            words.push(std::mem::take(current));
        }
    };

    let chars: Vec<char> = relative_path.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        // Separators: path delimiters and the punctuation sample packs use to
        // join words. `.` included, so the extension becomes its own token.
        if matches!(c, '/' | '\\' | '_' | '-' | '.' | ' ' | '\t' | '(' | ')' | '[' | ']' | '&' | '+' | ',' | '\'' | '#' | '@' | '!') {
            flush(&mut current, &mut words);
            continue;
        }

        // camelCase boundaries. Two cases: a lowercase or digit followed by an
        // uppercase (`deepKick`), and the end of an uppercase run that starts a
        // new word (`HHClosed` -> `hh closed`). Digits never split from
        // letters, so `808s` survives as one token — the spec's own example
        // depends on it.
        if c.is_uppercase() && !current.is_empty() {
            let prev = chars[i - 1];
            let next_is_lower = chars.get(i + 1).is_some_and(|n| n.is_lowercase());
            if prev.is_lowercase() || prev.is_ascii_digit() || (prev.is_uppercase() && next_is_lower) {
                flush(&mut current, &mut words);
            }
        }

        current.extend(c.to_lowercase());
    }
    flush(&mut current, &mut words);

    words.join(" ")
}

/// Splits a user's query into the terms that each become one AND-ed `LIKE`.
///
/// Lowercased to match the column, and de-duplicated so that pasting the same
/// word twice does not cost an extra scan of the table.
pub fn query_terms(query: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    for raw in query.split_whitespace() {
        let term = raw.to_lowercase();
        if !term.is_empty() && !terms.contains(&term) {
            terms.push(term);
        }
    }
    terms
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SPEC §15's third named test: "a table of filenames in, expected token
    /// strings out."
    #[test]
    fn normalizes_paths_to_tokens() {
        let cases = [
            // The spec's own worked example (§4).
            (r"Vinyl_808s\KICK_808_deep-02.wav", "vinyl 808s kick 808 deep 02 wav"),
            // Separators of every kind collapse to one space.
            (r"Acoustic\Kicks\kick.wav", "acoustic kicks kick wav"),
            ("a  b___c---d.wav", "a b c d wav"),
            // camelCase splits; digit-letter runs do not.
            ("deepKick.wav", "deep kick wav"),
            ("HHClosed.wav", "hh closed wav"),
            ("MyURLThing.wav", "my url thing wav"),
            ("808s.wav", "808s wav"),
            ("Kick808.wav", "kick808 wav"),
            // Real sample-pack punctuation.
            ("Kick (Hard) [Dry].wav", "kick hard dry wav"),
            ("Snare & Clap.wav", "snare clap wav"),
            ("Don't Stop.wav", "don t stop wav"),
            // Non-ASCII lowercases without being torn apart.
            ("Café_Ünïcode.wav", "café ünïcode wav"),
            // Nothing in, nothing out.
            ("", ""),
        ];
        for (input, expected) in cases {
            assert_eq!(search_text(input), expected, "input: {input:?}");
        }
    }

    #[test]
    fn every_term_of_the_spec_example_matches_in_any_order() {
        // §7.3: "so `808 kick` matches `Vinyl_808s/KICK_808_deep_02.wav` in any
        // term order". The query layer AND-s one LIKE per term, so the test is
        // that each term is a substring of the normalised column.
        let text = search_text(r"Vinyl_808s\KICK_808_deep_02.wav");
        for query in ["808 kick", "kick 808", "deep vinyl", "02"] {
            for term in query_terms(query) {
                assert!(text.contains(&term), "term {term:?} missing from {text:?}");
            }
        }
    }

    #[test]
    fn query_terms_are_lowercased_and_deduplicated() {
        assert_eq!(query_terms("  KICK   808  "), vec!["kick", "808"]);
        assert_eq!(query_terms("kick KICK kick"), vec!["kick"]);
        assert!(query_terms("   ").is_empty());
    }
}
