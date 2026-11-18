//! `stare mirror install`, `verify` and `scan` against fixture releases laid out as
//! data.stare.pub/releases/ lays out a real one (`stare-mirror-release` 1.0.0, and 1.1.0
//! with its per-file copies), signed with a key made for the test, served from a directory
//! and over a loopback HTTP server.

mod common;

use flate2::write::GzEncoder;
use sha1::Sha1;
use sha2::{Digest, Sha256};
use stare_cli::mirror::copy::{self, InstallOptions};
use stare_cli::mirror::hash::{hash_reader, hex};
use stare_cli::mirror::release::Key;
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

const RELEASE: &str = "v2026.11.20";
const SITE: &str = "site.v2026.11.20.1";

struct Signer {
    kp: minisign::KeyPair,
}

impl Signer {
    fn new() -> Signer {
        Signer {
            kp: minisign::KeyPair::generate_unencrypted_keypair().unwrap(),
        }
    }

    fn public(&self) -> String {
        self.kp.pk.to_base64()
    }

    fn key(&self) -> Key {
        Key::from_base64(&self.public()).unwrap()
    }

    fn sign(&self, data: &[u8]) -> String {
        minisign::sign(
            Some(&self.kp.pk),
            &self.kp.sk,
            data,
            Some("fixture"),
            Some("signature from minisign secret key"),
        )
        .unwrap()
        .into_string()
    }
}

fn sha(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

fn gzip(data: &[u8]) -> Vec<u8> {
    let mut gz = GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(data).unwrap();
    gz.finish().unwrap()
}

fn put(path: &Path, data: &[u8]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, data).unwrap();
}

fn pinned(path: &str, data: &[u8]) -> serde_json::Value {
    serde_json::json!({ "path": path, "sha256": sha(data), "bytes": data.len() })
}

/// A component's id, version, and files (path from the copy's root, bytes).
type ComponentFiles = (&'static str, &'static str, Vec<(String, Vec<u8>)>);

/// A copy's files by component, as the release builder lays them out.
fn copy_files() -> Vec<ComponentFiles> {
    let big: Vec<u8> = (0..70_000u32).map(|i| (i % 253) as u8).collect();
    vec![
        (
            "site",
            "v2026.11.20.1",
            vec![
                (
                    format!("{SITE}/index.html"),
                    b"<!doctype html>reader".to_vec(),
                ),
                (format!("{SITE}/about/index.html"), b"about".to_vec()),
                (format!("{SITE}/wasm/big.wasm"), big),
            ],
        ),
        (
            "kit",
            "v2026.11.20.1",
            vec![("kit/Caddyfile".to_string(), b":8080 {}\n".to_vec())],
        ),
        (
            "index",
            "v2026.11.05.3",
            vec![
                (
                    "mirror/idx/manifest.json".to_string(),
                    br#"{"version":"v2026.11.05.3","base":"v/v2026.11.05.3/"}"#.to_vec(),
                ),
                (
                    "mirror/idx/v/v2026.11.05.3/a2d/31.idx.gz".to_string(),
                    gzip(b"647,cap,0647-01\n"),
                ),
            ],
        ),
        (
            "crk",
            "v2026.11.08",
            vec![(
                "mirror/data/crk/errata.json".to_string(),
                b"{\"errata\":[]}\n".to_vec(),
            )],
        ),
    ]
}

/// Tar entries beyond the copy's files, to test what extraction refuses, or a 1.1.0
/// release, which also publishes the site and kit files under each component version's
/// `files/` and the release's pointer files under its `pointers/`, with `files_base` and
/// `pointer_files` in `release.json`.
enum Extra {
    None,
    Symlink(&'static str, &'static str),
    Format110,
}

/// The pointer files the fixture copy has.
const POINTERS: &[&str] = &[
    "mirror/mirror.json",
    "mirror/idx/manifest.json",
    "mirror/data/crk/errata.json",
];

struct Fixture {
    dir: tempfile::TempDir,
    signer: Signer,
}

impl Fixture {
    /// The releases base: what https://data.stare.pub/releases/ holds.
    fn base(&self) -> PathBuf {
        self.dir.path().join("releases")
    }

    fn base_str(&self) -> String {
        self.base().to_string_lossy().into_owned()
    }

    fn tar_rel(&self) -> String {
        format!("{RELEASE}/stare-tier1-{RELEASE}.tar")
    }
}

fn build(extra: Extra) -> Fixture {
    build_with(Signer::new(), extra)
}

fn build_with(signer: Signer, extra: Extra) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join("releases");
    let stage = dir.path().join("stage");
    let comps = copy_files();
    let v110 = matches!(extra, Extra::Format110);
    let format_version = if v110 { "1.1.0" } else { "1.0.0" };

    // The copy, staged.
    for (_, _, files) in &comps {
        for (p, d) in files {
            put(&stage.join(p), d);
        }
    }
    std::os::unix::fs::symlink(SITE, stage.join("site")).unwrap();
    let components: BTreeMap<&str, &str> = comps.iter().map(|(id, v, _)| (*id, *v)).collect();
    let mirror_json = serde_json::to_vec_pretty(&serde_json::json!({
        "format": "stare-mirror", "format_version": "1.0.0", "upstream": "https://stare.pub",
        "release": RELEASE, "data_date": "2026-11-08", "tiers": [1],
        "components": components.iter().map(|(k, v)| (k.to_string(), serde_json::json!({"version": v}))).collect::<serde_json::Map<_, _>>(),
    }))
    .unwrap();
    put(&stage.join("mirror/mirror.json"), &mirror_json);

    // Per-component manifests, in the copy and beside the release.
    let mut comp_entries = Vec::new();
    for (id, version, files) in &comps {
        let mut sorted = files.clone();
        sorted.sort_by(|a, b| a.0.cmp(&b.0));
        let mut lines = String::new();
        let mut sums = String::new();
        for (p, d) in &sorted {
            let h = hash_reader(&d[..]).unwrap();
            lines.push_str(
                &serde_json::to_string(&serde_json::json!({
                    "path": p, "sha256": h.sha256, "bytes": h.bytes, "btv2": h.btv2,
                }))
                .unwrap(),
            );
            lines.push('\n');
            sums.push_str(&format!("{}  {}\n", h.sha256, p));
        }
        let fj = gzip(lines.as_bytes());
        let cpath = format!("components/{id}/{version}");
        for b in [stage.join("mirror/releases"), base.clone()] {
            put(&b.join(&cpath).join("files.json.gz"), &fj);
            put(&b.join(&cpath).join("SHA256SUMS"), sums.as_bytes());
        }
        let root = match *id {
            "site" => SITE.to_string(),
            "kit" => "kit".to_string(),
            "index" => "mirror/idx".to_string(),
            _ => "mirror/data/crk".to_string(),
        };
        let files_base = (v110 && matches!(*id, "site" | "kit")).then(|| {
            let fb = format!("{cpath}/files/");
            for (p, d) in files {
                let rel = p.strip_prefix(&format!("{root}/")).unwrap();
                put(&base.join(&fb).join(rel), d);
            }
            fb
        });
        comp_entries.push(serde_json::json!({
            "id": id, "version": version, "tier": 1, "root": root,
            "files": files.len(), "bytes": files.iter().map(|f| f.1.len()).sum::<usize>(),
            "files_json": pinned(&format!("{cpath}/files.json.gz"), &fj),
            "sha256sums": pinned(&format!("{cpath}/SHA256SUMS"), sums.as_bytes()),
            "files_base": files_base,
            "pack": null, "torrent": null, "license": null,
        }));
    }

    // The tar.
    let tar_rel = format!("{RELEASE}/stare-tier1-{RELEASE}.tar");
    let tar_path = base.join(&tar_rel);
    std::fs::create_dir_all(tar_path.parent().unwrap()).unwrap();
    {
        let mut b = tar::Builder::new(std::fs::File::create(&tar_path).unwrap());
        b.follow_symlinks(false);
        b.append_dir_all(".", &stage).unwrap();
        if let Extra::Symlink(name, target) = extra {
            let mut h = tar::Header::new_gnu();
            h.set_entry_type(tar::EntryType::Symlink);
            h.set_size(0);
            h.set_mode(0o777);
            b.append_link(&mut h, name, target).unwrap();
        }
        b.finish().unwrap();
    }
    let tar_bytes = std::fs::read(&tar_path).unwrap();
    let tar_hash = hash_reader(&tar_bytes[..]).unwrap();

    // The torrent: a v2 single-file info dictionary is all the check reads.
    let root = hex_decode(tar_hash.btv2.as_ref().unwrap());
    let name = format!("stare-tier1-{RELEASE}.tar");
    let mut info = format!(
        "d9:file treed{}:{}d0:d6:lengthi{}e11:pieces root32:",
        name.len(),
        name,
        tar_bytes.len()
    )
    .into_bytes();
    info.extend(&root);
    info.extend(
        format!(
            "eee12:meta versioni2e4:name{}:{}12:piece lengthi1048576ee",
            name.len(),
            name
        )
        .bytes(),
    );
    let mut torrent = b"d4:info".to_vec();
    torrent.extend(&info);
    torrent.push(b'e');
    let tor_rel = format!("torrents/stare-tier1-{RELEASE}.torrent");
    put(&base.join(&tor_rel), &torrent);

    let pointer = hash_reader(&mirror_json[..]).unwrap();
    let pointer_files: Vec<serde_json::Value> = POINTERS
        .iter()
        .filter(|_| v110)
        .map(|p| {
            let d = std::fs::read(stage.join(p)).unwrap();
            put(&base.join(RELEASE).join("pointers").join(p), &d);
            let h = hash_reader(&d[..]).unwrap();
            serde_json::json!({"path": p, "sha256": h.sha256, "bytes": h.bytes, "btv2": h.btv2})
        })
        .collect();
    let mut release = serde_json::json!({
        "format": "stare-mirror-release", "format_version": format_version, "release": RELEASE,
        "created": "2026-11-20T00:00:00Z", "previous": "v2026.11.11", "sequence": 2,
        "upstream": "https://stare.pub", "data_date": "2026-11-08",
        "site": {"version": "v2026.11.20.1", "commit": "0", "component": "site"},
        "components": comp_entries,
        "tiers": {"1": {
            "components": ["site", "kit", "index", "crk"],
            "files": 0, "bytes": 0,
            "pointers": [{"path": "mirror/mirror.json", "sha256": pointer.sha256, "bytes": pointer.bytes, "btv2": pointer.btv2}],
            "symlinks": {"site": SITE},
            "tar": {
                "path": tar_rel, "sha256": tar_hash.sha256, "bytes": tar_hash.bytes,
                "torrent": {
                    "path": tor_rel, "sha256": sha(&torrent), "bytes": torrent.len(),
                    "btih": hex(&Sha1::digest(&info)),
                    "btmh": format!("1220{}", hex(&Sha256::digest(&info))),
                    "piece_length": 1048576, "pieces_root": tar_hash.btv2,
                    "web_seeds": [], "magnet": "",
                },
            },
        }},
        "origins": [],
        "trackers": [],
        "signing": {
            "tool": "minisign", "key_id": "0", "public_key": signer.public(),
            "recovery_key_id": "0", "recovery_public_key": "",
            "published_at": "https://stare.pub/.well-known/stare-release-key.pub",
        },
    });
    if v110 {
        release["pointer_files"] =
            serde_json::json!({"base": format!("{RELEASE}/pointers/"), "files": pointer_files});
    }
    let rj = serde_json::to_vec_pretty(&release).unwrap();
    put(&base.join(RELEASE).join("release.json"), &rj);
    put(
        &base.join(RELEASE).join("release.json.minisig"),
        signer.sign(&rj).as_bytes(),
    );
    let latest = serde_json::to_vec_pretty(&serde_json::json!({
        "format": "stare-mirror-latest", "format_version": "1.0.0", "release": RELEASE,
        "sequence": 2, "created": "2026-11-20T00:00:00Z",
        "release_json": pinned(&format!("{RELEASE}/release.json"), &rj),
        "key_id": "0",
    }))
    .unwrap();
    put(&base.join("latest.json"), &latest);
    put(
        &base.join("latest.json.minisig"),
        signer.sign(&latest).as_bytes(),
    );
    Fixture { dir, signer }
}

fn hex_decode(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn opts(fx: &Fixture, origins: Vec<String>) -> InstallOptions {
    InstallOptions {
        tier: 1,
        release: None,
        origins,
        only_origins: true,
        key: fx.signer.key(),
        log: Box::new(|_| {}),
    }
}

#[test]
fn install_from_a_directory_extracts_the_tar_and_checks_every_file() {
    let fx = build(Extra::None);
    let out = tempfile::tempdir().unwrap();
    let root = out.path().join("copy");
    let report = copy::install(&root, opts(&fx, vec![fx.base_str()])).unwrap();
    assert_eq!(report.release, RELEASE);
    assert_eq!(report.sequence, 2);
    assert_eq!(report.files, 7);
    assert_eq!(
        std::fs::read_link(root.join("site")).unwrap(),
        Path::new(SITE)
    );
    assert_eq!(
        std::fs::read(root.join("site/index.html")).unwrap(),
        b"<!doctype html>reader"
    );
    // The signed release list travels with the copy, and nothing else is left behind.
    assert!(root
        .join(format!("mirror/releases/{RELEASE}/release.json.minisig"))
        .is_file());
    assert!(!out.path().join("copy.partial").exists());

    let v = copy::verify(&root, &fx.signer.key()).unwrap();
    assert_eq!((v.problems, v.files, v.release.as_str()), (0, 7, RELEASE));
    let s = copy::scan(&root, &fx.signer.key()).unwrap();
    assert!(s.extra.is_empty(), "{:?}", s.extra);
    assert!(s.missing.is_empty());
    assert_eq!(s.components.len(), 4);
}

#[test]
fn install_over_http_resumes_a_partial_tar() {
    let fx = build(Extra::None);
    let server = common::http::Server::start(&fx.base());
    let out = tempfile::tempdir().unwrap();
    let root = out.path().join("copy");
    // An earlier run fetched the first half of the tar.
    let tar = std::fs::read(fx.base().join(fx.tar_rel())).unwrap();
    let part = out
        .path()
        .join("copy.partial/releases")
        .join(format!("{}.part", fx.tar_rel()));
    put(&part, &tar[..tar.len() / 2]);

    copy::install(&root, opts(&fx, vec![format!("{}/", server.url)])).unwrap();
    let reqs = server.take();
    let tar_req = reqs
        .iter()
        .find(|r| r.path.ends_with(".tar"))
        .expect("the tar was requested");
    assert_eq!(
        tar_req.range.as_deref(),
        Some(format!("bytes={}-", tar.len() / 2).as_str())
    );
    assert_eq!(copy::verify(&root, &fx.signer.key()).unwrap().problems, 0);
}

#[test]
fn a_bad_origin_is_skipped_for_the_next() {
    let fx = build(Extra::None);
    // A second origin whose tar is corrupt, tried first.
    let bad = tempfile::tempdir().unwrap();
    copy_dir(&fx.base(), bad.path());
    let tar = bad.path().join(fx.tar_rel());
    let mut data = std::fs::read(&tar).unwrap();
    let mid = data.len() / 2;
    data[mid] ^= 0xff;
    std::fs::write(&tar, data).unwrap();

    let out = tempfile::tempdir().unwrap();
    let only_bad = copy::install(
        &out.path().join("a"),
        opts(&fx, vec![bad.path().to_string_lossy().into_owned()]),
    );
    let err = format!("{:#}", only_bad.unwrap_err());
    assert!(err.contains("doesn't match the release list"), "{err}");
    assert!(!out.path().join("a").exists());

    copy::install(
        &out.path().join("b"),
        opts(
            &fx,
            vec![bad.path().to_string_lossy().into_owned(), fx.base_str()],
        ),
    )
    .unwrap();
}

#[test]
fn a_release_signed_by_another_key_is_refused() {
    let fx = build(Extra::None);
    let other = Signer::new();
    let out = tempfile::tempdir().unwrap();
    let mut o = opts(&fx, vec![fx.base_str()]);
    o.key = other.key();
    let err = format!("{:#}", copy::install(&out.path().join("c"), o).unwrap_err());
    assert!(err.contains("latest.json's signature"), "{err}");

    // A release.json changed after signing fails its own check, even when latest.json is
    // skipped with --release.
    let rj = fx.base().join(RELEASE).join("release.json");
    let mut data = std::fs::read(&rj).unwrap();
    data.extend(b" ");
    std::fs::write(&rj, data).unwrap();
    let mut o = opts(&fx, vec![fx.base_str()]);
    o.release = Some(RELEASE.into());
    let err = format!("{:#}", copy::install(&out.path().join("d"), o).unwrap_err());
    assert!(err.contains("release.json's signature"), "{err}");
}

#[test]
fn install_refuses_a_directory_that_isnt_empty() {
    let fx = build(Extra::None);
    let out = tempfile::tempdir().unwrap();
    put(&out.path().join("copy/keep.txt"), b"mine");
    let err = format!(
        "{:#}",
        copy::install(&out.path().join("copy"), opts(&fx, vec![fx.base_str()])).unwrap_err()
    );
    assert!(err.contains("isn't empty"), "{err}");
    assert_eq!(
        std::fs::read(out.path().join("copy/keep.txt")).unwrap(),
        b"mine"
    );
}

#[test]
fn a_tar_linking_outside_the_copy_is_refused() {
    let fx = build(Extra::Symlink("escape", "../../etc"));
    let out = tempfile::tempdir().unwrap();
    let err = format!(
        "{:#}",
        copy::install(&out.path().join("copy"), opts(&fx, vec![fx.base_str()])).unwrap_err()
    );
    assert!(err.contains("links outside its directory"), "{err}");
    assert!(!out.path().join("copy").exists());
}

#[test]
fn verify_and_scan_find_changed_missing_and_extra_files() {
    let fx = build(Extra::None);
    let out = tempfile::tempdir().unwrap();
    let root = out.path().join("copy");
    copy::install(&root, opts(&fx, vec![fx.base_str()])).unwrap();

    // Same size, other bytes: only verify sees it.
    std::fs::write(root.join(format!("{SITE}/about/index.html")), b"ABOUT").unwrap();
    std::fs::remove_file(root.join("kit/Caddyfile")).unwrap();
    put(&root.join("site.v2026.11.11.1/index.html"), b"old site");

    let v = copy::verify(&root, &fx.signer.key()).unwrap();
    assert_eq!(v.problems, 2, "{:?}", v.listed);
    assert!(v
        .listed
        .iter()
        .any(|p| p.contains("about/index.html") && p.contains("SHA-256")));
    assert!(v.listed.iter().any(|p| p == "kit/Caddyfile is missing"));

    let s = copy::scan(&root, &fx.signer.key()).unwrap();
    assert_eq!(s.missing, vec!["kit/Caddyfile is missing".to_string()]);
    assert_eq!(s.extra, vec!["site.v2026.11.11.1/index.html".to_string()]);
    assert_eq!(s.extra_bytes, 8);
    let kit = s.components.iter().find(|c| c.id == "kit").unwrap();
    assert_eq!(kit.missing, 1);

    // The CLI exits non-zero on a copy that doesn't verify.
    let pubkey = out.path().join("test.pub");
    std::fs::write(
        &pubkey,
        format!("untrusted comment: test key\n{}\n", fx.signer.public()),
    )
    .unwrap();
    let status = std::process::Command::new(env!("CARGO_BIN_EXE_stare"))
        .args(["mirror", "verify", "--pubkey"])
        .arg(&pubkey)
        .arg(&root)
        .output()
        .unwrap();
    assert!(!status.status.success());
    assert!(String::from_utf8_lossy(&status.stdout).contains("kit/Caddyfile is missing"));
}

#[test]
fn verify_refuses_a_copy_whose_release_list_was_changed() {
    let fx = build(Extra::None);
    let out = tempfile::tempdir().unwrap();
    let root = out.path().join("copy");
    copy::install(&root, opts(&fx, vec![fx.base_str()])).unwrap();
    let rj = root.join(format!("mirror/releases/{RELEASE}/release.json"));
    let text = std::fs::read_to_string(&rj)
        .unwrap()
        .replace("\"sequence\": 2", "\"sequence\": 9");
    std::fs::write(&rj, text).unwrap();
    let err = format!("{:#}", copy::verify(&root, &fx.signer.key()).unwrap_err());
    assert!(err.contains("signature"), "{err}");
}

#[test]
fn the_cli_installs_with_a_key_file_and_reports_json() {
    let fx = build(Extra::None);
    let out = tempfile::tempdir().unwrap();
    let pubkey = out.path().join("test.pub");
    std::fs::write(
        &pubkey,
        format!("untrusted comment: test key\n{}\n", fx.signer.public()),
    )
    .unwrap();
    let root = out.path().join("copy");
    let run = std::process::Command::new(env!("CARGO_BIN_EXE_stare"))
        .args(["--json", "mirror", "install", "--only-origins", "--origin"])
        .arg(fx.base())
        .arg("--pubkey")
        .arg(&pubkey)
        .arg(&root)
        .output()
        .unwrap();
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&run.stdout).unwrap();
    assert_eq!(report["release"], RELEASE);
    assert_eq!(report["files"], 7);
    let stderr = String::from_utf8_lossy(&run.stderr);
    assert!(stderr.contains("latest.json: signature good"), "{stderr}");
    assert!(stderr.contains("torrent: hashes match"), "{stderr}");
}

fn copy_dir(from: &Path, to: &Path) {
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let dest = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            std::fs::create_dir_all(&dest).unwrap();
            copy_dir(&entry.path(), &dest);
        } else {
            std::fs::copy(entry.path(), dest).unwrap();
        }
    }
}

#[test]
fn a_1_1_0_release_with_per_file_copies_installs_and_verifies() {
    let fx = build(Extra::Format110);
    // The fixture really is 1.1.0, with its per-file copies beside the release.
    let rj: serde_json::Value = serde_json::from_slice(
        &std::fs::read(fx.base().join(RELEASE).join("release.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(rj["format_version"], "1.1.0");
    assert_eq!(rj["pointer_files"]["files"].as_array().unwrap().len(), 3);
    assert_eq!(
        std::fs::read(
            fx.base()
                .join("components/site/v2026.11.20.1/files/about/index.html")
        )
        .unwrap(),
        b"about"
    );
    assert!(fx
        .base()
        .join(RELEASE)
        .join("pointers/mirror/idx/manifest.json")
        .is_file());

    // A 1.x reader installs it from the tar, as it would a 1.0.0 release.
    let out = tempfile::tempdir().unwrap();
    let root = out.path().join("copy");
    let report = copy::install(&root, opts(&fx, vec![fx.base_str()])).unwrap();
    assert_eq!((report.release.as_str(), report.files), (RELEASE, 7));
    let v = copy::verify(&root, &fx.signer.key()).unwrap();
    assert_eq!((v.problems, v.files, v.release.as_str()), (0, 7, RELEASE));
    let s = copy::scan(&root, &fx.signer.key()).unwrap();
    assert!(s.extra.is_empty(), "{:?}", s.extra);
    assert!(s.missing.is_empty());
}
