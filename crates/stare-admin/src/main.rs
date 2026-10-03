use anyhow::Context;
use clap::{Parser, Subcommand};
use rayon::prelude::*;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Parser)]
#[command(
    name = "stare-admin",
    about = "Build tools for stare.pub case law index"
)]
struct Cli {
    /// Show detailed output for each file
    #[arg(long, short, global = true)]
    verbose: bool,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Build .bin index from a zip file
    BuildIndex {
        /// Path to the volume zip file
        zip_path: PathBuf,
        /// Output path for the .bin file
        #[arg(short, long)]
        output: Option<PathBuf>,
    },
    /// Build indexes for all zips in a directory
    BatchIndex {
        /// Directory containing reporter/volume.zip files
        dir: PathBuf,
        /// Output directory for .bin files (preserves reporter/vol structure)
        #[arg(short, long)]
        output_dir: Option<PathBuf>,
    },
    /// Build manifest.json: indexed volumes, split volumes' parts and page ranges, counts
    BuildManifest {
        /// Directory containing .bin index files (reporter/volume.bin structure)
        index_dir: PathBuf,
        /// Output path (default: manifest.json in index_dir)
        #[arg(short, long)]
        output: Option<PathBuf>,
        /// CAP's VolumesMetadata.json (static.case.law/VolumesMetadata.json), which says
        /// which folders are parts of one volume. Required when any are.
        #[arg(long)]
        volumes_metadata: Option<PathBuf>,
    },
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Commands::BuildIndex { zip_path, output } => {
            build_index(&zip_path, output.as_deref(), cli.verbose)?;
        }
        Commands::BatchIndex { dir, output_dir } => {
            batch_index(&dir, output_dir.as_deref(), cli.verbose)?;
        }
        Commands::BuildManifest {
            index_dir,
            output,
            volumes_metadata,
        } => {
            build_manifest(&index_dir, output.as_deref(), volumes_metadata.as_deref())?;
        }
    }

    Ok(())
}

/// Parse a page number from a case filename.
///
/// Handles formats:
///   "0647-01"       → 647
///   "1265=1275-01"  → 1265 (takes first number before =)
///   "105, 106-01"   → 105 (takes first number before comma)
///   "428e-01"       → 428 (strips trailing letter suffix)
///   "1028A-01"      → 1028 (strips trailing letter suffix)
///   "LXXXVIII-01"   → None (roman numerals — front matter, skipped for now)
///   "Supp. 1-01"    → None (supplement pages, skipped for now)
///   "000?-02"       → None (unknown page, skipped)
fn parse_case_page(filename: &str) -> Option<usize> {
    let page_part = filename.split('-').next()?;
    // Take the first chunk (before = or ,)
    let chunk = page_part.split(['=', ',', ' ']).next()?.trim();
    // Try parsing directly
    if let Ok(n) = chunk.parse::<usize>() {
        return Some(n);
    }
    // Extract the longest numeric substring (handles both "428e" and "B174")
    let digits: String = chunk.chars().filter(|c| c.is_ascii_digit()).collect();
    if !digits.is_empty() {
        return digits.parse::<usize>().ok();
    }
    None
}

fn build_index(
    zip_path: &std::path::Path,
    output: Option<&std::path::Path>,
    verbose: bool,
) -> anyhow::Result<()> {
    let zip_bytes = std::fs::read(zip_path)
        .with_context(|| format!("failed to read {}", zip_path.display()))?;
    let cases = stare::case::list_cases_in_zip(&zip_bytes)?;

    let mut skipped = 0;
    let case_pages: Vec<(&str, usize)> = cases
        .iter()
        .filter_map(|c| match parse_case_page(c) {
            Some(page) => Some((c.as_str(), page)),
            None => {
                skipped += 1;
                eprintln!(
                    "Warning: skipping case with unparseable page: {} (in {})",
                    c,
                    zip_path.display()
                );
                None
            }
        })
        .collect();

    let result = stare::index::build(&case_pages);

    let out_path = output
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| zip_path.with_extension("bin"));
    std::fs::write(&out_path, &result.bin)
        .with_context(|| format!("failed to write {}", out_path.display()))?;

    if !result.multi.is_empty() {
        let multi_path = out_path.with_extension("multi");
        let multi_data = stare::index::serialize_multi(&result.multi);
        std::fs::write(&multi_path, &multi_data)
            .with_context(|| format!("failed to write {}", multi_path.display()))?;
    }

    if verbose {
        let multi_note = if result.multi.is_empty() {
            String::new()
        } else {
            format!(" ({} multi-case pages)", result.multi.len())
        };
        let skip_note = if skipped > 0 {
            format!(", {} skipped", skipped)
        } else {
            String::new()
        };
        println!(
            "  {} cases{}{}, {} bytes → {}",
            case_pages.len(),
            multi_note,
            skip_note,
            result.bin.len(),
            out_path.display()
        );
    }

    Ok(())
}

fn batch_index(
    dir: &std::path::Path,
    output_dir: Option<&std::path::Path>,
    verbose: bool,
) -> anyhow::Result<()> {
    let zips: Vec<PathBuf> = walkdir(dir)?
        .into_iter()
        .filter(|p| p.extension().map(|e| e == "zip").unwrap_or(false))
        .collect();

    println!("Found {} zip files, indexing in parallel...", zips.len());

    let count = AtomicUsize::new(0);
    let errors = AtomicUsize::new(0);
    // Pre-create output directories (not safe to race on mkdir)
    if let Some(out) = output_dir {
        for zip_path in &zips {
            let rel = zip_path.strip_prefix(dir).unwrap_or(zip_path);
            let out_path = out.join(rel).with_extension("bin");
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
        }
    }

    let total = zips.len();

    zips.par_iter().for_each(|zip_path| {
        let out_path = match output_dir {
            Some(out) => {
                let rel = zip_path.strip_prefix(dir).unwrap_or(zip_path);
                out.join(rel).with_extension("bin")
            }
            None => zip_path.with_extension("bin"),
        };

        match build_index(zip_path, Some(&out_path), verbose) {
            Ok(()) => {
                let n = count.fetch_add(1, Ordering::Relaxed) + 1;
                if n.is_multiple_of(100) || n == total {
                    eprint!("\rProgress: {}/{} indexed", n, total);
                }
            }
            Err(e) => {
                eprintln!("\nError indexing {}: {}", zip_path.display(), e);
                errors.fetch_add(1, Ordering::Relaxed);
            }
        }
    });

    let indexed = count.load(Ordering::Relaxed);
    let errs = errors.load(Ordering::Relaxed);
    println!("\n\nBatch complete: {} indexed, {} errors", indexed, errs);
    Ok(())
}

/// What one volume's index files hold.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct VolumeStats {
    /// Index entries: cases in the .bin plus lines in the .multi.
    entries: u64,
    /// The lowest and highest page any entry is at.
    pages: Option<(u32, u32)>,
}

fn volume_stats(bin_path: &std::path::Path) -> anyhow::Result<VolumeStats> {
    let bin = std::fs::read(bin_path)
        .with_context(|| format!("failed to read {}", bin_path.display()))?;
    let mut stats = VolumeStats::default();
    let note_page = |page: u32, stats: &mut VolumeStats| {
        stats.entries += 1;
        stats.pages = Some(match stats.pages {
            None => (page, page),
            Some((lo, hi)) => (lo.min(page), hi.max(page)),
        });
    };
    for (page, entry) in bin
        .as_chunks::<{ stare::index::ENTRY_SIZE }>()
        .0
        .iter()
        .enumerate()
    {
        if entry.iter().any(|&b| b != 0) {
            note_page(page as u32, &mut stats);
        }
    }
    let multi_path = bin_path.with_extension("multi");
    if multi_path.exists() {
        let text = std::fs::read_to_string(&multi_path)
            .with_context(|| format!("failed to read {}", multi_path.display()))?;
        for (page, _) in stare::index::parse_multi(&text) {
            note_page(page as u32, &mut stats);
        }
    }
    Ok(stats)
}

/// The fields of CAP's VolumesMetadata.json that say which folders are parts of one
/// volume.
#[derive(serde::Deserialize)]
struct CapVolume {
    reporter_slug: String,
    volume_folder: String,
    volume_number: String,
}

/// Scan an index directory for .bin files and build manifest.json (format 2, see
/// `stare::manifest`): every indexed volume folder per reporter, the parts of each
/// volume number CAP split over several folders with the pages each part's index
/// covers, and the volume and entry totals.
///
/// Which folders are parts of one volume comes from CAP's VolumesMetadata.json
/// (`volume_number`), which is required when any folder isn't a plain number.
fn build_manifest(
    index_dir: &std::path::Path,
    output: Option<&std::path::Path>,
    volumes_metadata: Option<&std::path::Path>,
) -> anyhow::Result<()> {
    let mut stats: BTreeMap<(String, String), VolumeStats> = BTreeMap::new();
    for path in walkdir(index_dir)? {
        if path.extension().map(|e| e != "bin").unwrap_or(true) {
            continue;
        }
        let Some(parent) = path.parent().filter(|p| *p != index_dir) else {
            continue;
        };
        let reporter = parent
            .file_name()
            .and_then(|s| s.to_str())
            .with_context(|| format!("bad reporter directory for {}", path.display()))?;
        let volume = path
            .file_stem()
            .and_then(|s| s.to_str())
            .with_context(|| format!("bad file name {}", path.display()))?;
        if !stare::manifest::is_volume_key(volume) {
            anyhow::bail!("not a volume folder name: {}", path.display());
        }
        stats.insert(
            (reporter.to_string(), volume.to_string()),
            volume_stats(&path)?,
        );
    }

    let mut manifest = stare::manifest::Manifest::default();
    for (reporter, volume) in stats.keys() {
        manifest
            .reporters
            .entry(reporter.clone())
            .or_default()
            .push(volume.clone());
    }
    for volumes in manifest.reporters.values_mut() {
        volumes.sort_by(|a, b| stare::manifest::compare_volumes(a, b));
    }
    manifest.volumes = Some(stats.len() as u64);
    manifest.entries = Some(stats.values().map(|s| s.entries).sum());

    let split = stats
        .keys()
        .any(|(_, v)| !v.chars().all(|c| c.is_ascii_digit()));
    match volumes_metadata {
        Some(path) => {
            let bytes = std::fs::read(path)
                .with_context(|| format!("failed to read {}", path.display()))?;
            let cap: Vec<CapVolume> = serde_json::from_slice(&bytes)
                .with_context(|| format!("failed to parse {}", path.display()))?;
            manifest.parts = split_parts(&cap, &stats);
        }
        None if split => anyhow::bail!(
            "{} has volume folders that aren't plain numbers (split volumes); \
             pass --volumes-metadata with CAP's VolumesMetadata.json to say which are parts of one volume",
            index_dir.display()
        ),
        None => {}
    }

    let out_path = output
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| index_dir.join("manifest.json"));
    std::fs::write(&out_path, manifest.to_json()?)
        .with_context(|| format!("failed to write {}", out_path.display()))?;

    let split_volumes: usize = manifest.parts.values().map(|n| n.len()).sum();
    println!(
        "Built manifest: {} reporters, {} volumes ({} split over several folders), {} entries → {}",
        manifest.reporters.len(),
        stats.len(),
        split_volumes,
        manifest.entries.unwrap_or(0),
        out_path.display()
    );
    Ok(())
}

/// The parts of every volume number CAP split over more than one indexed folder, keyed
/// by reporter and then by the number as cited. A volume number that isn't a plain
/// number (`33 Suppl.`, `81 1/2`) can't be cited as one, so it's left out; its folder is
/// still listed, and reachable, by name.
fn split_parts(
    cap: &[CapVolume],
    stats: &BTreeMap<(String, String), VolumeStats>,
) -> BTreeMap<String, BTreeMap<String, Vec<stare::manifest::Part>>> {
    let mut groups: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();
    for v in cap {
        let number = v.volume_number.trim();
        if number.is_empty() || !number.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        if stats.contains_key(&(v.reporter_slug.clone(), v.volume_folder.clone())) {
            groups
                .entry((v.reporter_slug.clone(), number.to_string()))
                .or_default()
                .push(v.volume_folder.clone());
        }
    }
    let mut parts: BTreeMap<String, BTreeMap<String, Vec<stare::manifest::Part>>> = BTreeMap::new();
    for ((reporter, number), mut folders) in groups {
        if folders.iter().all(|f| *f == number) {
            continue;
        }
        folders.sort_by(|a, b| stare::manifest::compare_volumes(a, b));
        folders.dedup();
        let list: Vec<stare::manifest::Part> = folders
            .into_iter()
            .filter_map(|folder| {
                let (first_page, last_page) = stats[&(reporter.clone(), folder.clone())].pages?;
                Some(stare::manifest::Part {
                    volume: folder,
                    first_page,
                    last_page,
                })
            })
            .collect();
        if !list.is_empty() {
            parts.entry(reporter).or_default().insert(number, list);
        }
    }
    parts
}

/// Simple recursive directory walk returning all file paths.
fn walkdir(dir: &std::path::Path) -> anyhow::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(dir)
        .with_context(|| format!("failed to read directory {}", dir.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            files.extend(walkdir(&path)?);
        } else {
            files.push(path);
        }
    }
    files.sort();
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../stare/tests/fixtures");

    /// An index directory holding a3d 138's two real CAP folders and a plain volume.
    fn index_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("a3d")).unwrap();
        std::fs::create_dir_all(dir.path().join("ga")).unwrap();
        for v in ["138", "138-2"] {
            std::fs::copy(
                format!("{FIXTURES}/a3d-{v}.bin"),
                dir.path().join(format!("a3d/{v}.bin")),
            )
            .unwrap();
        }
        let built = stare::index::build(&[("0005-01", 5), ("0005-02", 5), ("0009-01", 9)]);
        std::fs::write(dir.path().join("a3d/9.bin"), &built.bin).unwrap();
        std::fs::write(
            dir.path().join("a3d/9.multi"),
            stare::index::serialize_multi(&built.multi),
        )
        .unwrap();
        std::fs::write(dir.path().join("ga/33-suppl.bin"), &built.bin).unwrap();
        dir
    }

    fn volumes_metadata(dir: &std::path::Path) -> PathBuf {
        let path = dir.join("VolumesMetadata.json");
        std::fs::write(
            &path,
            r#"[
              {"reporter_slug": "a3d", "volume_folder": "9", "volume_number": "9"},
              {"reporter_slug": "a3d", "volume_folder": "138", "volume_number": "138"},
              {"reporter_slug": "a3d", "volume_folder": "138-2", "volume_number": "138"},
              {"reporter_slug": "a3d", "volume_folder": "139-2", "volume_number": "139"},
              {"reporter_slug": "ga", "volume_folder": "33-suppl", "volume_number": "33 Suppl."}
            ]"#,
        )
        .unwrap();
        path
    }

    #[test]
    fn manifest_lists_split_volumes_as_strings_with_their_page_ranges() {
        let dir = index_dir();
        let meta = volumes_metadata(dir.path());
        build_manifest(dir.path(), None, Some(&meta)).unwrap();
        let m = stare::manifest::Manifest::parse(
            &std::fs::read(dir.path().join("manifest.json")).unwrap(),
        )
        .unwrap();

        assert!(!m.legacy);
        assert_eq!(m.volumes("a3d"), ["9", "138", "138-2"]);
        assert_eq!(m.volumes("ga"), ["33-suppl"]);
        assert_eq!(m.volumes, Some(4));

        // The page ranges come from the folders' own indexes.
        let parts = &m.parts["a3d"]["138"];
        assert_eq!(
            parts,
            &[
                stare::manifest::Part {
                    volume: "138".into(),
                    first_page: 8,
                    last_page: 1221
                },
                stare::manifest::Part {
                    volume: "138-2".into(),
                    first_page: 2,
                    last_page: 1263
                },
            ]
        );
        // Unsplit volumes, unindexed folders and non-numeric volume numbers get no parts.
        assert_eq!(m.parts.len(), 1);
        assert_eq!(m.parts["a3d"].len(), 1);
        assert_eq!(m.candidates("a3d", "138", 1012), ["138", "138-2"]);
    }

    #[test]
    fn manifest_counts_bin_and_multi_entries() {
        let dir = index_dir();
        let stats = volume_stats(&dir.path().join("a3d/9.bin")).unwrap();
        assert_eq!(stats.entries, 3);
        assert_eq!(stats.pages, Some((5, 9)));
    }

    #[test]
    fn split_folders_need_the_volumes_metadata() {
        let dir = index_dir();
        let err = build_manifest(dir.path(), None, None).unwrap_err();
        assert!(err.to_string().contains("--volumes-metadata"), "{err}");
    }

    #[test]
    fn implausible_folder_names_fail_the_build() {
        let dir = index_dir();
        std::fs::write(dir.path().join("a3d/x9.bin"), [0u8; 8]).unwrap();
        let meta = volumes_metadata(dir.path());
        assert!(build_manifest(dir.path(), None, Some(&meta)).is_err());
    }
}
