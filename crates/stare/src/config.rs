//! Configuration and caching for stare.
//!
//! Config: ~/.config/stare/config.toml
//! Cache:  ~/.cache/stare/{bins,zips,tars}/

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub const DEFAULT_INDEX_URL: &str = "https://idx.stare.pub";
pub const DEFAULT_DATA_URL: &str = "https://static.case.law";

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct Config {
    #[serde(default)]
    pub sources: Sources,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct Sources {
    /// Where to find .bin index files. Path or URL.
    pub index: Option<String>,
    /// Where to find .zip case data. Path or URL.
    pub data: Option<String>,
}

impl Config {
    pub fn index_source(&self) -> &str {
        self.sources.index.as_deref().unwrap_or(DEFAULT_INDEX_URL)
    }

    pub fn data_source(&self) -> &str {
        self.sources.data.as_deref().unwrap_or(DEFAULT_DATA_URL)
    }
}

/// Get the config directory (~/.config/stare/)
pub fn config_dir() -> PathBuf {
    dirs_path("config")
}

/// Get the cache directory (~/.cache/stare/)
pub fn cache_dir() -> PathBuf {
    dirs_path("cache")
}

fn dirs_path(kind: &str) -> PathBuf {
    let base = match kind {
        "config" => std::env::var("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
                PathBuf::from(home).join(".config")
            }),
        "cache" => std::env::var("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
                PathBuf::from(home).join(".cache")
            }),
        _ => unreachable!(),
    };
    base.join("stare")
}

/// Load config from disk, or return defaults if not found.
pub fn load_config() -> Config {
    let path = config_dir().join("config.toml");
    match std::fs::read_to_string(&path) {
        Ok(contents) => toml::from_str(&contents).unwrap_or_default(),
        Err(_) => Config::default(),
    }
}

/// Save config to disk.
pub fn save_config(config: &Config) -> Result<()> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("failed to create config dir {}", dir.display()))?;
    let path = dir.join("config.toml");
    let contents = toml::to_string_pretty(config).context("failed to serialize config")?;
    std::fs::write(&path, contents)
        .with_context(|| format!("failed to write {}", path.display()))?;
    Ok(())
}

/// Get the path to a specific cache subdirectory.
pub fn cache_subdir(kind: &str) -> PathBuf {
    cache_dir().join(kind)
}

/// Check the cache for a file. Returns the path if cached.
pub fn cache_path(kind: &str, key: &str) -> PathBuf {
    cache_subdir(kind).join(key)
}

/// Read a cached file if it exists.
pub fn cache_get(kind: &str, key: &str) -> Option<Vec<u8>> {
    let path = cache_path(kind, key);
    std::fs::read(&path).ok()
}

/// Write a file to the cache.
pub fn cache_set(kind: &str, key: &str, data: &[u8]) -> Result<()> {
    let path = cache_path(kind, key);
    atomic_write(&path, data)
}

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Write `data` to `path` atomically: write to a temp file in the same directory,
/// then rename it into place. A process killed mid-write, or a concurrent reader,
/// never sees a partial file, since rename within a directory is atomic on POSIX
/// (and NTFS via `MoveFileEx` on Windows).
pub fn atomic_write(path: &Path, data: &[u8]) -> Result<()> {
    let dir = path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("failed to create dir {}", dir.display()))?;

    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_path = dir.join(format!(".{}.tmp-{}-{}", file_name, std::process::id(), n));

    std::fs::write(&tmp_path, data)
        .with_context(|| format!("failed to write {}", tmp_path.display()))?;
    std::fs::rename(&tmp_path, path).with_context(|| {
        format!(
            "failed to rename {} to {}",
            tmp_path.display(),
            path.display()
        )
    })?;
    Ok(())
}

/// Get cache statistics.
pub struct CacheStats {
    pub kind: String,
    pub count: usize,
    pub total_bytes: u64,
}

pub fn cache_stats() -> Vec<CacheStats> {
    let mut stats = Vec::new();
    for kind in &["bins", "zips", "tars"] {
        let dir = cache_subdir(kind);
        let (count, bytes) = dir_size(&dir);
        stats.push(CacheStats {
            kind: kind.to_string(),
            count,
            total_bytes: bytes,
        });
    }
    stats
}

/// Clear a cache subdirectory (or all if kind is "all").
pub fn cache_clear(kind: &str) -> Result<()> {
    if kind == "all" {
        for k in &["bins", "zips", "tars"] {
            let dir = cache_subdir(k);
            if dir.exists() {
                std::fs::remove_dir_all(&dir)?;
            }
        }
    } else {
        let dir = cache_subdir(kind);
        if dir.exists() {
            std::fs::remove_dir_all(&dir)?;
        }
    }
    Ok(())
}

fn dir_size(dir: &Path) -> (usize, u64) {
    let mut count = 0;
    let mut bytes = 0u64;
    if let Ok(entries) = walkdir_flat(dir) {
        for path in entries {
            if path.is_file() {
                count += 1;
                bytes += path.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    (count, bytes)
}

fn walkdir_flat(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    if !dir.exists() {
        return Ok(files);
    }
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            files.extend(walkdir_flat(&path)?);
        } else {
            files.push(path);
        }
    }
    Ok(files)
}

/// Format bytes for display.
pub fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{} B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else if bytes < 1024 * 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{:.2} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_creates_file_with_exact_contents() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/file.bin");

        atomic_write(&path, b"hello world").unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"hello world");
    }

    #[test]
    fn atomic_write_overwrites_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.bin");
        std::fs::write(&path, b"old contents").unwrap();

        atomic_write(&path, b"new").unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"new");
    }

    #[test]
    fn atomic_write_leaves_no_temp_file_behind() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.bin");

        atomic_write(&path, b"data").unwrap();

        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(entries, vec![std::ffi::OsString::from("file.bin")]);
    }
}
