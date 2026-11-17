//! `stare mirror install`, `verify` and `scan`: a copy installed from a signed release,
//! and checked against it.
//!
//! The order of checks follows the release format (`mirror-kit/README.md`): nothing is
//! trusted until `latest.json`'s and `release.json`'s signatures check against the release
//! key; every other file is trusted only through the SHA-256 and size the signed list
//! gives it (the torrent, each component's `files.json.gz` and `SHA256SUMS`, the tier
//! tar), and every file of the extracted copy is then checked against its component's
//! manifest, with the tier's pointer files and symlinks.
use super::hash::{hash_file, sha256_file};
use super::release::{
    read_files_json_gz, safe_rel, FileEntry, Key, Latest, MirrorJson, Pinned, Release,
    DEFAULT_ORIGINS,
};
use super::source::Sources;
use super::torrent;
use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// The most problems a report lists by name; the count is always exact.
pub const MAX_LISTED: usize = 50;

pub struct InstallOptions {
    pub tier: u32,
    /// The release to install; None for the one `latest.json` names.
    pub release: Option<String>,
    /// Release bases tried before the default origins and the release list's own.
    pub origins: Vec<String>,
    /// Fetch only from `origins`: not from data.stare.pub, mirror.stare.pub or the origins
    /// the release list names (an air-gapped install from a disk).
    pub only_origins: bool,
    pub key: Key,
    pub log: Box<dyn Fn(&str)>,
}

#[derive(Debug, Serialize)]
pub struct InstallReport {
    pub root: PathBuf,
    pub release: String,
    pub sequence: u64,
    pub tier: u32,
    pub data_date: String,
    pub files: usize,
    pub bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct VerifyReport {
    pub root: PathBuf,
    pub release: String,
    pub sequence: u64,
    pub tiers: Vec<u32>,
    pub files: usize,
    pub bytes: u64,
    /// How many files, pointers and symlinks don't match.
    pub problems: usize,
    /// The first [`MAX_LISTED`] of them.
    pub listed: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ComponentScan {
    pub id: String,
    pub version: String,
    pub tier: u32,
    pub files: usize,
    pub missing: usize,
    pub wrong_size: usize,
}

#[derive(Debug, Serialize)]
pub struct ScanReport {
    pub root: PathBuf,
    pub release: String,
    pub sequence: u64,
    pub data_date: String,
    pub tiers: Vec<u32>,
    pub components: Vec<ComponentScan>,
    /// Manifest files that aren't there, or are there at another size (the first
    /// [`MAX_LISTED`]).
    pub missing: Vec<String>,
    /// Files under the root that the release doesn't name, outside `mirror/releases/`:
    /// older versions' files, or anything else put there. Every one is listed.
    pub extra: Vec<String>,
    pub extra_bytes: u64,
}

/// A downloaded, signature-checked release list and its component manifests.
struct Fetched {
    meta: Release,
    manifests: BTreeMap<String, Vec<FileEntry>>,
}

fn work_dir(root: &Path) -> Result<PathBuf> {
    let name = root
        .file_name()
        .with_context(|| format!("{} has no directory name", root.display()))?;
    let mut n = name.to_os_string();
    n.push(".partial");
    Ok(root.with_file_name(n))
}

/// Read `latest.json` (unless `release` is given), then `release.json`, and check both
/// signatures and the release list's own consistency; then fetch the tier's torrent and
/// every component's manifests and check them against the list.
fn fetch_release(
    src: &mut Sources,
    dest: &Path,
    key: &Key,
    release: Option<&str>,
    tier: u32,
    add_listed_origins: bool,
) -> Result<Fetched> {
    let (name, rj_bytes) = match release {
        None => {
            let latest = src.get_bytes("latest.json", dest, None)?;
            let sig = src.get_bytes("latest.json.minisig", dest, None)?;
            key.verify(&latest, &String::from_utf8_lossy(&sig), "latest.json")?;
            let l = Latest::parse(&latest)?;
            src.log(&format!(
                "latest.json: signature good, names {} (sequence {})",
                l.release, l.sequence
            ));
            let rj = src.get_bytes(&l.release_json.path, dest, Some(&l.release_json))?;
            (l.release, rj)
        }
        Some(r) => {
            super::release::check_segment(r, "the release")?;
            (
                r.to_string(),
                src.get_bytes(&format!("{r}/release.json"), dest, None)?,
            )
        }
    };
    let sig = src.get_bytes(&format!("{name}/release.json.minisig"), dest, None)?;
    key.verify(&rj_bytes, &String::from_utf8_lossy(&sig), "release.json")?;
    let meta = Release::parse(&rj_bytes, key, &name)?;
    src.log(&format!(
        "release.json: signature good ({}), {}, sequence {}",
        meta.signing.key_id, meta.release, meta.sequence
    ));
    if add_listed_origins {
        for o in &meta.origins {
            src.add(&o.releases)?;
        }
    }

    let t = meta
        .tier(tier)
        .with_context(|| format!("{} has no tier {tier}", meta.release))?;
    if let Some(tor) = t.tar.as_ref().and_then(|tar| tar.torrent.as_ref()) {
        let pin = Pinned {
            path: tor.path.clone(),
            sha256: tor.sha256.clone(),
            bytes: tor.bytes,
        };
        let data = src.get_bytes(&tor.path, dest, Some(&pin))?;
        let got = torrent::describe(&data)?;
        if got.btih != tor.btih
            || format!("1220{}", got.btmh) != tor.btmh
            || got.pieces_root != tor.pieces_root
        {
            bail!("the torrent's infohashes aren't the ones release.json gives");
        }
        src.log(&format!("torrent: hashes match (btih {})", got.btih));
    }

    let mut manifests = BTreeMap::new();
    for c in meta.components_through(&tiers_through(tier)) {
        let fj = src.get_bytes(&c.files_json.path, dest, Some(&c.files_json))?;
        src.get(&c.sha256sums.path, dest, Some(&c.sha256sums))?;
        let files = read_files_json_gz(&fj)?;
        if files.len() as u64 != c.files {
            bail!(
                "{}'s files.json.gz lists {} files, not {}",
                c.id,
                files.len(),
                c.files
            );
        }
        manifests.insert(c.id.clone(), files);
    }
    src.log(&format!("component manifests: {} match", manifests.len()));
    Ok(Fetched { meta, manifests })
}

/// Tiers 1 to `n`.
fn tiers_through(n: u32) -> Vec<u32> {
    (1..=n).collect()
}

/// Install a release's tier into `root`, which must not exist yet or be empty.
///
/// Everything happens in `<root>.partial/` beside it: the downloads under `releases/`,
/// laid out as the release base is, and the extracted copy under `tree/`. Only when every
/// file has checked is `tree/` renamed to `root` and the rest deleted, so `root` is either
/// absent or a whole, checked copy. A run that stopped keeps its downloads, and the next
/// one resumes the tar where it left off.
pub fn install(root: &Path, opts: InstallOptions) -> Result<InstallReport> {
    if opts.tier != 1 {
        bail!(
            "tier {} isn't in mirror releases yet; tier 1 is the one stare.pub publishes",
            opts.tier
        );
    }
    if root.exists() {
        let empty = std::fs::read_dir(root)
            .with_context(|| format!("{} isn't a directory", root.display()))?
            .next()
            .is_none();
        if !empty {
            bail!(
                "{} isn't empty; install makes a new copy (verify or scan checks one that's there)",
                root.display()
            );
        }
    }
    let work = work_dir(root)?;
    let dest = work.join("releases");
    std::fs::create_dir_all(&dest).with_context(|| format!("can't create {}", dest.display()))?;
    let mut bases = opts.origins.clone();
    if !opts.only_origins {
        bases.extend(DEFAULT_ORIGINS.iter().map(|s| s.to_string()));
    } else if bases.is_empty() {
        bail!("--only-origins needs at least one --origin");
    }
    let mut src = Sources::new(&bases, opts.log)?;
    let f = fetch_release(
        &mut src,
        &dest,
        &opts.key,
        opts.release.as_deref(),
        1,
        !opts.only_origins,
    )?;
    let meta = &f.meta;
    let tier = meta.tier(1).context("no tier 1")?;
    let tar = tier
        .tar
        .as_ref()
        .with_context(|| format!("{} has no tier 1 tar", meta.release))?;

    src.log(&format!("downloading {} ({} bytes)", tar.path, tar.bytes));
    let tar_path = src.get(&tar.path, &dest, Some(&tar.pinned()))?;
    src.log(&format!("tar: SHA-256 matches ({})", tar.sha256));
    if let Some(root_hash) = tar.torrent.as_ref().and_then(|t| t.pieces_root.as_ref()) {
        if hash_file(&tar_path)?.btv2.as_ref() != Some(root_hash) {
            bail!("the tar's v2 pieces root isn't the torrent's");
        }
        src.log("tar: v2 pieces root matches the torrent");
    }

    let tree = work.join("tree");
    if tree.exists() {
        // An extraction an earlier run didn't finish; ours, under our work directory.
        std::fs::remove_dir_all(&tree)
            .with_context(|| format!("can't clear {}", tree.display()))?;
    }
    std::fs::create_dir_all(&tree)?;
    extract(&tar_path, &tree)?;
    let (problems, files, bytes) = check_copy(&tree, meta, &f.manifests, &[1], true)?;
    if !problems.is_empty() {
        bail!(
            "{} files in the extracted tar don't match the release, e.g. {}",
            problems.len(),
            problems[0]
        );
    }
    let rdir = tree.join("mirror/releases").join(&meta.release);
    std::fs::create_dir_all(&rdir)?;
    for name in ["release.json", "release.json.minisig"] {
        std::fs::copy(dest.join(&meta.release).join(name), rdir.join(name))
            .with_context(|| format!("can't copy {name} into the copy"))?;
    }
    if root.exists() {
        std::fs::remove_dir(root).with_context(|| format!("can't replace {}", root.display()))?;
    }
    std::fs::rename(&tree, root)
        .with_context(|| format!("can't move the copy into {}", root.display()))?;
    std::fs::remove_dir_all(&work)
        .with_context(|| format!("installed, but can't remove {}", work.display()))?;
    src.log(&format!(
        "installed {} into {}: all {files} files match",
        meta.release,
        root.display()
    ));
    Ok(InstallReport {
        root: root.to_path_buf(),
        release: meta.release.clone(),
        sequence: meta.sequence,
        tier: 1,
        data_date: meta.data_date.clone(),
        files,
        bytes,
    })
}

/// Extract a tier tar into `dir`: regular files, directories and relative symlinks only,
/// each at a safe relative path.
fn extract(tar_path: &Path, dir: &Path) -> Result<()> {
    let file = std::fs::File::open(tar_path)?;
    let mut ar = tar::Archive::new(file);
    ar.set_preserve_permissions(false);
    ar.set_overwrite(false);
    for entry in ar.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.to_string_lossy().into_owned();
        let rel = path.trim_end_matches('/').trim_start_matches("./");
        if rel.is_empty() || rel == "." {
            continue;
        }
        safe_rel(rel).with_context(|| format!("the tar holds {path:?}"))?;
        match entry.header().entry_type() {
            tar::EntryType::Regular | tar::EntryType::Directory => {}
            tar::EntryType::Symlink => {
                let target = entry
                    .link_name()?
                    .with_context(|| format!("{path} is a symlink without a target"))?
                    .to_string_lossy()
                    .into_owned();
                // A copy's only links point at a sibling (site -> site.<version>).
                super::release::check_segment(&target, "a symlink target")
                    .with_context(|| format!("the tar's {path} links outside its directory"))?;
            }
            other => bail!("the tar holds {path}, a {other:?}, which a copy never has"),
        }
        if !entry.unpack_in(dir)? {
            bail!("the tar's {path} would land outside the copy");
        }
    }
    Ok(())
}

/// Check every file of `tiers` in the copy at `root` against its manifest, then the
/// tiers' pointers and symlinks. `hash` false checks presence and size only. Returns the
/// problems, and the number and total size of the manifest files.
fn check_copy(
    root: &Path,
    meta: &Release,
    manifests: &BTreeMap<String, Vec<FileEntry>>,
    tiers: &[u32],
    hash: bool,
) -> Result<(Vec<String>, usize, u64)> {
    let mut bad = Vec::new();
    let mut files = 0;
    let mut bytes = 0;
    for c in meta.components_through(tiers) {
        let Some(list) = manifests.get(&c.id) else {
            bad.push(format!("{}'s manifest is missing", c.id));
            continue;
        };
        for f in list {
            files += 1;
            bytes += f.bytes;
            let p = root.join(safe_rel(&f.path)?);
            let Ok(meta) = std::fs::metadata(&p) else {
                bad.push(format!("{} is missing", f.path));
                continue;
            };
            if !meta.is_file() || meta.len() != f.bytes {
                bad.push(format!("{} ({}) isn't {} bytes", f.path, c.id, f.bytes));
                continue;
            }
            if hash && sha256_file(&p)?.0 != f.sha256 {
                bad.push(format!("{} ({}) doesn't match its SHA-256", f.path, c.id));
            }
        }
    }
    for n in tiers {
        let Some(t) = meta.tier(*n) else { continue };
        for ptr in &t.pointers {
            let p = root.join(safe_rel(&ptr.path)?);
            match sha256_file(&p) {
                Ok((sha, len)) if sha == ptr.sha256 && len == ptr.bytes => {}
                Ok(_) => bad.push(format!("{} doesn't match", ptr.path)),
                Err(_) => bad.push(format!("{} is missing", ptr.path)),
            }
        }
        for (link, target) in &t.symlinks {
            let p = root.join(safe_rel(link)?);
            match std::fs::read_link(&p) {
                Ok(found) if found == Path::new(target) => {}
                _ => bad.push(format!("{link} isn't a link to {target}")),
            }
        }
    }
    Ok((bad, files, bytes))
}

/// An installed copy's release: `mirror/mirror.json` names it, and its signed
/// `release.json` and component manifests are under `mirror/releases/`, each checked.
fn installed(root: &Path, key: &Key) -> Result<(MirrorJson, Fetched)> {
    let mj_path = root.join("mirror/mirror.json");
    let mj =
        MirrorJson::parse(&std::fs::read(&mj_path).with_context(|| {
            format!("{} isn't a copy: no {}", root.display(), mj_path.display())
        })?)?;
    let rdir = root.join("mirror/releases").join(&mj.release);
    let rj = std::fs::read(rdir.join("release.json")).with_context(|| {
        format!(
            "{} names {}, but {}/release.json isn't there",
            mj_path.display(),
            mj.release,
            rdir.display()
        )
    })?;
    let sig = std::fs::read_to_string(rdir.join("release.json.minisig"))
        .with_context(|| format!("no {}/release.json.minisig", rdir.display()))?;
    key.verify(&rj, &sig, "release.json")?;
    let meta = Release::parse(&rj, key, &mj.release)?;
    let mut manifests = BTreeMap::new();
    for c in meta.components_through(&mj.tiers) {
        let p = root
            .join("mirror/releases")
            .join(safe_rel(&c.files_json.path)?);
        let data = std::fs::read(&p).with_context(|| format!("no {}", p.display()))?;
        let got = super::hash::hash_reader(&data[..])?;
        if !super::source::matches(&got, &c.files_json) {
            bail!("{} isn't the manifest release.json pins", p.display());
        }
        let files = read_files_json_gz(&data)?;
        if files.len() as u64 != c.files {
            bail!(
                "{}'s files.json.gz lists {} files, not {}",
                c.id,
                files.len(),
                c.files
            );
        }
        manifests.insert(c.id.clone(), files);
    }
    Ok((mj, Fetched { meta, manifests }))
}

/// Rehash every file of an installed copy against its release.
pub fn verify(root: &Path, key: &Key) -> Result<VerifyReport> {
    let (mj, f) = installed(root, key)?;
    let (bad, files, bytes) = check_copy(root, &f.meta, &f.manifests, &mj.tiers, true)?;
    Ok(VerifyReport {
        root: root.to_path_buf(),
        release: f.meta.release.clone(),
        sequence: f.meta.sequence,
        tiers: mj.tiers.clone(),
        files,
        bytes,
        problems: bad.len(),
        listed: bad.into_iter().take(MAX_LISTED).collect(),
    })
}

/// What a copy holds: its release, each component's files present at the right size, and
/// the files the release doesn't name. Sizes only, no hashing; `verify` hashes.
pub fn scan(root: &Path, key: &Key) -> Result<ScanReport> {
    let (mj, f) = installed(root, key)?;
    let meta = &f.meta;
    let mut named: BTreeSet<String> = BTreeSet::new();
    let mut components = Vec::new();
    let mut missing = Vec::new();
    for c in meta.components_through(&mj.tiers) {
        let list = &f.manifests[&c.id];
        let (mut gone, mut wrong) = (0, 0);
        for e in list {
            named.insert(e.path.clone());
            match std::fs::metadata(root.join(safe_rel(&e.path)?)) {
                Ok(m) if m.is_file() && m.len() == e.bytes => {}
                Ok(_) => {
                    wrong += 1;
                    if missing.len() < MAX_LISTED {
                        missing.push(format!("{} isn't {} bytes", e.path, e.bytes));
                    }
                }
                Err(_) => {
                    gone += 1;
                    if missing.len() < MAX_LISTED {
                        missing.push(format!("{} is missing", e.path));
                    }
                }
            }
        }
        components.push(ComponentScan {
            id: c.id.clone(),
            version: c.version.clone(),
            tier: c.tier,
            files: list.len(),
            missing: gone,
            wrong_size: wrong,
        });
    }
    let mut links = BTreeSet::new();
    for n in &mj.tiers {
        if let Some(t) = meta.tier(*n) {
            named.extend(t.pointers.iter().map(|p| p.path.clone()));
            links.extend(t.symlinks.keys().cloned());
        }
    }
    let mut extra = Vec::new();
    let mut extra_bytes = 0;
    walk(root, root, &named, &links, &mut extra, &mut extra_bytes)?;
    extra.sort();
    Ok(ScanReport {
        root: root.to_path_buf(),
        release: meta.release.clone(),
        sequence: meta.sequence,
        data_date: meta.data_date.clone(),
        tiers: mj.tiers.clone(),
        components,
        missing,
        extra,
        extra_bytes,
    })
}

fn walk(
    root: &Path,
    dir: &Path,
    named: &BTreeSet<String>,
    links: &BTreeSet<String>,
    extra: &mut Vec<String>,
    extra_bytes: &mut u64,
) -> Result<()> {
    for entry in std::fs::read_dir(dir).with_context(|| format!("can't read {}", dir.display()))? {
        let entry = entry?;
        let path = entry.path();
        let rel = path
            .strip_prefix(root)
            .expect("under the root")
            .to_string_lossy()
            .replace('\\', "/");
        if rel == "mirror/releases" {
            continue;
        }
        let ft = entry.file_type()?;
        if ft.is_symlink() {
            if !links.contains(&rel) {
                extra.push(rel);
            }
        } else if ft.is_dir() {
            walk(root, &path, named, links, extra, extra_bytes)?;
        } else if !named.contains(&rel) {
            *extra_bytes += entry.metadata()?.len();
            extra.push(rel);
        }
    }
    Ok(())
}
