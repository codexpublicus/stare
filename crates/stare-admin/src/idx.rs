//! Writing the unified per-volume index (`<slug>/<vol>.idx.gz`, see `stare::idx`) for a
//! build: CAP's lines from each volume folder, folded into one file per volume as cited,
//! plus CourtListener's lines from an export manifest.

use anyhow::Context;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use stare::idx::Entry;
use std::collections::BTreeMap;
use std::io::BufRead;
use std::path::{Path, PathBuf};

use crate::CapVolume;

/// `(slug, volume)`: a CAP folder, or a volume as cited.
pub type VolumeKey = (String, String);

/// Where a CAP folder's lines go: the volume file they're in, and the folder to name in
/// their refs when it isn't that volume.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Placement {
    pub volume: String,
    pub prefix: Option<String>,
}

/// Where each folder's lines go. A volume number CAP split over several folders (CAP's
/// VolumesMetadata.json gives the folders the same plain-number `volume_number`, and at
/// least one isn't named for it) is one file under that number; every other folder is
/// its own file. The same grouping as the manifest's `parts`.
pub fn placements<'a>(
    folders: impl Iterator<Item = &'a VolumeKey>,
    meta: &[CapVolume],
) -> BTreeMap<VolumeKey, Placement> {
    let folders: Vec<&VolumeKey> = folders.collect();
    let present: std::collections::BTreeSet<&VolumeKey> = folders.iter().copied().collect();
    let mut groups: BTreeMap<VolumeKey, Vec<String>> = BTreeMap::new();
    for v in meta {
        let number = v.volume_number.trim();
        if number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let key = (v.reporter_slug.clone(), v.volume_folder.clone());
        if present.contains(&key) {
            groups
                .entry((v.reporter_slug.clone(), number.to_string()))
                .or_default()
                .push(v.volume_folder.clone());
        }
    }
    let mut out: BTreeMap<VolumeKey, Placement> = BTreeMap::new();
    for ((slug, number), members) in groups {
        if members.iter().all(|f| *f == number) {
            continue;
        }
        for folder in members {
            let prefix = (folder != number).then(|| folder.clone());
            out.insert(
                (slug.clone(), folder),
                Placement {
                    volume: number.clone(),
                    prefix,
                },
            );
        }
    }
    for key in folders {
        out.entry(key.clone()).or_insert_with(|| Placement {
            volume: key.1.clone(),
            prefix: None,
        });
    }
    out
}

/// What reading a CourtListener export manifest found. Written into batch-index's
/// results and the build report.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClInput {
    /// The export date, from the manifest's directory (`cl/exports/<date>/`), if it is one.
    pub export: Option<String>,
    /// Records (manifest lines) read.
    pub records: u64,
    /// Citations across them.
    pub citations: u64,
    /// Index lines made (a citation with two candidate slugs makes two).
    pub lines: u64,
    /// Records with no line at all.
    pub records_without_lines: u64,
    /// Citations left out: Westlaw and LEXIS numbers, which are never a reporter volume.
    pub skipped_vendor: u64,
    /// Citations left out: a volume a path can't hold (`is_volume_key`).
    pub skipped_volume: u64,
    /// Citations left out: a page a line can't hold.
    pub skipped_page: u64,
    /// Citations left out: no usable slug.
    pub skipped_slug: u64,
    /// Citations whose slug was derived from the reporter's name, CAP having none.
    pub derived_slug: u64,
    /// Citations CAP's table gives several slugs (`Ct. Cl.`), indexed under each.
    pub several_slugs: u64,
}

#[derive(Deserialize)]
struct ManifestLine {
    id: u64,
    hash: String,
    #[serde(default)]
    citations: Vec<ManifestCite>,
}

#[derive(Deserialize)]
struct ManifestCite {
    #[serde(default)]
    volume: Option<String>,
    #[serde(default)]
    reporter: Option<String>,
    #[serde(default)]
    page: Option<String>,
    #[serde(default, rename = "type")]
    cite_type: Option<i64>,
    /// citare's slug, once the pipeline writes it (citare#71).
    #[serde(default)]
    slug: Option<String>,
    #[serde(default)]
    cap_slugs: Vec<String>,
}

/// CourtListener citation types that are never a reporter volume: LEXIS and Westlaw.
const VENDOR_TYPES: [i64; 2] = [6, 7];

/// A reporter name as a slug, the way citare names an edition CAP doesn't have
/// (citare#71): lowercased, apostrophes dropped, every other run of characters that
/// aren't ASCII letters or digits one hyphen. `NY Slip Op` → `ny-slip-op`, `F.4th` →
/// `f-4th`.
pub fn derive_slug(reporter: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for c in reporter.chars().flat_map(char::to_lowercase) {
        if matches!(c, '\'' | '\u{2019}' | '\u{2018}') {
            continue;
        }
        if c.is_ascii_alphanumeric() {
            if gap && !out.is_empty() {
                out.push('-');
            }
            out.push(c);
            gap = false;
        } else {
            gap = true;
        }
    }
    out
}

/// Read a CourtListener export manifest (`cl/exports/<date>/manifest.ndjson.gz`, as
/// `stare-cl records` writes it; gzipped or plain): one `cl` line per citation of each
/// record, under the slug and volume as cited.
pub fn read_cl_manifest(path: &Path) -> anyhow::Result<(BTreeMap<VolumeKey, Vec<Entry>>, ClInput)> {
    let file =
        std::fs::File::open(path).with_context(|| format!("failed to open {}", path.display()))?;
    let mut head = [0u8; 2];
    let gz = {
        use std::io::Read;
        let mut f = &file;
        f.read(&mut head)? == 2 && head == [0x1f, 0x8b]
    };
    let file =
        std::fs::File::open(path).with_context(|| format!("failed to open {}", path.display()))?;
    let reader: Box<dyn BufRead> = if gz {
        Box::new(std::io::BufReader::new(flate2::read::MultiGzDecoder::new(
            file,
        )))
    } else {
        Box::new(std::io::BufReader::new(file))
    };
    let mut input = ClInput {
        export: path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .filter(|n| n.len() == 10 && n.as_bytes()[4] == b'-' && n.as_bytes()[7] == b'-')
            .map(String::from),
        ..Default::default()
    };
    let mut out: BTreeMap<VolumeKey, Vec<Entry>> = BTreeMap::new();
    for (i, line) in reader.lines().enumerate() {
        let line = line.with_context(|| format!("{}: line {}", path.display(), i + 1))?;
        if line.trim().is_empty() {
            continue;
        }
        let record: ManifestLine = serde_json::from_str(&line).with_context(|| {
            format!("{}: line {} isn't a manifest record", path.display(), i + 1)
        })?;
        if !stare::cl::is_hash(&record.hash) {
            anyhow::bail!(
                "{}: line {}: bad hash {:?}",
                path.display(),
                i + 1,
                record.hash
            );
        }
        input.records += 1;
        let before = input.lines;
        for c in &record.citations {
            input.citations += 1;
            if c.cite_type.is_some_and(|t| VENDOR_TYPES.contains(&t)) {
                input.skipped_vendor += 1;
                continue;
            }
            let volume = c.volume.as_deref().unwrap_or("").trim();
            if !stare::manifest::is_volume_key(volume) {
                input.skipped_volume += 1;
                continue;
            }
            let Some(page) = c.page.as_deref().and_then(stare::idx::parse_page) else {
                input.skipped_page += 1;
                continue;
            };
            let slugs: Vec<String> = match (&c.slug, c.cap_slugs.is_empty()) {
                (Some(s), _) => vec![s.clone()],
                (None, false) => c.cap_slugs.clone(),
                (None, true) => {
                    let s = derive_slug(c.reporter.as_deref().unwrap_or(""));
                    if !s.is_empty() {
                        input.derived_slug += 1;
                    }
                    vec![s]
                }
            };
            let slugs: Vec<String> = slugs
                .into_iter()
                .filter(|s| stare::cl::is_reporter_slug(s))
                .collect();
            if slugs.is_empty() {
                input.skipped_slug += 1;
                continue;
            }
            if slugs.len() > 1 {
                input.several_slugs += 1;
            }
            for slug in slugs {
                let entry = Entry::cl(page.clone(), record.id, &record.hash)?;
                out.entry((slug, volume.to_string()))
                    .or_default()
                    .push(entry);
                input.lines += 1;
            }
        }
        if input.lines == before {
            input.records_without_lines += 1;
        }
    }
    Ok((out, input))
}

/// What writing a build's unified index produced.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Written {
    /// Every volume file written, as cited: `(slug, volume)`.
    pub volumes: Vec<VolumeKey>,
    pub files: u64,
}

/// Write `<out>/<slug>/<vol>.idx.gz` (and later parts) for every volume: CAP's folders'
/// lines (`cap`, keyed by folder, refs without a folder) placed by [`placements`], and
/// CourtListener's (`cl`, keyed by volume as cited). Any `.idx.gz` already under `out`
/// is removed first, so the files are exactly this build's.
pub fn write(
    out: &Path,
    cap: BTreeMap<VolumeKey, Vec<Entry>>,
    meta: &[CapVolume],
    cl: BTreeMap<VolumeKey, Vec<Entry>>,
) -> anyhow::Result<Written> {
    for path in crate::walkdir(out).unwrap_or_default() {
        if is_idx_file(&path) {
            std::fs::remove_file(&path)
                .with_context(|| format!("failed to remove {}", path.display()))?;
        }
    }
    let placed = placements(cap.keys(), meta);
    let mut volumes: BTreeMap<VolumeKey, Vec<Entry>> = BTreeMap::new();
    for (key, entries) in cap {
        let p = &placed[&key];
        let target = volumes
            .entry((key.0.clone(), p.volume.clone()))
            .or_default();
        for e in entries {
            let (folder, file) = e
                .cap_case()
                .with_context(|| format!("{}/{}: not a CAP line: {}", key.0, key.1, e.line()))?;
            if folder.is_some() {
                anyhow::bail!(
                    "{}/{}: CAP line already has a folder: {}",
                    key.0,
                    key.1,
                    e.line()
                );
            }
            target.push(Entry::cap(e.page.clone(), p.prefix.as_deref(), file)?);
        }
    }
    for (key, entries) in cl {
        volumes.entry(key).or_default().extend(entries);
    }
    for (slug, _) in volumes.keys() {
        std::fs::create_dir_all(out.join(slug))
            .with_context(|| format!("failed to create {}", out.join(slug).display()))?;
    }
    let files: Vec<u64> = volumes
        .into_par_iter()
        .map(|((slug, volume), entries)| -> anyhow::Result<u64> {
            let parts = stare::idx::write_parts(entries, stare::idx::SPLIT_LINES);
            for (n, text) in parts.iter().enumerate() {
                let path = out.join(stare::idx::path(&slug, &volume, n)?);
                std::fs::write(&path, stare::idx::gzip(text))
                    .with_context(|| format!("failed to write {}", path.display()))?;
            }
            Ok(parts.len() as u64)
        })
        .collect::<anyhow::Result<_>>()?;
    let written = scan_volumes(out)?;
    Ok(Written {
        files: files.iter().sum(),
        volumes: written,
    })
}

/// Whether `path` is a unified index file.
pub fn is_idx_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.ends_with(".idx.gz"))
}

/// `(slug, volume, part)` of a unified index file under `dir`, from its path.
pub fn idx_file_key(dir: &Path, path: &Path) -> Option<(String, String, usize)> {
    let rel = path.strip_prefix(dir).ok()?;
    let mut comps = rel.components();
    let slug = comps.next()?.as_os_str().to_str()?.to_string();
    let name = comps.next()?.as_os_str().to_str()?;
    if comps.next().is_some() {
        return None;
    }
    let stem = name.strip_suffix(".idx.gz")?;
    let (volume, part) = match stem.split_once('.') {
        Some((v, n)) => (v, n.parse().ok()?),
        None => (stem, 0),
    };
    (stare::cl::is_reporter_slug(&slug) && stare::manifest::is_volume_key(volume))
        .then(|| (slug, volume.to_string(), part))
}

/// The volumes with a unified index file (part 0) under `dir`, sorted.
pub fn scan_volumes(dir: &Path) -> anyhow::Result<Vec<VolumeKey>> {
    let mut out: Vec<VolumeKey> = crate::walkdir(dir)?
        .iter()
        .filter(|p| is_idx_file(p))
        .filter_map(|p| idx_file_key(dir, p))
        .filter(|(_, _, part)| *part == 0)
        .map(|(s, v, _)| (s, v))
        .collect();
    out.sort();
    Ok(out)
}

/// What a build's unified index files hold, for the report.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Counts {
    /// The index format (`stare::idx::FORMAT`).
    pub format: u32,
    /// Volumes, and files (a split volume has several).
    pub volumes: u64,
    pub files: u64,
    /// Volumes in more than one part.
    pub split_volumes: u64,
    /// Volumes with no CAP line: only CourtListener has them.
    pub cl_only_volumes: u64,
    /// Lines per source.
    pub lines: BTreeMap<String, u64>,
    /// Lines a reader would skip as malformed (should be 0).
    pub malformed: u64,
    /// The files' gzipped size in bytes, in total and the largest.
    pub gz_bytes: u64,
    pub max_gz_bytes: u64,
    /// What the CourtListener input held, when the build read one.
    pub cl_input: Option<ClInput>,
}

/// Count what the unified index files under `dir` hold.
pub fn count(dir: &Path) -> anyhow::Result<Option<Counts>> {
    let files: Vec<PathBuf> = crate::walkdir(dir)?
        .into_iter()
        .filter(|p| is_idx_file(p))
        .collect();
    if files.is_empty() {
        return Ok(None);
    }
    struct One {
        key: VolumeKey,
        part: usize,
        gz: u64,
        cap: u64,
        cl: u64,
        malformed: u64,
    }
    let ones: Vec<One> = files
        .par_iter()
        .filter_map(|p| idx_file_key(dir, p).map(|k| (p, k)))
        .map(|(p, (slug, volume, part))| -> anyhow::Result<One> {
            let bytes =
                std::fs::read(p).with_context(|| format!("failed to read {}", p.display()))?;
            let idx = stare::idx::parse_bytes(&bytes)
                .with_context(|| format!("failed to read {}", p.display()))?;
            let of = |s| idx.entries.iter().filter(|e| e.source == s).count() as u64;
            Ok(One {
                key: (slug, volume),
                part,
                gz: bytes.len() as u64,
                cap: of(stare::idx::Source::Cap),
                cl: of(stare::idx::Source::Cl),
                malformed: idx.malformed.len() as u64,
            })
        })
        .collect::<anyhow::Result<_>>()?;
    let mut c = Counts {
        format: stare::idx::FORMAT,
        ..Default::default()
    };
    let mut per_volume: BTreeMap<&VolumeKey, (usize, u64)> = BTreeMap::new();
    for o in &ones {
        c.files += 1;
        c.gz_bytes += o.gz;
        c.max_gz_bytes = c.max_gz_bytes.max(o.gz);
        c.malformed += o.malformed;
        *c.lines.entry("cap".into()).or_default() += o.cap;
        *c.lines.entry("cl".into()).or_default() += o.cl;
        let v = per_volume.entry(&o.key).or_default();
        v.0 = v.0.max(o.part);
        v.1 += o.cap;
    }
    c.volumes = per_volume.len() as u64;
    c.split_volumes = per_volume.values().filter(|(p, _)| *p > 0).count() as u64;
    c.cl_only_volumes = per_volume.values().filter(|(_, cap)| *cap == 0).count() as u64;
    Ok(Some(c))
}

/// A CAP folder's lines from its `.bin` and `.multi` in an index directory.
pub fn folder_entries(dir: &Path, slug: &str, folder: &str) -> anyhow::Result<Vec<Entry>> {
    let bin_path = dir.join(slug).join(format!("{folder}.bin"));
    let bin = std::fs::read(&bin_path)
        .with_context(|| format!("failed to read {}", bin_path.display()))?;
    let multi_path = bin_path.with_extension("multi");
    let multi = match std::fs::read_to_string(&multi_path) {
        Ok(m) => Some(m),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            return Err(e).with_context(|| format!("failed to read {}", multi_path.display()))
        }
    };
    stare::idx::entries_from_bin(&bin, multi.as_deref(), None)
        .with_context(|| format!("{slug}/{folder}"))
}

/// A volume's CAP lines from what indexing its zip built.
pub fn build_entries(result: &stare::index::BuildResult) -> anyhow::Result<Vec<Entry>> {
    let multi = result.multi_file();
    stare::idx::entries_from_bin(&result.bin, multi.as_deref(), None)
}

/// Read CAP's VolumesMetadata.json.
pub fn read_volumes_metadata(path: &Path) -> anyhow::Result<Vec<CapVolume>> {
    let bytes =
        std::fs::read(path).with_context(|| format!("failed to read {}", path.display()))?;
    serde_json::from_slice(&bytes).with_context(|| format!("failed to parse {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use stare::index::PageKey;
    use std::io::Write;

    const H1: &str = "0f3a9c2e7b1d4a65";

    fn meta() -> Vec<CapVolume> {
        serde_json::from_str(
            r#"[
              {"reporter_slug": "a3d", "volume_folder": "138", "volume_number": "138"},
              {"reporter_slug": "a3d", "volume_folder": "138-2", "volume_number": "138"},
              {"reporter_slug": "a3d", "volume_folder": "9", "volume_number": "9"},
              {"reporter_slug": "x", "volume_folder": "5-1", "volume_number": "5"},
              {"reporter_slug": "x", "volume_folder": "5-2", "volume_number": "5"},
              {"reporter_slug": "ga", "volume_folder": "33-suppl", "volume_number": "33 Suppl."}
            ]"#,
        )
        .unwrap()
    }

    fn key(s: &str, v: &str) -> VolumeKey {
        (s.to_string(), v.to_string())
    }

    #[test]
    fn split_folders_fold_into_the_number_as_cited() {
        let folders = [
            key("a3d", "138"),
            key("a3d", "138-2"),
            key("a3d", "9"),
            key("x", "5-1"),
            key("x", "5-2"),
            key("ga", "33-suppl"),
            key("b", "1"),
        ];
        let p = placements(folders.iter(), &meta());
        let at = |s, v| p[&key(s, v)].clone();
        assert_eq!(
            at("a3d", "138"),
            Placement {
                volume: "138".into(),
                prefix: None
            }
        );
        assert_eq!(
            at("a3d", "138-2"),
            Placement {
                volume: "138".into(),
                prefix: Some("138-2".into())
            }
        );
        assert_eq!(at("x", "5-1").volume, "5");
        assert_eq!(at("x", "5-1").prefix.as_deref(), Some("5-1"));
        assert_eq!(
            at("a3d", "9"),
            Placement {
                volume: "9".into(),
                prefix: None
            }
        );
        assert_eq!(at("ga", "33-suppl").volume, "33-suppl");
        assert_eq!(at("b", "1").volume, "1");
    }

    #[test]
    fn slugs_derive_like_citare() {
        assert_eq!(derive_slug("NY Slip Op"), "ny-slip-op");
        assert_eq!(derive_slug("F.4th"), "f-4th");
        assert_eq!(derive_slug("N.Y.S.3d"), "n-y-s-3d");
        assert_eq!(derive_slug("T.C. Memo."), "t-c-memo");
        assert_eq!(derive_slug("F. App’x"), "f-appx");
        assert_eq!(derive_slug("..."), "");
    }

    fn write_manifest(dir: &Path, lines: &[serde_json::Value]) -> PathBuf {
        let d = dir.join("cl/exports/2026-09-30");
        std::fs::create_dir_all(&d).unwrap();
        let path = d.join("manifest.ndjson.gz");
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        for l in lines {
            writeln!(gz, "{}", l).unwrap();
        }
        std::fs::write(&path, gz.finish().unwrap()).unwrap();
        path
    }

    #[test]
    fn reads_the_export_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_manifest(
            dir.path(),
            &[
                serde_json::json!({"id": 1, "hash": H1, "first_seen": "2026-09-30", "citations": [
                    {"cite": "2021 NY Slip Op 01234", "volume": "2021", "reporter": "NY Slip Op", "page": "01234", "type": 2, "cap_slugs": []},
                    {"cite": "2021 WL 1", "volume": "2021", "reporter": "WL", "page": "1", "type": 7, "cap_slugs": []},
                ]}),
                serde_json::json!({"id": 2, "hash": H1, "citations": [
                    {"volume": "250", "reporter": "A.3d", "page": "100", "type": 3, "cap_slugs": ["a3d"]},
                    {"volume": "1", "reporter": "Ct. Cl.", "page": "5", "type": 2, "cap_slugs": ["us-ct-cl", "wv-ct-cl"]},
                    {"volume": "x y", "reporter": "A.3d", "page": "1", "type": 3, "cap_slugs": ["a3d"]},
                    {"volume": "2", "reporter": "A.3d", "page": "", "type": 3, "cap_slugs": ["a3d"]},
                    {"volume": "20", "reporter": "Ohio", "page": "7", "type": 8, "slug": "ohio", "cap_slugs": []},
                ]}),
                serde_json::json!({"id": 3, "hash": H1, "citations": []}),
            ],
        );
        let (lines, input) = read_cl_manifest(&path).unwrap();
        assert_eq!(input.export.as_deref(), Some("2026-09-30"));
        assert_eq!((input.records, input.citations, input.lines), (3, 7, 5));
        assert_eq!(input.skipped_vendor, 1);
        assert_eq!(input.skipped_volume, 1);
        assert_eq!(input.skipped_page, 1);
        assert_eq!(input.derived_slug, 1);
        assert_eq!(input.several_slugs, 1);
        assert_eq!(input.records_without_lines, 1);
        let at = |s, v| {
            lines[&key(s, v)]
                .iter()
                .map(Entry::line)
                .collect::<Vec<_>>()
        };
        assert_eq!(at("ny-slip-op", "2021"), [format!("1234,cl,1/{H1}")]);
        assert_eq!(at("a3d", "250"), [format!("100,cl,2/{H1}")]);
        assert_eq!(at("us-ct-cl", "1").len(), 1);
        assert_eq!(at("wv-ct-cl", "1").len(), 1);
        assert_eq!(at("ohio", "20"), [format!("7,cl,2/{H1}")]);
    }

    #[test]
    fn writes_folded_volumes_and_cl_only_volumes_and_counts_them() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("out");
        std::fs::create_dir_all(out.join("a3d")).unwrap();
        // A stale file from an earlier run goes.
        std::fs::write(out.join("a3d/77.idx.gz"), b"stale").unwrap();
        let cap_line = |p: usize, f: &str| Entry::cap(PageKey::Number(p), None, f).unwrap();
        let mut cap = BTreeMap::new();
        cap.insert(key("a3d", "138"), vec![cap_line(8, "0008-01")]);
        cap.insert(
            key("a3d", "138-2"),
            vec![cap_line(8, "0008-01"), cap_line(1012, "1012-01")],
        );
        // A big volume that splits.
        cap.insert(
            key("a3d", "9"),
            (0..2500)
                .map(|i| cap_line(i / 2 + 1, &format!("{:04}-{:02}", i / 2 + 1, i % 2 + 1)))
                .collect(),
        );
        let mut cl = BTreeMap::new();
        cl.insert(
            key("a3d", "138"),
            vec![Entry::cl(PageKey::Number(8), 5, H1).unwrap()],
        );
        cl.insert(
            key("ny-slip-op", "2021"),
            vec![Entry::cl(PageKey::Number(1234), 6, H1).unwrap()],
        );

        let written = write(&out, cap, &meta(), cl).unwrap();
        assert_eq!(
            written.volumes,
            [
                key("a3d", "138"),
                key("a3d", "9"),
                key("ny-slip-op", "2021")
            ]
        );
        assert!(!out.join("a3d/77.idx.gz").exists());
        assert!(!out.join("a3d/138-2.idx.gz").exists());
        let text = stare::idx::decode(&std::fs::read(out.join("a3d/138.idx.gz")).unwrap()).unwrap();
        assert_eq!(
            text,
            format!("8,cap,0008-01\n8,cap,138-2/0008-01\n8,cl,5/{H1}\n1012,cap,138-2/1012-01\n")
        );
        assert!(out.join("a3d/9.1.idx.gz").exists());
        assert!(out.join("a3d/9.2.idx.gz").exists());
        assert!(!out.join("a3d/9.3.idx.gz").exists());

        // Deterministic: a second write is byte-identical.
        let before = std::fs::read(out.join("a3d/9.1.idx.gz")).unwrap();
        let mut cap = BTreeMap::new();
        cap.insert(
            key("a3d", "9"),
            (0..2500)
                .map(|i| cap_line(i / 2 + 1, &format!("{:04}-{:02}", i / 2 + 1, i % 2 + 1)))
                .collect(),
        );
        let out2 = dir.path().join("out2");
        write(&out2, cap, &meta(), BTreeMap::new()).unwrap();
        assert_eq!(std::fs::read(out2.join("a3d/9.1.idx.gz")).unwrap(), before);

        let c = count(&out).unwrap().unwrap();
        assert_eq!(
            (c.volumes, c.files, c.split_volumes, c.cl_only_volumes),
            (3, 5, 1, 1)
        );
        assert_eq!(c.lines["cap"], 2503);
        assert_eq!(c.lines["cl"], 2);
        assert_eq!(c.malformed, 0);
        assert!(c.max_gz_bytes > 0 && c.gz_bytes >= c.max_gz_bytes);
        std::fs::create_dir_all(dir.path().join("empty")).unwrap();
        assert_eq!(count(&dir.path().join("empty")).unwrap(), None);
    }
}
