//! Build steps for the stare.pub site that need the stare library. The site build
//! (`.github/actions/build-site`, `mise run build-wasm`) runs `export-citare-data`
//! after building stare-wasm. It was `stare-admin export-citare-data` until
//! stare-admin moved to codexpublicus/stare-builder (#163). `export-reporters`
//! writes the reporter map, `/reporters.json` (#161).

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
    /// /data/citare/v1/), and its sidecar, citare-data-<hash>.json: the
    /// bundle's licence and its sources, one entry each: reporters-db and
    /// courts-db with their licences and notices, and citare's own supplements. Removes any other citare-data-* file there and
    /// prints the bundle's path.
    ExportCitareData {
        /// Output directory, created if missing
        dir: PathBuf,
    },
    /// Write the reporter map (stare::reporters, schemas/reporters.v1.schema.json)
    /// to FILE: every reporter slug, the abbreviations citare reads as it, the
    /// volumes the index manifest lists and the URL templates for the index and
    /// case files. The site serves it at /reporters.json.
    ExportReporters {
        /// The index manifest to take volumes from, a copy of
        /// https://idx.stare.pub/manifest.json
        #[arg(long)]
        manifest: PathBuf,
        /// Output file; its directory is created if missing
        file: PathBuf,
    },
}

fn main() -> anyhow::Result<()> {
    match Cli::parse().command {
        Commands::ExportCitareData { dir } => {
            let path = export_citare_data(&dir)?;
            println!("{}", path.display());
        }
        Commands::ExportReporters { manifest, file } => {
            let bytes = std::fs::read(&manifest)
                .with_context(|| format!("reading {}", manifest.display()))?;
            let manifest = stare::manifest::Manifest::parse(&bytes)
                .with_context(|| format!("parsing {}", manifest.display()))?;
            let map = export_reporters(&manifest, &file)?;
            println!(
                "{}: {} slugs, {} abbreviations",
                file.display(),
                map.reporters.len(),
                map.abbreviations.len()
            );
        }
    }
    Ok(())
}

/// Writes the reporter map for `manifest` and the citare data built into stare
/// to `file`, as one line of JSON.
fn export_reporters(
    manifest: &stare::manifest::Manifest,
    file: &Path,
) -> anyhow::Result<stare::reporters::ReporterMap> {
    let map = stare::reporters::from_citare(
        Some(manifest),
        &stare::data::file_name(stare::data::embedded()),
    );
    if let Some(dir) = file.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    let mut json = serde_json::to_string(&map)?;
    json.push('\n');
    std::fs::write(file, json).with_context(|| format!("writing {}", file.display()))?;
    Ok(map)
}

/// Writes stare's embedded citare data bundle into `dir`, gzipped, under its
/// published name, with its sidecar (`stare::data::Sidecar`), and removes other
/// bundles and sidecars there so the site build finds exactly one. The name keeps the uncompressed bundle's hash, citare's own
/// name for it: it changes exactly when the data does, and a different
/// compressor's bytes under the same name still decompress to the same bundle.
fn export_citare_data(dir: &Path) -> anyhow::Result<PathBuf> {
    let bytes = stare::data::embedded();
    let name = format!("{}.gz", stare::data::file_name(bytes));
    let sidecar_name = stare::data::sidecar_name(bytes);
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let other = entry.file_name().to_string_lossy().into_owned();
        if other != name && other != sidecar_name && other.starts_with("citare-data-") {
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
    let sidecar = dir.join(&sidecar_name);
    let mut json = serde_json::to_string_pretty(&stare::data::embedded_sidecar())?;
    json.push('\n');
    std::fs::write(&sidecar, json).with_context(|| format!("writing {}", sidecar.display()))?;
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
        std::fs::write(dir.path().join("citare-data-0000000000000000.json"), b"old").unwrap();
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
        let sidecar = stare::data::sidecar_name(&bytes);
        assert_eq!(
            names,
            vec![name.to_string(), sidecar.clone(), "keep.txt".to_string()]
        );
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(&sidecar)).unwrap()).unwrap();
        assert_eq!(json["file"], name);
        assert_eq!(json["license"]["url"], stare::license::CC_BY_NC_ND.url);
        assert_eq!(json["sources"][0]["name"], "reporters-db");
        assert_eq!(json["sources"][1]["name"], "courts-db");
        assert_eq!(json["sources"][2]["name"], "citare");
    }
}
