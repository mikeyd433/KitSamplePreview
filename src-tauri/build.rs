//! Stamps the binary with the commit it was built from.
//!
//! "Am I running the latest version?" is otherwise unanswerable without
//! comparing timestamps by hand — and the app is updated by rebuilding from a
//! branch, so the question comes up every time.

use std::process::Command;

fn main() {
    let git = |args: &[&str]| -> Option<String> {
        let out = Command::new("git").args(args).output().ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
            .filter(|s| !s.is_empty())
    };

    // A build from a tarball or a shallow copy has no git; that is not an
    // error, it just means the stamp is less specific.
    let commit = git(&["rev-parse", "--short=7", "HEAD"]).unwrap_or_else(|| "nogit".into());

    // A trailing "+" means the working tree had uncommitted changes when this
    // was built, so the commit alone does not describe what is running.
    let dirty = git(&["status", "--porcelain"]).is_some_and(|s| !s.is_empty());
    let stamp = if dirty { format!("{commit}+") } else { commit };

    let built_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // Where this binary was built from, so the app can find its own update
    // script. Correct because Kitbench is always built on the machine it runs
    // on; a binary moved elsewhere simply finds nothing there and hides the
    // update button.
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();

    println!("cargo:rustc-env=KITBENCH_REPO_DIR={repo}");
    println!("cargo:rustc-env=KITBENCH_COMMIT={stamp}");
    println!("cargo:rustc-env=KITBENCH_BUILT_AT={built_at}");
    // Re-stamp when the checked-out commit moves.
    println!("cargo:rerun-if-changed=../.git/HEAD");

    tauri_build::build()
}
