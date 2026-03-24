use anyhow::Context;
use clap::{Parser, Subcommand};
use rayon::prelude::*;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Parser)]
#[command(name = "stare-admin", about = "Build tools for stare.pub case law index")]
struct Cli {
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
    /// Build reporters.json from ReportersMetadata.json
    BuildReporters {
        /// Path to ReportersMetadata.json
        metadata_path: PathBuf,
        /// Output path (default: reporters.json in current dir)
        #[arg(short, long)]
        output: Option<PathBuf>,
    },
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Commands::BuildIndex { zip_path, output } => {
            build_index(&zip_path, output.as_deref())?;
        }
        Commands::BatchIndex { dir, output_dir } => {
            batch_index(&dir, output_dir.as_deref())?;
        }
        Commands::BuildReporters {
            metadata_path,
            output,
        } => {
            build_reporters(&metadata_path, output.as_deref())?;
        }
    }

    Ok(())
}

fn build_index(zip_path: &std::path::Path, output: Option<&std::path::Path>) -> anyhow::Result<()> {
    let zip_bytes = std::fs::read(zip_path)
        .with_context(|| format!("failed to read {}", zip_path.display()))?;
    let cases = stare::case::list_cases_in_zip(&zip_bytes)?;
    let case_pages: Vec<(&str, usize)> = cases
        .iter()
        .filter_map(|c| {
            // Filename is like "0647-01" or rarely "1265=1275-01"
            let page_part = c.split('-').next().unwrap();
            // Handle "1265=1275" by taking the first number
            let page_str = page_part.split('=').next().unwrap();
            match page_str.parse::<usize>() {
                Ok(page) => Some((c.as_str(), page)),
                Err(_) => {
                    eprintln!("Warning: skipping case with unparseable page: {}", c);
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
        println!(
            "Built index: {} cases ({} multi-case pages), {} bytes → {} + {}",
            cases.len(),
            result.multi.len(),
            result.bin.len(),
            out_path.display(),
            multi_path.display()
        );
    } else {
        println!(
            "Built index: {} cases, {} bytes → {}",
            cases.len(),
            result.bin.len(),
            out_path.display()
        );
    }

    Ok(())
}

fn batch_index(dir: &std::path::Path, output_dir: Option<&std::path::Path>) -> anyhow::Result<()> {
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

    zips.par_iter().for_each(|zip_path| {
        let out_path = match output_dir {
            Some(out) => {
                let rel = zip_path.strip_prefix(dir).unwrap_or(zip_path);
                out.join(rel).with_extension("bin")
            }
            None => zip_path.with_extension("bin"),
        };

        match build_index(zip_path, Some(&out_path)) {
            Ok(()) => {
                let n = count.fetch_add(1, Ordering::Relaxed) + 1;
                if n % 1000 == 0 {
                    eprintln!("Progress: {}/{} indexed", n, zips.len());
                }
            }
            Err(e) => {
                eprintln!("Error indexing {}: {}", zip_path.display(), e);
                errors.fetch_add(1, Ordering::Relaxed);
            }
        }
    });

    println!(
        "\nBatch complete: {} indexed, {} errors",
        count.load(Ordering::Relaxed),
        errors.load(Ordering::Relaxed)
    );
    Ok(())
}

fn build_reporters(
    metadata_path: &std::path::Path,
    output: Option<&std::path::Path>,
) -> anyhow::Result<()> {
    let data = std::fs::read_to_string(metadata_path)
        .with_context(|| format!("failed to read {}", metadata_path.display()))?;

    #[derive(serde::Deserialize)]
    struct Reporter {
        short_name: String,
        slug: String,
    }

    let reporters: Vec<Reporter> = serde_json::from_str(&data)
        .context("failed to parse ReportersMetadata.json")?;

    let mapping: BTreeMap<&str, &str> = reporters
        .iter()
        .map(|r| (r.short_name.as_str(), r.slug.as_str()))
        .collect();

    let json = serde_json::to_string_pretty(&mapping)?;

    let out_path = output
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("reporters.json"));
    std::fs::write(&out_path, &json)
        .with_context(|| format!("failed to write {}", out_path.display()))?;

    println!(
        "Built reporters.json: {} reporters → {}",
        mapping.len(),
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
