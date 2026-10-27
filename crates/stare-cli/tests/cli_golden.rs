//! The CLI's output on the fixture mirror, byte for byte (#162). These files were
//! written before the orchestration moved out of `main.rs`, and the refactored CLI
//! must keep matching them. `UPDATE_GOLDEN=1 cargo test -p stare-cli --test
//! cli_golden` rewrites them for review.

mod common;

use std::process::{Command, Stdio};

/// Run `stare` with `args` against `mirror`, in a cache and config of its own, and
/// return its stdout, or for a failing run its exit code and stderr, with the mirror's
/// path masked.
fn run(mirror: &common::Mirror, home: &std::path::Path, args: &[&str]) -> String {
    let out = Command::new(env!("CARGO_BIN_EXE_stare"))
        .arg("--index")
        .arg(mirror.index())
        .arg("--data")
        .arg(mirror.data())
        .args(args)
        .env("XDG_CACHE_HOME", home.join("cache"))
        .env("XDG_CONFIG_HOME", home.join("config"))
        .env_remove("STARE_INDEX")
        .env_remove("STARE_DATA")
        .current_dir(common::tests_dir())
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let mask = |s: &[u8]| {
        String::from_utf8_lossy(s)
            .replace(&mirror.root().to_string_lossy().into_owned(), "<mirror>")
    };
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
pub const CASES: &[(&str, &[&str])] = &[
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
    for (name, args) in CASES {
        // A fresh cache for each, so none reads what another fetched.
        let home = tempfile::tempdir().unwrap();
        common::golden(name, &run(&mirror, home.path(), args));
    }
}
