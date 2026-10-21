//! stare's copies of reporters-db's and courts-db's LICENSE files (`src/licenses/`), which
//! `reporters.json` and the citare data bundle's sidecar state (D65), are the files in the
//! citare checkout stare is built with: citare vendors both as submodules under `data/`,
//! and its data bundle is built from them. A citare bump that brings a changed LICENSE
//! fails here until the copy is updated.

use std::path::PathBuf;
use std::process::Command;

/// The directory of the citare checkout cargo built `citare-core` from.
fn citare_checkout() -> PathBuf {
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
    let manifest = meta["packages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == "citare-core")
        .expect("citare-core is a dependency")["manifest_path"]
        .as_str()
        .unwrap()
        .to_string();
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
