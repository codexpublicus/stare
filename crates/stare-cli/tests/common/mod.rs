//! A fixture mirror laid out as idx.stare.pub and data.stare.pub are, built from
//! `crates/stare/tests/fixtures` at test time, and the helpers the golden tests share.
//!
//! The mirror holds one build, `v2026.10.26.2`:
//!
//! - a2d 31: CAP's zip (`a2d-31.zip`), indexed from its case files, with a
//!   CourtListener line at 647;
//! - a3d 250: a volume only CourtListener has, `cl-record.json` at page 100;
//! - n-w 260: aliases only, page 287 is a2d/31's 0647-01 through CourtListener's
//!   citations;
//! - every volume of `cl-sample-build.json`, each with its record (`cl-record.json`
//!   again, under the sample's cluster and hash).
#![allow(dead_code)]

pub mod http;

use std::io::Write;
use std::path::{Path, PathBuf};

pub const VERSION: &str = "v2026.10.26.2";
pub const H1: &str = "0f3a9c2e7b1d4a65";

/// `crates/stare/tests/fixtures`.
pub fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../stare/tests/fixtures")
}

/// `crates/stare-cli/tests`.
pub fn tests_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests")
}

pub struct Mirror {
    pub dir: tempfile::TempDir,
}

impl Mirror {
    /// The index root, as `--index` takes it.
    pub fn index(&self) -> PathBuf {
        self.dir.path().join("idx")
    }

    /// The CAP data root, as `--data` takes it (`.../data/cap`).
    pub fn data(&self) -> PathBuf {
        self.dir.path().join("data/cap")
    }

    pub fn root(&self) -> &Path {
        self.dir.path()
    }
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(bytes).unwrap();
    gz.finish().unwrap()
}

fn write(path: &Path, bytes: &[u8]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
}

/// Build the mirror in a new temporary directory.
pub fn mirror() -> Mirror {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let idx = root.join("idx");
    let v = idx.join("v").join(VERSION);
    let data = root.join("data");

    let fixtures = fixtures();
    let zip = std::fs::read(fixtures.join("a2d-31.zip")).unwrap();
    let record = std::fs::read(fixtures.join("cl-record.json")).unwrap();
    let sample: serde_json::Value =
        serde_json::from_slice(&std::fs::read(fixtures.join("cl-sample-build.json")).unwrap())
            .unwrap();

    // a2d 31, from the zip's case files, with a CourtListener line at 647.
    let names = stare::case::list_cases_in_zip(&zip).unwrap();
    let keyed: Vec<(&str, usize)> = names
        .iter()
        .map(|n| (n.as_str(), n[..4].parse().unwrap()))
        .collect();
    let built = stare::index::build(&keyed);
    let mut entries =
        stare::idx::entries_from_bin(&built.bin, built.multi_file().as_deref(), None).unwrap();
    entries.push(stare::idx::Entry::cl(stare::index::PageKey::Number(647), 1, H1).unwrap());
    stare::idx::sort_entries(&mut entries);
    let text: String = entries.iter().map(|e| e.line() + "\n").collect();
    write(&v.join("a2d/31.idx.gz"), &stare::idx::gzip(&text));
    write(&data.join("cap/a2d/31.zip"), &zip);

    // a3d 250: CourtListener only.
    write(
        &v.join("a3d/250.idx.gz"),
        &stare::idx::gzip(&format!("100,cl,9876543/{H1}\n")),
    );
    write(
        &data.join(format!("cl/c/9876543/{H1}.json.gz")),
        &gzip(&record),
    );

    // nw 260: an alias to a2d/31's 0647-01.
    write(
        &v.join("n-w/260.idx.gz"),
        &stare::idx::gzip("287,cap,a2d/31/0647-01,via=cl:8077312\n"),
    );

    // The CourtListener sample build.
    let hash = sample["hash"].as_str().unwrap();
    let mut reporters: std::collections::BTreeMap<String, Vec<String>> = Default::default();
    reporters.insert("a2d".into(), vec!["31".into()]);
    reporters.insert("a3d".into(), vec!["250".into()]);
    for (key, lines) in sample["idx"].as_object().unwrap() {
        let (slug, volume) = key.split_once('/').unwrap();
        write(
            &v.join(format!("{slug}/{volume}.idx.gz")),
            &stare::idx::gzip(lines.as_str().unwrap()),
        );
        reporters
            .entry(slug.to_string())
            .or_default()
            .push(volume.to_string());
    }
    for c in sample["citations"].as_array().unwrap() {
        let cluster = c["cluster_id"].as_u64().unwrap();
        write(
            &data.join(format!("cl/c/{cluster}/{hash}.json.gz")),
            &gzip(&record),
        );
    }

    let manifest = |base: Option<&str>| {
        let mut m = serde_json::json!({
            "format": 2,
            "version": VERSION,
            "generated_at": "2026-10-26T12:00:00Z",
            "volumes": 1,
            "entries": names.len(),
            "idx": 1,
            "reporters": reporters,
            "aliases": {"n-w": ["260"]},
            "license": serde_json::to_value(stare::license::CC_BY_NC_ND).unwrap(),
            "based_on": serde_json::to_value(stare::license::index_based_on()).unwrap(),
        });
        if let Some(base) = base {
            m["base"] = base.into();
        }
        serde_json::to_vec_pretty(&m).unwrap()
    };
    write(
        &idx.join("manifest.json"),
        &manifest(Some(&format!("v/{VERSION}/"))),
    );
    write(&v.join("manifest.json"), &manifest(None));

    Mirror { dir }
}

/// Compare `actual` with the golden file `name` under `tests/golden/`, or write it when
/// `UPDATE_GOLDEN` is set.
pub fn golden(name: &str, actual: &str) {
    let path = tests_dir().join("golden").join(name);
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        write(&path, actual.as_bytes());
        return;
    }
    let expected = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{}: {e} (run with UPDATE_GOLDEN=1)", path.display()));
    if expected != actual {
        let first = expected
            .lines()
            .zip(actual.lines())
            .position(|(a, b)| a != b)
            .unwrap_or(expected.lines().count().min(actual.lines().count()));
        panic!(
            "{} differs from the output at line {}:\n  golden: {:?}\n  actual: {:?}",
            name,
            first + 1,
            expected.lines().nth(first),
            actual.lines().nth(first),
        );
    }
}
