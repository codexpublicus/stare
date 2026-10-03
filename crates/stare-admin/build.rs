// Records the citare-core version stare-admin is built with, for the build report's
// identity (`build.citare`). It comes from the workspace's Cargo.lock: the git tag in
// the package's source when it has one (`v0.4.1`), its version otherwise.

use std::path::Path;

fn main() {
    let lock = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../Cargo.lock");
    println!("cargo:rerun-if-changed={}", lock.display());
    let citare = std::fs::read_to_string(&lock)
        .ok()
        .and_then(|text| citare_version(&text))
        .unwrap_or_default();
    println!("cargo:rustc-env=STARE_CITARE_VERSION={citare}");
}

fn citare_version(lock: &str) -> Option<String> {
    let block = lock
        .split("[[package]]")
        .find(|b| b.lines().any(|l| l.trim() == "name = \"citare-core\""))?;
    let field = |key: &str| {
        block.lines().find_map(|l| {
            let value = l.trim().strip_prefix(key)?.trim().strip_prefix('=')?;
            Some(value.trim().trim_matches('"').to_string())
        })
    };
    if let Some(source) = field("source") {
        if let Some(tag) = source.split("?tag=").nth(1) {
            return Some(tag.split('#').next().unwrap_or(tag).to_string());
        }
    }
    field("version")
}
