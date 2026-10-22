//! stare's copies of reporters-db's and courts-db's LICENSE files (`src/licenses/`), which
//! `reporters.json` and the citare data bundle's sidecar state (D65), are the files in the
//! citare checkout stare is built with: citare vendors both as submodules under `data/`,
//! and its data bundle is built from them. A citare bump that brings a changed LICENSE
//! fails here until the copy is updated.
//!
//! The citare commit `reporters.json` and the sidecar name for citare's own supplements
//! (D67, `stare::license::CITARE_COMMIT`) is checked here too, against the commit cargo
//! built `citare-core` from.

use std::path::PathBuf;
use std::process::Command;

/// cargo's metadata for the `citare-core` package stare is built with.
fn citare_core() -> serde_json::Value {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let out = Command::new(cargo)
        .args([
            "metadata",
            "--format-version",
            "1",
            "--offline",
            "--manifest-path",
        ])
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml"))
        .output()
        .expect("cargo metadata runs");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let meta: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    meta["packages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == "citare-core")
        .expect("citare-core is a dependency")
        .clone()
}

/// The directory of the citare checkout cargo built `citare-core` from.
fn citare_checkout() -> PathBuf {
    let manifest = citare_core()["manifest_path"].as_str().unwrap().to_string();
    // <checkout>/crates/citare-core/Cargo.toml
    PathBuf::from(manifest)
        .ancestors()
        .nth(3)
        .unwrap()
        .to_path_buf()
}

#[test]
fn the_upstream_licence_copies_match_citares_submodules() {
    let citare = citare_checkout();
    for (upstream, dir) in [
        (stare::license::REPORTERS_DB, "reporters-db"),
        (stare::license::COURTS_DB, "courts-db"),
    ] {
        let path = citare.join("data").join(dir).join("LICENSE");
        let text =
            std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        assert_eq!(upstream.text, text, "{}", path.display());
        assert!(text.contains(upstream.copyright), "{dir}");
    }
}

#[test]
fn the_citare_commit_is_the_one_cargo_builds() {
    // git+ssh://git@github.com/codexpublicus/citare.git?tag=v0.7.2#<commit>
    let source = citare_core()["source"].as_str().unwrap().to_string();
    let commit = source.rsplit_once('#').map(|(_, c)| c).unwrap_or_default();
    assert_eq!(stare::license::CITARE_COMMIT, commit, "{source}");
}
