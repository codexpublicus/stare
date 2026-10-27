//! Reading single files out of a volume's zip (#162, design decision 4): a case's JSON
//! (`json/0647-01.json`), its HTML, or the volume's `metadata/CasesMetadata.json`,
//! without fetching the whole zip, which averages about 1.9 MB.
//!
//! In order, an entry comes from:
//!
//! 1. the cache, where entries read by range are kept under
//!    `zips/<slug>/<folder>/<entry>`, beside whole zips;
//! 2. a whole zip in the cache (`zips/<slug>/<folder>.zip`, from `stare download` or an
//!    older `stare resolve`), read in place;
//! 3. a data source that is a directory, the zip read from disk, only the entry's bytes;
//! 4. a data source that is a URL: the zip's central directory by range requests
//!    ([`stare::ziprange`], read once per zip for the life of the [`Sources`]), then the
//!    entry's own bytes, which are cached.

use super::fetch::fetch_range;
use super::Sources;
use anyhow::{bail, Context, Result};
use stare::config;
use std::io::{Read, Seek};
use std::path::PathBuf;
use std::sync::Arc;

/// The bytes of `name` (`json/0647-01.json`) in `<reporter>/<folder>.zip`.
pub fn read_entry(src: &Sources, reporter: &str, folder: &str, name: &str) -> Result<Vec<u8>> {
    if !stare::cl::is_reporter_slug(reporter) || !stare::manifest::is_volume_key(folder) {
        bail!("not a volume: {reporter}/{folder}");
    }
    if name.starts_with('/') || name.split('/').any(|part| part == "..") {
        bail!("not a file in a zip: {name}");
    }
    let key = format!("{reporter}/{folder}/{name}");
    if let Some(bytes) = config::cache_get("zips", &key) {
        return Ok(bytes);
    }
    let zip_key = format!("{reporter}/{folder}.zip");
    if let Some(zip) = config::cache_get("zips", &zip_key) {
        return entry_from(std::io::Cursor::new(zip), name)
            .with_context(|| format!("cached {zip_key}"));
    }
    if !Sources::is_url(&src.data) {
        let path = PathBuf::from(&src.data).join(&zip_key);
        let file = std::fs::File::open(&path)
            .with_context(|| format!("zip not found: {}", path.display()))?;
        return entry_from(file, name).with_context(|| path.display().to_string());
    }
    let url = format!("{}/{}", src.data, zip_key);
    let entries = directory(src, &url)?;
    let entry = entries
        .iter()
        .find(|e| e.name == name)
        .with_context(|| format!("{name} not found in {url}"))?;
    let range = format!("bytes={}-{}", entry.start, entry.end.saturating_sub(1));
    let (bytes, start) = fetch_range(&url, &range)?;
    let data =
        stare::ziprange::entry(&bytes, start, entry).with_context(|| format!("{name} in {url}"))?;
    let _ = config::cache_set("zips", &key, &data);
    Ok(data)
}

/// A CAP case's JSON, `json/<case_file>.json` in `<reporter>/<folder>.zip`.
pub fn read_case(
    src: &Sources,
    reporter: &str,
    folder: &str,
    case_file: &str,
) -> Result<stare::case::CaseJson> {
    let bytes = read_entry(src, reporter, folder, &format!("json/{case_file}.json"))
        .with_context(|| format!("case file {case_file} not found"))?;
    stare::case::CaseJson::parse(&bytes)
        .with_context(|| format!("failed to parse JSON for case {case_file}"))
}

/// A volume's `metadata/CasesMetadata.json`: every case in the folder.
pub fn read_cases_metadata(
    src: &Sources,
    reporter: &str,
    folder: &str,
) -> Result<Vec<stare::case::CaseMetaEntry>> {
    let bytes = read_entry(src, reporter, folder, "metadata/CasesMetadata.json")?;
    serde_json::from_slice(&bytes).context("failed to parse CasesMetadata.json")
}

/// The central directory of the zip at `url`, read by range requests the first time
/// and kept in `src` after.
fn directory(src: &Sources, url: &str) -> Result<Arc<Vec<stare::ziprange::Entry>>> {
    if let Some(entries) = src.zip_directories.lock().unwrap().get(url) {
        return Ok(entries.clone());
    }
    let entries = Arc::new(super::fetch::zip_directory(url)?);
    src.zip_directories
        .lock()
        .unwrap()
        .insert(url.to_string(), entries.clone());
    Ok(entries)
}

/// One file from a whole zip.
fn entry_from(reader: impl Read + Seek, name: &str) -> Result<Vec<u8>> {
    let mut archive = zip::ZipArchive::new(reader)?;
    let mut file = archive
        .by_name(name)
        .with_context(|| format!("{name} not found in zip"))?;
    let mut out = Vec::with_capacity(file.size() as usize);
    file.read_to_end(&mut out)?;
    Ok(out)
}
