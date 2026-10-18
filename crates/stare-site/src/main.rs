//! Build steps for the stare.pub site that need the stare library. The site build
//! (`.github/actions/build-site`, `mise run build-wasm`) runs `export-citare-data`
//! after building stare-wasm. It was `stare-admin export-citare-data` until
//! stare-admin moved to codexpublicus/stare-builder (#163).

use anyhow::Context;
use clap::{Parser, Subcommand};
use std::path::{Path, PathBuf};

#[derive(Parser)]
#[command(name = "stare-site", about = "Build steps for the stare.pub site")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Write the citare data bundle built into stare to DIR, gzipped with
    /// zopfli, as citare-data-<hash>.bin.gz, where <hash> is the uncompressed
    /// bundle's (the one stare-wasm loads; the site serves it from
    /// /data/citare/v1/). Removes any other citare-data-* file there and
    /// prints the file's path.
    ExportCitareData {
        /// Output directory, created if missing
        dir: PathBuf,
    },
}

fn main() -> anyhow::Result<()> {
    match Cli::parse().command {
        Commands::ExportCitareData { dir } => {
            let path = export_citare_data(&dir)?;
            println!("{}", path.display());
        }
    }
    Ok(())
}

/// Writes stare's embedded citare data bundle into `dir`, gzipped, under its
/// published name, and removes other bundles there so the site build finds
/// exactly one. The name keeps the uncompressed bundle's hash, citare's own
/// name for it: it changes exactly when the data does, and a different
/// compressor's bytes under the same name still decompress to the same bundle.
fn export_citare_data(dir: &Path) -> anyhow::Result<PathBuf> {
    let bytes = stare::data::embedded();
    let name = format!("{}.gz", stare::data::file_name(bytes));
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let other = entry.file_name().to_string_lossy().into_owned();
        if other != name && other.starts_with("citare-data-") {
            std::fs::remove_file(entry.path())?;
        }
    }
    let mut gz = Vec::new();
    zopfli::compress(
        zopfli::Options::default(),
        zopfli::Format::Gzip,
        bytes,
        &mut gz,
    )?;
    let path = dir.join(&name);
    std::fs::write(&path, gz).with_context(|| format!("writing {}", path.display()))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_citare_data_writes_one_gzipped_bundle_by_hash() {
        use std::io::Read;
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("citare-data-0000000000000000.bin"), b"old").unwrap();
        std::fs::write(
            dir.path().join("citare-data-0000000000000000.bin.gz"),
            b"old",
        )
        .unwrap();
        std::fs::write(dir.path().join("keep.txt"), b"x").unwrap();
        let path = export_citare_data(dir.path()).unwrap();
        let mut bytes = Vec::new();
        flate2::read::GzDecoder::new(std::fs::File::open(&path).unwrap())
            .read_to_end(&mut bytes)
            .unwrap();
        assert_eq!(bytes, stare::data::embedded());
        let name = path.file_name().unwrap().to_str().unwrap();
        assert_eq!(name, format!("{}.gz", stare::data::file_name(&bytes)));
        let mut names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, vec![name.to_string(), "keep.txt".to_string()]);
    }
}
