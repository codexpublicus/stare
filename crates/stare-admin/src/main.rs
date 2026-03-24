use anyhow::Context;
use clap::{Parser, Subcommand};
use std::path::PathBuf;

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
        /// Output directory for .bin files (default: same as input)
        #[arg(short, long)]
        output_dir: Option<PathBuf>,
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
    }

    Ok(())
}

fn build_index(zip_path: &std::path::Path, output: Option<&std::path::Path>) -> anyhow::Result<()> {
    let zip_bytes = std::fs::read(zip_path)
        .with_context(|| format!("failed to read {}", zip_path.display()))?;
    let cases = stare::case::list_cases_in_zip(&zip_bytes)?;
    let case_pages: Vec<(&str, usize)> = cases
        .iter()
        .map(|c| {
            let page: usize = c.split('-').next().unwrap().parse().unwrap();
            (c.as_str(), page)
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
    let mut count = 0;
    let mut errors = 0;

    // Walk directory for .zip files
    for entry in walkdir(dir)? {
        let path = entry;
        if path.extension().map(|e| e == "zip").unwrap_or(false) {
            let out_dir = output_dir.unwrap_or_else(|| path.parent().unwrap());
            let out_path = out_dir.join(path.file_stem().unwrap()).with_extension("bin");

            // Create output directory if needed
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)?;
            }

            match build_index(&path, Some(&out_path)) {
                Ok(()) => count += 1,
                Err(e) => {
                    eprintln!("Error indexing {}: {}", path.display(), e);
                    errors += 1;
                }
            }
        }
    }

    println!("\nBatch complete: {} indexed, {} errors", count, errors);
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
