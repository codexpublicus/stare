//! The lookups behind `stare resolve` and `stare check`, as a library (#162): where the
//! index and data are ([`Sources`]), reading their files ([`fetch`]), resolving a
//! citation to its case ([`resolve`]) and checking a text's citations ([`check`]).
//! Nothing here prints; `main.rs` keeps the argument parsing and the output, and `stare
//! mcp` calls the same functions.
//!
//! The engine is synchronous. A caller on an async runtime runs it on a blocking
//! thread.

pub mod check;
pub mod fetch;
pub mod resolve;

use stare::config;
use std::sync::OnceLock;

/// Where the index and the case data are read from, after the config file, the
/// environment and the flags are merged, and the index manifest once it's fetched.
pub struct Sources {
    /// The index source: a URL (`https://idx.stare.pub`) or a directory laid out the
    /// same way.
    pub index: String,
    /// The CAP data source: a URL (`https://data.stare.pub/cap`) or a directory.
    pub data: String,
    /// The index manifest, fetched on first use (see [`Sources::manifest`]).
    manifest: OnceLock<Option<stare::manifest::Manifest>>,
}

impl Sources {
    /// Sources at `index` and `data`, with the manifest fetched on first use.
    pub fn new(index: impl Into<String>, data: impl Into<String>) -> Self {
        Sources {
            index: index.into(),
            data: data.into(),
            manifest: OnceLock::new(),
        }
    }

    /// The sources a flag or the environment names, else the config file's, else the
    /// defaults (idx.stare.pub and data.stare.pub).
    pub fn from_config(index: Option<String>, data: Option<String>) -> Self {
        let cfg = config::load_config();
        Sources::new(
            index.unwrap_or_else(|| cfg.index_source().to_string()),
            data.unwrap_or_else(|| cfg.data_source().to_string()),
        )
    }

    /// The index manifest, fetched once. When the index source can't be reached, the
    /// copy saved by the last successful fetch is used, so cached index files are still
    /// found offline. None when there's neither.
    pub fn manifest(&self) -> Option<&stare::manifest::Manifest> {
        self.manifest
            .get_or_init(|| fetch::fetch_manifest(self).ok())
            .as_ref()
    }

    /// Where an index file (`a3d/138.bin`) is, relative to the index source, and its
    /// cache key: under the manifest's `base` (`v/v2026.10.03/a3d/138.bin`) when it has
    /// one, at the root otherwise. A build's files never change under their versioned
    /// path, so a new index version is new cache keys.
    pub fn index_key(&self, path: &str) -> String {
        match self.manifest() {
            Some(m) => m.index_path(path),
            None => path.to_string(),
        }
    }

    /// Whether a source string is a URL, not a directory.
    pub fn is_url(s: &str) -> bool {
        crate::is_url(s)
    }
}

/// Held by every unit test that points the cache at a temporary directory through the
/// environment, which all tests in a binary share.
#[cfg(test)]
pub(crate) static CACHE_ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests;
