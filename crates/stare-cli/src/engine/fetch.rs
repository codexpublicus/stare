//! Reading the index and data files: the cache first, then the source, a URL or a
//! directory.

use super::Sources;
use anyhow::{bail, Context, Result};
use stare::config;
use std::path::PathBuf;

/// The User-Agent every request sends.
pub const USER_AGENT: &str = "stare/0.1.0 (case law tool; github.com/codexpublicus/stare)";

pub fn fetch_bin(src: &Sources, reporter: &str, volume: &str) -> Result<Vec<u8>> {
    let key = src.index_key(&format!("{}/{}.bin", reporter, volume));

    // 1. Check cache
    if let Some(data) = config::cache_get("bins", &key) {
        return Ok(data);
    }

    // 2. Check configured index source
    let source = &src.index;
    let data = if !source.is_empty() {
        if Sources::is_url(source) {
            fetch_url(&format!("{}/{}", source, key))?
        } else {
            let path = PathBuf::from(source).join(&key);
            std::fs::read(&path).with_context(|| format!("index not found: {}", path.display()))?
        }
    } else {
        bail!("No index source configured. Run: stare config set index <path-or-url>");
    };

    // Cache for next time
    let _ = config::cache_set("bins", &key, &data);
    Ok(data)
}

/// A volume's `.multi` file, or None if it has none.
pub fn fetch_multi(src: &Sources, reporter: &str, volume: &str) -> Result<Option<String>> {
    fetch_optional_index(src, &format!("{}/{}.multi", reporter, volume))?
        .map(String::from_utf8)
        .transpose()
        .map_err(Into::into)
}

/// One part of a volume's unified index (`<reporter>/<volume>.idx.gz`, or a later
/// `.<n>.idx.gz`), parsed; None when the source has no such file.
pub fn fetch_idx(
    src: &Sources,
    reporter: &str,
    volume: &str,
    part: usize,
) -> Result<Option<stare::idx::VolumeIndex>> {
    let path = stare::idx::path(reporter, volume, part)?;
    let Some(bytes) = fetch_optional_index(src, &path)? else {
        return Ok(None);
    };
    stare::idx::parse_bytes(&bytes)
        .with_context(|| format!("failed to read {}", path))
        .map(Some)
}

/// A file of the index that a volume may not have, by its path under the manifest's
/// `base`: None when the source has no such file.
pub fn fetch_optional_index(src: &Sources, path: &str) -> Result<Option<Vec<u8>>> {
    let key = src.index_key(path);
    if let Some(data) = config::cache_get("bins", &key) {
        return Ok(Some(data));
    }
    let source = &src.index;
    let data = if Sources::is_url(source) {
        let url = format!("{}/{}", source, key);
        let client = reqwest::blocking::Client::builder()
            .user_agent(USER_AGENT)
            .build()?;
        let response = crate::http::send_with_retry(|| client.get(&url))
            .with_context(|| format!("failed to fetch {}", url))?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            bail!("HTTP {} fetching {}", response.status(), url);
        }
        response.bytes()?.to_vec()
    } else {
        let path = PathBuf::from(source).join(&key);
        if !path.exists() {
            return Ok(None);
        }
        std::fs::read(&path).with_context(|| format!("failed to read {}", path.display()))?
    };
    let _ = config::cache_set("bins", &key, &data);
    Ok(Some(data))
}

pub fn fetch_zip(src: &Sources, reporter: &str, volume: &str) -> Result<Vec<u8>> {
    let key = format!("{}/{}.zip", reporter, volume);

    if let Some(data) = config::cache_get("zips", &key) {
        return Ok(data);
    }

    let source = &src.data;
    let data = if Sources::is_url(source) {
        fetch_url(&format!("{}/{}", source, key))?
    } else {
        let path = PathBuf::from(source).join(&key);
        std::fs::read(&path).with_context(|| format!("zip not found: {}", path.display()))?
    };

    let _ = config::cache_set("zips", &key, &data);
    Ok(data)
}

/// A CourtListener record's bytes (gzip, as stored), from the data bucket's `cl/`
/// prefix, which sits beside the `cap/` the data source names. Records never change
/// under their path, so they're cached like the zips.
pub fn fetch_record(src: &Sources, cluster_id: u64, hash: &str) -> Result<Vec<u8>> {
    let key = stare::cl::record_path(cluster_id, hash)?;
    if let Some(data) = config::cache_get("zips", &key) {
        return Ok(data);
    }
    let base = stare::cl::data_base_for(&src.data);
    let data = if Sources::is_url(base) {
        fetch_url(&stare::cl::record_url(base, cluster_id, hash)?)?
    } else {
        let path = PathBuf::from(base).join(&key);
        std::fs::read(&path).with_context(|| format!("record not found: {}", path.display()))?
    };
    let _ = config::cache_set("zips", &key, &data);
    Ok(data)
}

pub fn fetch_url(url: &str) -> Result<Vec<u8>> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .build()?;
    let response = crate::http::send_with_retry(|| client.get(url))
        .with_context(|| format!("failed to fetch {}", url))?;
    if !response.status().is_success() {
        bail!("HTTP {} fetching {}", response.status(), url);
    }
    Ok(response.bytes()?.to_vec())
}

/// Fetch the index manifest from the index source. It changes when the index is
/// rebuilt, so it's always fetched; the copy saved in the cache
/// (`bins/manifest.json`, which `stare download` writes too) is only read when the
/// source can't be reached.
pub fn fetch_manifest(src: &Sources) -> Result<stare::manifest::Manifest> {
    let fetched = if Sources::is_url(&src.index) {
        fetch_url(&format!("{}/manifest.json", src.index))
    } else {
        let path = PathBuf::from(&src.index).join("manifest.json");
        std::fs::read(&path).with_context(|| format!("manifest not found: {}", path.display()))
    };
    match fetched {
        Ok(bytes) => {
            let manifest = stare::manifest::Manifest::parse(&bytes)?;
            let _ = config::cache_set("bins", crate::MANIFEST_CACHE_KEY, &bytes);
            Ok(manifest)
        }
        Err(e) => match config::cache_get("bins", crate::MANIFEST_CACHE_KEY) {
            Some(bytes) => stare::manifest::Manifest::parse(&bytes),
            None => Err(e),
        },
    }
}

/// A zip's central directory by range requests: its tail, and the bytes before it
/// when the directory starts earlier.
pub fn zip_directory(url: &str) -> Result<Vec<stare::ziprange::Entry>> {
    use stare::ziprange::{directory, Directory, TAIL};
    let (tail, start) = fetch_range(url, &format!("bytes=-{TAIL}"))?;
    match directory(&tail, start)? {
        Directory::Entries(entries) => Ok(entries),
        Directory::Need(from) => {
            let (bytes, start) = fetch_range(url, &format!("bytes={from}-"))?;
            match directory(&bytes, start)? {
                Directory::Entries(entries) => Ok(entries),
                Directory::Need(_) => bail!("no central directory in {}", url),
            }
        }
    }
}

/// The bytes of `url` that `range` (a Range header, `bytes=-65536`) asks for, and the
/// offset they start at.
pub fn fetch_range(url: &str, range: &str) -> Result<(Vec<u8>, u64)> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .build()?;
    let response =
        crate::http::send_with_retry(|| client.get(url).header(reqwest::header::RANGE, range))
            .with_context(|| format!("failed to fetch {}", url))?;
    let status = response.status();
    if status == reqwest::StatusCode::OK {
        // A server that ignores Range sends the whole file.
        return Ok((response.bytes()?.to_vec(), 0));
    }
    if status != reqwest::StatusCode::PARTIAL_CONTENT {
        bail!("HTTP {} fetching {} ({})", status, url, range);
    }
    let from = response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("bytes "))
        .and_then(|v| v.split('-').next())
        .and_then(|v| v.parse::<u64>().ok())
        .with_context(|| format!("no Content-Range fetching {}", url))?;
    Ok((response.bytes()?.to_vec(), from))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::CACHE_ENV;

    fn sources(index: &std::path::Path) -> Sources {
        Sources::new(index.to_string_lossy(), "")
    }

    #[test]
    fn index_files_resolve_through_the_manifest_base() {
        let _env = CACHE_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let cache = tempfile::tempdir().unwrap();
        std::env::set_var("XDG_CACHE_HOME", cache.path());

        // A versioned index: the old build at the root, the live one under its base.
        let idx = tempfile::tempdir().unwrap();
        std::fs::write(
            idx.path().join("manifest.json"),
            r#"{"format": 2, "base": "v/v2026.10.03/", "reporters": {"a2d": ["31"]}}"#,
        )
        .unwrap();
        std::fs::create_dir_all(idx.path().join("a2d")).unwrap();
        std::fs::write(idx.path().join("a2d/31.bin"), b"old").unwrap();
        std::fs::create_dir_all(idx.path().join("v/v2026.10.03/a2d")).unwrap();
        std::fs::write(idx.path().join("v/v2026.10.03/a2d/31.bin"), b"new").unwrap();

        let src = sources(idx.path());
        assert_eq!(src.index_key("a2d/31.bin"), "v/v2026.10.03/a2d/31.bin");
        assert_eq!(fetch_bin(&src, "a2d", "31").unwrap(), b"new");
        // Cached under the versioned path, with the manifest beside it.
        assert_eq!(
            config::cache_get("bins", "v/v2026.10.03/a2d/31.bin").unwrap(),
            b"new"
        );
        assert!(config::cache_get("bins", "a2d/31.bin").is_none());
        assert!(config::cache_get("bins", crate::MANIFEST_CACHE_KEY).is_some());

        // The source gone, the saved manifest still finds the cached file.
        let gone = sources(&idx.path().join("missing"));
        assert_eq!(gone.index_key("a2d/31.bin"), "v/v2026.10.03/a2d/31.bin");
        assert_eq!(fetch_bin(&gone, "a2d", "31").unwrap(), b"new");

        // A manifest without base, and no manifest at all, read the root.
        let fresh = tempfile::tempdir().unwrap();
        std::env::set_var("XDG_CACHE_HOME", fresh.path());
        std::fs::write(idx.path().join("manifest.json"), r#"{"a2d": [31]}"#).unwrap();
        assert_eq!(sources(idx.path()).index_key("a2d/31.bin"), "a2d/31.bin");
        let empty = tempfile::tempdir().unwrap();
        let cache2 = tempfile::tempdir().unwrap();
        std::env::set_var("XDG_CACHE_HOME", cache2.path());
        assert_eq!(sources(empty.path()).index_key("a2d/31.bin"), "a2d/31.bin");
    }
}
