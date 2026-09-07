//! Canonical path handling (SPEC §3, §13).
//!
//! Path normalisation bugs are nearly invisible at 200 files and produce
//! thousands of phantom rows at scale, so `sample.path` stores one canonical
//! spelling and every comparison goes through here.
//!
//! Two layers, deliberately:
//!
//! * [`normalize_lexical`] is a pure string function. It knows the Windows
//!   spellings — drive-letter case, `/` versus `\`, doubled separators, `.` and
//!   `..`, trailing separators, UNC shares, `\\?\` verbatim prefixes — and it
//!   is testable on any machine. That matters: this file is developed on Linux
//!   and shipped on Windows, and a normaliser that can only be tested on the
//!   target is a normaliser that does not get tested.
//! * [`canonicalize`] asks the OS first, because only the filesystem knows the
//!   true on-disk casing and where a symlink or junction actually points, and
//!   falls back to the lexical form when the file is gone.

use std::path::{Path, PathBuf};

/// Normalises a path spelling without touching the filesystem.
///
/// Idempotent: normalising an already-normalised path returns it unchanged.
/// This is the property the whole scheme rests on — a rescan re-normalises
/// paths that came out of the database, and any drift produces duplicate rows.
pub fn normalize_lexical(input: &str) -> String {
    let mut s = input.replace('/', "\\");

    // `\\?\` disables all Win32 path parsing, so it only makes sense on a path
    // that is already fully qualified. Strip it for storage and let
    // `for_file_io` put it back when a call actually needs it.
    let unc_from_verbatim = if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        s = format!(r"\\{rest}");
        true
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        s = rest.to_string();
        false
    } else {
        false
    };

    // A UNC path keeps exactly two leading separators; everything else
    // collapses runs of them.
    let is_unc = unc_from_verbatim || s.starts_with(r"\\");
    // A single leading separator is a root-relative path (`\Samples\kick.wav`),
    // which is rare but legal on Windows and must not silently become relative.
    let is_rooted = !is_unc && s.starts_with('\\');
    let body = if is_unc { &s[2..] } else { &s[..] };

    // Split first, resolve second: `..` needs to know where the root ends, and
    // that is only knowable once the leading segment has been classified.
    let raw: Vec<&str> = body
        .split('\\')
        .filter(|seg| !seg.is_empty() && *seg != ".")
        .collect();

    // How many leading segments are root and therefore cannot be popped. For
    // UNC that is the server: `\\NAS\..` has no meaning above `\\NAS`. For a
    // drive-rooted path it is the drive.
    let root_len = usize::from(is_unc || raw.first().is_some_and(|first| is_drive(first)));

    let mut segments: Vec<&str> = Vec::new();
    for (i, seg) in raw.iter().enumerate() {
        if i < root_len {
            segments.push(seg);
        } else if *seg == ".." {
            if segments.len() > root_len && segments.last() != Some(&"..") {
                segments.pop();
            } else if root_len == 0 {
                // Relative path with nothing to pop: the `..` is real.
                segments.push("..");
            }
            // Rooted and already at the root: `C:\..\x` is `C:\x`.
        } else {
            segments.push(seg);
        }
    }

    let mut out = String::new();
    if is_unc {
        out.push_str(r"\\");
    } else if is_rooted {
        out.push('\\');
    }
    for (i, seg) in segments.iter().enumerate() {
        if i > 0 {
            out.push('\\');
        }
        if i == 0 && !is_unc && is_drive(seg) {
            // `c:` and `C:` are the same volume; pick one spelling so the
            // UNIQUE index on `sample.path` does its job.
            out.push_str(&seg.to_ascii_uppercase());
        } else {
            out.push_str(seg);
        }
    }

    // A bare drive is a root and keeps its separator: `C:` means "the current
    // directory on C:", which is not what anyone storing a root means.
    if !is_unc && segments.len() == 1 && is_drive(segments[0]) {
        out.push('\\');
    }
    if out.is_empty() && input.starts_with('\\') {
        out.push('\\');
    }
    out
}

/// `c:` — a drive specifier, the one segment whose case is not ours to keep.
fn is_drive(seg: &str) -> bool {
    let b = seg.as_bytes();
    b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// The canonical spelling to store in `sample.path`.
///
/// Prefers the OS answer, which resolves symlinks and junctions and reports the
/// real on-disk casing — the thing that actually stops `C:\Samples\kick.wav`
/// and `c:/samples/kick.wav` becoming two rows. `dunce` is used rather than
/// `std::fs::canonicalize` so that ordinary paths come back in ordinary form;
/// it only leaves a `\\?\` prefix in place when the path cannot be expressed
/// without one, which is precisely the over-MAX_PATH case (SPEC §3).
///
/// Falls back to the lexical form for a path that no longer exists, so a
/// removed file can still be matched against its row.
pub fn canonicalize(path: &Path) -> String {
    match dunce::canonicalize(path) {
        Ok(p) => normalize_lexical(&p.to_string_lossy()),
        Err(_) => normalize_lexical(&path.to_string_lossy()),
    }
}

/// True when a path needs `\\?\` to be usable, i.e. it is over MAX_PATH.
///
/// Two callers care. File I/O needs the prefix to reach the file at all. And
/// drag-out must refuse these outright: `drag-rs` hands the path to
/// `ILCreateFromPathW`, which rejects the verbatim prefix, returns a null
/// ITEMIDLIST, and takes the process down via an `unwrap` on the resulting
/// `Option`. That is not theoretical — it crashed the Phase 0 spike (see
/// `spike/RESULTS.md` row 9).
pub fn needs_verbatim_prefix(path: &str) -> bool {
    path.len() >= 260 || path.starts_with(r"\\?\")
}

/// The spelling to hand to a filesystem call.
///
/// Only differs from the stored form for long paths, and only on Windows.
pub fn for_file_io(path: &str) -> PathBuf {
    // Development affordance, not a cross-platform abstraction (SPEC §0 rules
    // those out). The stored form is Windows-shaped everywhere so that
    // `normalize_lexical` and its tests behave identically on any machine;
    // this hands the separator back on a host that wants the other one, which
    // is what lets the app be run and smoke-tested off-target. On Windows the
    // branch compiles to nothing.
    #[cfg(not(windows))]
    return PathBuf::from(path.replace('\\', "/"));

    #[cfg(windows)]
    if needs_verbatim_prefix(path) && !path.starts_with(r"\\?\") {
        if let Some(rest) = path.strip_prefix(r"\\") {
            return PathBuf::from(format!(r"\\?\UNC\{rest}"));
        }
        return PathBuf::from(format!(r"\\?\{path}"));
    } else {
        return PathBuf::from(path);
    }
}

/// The last component of a stored path.
///
/// Not `std::path::Path::file_name`: the stored spelling is Windows-shaped, and
/// `std::path` only treats `\` as a separator when compiled for Windows. Doing
/// the split here means the same answer on any host, which is what makes the
/// scan testable and runnable off-target.
pub fn file_name(path: &str) -> &str {
    match path.rfind('\\') {
        Some(i) => &path[i + 1..],
        None => path,
    }
}

/// Everything before the last component, or `""` at the top.
pub fn parent(path: &str) -> &str {
    match path.rfind('\\') {
        Some(i) => &path[..i],
        None => "",
    }
}

/// Lowercased extension without the dot, or `""`.
pub fn extension(path: &str) -> String {
    let name = file_name(path);
    match name.rfind('.') {
        // A leading dot is a hidden file, not an extension.
        Some(i) if i > 0 => name[i + 1..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SPEC §15's first named test: "round-trip a variety of Windows path
    /// spellings and assert they normalize identically. This is the bug that
    /// silently produces duplicate rows."
    #[test]
    fn spellings_of_the_same_file_normalize_identically() {
        let expected = r"C:\Samples\kick.wav";
        for spelling in [
            r"C:\Samples\kick.wav",
            r"c:\Samples\kick.wav",
            "c:/Samples/kick.wav",
            r"C:\Samples\\kick.wav",
            r"C:\.\Samples\kick.wav",
            r"C:\Samples\.\kick.wav",
            r"C:\Samples\808s\..\kick.wav",
            r"C:\Other\..\Samples\kick.wav",
            r"\\?\C:\Samples\kick.wav",
            "c:/Samples\\kick.wav",
        ] {
            assert_eq!(normalize_lexical(spelling), expected, "spelling: {spelling}");
        }
    }

    #[test]
    fn normalization_is_idempotent() {
        // A rescan re-normalises what came out of the database. Any drift here
        // is a duplicate row per file per scan.
        for spelling in [
            r"C:\Samples\kick.wav",
            r"\\NAS\samples\kick.wav",
            r"C:\",
            r"\\NAS\share",
            "relative\\path.wav",
            r"..\up.wav",
        ] {
            let once = normalize_lexical(spelling);
            assert_eq!(normalize_lexical(&once), once, "not idempotent: {spelling}");
        }
    }

    #[test]
    fn unc_paths_keep_their_double_leading_separator() {
        let expected = r"\\NAS\samples\kick.wav";
        for spelling in [
            r"\\NAS\samples\kick.wav",
            "//NAS/samples/kick.wav",
            r"\\NAS\samples\.\kick.wav",
            r"\\NAS\samples\x\..\kick.wav",
            r"\\?\UNC\NAS\samples\kick.wav",
        ] {
            assert_eq!(normalize_lexical(spelling), expected, "spelling: {spelling}");
        }
        // A share root is not a file path but must still survive the trip.
        assert_eq!(normalize_lexical(r"\\NAS\share\"), r"\\NAS\share");
    }

    #[test]
    fn dot_dot_never_escapes_a_root() {
        assert_eq!(normalize_lexical(r"C:\..\Samples"), r"C:\Samples");
        assert_eq!(normalize_lexical(r"C:\..\..\Samples"), r"C:\Samples");
        assert_eq!(normalize_lexical(r"\\NAS\..\share"), r"\\NAS\share");
    }

    #[test]
    fn relative_dot_dot_is_preserved() {
        // Nothing to pop, so the `..` is meaningful and must survive.
        assert_eq!(normalize_lexical(r"..\up.wav"), r"..\up.wav");
        assert_eq!(normalize_lexical(r"..\..\up.wav"), r"..\..\up.wav");
        assert_eq!(normalize_lexical(r"a\..\b.wav"), "b.wav");
    }

    #[test]
    fn a_leading_root_separator_survives() {
        // Dropping this turns an absolute path into a relative one, and the
        // scan then walks nothing at all.
        assert_eq!(normalize_lexical(r"\Samples\kick.wav"), r"\Samples\kick.wav");
        assert_eq!(normalize_lexical("/Samples/kick.wav"), r"\Samples\kick.wav");
        assert_eq!(normalize_lexical(r"\Samples\.\kick.wav"), r"\Samples\kick.wav");
    }

    #[test]
    fn components_split_on_the_stored_separator() {
        assert_eq!(file_name(r"C:\Samples\808s\kick.wav"), "kick.wav");
        assert_eq!(file_name("kick.wav"), "kick.wav");
        assert_eq!(parent(r"C:\Samples\808s\kick.wav"), r"C:\Samples\808s");
        assert_eq!(parent("kick.wav"), "");
        assert_eq!(extension(r"C:\Samples\KICK.WAV"), "wav");
        assert_eq!(extension("kick"), "");
        assert_eq!(extension(".hidden"), "");
        assert_eq!(extension(r"C:\my.folder\kick"), "");
    }

    #[test]
    fn drive_roots_keep_a_trailing_separator() {
        assert_eq!(normalize_lexical(r"C:\"), r"C:\");
        assert_eq!(normalize_lexical("c:/"), r"C:\");
        assert_eq!(normalize_lexical("c:"), r"C:\");
        // But an ordinary directory loses its trailing separator, so that a
        // root added as "C:\Samples\" matches paths built under "C:\Samples".
        assert_eq!(normalize_lexical(r"C:\Samples\"), r"C:\Samples");
    }

    #[test]
    fn non_ascii_and_spaces_survive_untouched() {
        // Phase 0 rows 3 and 4 both landed in Sitala; nothing here may mangle
        // what the shell accepted.
        assert_eq!(
            normalize_lexical(r"C:\Sample Packs\Dusty Breaks\kick 01.wav"),
            r"C:\Sample Packs\Dusty Breaks\kick 01.wav"
        );
        assert_eq!(
            normalize_lexical("C:/Café_Ünïcode_日本語/kick_ñ_ドラム.wav"),
            r"C:\Café_Ünïcode_日本語\kick_ñ_ドラム.wav"
        );
    }

    #[test]
    fn long_paths_are_flagged_and_prefixed() {
        let long = format!(r"C:\{}\kick.wav", "nested_folder_x".repeat(20));
        assert!(needs_verbatim_prefix(&long));
        assert!(!needs_verbatim_prefix(r"C:\Samples\kick.wav"));

        if cfg!(windows) {
            assert!(for_file_io(&long).to_string_lossy().starts_with(r"\\?\"));
            assert_eq!(
                for_file_io(r"C:\Samples\kick.wav").to_string_lossy(),
                r"C:\Samples\kick.wav"
            );
        }
    }

    #[test]
    fn a_verbatim_path_round_trips_back_to_verbatim() {
        // Storage strips the prefix; file I/O puts it back. Losing the round
        // trip means an over-MAX_PATH file becomes unreadable after a rescan.
        let long = format!(r"C:\{}\kick.wav", "nested_folder_x".repeat(20));
        let stored = normalize_lexical(&format!(r"\\?\{long}"));
        assert!(!stored.starts_with(r"\\?\"));
        assert_eq!(stored, long);
        if cfg!(windows) {
            assert_eq!(for_file_io(&stored).to_string_lossy(), format!(r"\\?\{long}"));
        }
    }
}
