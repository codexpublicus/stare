use anyhow::Context;
use clap::{Parser, Subcommand};
use rayon::prelude::*;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

mod report;

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
        /// JSON object of volumes ("reporter/volume") allowed to fail the index check,
        /// each with its reason
        #[arg(long)]
        allow: Option<PathBuf>,
    },
    /// Build indexes for all zips in a directory
    BatchIndex {
        /// Directory containing reporter/volume.zip files
        dir: PathBuf,
        /// Output directory for .bin files (preserves reporter/vol structure)
        #[arg(short, long)]
        output_dir: Option<PathBuf>,
        /// JSON object of volumes ("reporter/volume") allowed to fail the index check,
        /// each with its reason
        #[arg(long)]
        allow: Option<PathBuf>,
        /// Write what indexing each volume found here (JSON), for build-report. Written
        /// even when volumes fail.
        #[arg(long)]
        results: Option<PathBuf>,
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
        /// The index's CalVer data version, vYYYY.MM.DD or vYYYY.MM.DD.N for a later
        /// release the same day (default: today's UTC date, vYYYY.MM.DD)
        #[arg(long = "version", value_name = "VERSION")]
        data_version: Option<String>,
    },
    /// Build report.json for an index build: its identity, totals, per-reporter counts,
    /// failed and allow-listed volumes, and the changes since a previous report
    /// (schemas/index-report.v1.schema.json)
    BuildReport {
        /// The build directory: the .bin and .multi files and, when build-manifest ran,
        /// manifest.json
        build_dir: PathBuf,
        /// The build's data version, vYYYY.MM.DD[.N]
        #[arg(long = "version", value_name = "VERSION")]
        data_version: String,
        /// What batch-index --results wrote (default: batch-index.json in build_dir)
        #[arg(long)]
        results: Option<PathBuf>,
        /// The previous build's report.json, to report what changed since it
        #[arg(long)]
        previous: Option<PathBuf>,
        /// The stare tag stare-admin was built from
        #[arg(long)]
        stare_tag: Option<String>,
        /// That tag's commit
        #[arg(long)]
        stare_commit: Option<String>,
        /// What identifies the CAP data the build read
        #[arg(long)]
        cap_release: Option<String>,
        /// When the build started, as an RFC 3339 UTC time (2026-10-03T17:04:12Z)
        #[arg(long)]
        started_at: Option<String>,
        /// Output path (default: report.json in build_dir)
        #[arg(short, long)]
        output: Option<PathBuf>,
    },
    /// Write the citare data bundle built into stare to DIR as
    /// citare-data-<hash>.bin (the one stare-wasm loads; the site serves it from
    /// /data/citare/v1/), remove any other citare-data-*.bin there, and print
    /// the file's path
    ExportCitareData {
        /// Output directory, created if missing
        dir: PathBuf,
    },
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Commands::BuildIndex {
            zip_path,
            output,
            allow,
        } => {
            let allow = load_allowlist(allow.as_deref())?;
            let key = volume_key(&zip_path, zip_path.parent().and_then(|p| p.parent()));
            let report = build_index(&zip_path, output.as_deref(), cli.verbose)?;
            if let Some(reason) = check_failure(&key, &report, &allow) {
                anyhow::bail!("{}", reason);
            }
        }
        Commands::BatchIndex {
            dir,
            output_dir,
            allow,
            results,
        } => {
            let allow = load_allowlist(allow.as_deref())?;
            batch_index(
                &dir,
                output_dir.as_deref(),
                &allow,
                results.as_deref(),
                cli.verbose,
            )?;
        }
        Commands::BuildManifest {
            index_dir,
            output,
            volumes_metadata,
            data_version,
        } => {
            build_manifest(
                &index_dir,
                output.as_deref(),
                volumes_metadata.as_deref(),
                data_version.as_deref(),
            )?;
        }
        Commands::BuildReport {
            build_dir,
            data_version,
            results,
            previous,
            stare_tag,
            stare_commit,
            cap_release,
            started_at,
            output,
        } => {
            let identity = report::Identity {
                version: data_version,
                stare_tag,
                stare_commit,
                cap_release,
                started_at,
            };
            build_report(
                &build_dir,
                results.as_deref(),
                previous.as_deref(),
                &identity,
                output.as_deref(),
            )?;
        }
        Commands::ExportCitareData { dir } => {
            let path = export_citare_data(&dir)?;
            println!("{}", path.display());
        }
    }

    Ok(())
}

/// Writes stare's embedded citare data bundle into `dir` under its published
/// name, and removes other bundles there so the site build finds exactly one.
fn export_citare_data(dir: &std::path::Path) -> anyhow::Result<PathBuf> {
    let bytes = stare::data::embedded();
    let name = stare::data::file_name(bytes);
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let other = entry.file_name().to_string_lossy().into_owned();
        if other != name && other.starts_with("citare-data-") && other.ends_with(".bin") {
            std::fs::remove_file(entry.path())?;
        }
    }
    let path = dir.join(&name);
    std::fs::write(&path, bytes).with_context(|| format!("writing {}", path.display()))?;
    Ok(path)
}

/// Volumes allowed to fail the index check: `{"reporter/volume": "reason", ...}`.
type Allowlist = BTreeMap<String, String>;

fn load_allowlist(path: Option<&std::path::Path>) -> anyhow::Result<Allowlist> {
    let Some(path) = path else {
        return Ok(Allowlist::new());
    };
    let bytes =
        std::fs::read(path).with_context(|| format!("failed to read {}", path.display()))?;
    serde_json::from_slice(&bytes).with_context(|| format!("failed to parse {}", path.display()))
}

/// `reporter/volume` for a zip at `<root>/<reporter>/<volume>.zip`.
fn volume_key(zip_path: &std::path::Path, root: Option<&std::path::Path>) -> String {
    let rel = root
        .and_then(|r| zip_path.strip_prefix(r).ok())
        .unwrap_or(zip_path);
    rel.with_extension("").to_string_lossy().replace('\\', "/")
}

/// What building one volume's index found.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct VolumeReport {
    /// Case JSON files in the zip.
    cases: usize,
    /// Index entries written, in the .bin and the .multi.
    entries: usize,
    /// Cases on unnumbered pages (roman numeral front matter, supplements).
    labeled: usize,
    /// Pages whose first case's name is too long for the .bin.
    long_names: usize,
    /// Where the index doesn't account for every case exactly once.
    problems: Vec<String>,
}

/// The reason a volume fails the index check, or None if it passes or is allow-listed.
fn check_failure(key: &str, report: &VolumeReport, allow: &Allowlist) -> Option<String> {
    if report.problems.is_empty() || allow.contains_key(key) {
        return None;
    }
    Some(format!(
        "{}: index check failed ({} cases, {} entries): {}",
        key,
        report.cases,
        report.entries,
        report.problems.join("; ")
    ))
}

/// Build one volume's index from its zip's bytes, and check that the index holds every
/// case in the zip exactly once, each found again by looking up its own page.
///
/// A case's page comes from `first_page` in the zip's CasesMetadata.json, falling back
/// to its file name; see `stare::index::page_key` for how labels map to pages.
fn index_volume(zip_bytes: &[u8]) -> anyhow::Result<(stare::index::BuildResult, VolumeReport)> {
    use stare::index::{self, PageKey};

    let names = stare::case::list_cases_in_zip(zip_bytes)?;
    let mut report = VolumeReport {
        cases: names.len(),
        ..Default::default()
    };

    let meta = match stare::case::extract_cases_metadata(zip_bytes) {
        Ok(meta) => meta,
        Err(e) => {
            report
                .problems
                .push(format!("no usable CasesMetadata.json ({e})"));
            Vec::new()
        }
    };
    let first_pages: BTreeMap<&str, &str> = meta
        .iter()
        .map(|m| (m.file_name.as_str(), m.first_page.as_str()))
        .collect();
    if !meta.is_empty() {
        let in_zip: std::collections::BTreeSet<&str> = names.iter().map(|n| n.as_str()).collect();
        let no_json: Vec<&str> = first_pages
            .keys()
            .filter(|f| !in_zip.contains(*f))
            .copied()
            .collect();
        let no_meta: Vec<&str> = in_zip
            .iter()
            .filter(|f| !first_pages.contains_key(*f))
            .copied()
            .collect();
        if !no_json.is_empty() {
            report.problems.push(format!(
                "in CasesMetadata.json but not json/: {}",
                no_json.join(", ")
            ));
        }
        if !no_meta.is_empty() {
            report.problems.push(format!(
                "in json/ but not CasesMetadata.json: {}",
                no_meta.join(", ")
            ));
        }
    }

    let keyed: Vec<(&str, PageKey)> = names
        .iter()
        .map(|n| {
            let label = first_pages
                .get(n.as_str())
                .copied()
                .unwrap_or_else(|| index::file_page(n));
            (n.as_str(), index::page_key(label))
        })
        .collect();
    let result = index::build(&keyed);
    let multi_text = result.multi_file();

    let mut indexed = index::all_cases(&result.bin, multi_text.as_deref());
    report.entries = indexed.len();
    report.labeled = result.labeled.len();
    report.long_names = result
        .bin
        .chunks(index::ENTRY_SIZE)
        .filter(|e| e.starts_with(index::LONG_NAME.as_bytes()) && e[1..].iter().all(|&b| b == 0))
        .count();

    let mut expected: Vec<&str> = names.iter().map(|n| n.as_str()).collect();
    expected.sort();
    indexed.sort();
    if indexed != expected {
        report.problems.push(format!(
            "index holds {} entries for {} cases",
            indexed.len(),
            expected.len()
        ));
    }
    let multi = index::parse_multi(multi_text.as_deref().unwrap_or(""));
    let labeled = index::parse_labeled(multi_text.as_deref().unwrap_or(""));
    let lost: Vec<&str> = keyed
        .iter()
        .filter(|(name, key)| {
            let found = match key {
                PageKey::Number(page) => index::lookup_all(&result.bin, &multi, *page),
                PageKey::Label(label) => index::lookup_label(&labeled, label),
            };
            !found.contains(name)
        })
        .map(|(name, _)| *name)
        .collect();
    if !lost.is_empty() {
        report
            .problems
            .push(format!("not found at their own page: {}", lost.join(", ")));
    }
    Ok((result, report))
}

fn build_index(
    zip_path: &std::path::Path,
    output: Option<&std::path::Path>,
    verbose: bool,
) -> anyhow::Result<VolumeReport> {
    let zip_bytes = std::fs::read(zip_path)
        .with_context(|| format!("failed to read {}", zip_path.display()))?;
    let (result, report) = index_volume(&zip_bytes)
        .with_context(|| format!("failed to index {}", zip_path.display()))?;

    let out_path = output
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| zip_path.with_extension("bin"));
    std::fs::write(&out_path, &result.bin)
        .with_context(|| format!("failed to write {}", out_path.display()))?;

    // Remove a .multi left by an earlier build when this one needs none.
    let multi_path = out_path.with_extension("multi");
    match result.multi_file() {
        Some(multi) => std::fs::write(&multi_path, multi)
            .with_context(|| format!("failed to write {}", multi_path.display()))?,
        None if multi_path.exists() => std::fs::remove_file(&multi_path)
            .with_context(|| format!("failed to remove {}", multi_path.display()))?,
        None => {}
    }

    if verbose {
        println!(
            "  {} cases, {} entries ({} multi, {} labeled, {} long names), {} bytes → {}",
            report.cases,
            report.entries,
            result.multi.len(),
            report.labeled,
            report.long_names,
            result.bin.len(),
            out_path.display()
        );
    }

    Ok(report)
}

fn batch_index(
    dir: &std::path::Path,
    output_dir: Option<&std::path::Path>,
    allow: &Allowlist,
    results_path: Option<&std::path::Path>,
    verbose: bool,
) -> anyhow::Result<()> {
    let zips: Vec<PathBuf> = walkdir(dir)?
        .into_iter()
        .filter(|p| p.extension().map(|e| e == "zip").unwrap_or(false))
        .collect();

    println!("Found {} zip files, indexing in parallel...", zips.len());

    let count = AtomicUsize::new(0);
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

    let results: Vec<(String, anyhow::Result<VolumeReport>)> = zips
        .par_iter()
        .map(|zip_path| {
            let out_path = match output_dir {
                Some(out) => {
                    let rel = zip_path.strip_prefix(dir).unwrap_or(zip_path);
                    out.join(rel).with_extension("bin")
                }
                None => zip_path.with_extension("bin"),
            };
            let result = build_index(zip_path, Some(&out_path), verbose);
            let n = count.fetch_add(1, Ordering::Relaxed) + 1;
            if n.is_multiple_of(100) || n == total {
                eprint!("\rProgress: {}/{} indexed", n, total);
            }
            (volume_key(zip_path, Some(dir)), result)
        })
        .collect();

    let mut totals = VolumeReport::default();
    let mut errors = Vec::new();
    let mut failures = Vec::new();
    let mut allowed = 0;
    let mut batch = report::BatchResults {
        format: report::RESULTS_FORMAT,
        allow: allow.clone(),
        ..Default::default()
    };
    for (key, result) in &results {
        match result {
            Ok(report) => {
                batch.volumes.insert(key.clone(), report.clone());
                totals.cases += report.cases;
                totals.entries += report.entries;
                totals.labeled += report.labeled;
                totals.long_names += report.long_names;
                if !report.problems.is_empty() {
                    match check_failure(key, report, allow) {
                        Some(reason) => failures.push(reason),
                        None => allowed += 1,
                    }
                }
            }
            Err(e) => {
                batch.errors.insert(key.clone(), format!("{:#}", e));
                errors.push(format!("{}: {:#}", key, e));
            }
        }
    }
    if let Some(path) = results_path {
        std::fs::write(path, serde_json::to_string(&batch)? + "\n")
            .with_context(|| format!("failed to write {}", path.display()))?;
    }

    println!(
        "\n\nBatch complete: {} indexed, {} errors; {} cases, {} entries ({} on unnumbered pages, {} pages with long names)",
        results.len() - errors.len(),
        errors.len(),
        totals.cases,
        totals.entries,
        totals.labeled,
        totals.long_names
    );
    for e in &errors {
        eprintln!("Error indexing {}", e);
    }
    for f in &failures {
        eprintln!("{}", f);
    }
    if allowed > 0 {
        println!(
            "{} volumes failed the index check with an allow-listed reason",
            allowed
        );
    }
    if !errors.is_empty() || !failures.is_empty() {
        anyhow::bail!(
            "{} volumes failed to index and {} failed the index check",
            errors.len(),
            failures.len()
        );
    }
    Ok(())
}

/// What one volume's index files hold.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct VolumeStats {
    /// Index entries: cases in the .bin (less long-name markers) plus lines in the .multi.
    entries: u64,
    /// The lowest and highest page any entry is at.
    pages: Option<(u32, u32)>,
}

fn volume_stats(bin_path: &std::path::Path) -> anyhow::Result<VolumeStats> {
    let bin = std::fs::read(bin_path)
        .with_context(|| format!("failed to read {}", bin_path.display()))?;
    let multi_path = bin_path.with_extension("multi");
    let multi = if multi_path.exists() {
        Some(
            std::fs::read_to_string(&multi_path)
                .with_context(|| format!("failed to read {}", multi_path.display()))?,
        )
    } else {
        None
    };
    // Every numbered page with an entry: the .bin's (markers included) and the .multi's.
    let pages = bin
        .as_chunks::<{ stare::index::ENTRY_SIZE }>()
        .0
        .iter()
        .enumerate()
        .filter(|(_, entry)| entry.iter().any(|&b| b != 0))
        .map(|(page, _)| page as u32)
        .chain(
            stare::index::parse_multi(multi.as_deref().unwrap_or(""))
                .into_iter()
                .map(|(page, _)| page as u32),
        );
    let pages = pages.fold(None, |range: Option<(u32, u32)>, page| {
        Some(range.map_or((page, page), |(lo, hi)| (lo.min(page), hi.max(page))))
    });
    Ok(VolumeStats {
        entries: stare::index::all_cases(&bin, multi.as_deref()).len() as u64,
        pages,
    })
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
///
/// The manifest's `version` is `data_version`, or today's UTC date (`vYYYY.MM.DD`), and
/// its `generated_at` is now.
fn build_manifest(
    index_dir: &std::path::Path,
    output: Option<&std::path::Path>,
    volumes_metadata: Option<&std::path::Path>,
    data_version: Option<&str>,
) -> anyhow::Result<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .context("system clock is before 1970")?
        .as_secs();
    let version = match data_version {
        Some(v) if stare::manifest::is_data_version(v) => v.to_string(),
        Some(v) => anyhow::bail!(
            "--version {:?} isn't a data version: use vYYYY.MM.DD, or vYYYY.MM.DD.N for a later release the same day",
            v
        ),
        None => stare::manifest::data_version_for(now),
    };

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
    manifest.version = Some(version);
    manifest.generated_at = Some(stare::manifest::rfc3339_utc(now));

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
        "Built manifest {}: {} reporters, {} volumes ({} split over several folders), {} entries → {}",
        manifest.version.as_deref().unwrap_or(""),
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

/// Write report.json for the build in `build_dir` from batch-index's results, the
/// build's manifest.json when there is one, and the previous build's report.
fn build_report(
    build_dir: &std::path::Path,
    results: Option<&std::path::Path>,
    previous: Option<&std::path::Path>,
    identity: &report::Identity,
    output: Option<&std::path::Path>,
) -> anyhow::Result<report::Report> {
    if !stare::manifest::is_data_version(&identity.version) {
        anyhow::bail!(
            "--version {:?} isn't a data version: use vYYYY.MM.DD, or vYYYY.MM.DD.N",
            identity.version
        );
    }
    let results_path = results
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| build_dir.join("batch-index.json"));
    let bytes = std::fs::read(&results_path)
        .with_context(|| format!("failed to read {}", results_path.display()))?;
    let results: report::BatchResults = serde_json::from_slice(&bytes)
        .with_context(|| format!("failed to parse {}", results_path.display()))?;
    if results.format != report::RESULTS_FORMAT {
        anyhow::bail!(
            "{} is results format {}; this stare-admin reads {}",
            results_path.display(),
            results.format,
            report::RESULTS_FORMAT
        );
    }

    let manifest_path = build_dir.join("manifest.json");
    let manifest = match std::fs::read(&manifest_path) {
        Ok(bytes) => Some(
            stare::manifest::Manifest::parse(&bytes)
                .with_context(|| format!("failed to parse {}", manifest_path.display()))?,
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            return Err(e).with_context(|| format!("failed to read {}", manifest_path.display()))
        }
    };
    let previous = match previous {
        Some(path) => {
            let bytes = std::fs::read(path)
                .with_context(|| format!("failed to read {}", path.display()))?;
            Some(
                report::Report::parse(&bytes)
                    .with_context(|| format!("failed to parse {}", path.display()))?,
            )
        }
        None => None,
    };

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .context("system clock is before 1970")?
        .as_secs();
    let report = report::build_report(
        build_dir,
        &results,
        manifest.as_ref(),
        identity,
        previous.as_ref(),
        now,
    )?;

    let out_path = output
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| build_dir.join("report.json"));
    std::fs::write(&out_path, report.to_json()?)
        .with_context(|| format!("failed to write {}", out_path.display()))?;

    let t = &report.totals;
    println!(
        "Built report {}: {} reporters, {} volumes, {} cases, {} entries ({} short), {} allow-listed, {} failed → {}",
        report.version,
        t.reporters,
        t.volumes,
        t.cases,
        t.entries,
        t.shortfall,
        t.allowed,
        t.failed,
        out_path.display()
    );
    if let Some(d) = &report.diff {
        println!(
            "Since {}: {} volumes added, {} removed, {} changed; entries {} → {}",
            d.previous_version,
            d.volumes_added.len(),
            d.volumes_removed.len(),
            d.volumes_changed.len(),
            d.totals.entries[0],
            d.totals.entries[1]
        );
    }
    Ok(report)
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

    #[test]
    fn export_citare_data_writes_one_bundle_by_hash() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("citare-data-0000000000000000.bin"), b"old").unwrap();
        std::fs::write(dir.path().join("keep.txt"), b"x").unwrap();
        let path = export_citare_data(dir.path()).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(bytes, stare::data::embedded());
        let name = path.file_name().unwrap().to_str().unwrap();
        assert_eq!(name, stare::data::file_name(&bytes));
        let mut names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, vec![name.to_string(), "keep.txt".to_string()]);
    }

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
        build_manifest(dir.path(), None, Some(&meta), None).unwrap();
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

    fn read_manifest_json(dir: &std::path::Path) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(dir.join("manifest.json")).unwrap()).unwrap()
    }

    #[test]
    fn manifest_carries_the_given_version_and_when_it_was_built() {
        let dir = index_dir();
        let meta = volumes_metadata(dir.path());
        build_manifest(dir.path(), None, Some(&meta), Some("v2026.10.03.1")).unwrap();
        let raw = read_manifest_json(dir.path());
        assert_eq!(raw["format"], 2);
        assert_eq!(raw["version"], "v2026.10.03.1");
        let generated_at = raw["generated_at"].as_str().unwrap();
        assert_eq!(generated_at.len(), "2026-10-03T17:04:12Z".len());
        assert!(generated_at.ends_with('Z'), "{generated_at}");
        // Every key readers already use is still there.
        for key in ["volumes", "entries", "reporters", "parts"] {
            assert!(raw.get(key).is_some(), "{key}");
        }
        let m = stare::manifest::Manifest::parse(
            &std::fs::read(dir.path().join("manifest.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(m.version.as_deref(), Some("v2026.10.03.1"));
        assert_eq!(m.volumes("a3d"), ["9", "138", "138-2"]);
    }

    #[test]
    fn manifest_version_defaults_to_todays_utc_date() {
        let dir = index_dir();
        let meta = volumes_metadata(dir.path());
        let before = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        build_manifest(dir.path(), None, Some(&meta), None).unwrap();
        let after = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let version = read_manifest_json(dir.path())["version"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(stare::manifest::is_data_version(&version), "{version}");
        assert!(
            [before, after]
                .iter()
                .any(|&t| stare::manifest::data_version_for(t) == version),
            "{version}"
        );
    }

    #[test]
    fn manifest_rejects_a_malformed_version() {
        let dir = index_dir();
        let meta = volumes_metadata(dir.path());
        for bad in ["2026.10.03", "v2026.10.3", "latest"] {
            let err = build_manifest(dir.path(), None, Some(&meta), Some(bad)).unwrap_err();
            assert!(err.to_string().contains("isn't a data version"), "{err}");
        }
        assert!(!dir.path().join("manifest.json").exists());
    }

    #[test]
    fn cli_parses_build_manifest_version() {
        use clap::{CommandFactory, Parser};
        Cli::command().debug_assert();
        let cli = Cli::try_parse_from([
            "stare-admin",
            "build-manifest",
            "idx",
            "--version",
            "v2026.10.03.1",
        ])
        .unwrap();
        match cli.command {
            Commands::BuildManifest { data_version, .. } => {
                assert_eq!(data_version.as_deref(), Some("v2026.10.03.1"));
            }
            _ => panic!("not build-manifest"),
        }
    }

    /// A volume zip with these case files, and CasesMetadata.json giving each its first
    /// page (`None` leaves a case out of the metadata).
    fn volume_zip(cases: &[(&str, Option<&str>)]) -> Vec<u8> {
        use std::io::Write;
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default();
        let mut meta = Vec::new();
        for (file, first_page) in cases {
            zip.start_file(format!("json/{file}.json"), opts).unwrap();
            zip.write_all(b"{}").unwrap();
            if let Some(first_page) = first_page {
                meta.push(serde_json::json!({
                    "id": meta.len(), "name_abbreviation": file, "decision_date": "1900",
                    "first_page": first_page, "last_page": first_page, "file_name": file,
                }));
            }
        }
        zip.start_file("metadata/CasesMetadata.json", opts).unwrap();
        zip.write_all(serde_json::to_string(&meta).unwrap().as_bytes())
            .unwrap();
        zip.finish().unwrap().into_inner()
    }

    #[test]
    fn index_holds_every_case_once_including_long_names_and_front_matter() {
        // File names and first pages as CAP has them (or-tax/8, mcgrath/1, cai-cas/1,
        // cal-app-4th/15, mich-np-r/1, a2d/615).
        let zip = volume_zip(&[
            ("0001-01", Some("1")),
            ("[106]-01", Some("[106]")),
            ("1107-01", Some("1107")),
            ("1107½-01", Some("1107½")),
            ("1107½-02", Some("1107½")),
            ("xxix-01", Some("xxix")),
            ("000i-01", Some("i")),
            ("Supp. 1-01", Some("Supp. 1")),
            ("1114-1140-01", Some("1114-1140")),
        ]);
        let (result, report) = index_volume(&zip).unwrap();
        assert_eq!(report.problems, Vec::<String>::new());
        assert_eq!((report.cases, report.entries), (9, 9));
        assert_eq!(report.labeled, 3);
        assert_eq!(report.long_names, 2); // pages 106 and 1114

        let multi = stare::index::parse_multi(&result.multi_file().unwrap());
        assert_eq!(
            stare::index::lookup_all(&result.bin, &multi, 106),
            ["[106]-01"]
        );
        // Zero-padded front matter no longer collapses onto page 0.
        assert!(stare::index::lookup_all(&result.bin, &multi, 0).is_empty());
    }

    #[test]
    fn real_volume_passes_the_check() {
        let zip = std::fs::read(format!("{FIXTURES}/a2d-31.zip")).unwrap();
        let (_, report) = index_volume(&zip).unwrap();
        assert!(report.problems.is_empty(), "{:?}", report.problems);
        assert_eq!(report.entries, report.cases);
    }

    #[test]
    fn metadata_and_files_that_disagree_fail_the_check_unless_allowed() {
        let zip = volume_zip(&[("0001-01", Some("1")), ("0002-01", None)]);
        let (_, report) = index_volume(&zip).unwrap();
        assert_eq!(
            report.problems,
            ["in json/ but not CasesMetadata.json: 0002-01"]
        );
        // The file name still places the case.
        assert_eq!(report.entries, 2);

        let mut allow = Allowlist::new();
        let failure = check_failure("x/1", &report, &allow).unwrap();
        assert!(failure.starts_with("x/1: index check failed (2 cases, 2 entries)"));
        allow.insert("x/1".into(), "CAP left 0002-01 out of the metadata".into());
        assert_eq!(check_failure("x/1", &report, &allow), None);
    }

    #[test]
    fn batch_fails_on_a_check_failure_and_writes_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let zips = dir.path().join("zips");
        std::fs::create_dir_all(zips.join("x")).unwrap();
        std::fs::write(zips.join("x/1.zip"), volume_zip(&[("0001-01", Some("1"))])).unwrap();
        std::fs::write(
            zips.join("x/2.zip"),
            volume_zip(&[("0001-01", Some("1")), ("0002-01", None)]),
        )
        .unwrap();
        let out = dir.path().join("idx");

        let err = batch_index(&zips, Some(&out), &Allowlist::new(), None, false).unwrap_err();
        assert!(
            err.to_string().contains("1 failed the index check"),
            "{err}"
        );
        assert!(out.join("x/1.bin").exists() && out.join("x/2.bin").exists());

        let allow = Allowlist::from([("x/2".to_string(), "known".to_string())]);
        batch_index(&zips, Some(&out), &allow, None, false).unwrap();
    }

    #[test]
    fn batch_results_feed_a_report_and_the_next_build_diffs_against_it() {
        let dir = tempfile::tempdir().unwrap();
        let zips = dir.path().join("zips");
        std::fs::create_dir_all(zips.join("x")).unwrap();
        std::fs::write(zips.join("x/1.zip"), volume_zip(&[("0001-01", Some("1"))])).unwrap();
        std::fs::write(
            zips.join("x/2.zip"),
            volume_zip(&[("0001-01", Some("1")), ("0002-01", None)]),
        )
        .unwrap();
        std::fs::write(zips.join("x/3.zip"), b"not a zip").unwrap();

        // The first build fails: x/2 fails the check and x/3 isn't a zip. The results
        // are written anyway, and the report records both.
        let first = dir.path().join("v1");
        let results = first.join("batch-index.json");
        assert!(batch_index(
            &zips,
            Some(&first),
            &Allowlist::new(),
            Some(&results),
            false
        )
        .is_err());
        let identity = report::Identity {
            version: "v2026.10.04".into(),
            started_at: Some("2026-10-04T00:00:00Z".into()),
            ..Default::default()
        };
        let r1 = build_report(&first, None, None, &identity, None).unwrap();
        assert!(first.join("report.json").exists());
        assert_eq!(
            (r1.totals.volumes, r1.totals.failed, r1.totals.allowed),
            (2, 2, 0)
        );
        assert_eq!(r1.totals.split_volumes, None); // no manifest.json
        let kinds: Vec<_> = r1
            .failed
            .iter()
            .map(|f| (f.volume.as_str(), f.kind))
            .collect();
        assert_eq!(
            kinds,
            [
                ("x/2", report::FailureKind::Check),
                ("x/3", report::FailureKind::Error)
            ]
        );

        // The second build allow-lists x/2, drops x/3, and has a manifest.
        std::fs::remove_file(zips.join("x/3.zip")).unwrap();
        let allow = Allowlist::from([("x/2".to_string(), "CAP left 0002-01 out".to_string())]);
        let second = dir.path().join("v2");
        batch_index(
            &zips,
            Some(&second),
            &allow,
            Some(&second.join("batch-index.json")),
            false,
        )
        .unwrap();
        build_manifest(&second, None, None, Some("v2026.10.05")).unwrap();
        let identity = report::Identity {
            version: "v2026.10.05".into(),
            ..Default::default()
        };
        let r2 = build_report(
            &second,
            None,
            Some(&first.join("report.json")),
            &identity,
            None,
        )
        .unwrap();
        assert_eq!((r2.totals.failed, r2.totals.allowed), (0, 1));
        assert_eq!(
            (r2.totals.split_volumes, r2.totals.split_parts),
            (Some(0), Some(0))
        );
        assert_eq!(
            r2.allowed[0].problems,
            ["in json/ but not CasesMetadata.json: 0002-01"]
        );
        let d = r2.diff.as_ref().unwrap();
        assert_eq!(d.previous_version, "v2026.10.04");
        // Same zips, same indexer: nothing changed but the failures.
        assert!(d.volumes_added.is_empty() && d.volumes_removed.is_empty());
        assert!(d.volumes_changed.is_empty(), "{:?}", d.volumes_changed);

        // A malformed version is refused before anything is written.
        let bad = report::Identity {
            version: "latest".into(),
            ..Default::default()
        };
        let out = dir.path().join("bad.json");
        assert!(build_report(&second, None, None, &bad, Some(&out)).is_err());
        assert!(!out.exists());
    }

    #[test]
    fn cli_parses_build_report() {
        use clap::Parser;
        let cli = Cli::try_parse_from([
            "stare-admin",
            "build-report",
            "/index/builds/v2026.10.04",
            "--version",
            "v2026.10.04",
            "--previous",
            "/index/current/report.json",
            "--stare-tag",
            "v2026.10.04.1",
            "--started-at",
            "2026-10-04T00:00:00Z",
        ])
        .unwrap();
        match cli.command {
            Commands::BuildReport {
                data_version,
                previous,
                stare_tag,
                ..
            } => {
                assert_eq!(data_version, "v2026.10.04");
                assert_eq!(previous, Some(PathBuf::from("/index/current/report.json")));
                assert_eq!(stare_tag.as_deref(), Some("v2026.10.04.1"));
            }
            _ => panic!("not build-report"),
        }
    }

    #[test]
    fn rebuild_removes_a_stale_multi() {
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("1.zip");
        std::fs::write(&zip_path, volume_zip(&[("0001-01", Some("1"))])).unwrap();
        std::fs::write(dir.path().join("1.multi"), "1,0001-02\n").unwrap();
        build_index(&zip_path, None, false).unwrap();
        assert!(!dir.path().join("1.multi").exists());
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
        let err = build_manifest(dir.path(), None, None, None).unwrap_err();
        assert!(err.to_string().contains("--volumes-metadata"), "{err}");
    }

    #[test]
    fn implausible_folder_names_fail_the_build() {
        let dir = index_dir();
        std::fs::write(dir.path().join("a3d/x9.bin"), [0u8; 8]).unwrap();
        let meta = volumes_metadata(dir.path());
        assert!(build_manifest(dir.path(), None, Some(&meta), None).is_err());
    }
}
