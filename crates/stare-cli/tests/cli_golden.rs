//! The CLI's output on the fixture mirror, byte for byte (#162). These files were
//! written before the orchestration moved out of `main.rs`, and the refactored CLI
//! must keep matching them, from a directory and over HTTP. `UPDATE_GOLDEN=1 cargo
//! test -p stare-cli --test cli_golden` rewrites them for review.

mod common;

use std::process::{Command, Stdio};

/// Run `stare` with `args` against the index and data sources given, in a cache and
/// config of its own under `home`, and return its stdout, or for a failing run its
/// exit code and stderr, with `mask` replaced by `<mirror>`.
fn run(index: &str, data: &str, mask: &str, home: &std::path::Path, args: &[&str]) -> String {
    let out = Command::new(env!("CARGO_BIN_EXE_stare"))
        .args(["--index", index, "--data", data])
        .args(args)
        .env("XDG_CACHE_HOME", home.join("cache"))
        .env("XDG_CONFIG_HOME", home.join("config"))
        .env_remove("STARE_INDEX")
        .env_remove("STARE_DATA")
        .current_dir(common::tests_dir())
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let mask = |s: &[u8]| String::from_utf8_lossy(s).replace(mask, "<mirror>");
    if out.status.success() {
        mask(&out.stdout)
    } else {
        format!(
            "exit: {}\n{}{}",
            out.status.code().unwrap_or(-1),
            mask(&out.stdout),
            mask(&out.stderr)
        )
    }
}

/// Every command the goldens cover: (golden file, arguments).
const CASES: &[(&str, &[&str])] = &[
    ("check.json", &["--json", "check", "fixtures/brief.txt"]),
    ("check.txt", &["check", "fixtures/brief.txt"]),
    ("resolve-cite.json", &["--json", "resolve", "31 A.2d 647"]),
    ("resolve-slug.txt", &["resolve", "a2d", "31", "647"]),
    ("resolve-shared.txt", &["resolve", "a2d 31 657"]),
    ("resolve-alias.json", &["--json", "resolve", "260 N.W. 287"]),
    ("resolve-alias.txt", &["resolve", "260 N.W. 287"]),
    ("resolve-cl.json", &["--json", "resolve", "a3d 250 100"]),
    ("resolve-cl.txt", &["resolve", "250 A.3d 100"]),
    (
        "resolve-cl-sample.txt",
        &["resolve", "2021 NY Slip Op 01234"],
    ),
    ("resolve-miss.txt", &["resolve", "31 A.2d 648"]),
    ("resolve-unparsed.txt", &["resolve", "no citation here"]),
    ("list.txt", &["list", "a2d", "31"]),
];

#[test]
fn cli_output_matches_the_golden_files() {
    let mirror = common::mirror();
    let root = mirror.root().to_string_lossy().into_owned();
    let (index, data) = (
        mirror.index().to_string_lossy().into_owned(),
        mirror.data().to_string_lossy().into_owned(),
    );
    for (name, args) in CASES {
        // A fresh cache for each, so none reads what another fetched.
        let home = tempfile::tempdir().unwrap();
        common::golden(name, &run(&index, &data, &root, home.path(), args));
    }
}

/// The same output with the mirror served over HTTP, and no zip fetched whole: each
/// case's JSON and the volume's metadata are read out of it by range requests.
#[test]
fn cli_output_over_http_matches_the_golden_files() {
    let mirror = common::mirror();
    let server = common::http::Server::start(mirror.root());
    let (index, data) = (
        format!("{}/idx", server.url),
        format!("{}/data/cap", server.url),
    );
    for (name, args) in CASES {
        let home = tempfile::tempdir().unwrap();
        common::golden(name, &run(&index, &data, &server.url, home.path(), args));
        let requests = server.take();
        let whole: Vec<_> = requests
            .iter()
            .filter(|r| r.path.ends_with(".zip") && r.range.is_none())
            .collect();
        assert!(whole.is_empty(), "{name} fetched whole zips: {whole:?}");
        if name.starts_with("resolve-cite") || name.starts_with("list") {
            assert!(
                requests.iter().any(|r| r.path.ends_with(".zip")),
                "{name} read no zip"
            );
        }
        // The same command again reads its zip entries from the cache.
        run(&index, &data, &server.url, home.path(), args);
        let again: Vec<_> = server
            .take()
            .into_iter()
            .filter(|r| r.path.ends_with(".zip"))
            .collect();
        assert!(again.is_empty(), "{name} read zips again: {again:?}");
    }
}
