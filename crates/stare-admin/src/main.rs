use anyhow::Context;
use clap::{Parser, Subcommand};
use rayon::prelude::*;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Parser)]
#[command(name = "stare-admin", about = "Build tools for stare.pub case law index")]
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
    /// Build manifest.json listing all indexed reporters and volumes
    BuildManifest {
        /// Directory containing .bin index files (reporter/volume.bin structure)
        index_dir: PathBuf,
        /// Output path (default: manifest.json in index_dir)
        #[arg(short, long)]
        output: Option<PathBuf>,
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
        } => {
            build_manifest(&index_dir, output.as_deref())?;
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
    let chunk = page_part
        .split(|c: char| c == '=' || c == ',' || c == ' ')
        .next()?
        .trim();
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
        .filter_map(|c| {
            match parse_case_page(c) {
                Some(page) => Some((c.as_str(), page)),
                None => {
                    skipped += 1;
                    eprintln!("Warning: skipping case with unparseable page: {} (in {})", c, zip_path.display());
                    None
                }
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
                if n % 100 == 0 || n == total {
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

/// Scan an index directory for .bin files and build a manifest.json
/// listing which reporters and volumes are indexed.
///
/// Output: { "a2d": [1, 2, 31, ...], "us": [1, 2, 3, ...], ... }
fn build_manifest(
    index_dir: &std::path::Path,
    output: Option<&std::path::Path>,
) -> anyhow::Result<()> {
    let mut manifest: BTreeMap<String, Vec<u32>> = BTreeMap::new();

    let files = walkdir(index_dir)?;
    for path in &files {
        if path.extension().map(|e| e == "bin").unwrap_or(false) {
            if let Some(volume_str) = path.file_stem().and_then(|s| s.to_str()) {
                if let Ok(volume) = volume_str.parse::<u32>() {
                    if let Some(reporter) = path.parent()
                        .and_then(|p| p.file_name())
                        .and_then(|s| s.to_str())
                    {
                        if path.parent() != Some(index_dir) {
                            manifest
                                .entry(reporter.to_string())
                                .or_default()
                                .push(volume);
                        }
                    }
                }
            }
        }
    }

    for volumes in manifest.values_mut() {
        volumes.sort();
    }

    let total_volumes: usize = manifest.values().map(|v| v.len()).sum();
    let json = serde_json::to_string_pretty(&manifest)?;

    let out_path = output
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| index_dir.join("manifest.json"));
    std::fs::write(&out_path, &json)
        .with_context(|| format!("failed to write {}", out_path.display()))?;

    println!(
        "Built manifest: {} reporters, {} volumes → {}",
        manifest.len(),
        total_volumes,
        out_path.display()
    );

    Ok(())
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
