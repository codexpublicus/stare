//! Session pinning (design, "Versioning against the live index"): a session reads one
//! index build from the first call that needs it until `index_info(refresh: true)`, so
//! a build that goes live mid-session doesn't change answers under the agent.

use super::error::{Code, ToolError, ToolResult};
use crate::engine::fetch::fetch_url;
use crate::engine::Sources;
use stare::config;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

/// What `stare mcp` is started with.
#[derive(Debug, Clone, Default)]
pub struct Options {
    /// The index source (`--index`, `STARE_INDEX`, the config file, idx.stare.pub).
    pub index: Option<String>,
    /// The CAP data source (`--data`, `STARE_DATA`, the config file, data.stare.pub/cap).
    pub data: Option<String>,
    /// `--index-version`: read this build instead of the live one.
    pub index_version: Option<String>,
}

/// The build a session reads.
pub struct Pin {
    /// The build's data version (`v2026.10.26.2`); None for an index without versions.
    pub version: Option<String>,
    /// When the session pinned it, RFC 3339.
    pub pinned_at: String,
    /// The live build's version when the index source was last read, which can differ
    /// from `version` after a new build goes live, or with `--index-version`.
    pub live_version: Option<String>,
    /// Where the manifest came from: the index URL, a mirror directory, or `offline`
    /// when the source couldn't be reached and the cached manifest was read.
    pub source: String,
    /// The index and data sources, reading the pinned manifest.
    pub sources: Arc<Sources>,
}

impl Pin {
    pub fn manifest(&self) -> Option<&stare::manifest::Manifest> {
        self.sources.manifest()
    }
}

pub struct Session {
    pub index: String,
    pub data: String,
    explicit_version: Option<String>,
    pin: RwLock<Option<Arc<Pin>>>,
}

impl Session {
    pub fn new(options: Options) -> Self {
        let cfg = config::load_config();
        Session {
            index: options
                .index
                .unwrap_or_else(|| cfg.index_source().to_string())
                .trim_end_matches('/')
                .to_string(),
            data: options
                .data
                .unwrap_or_else(|| cfg.data_source().to_string())
                .trim_end_matches('/')
                .to_string(),
            explicit_version: options.index_version,
            pin: RwLock::new(None),
        }
    }

    /// Whether the data source is a directory (a mirror), not a URL.
    pub fn data_is_dir(&self) -> bool {
        !Sources::is_url(&self.data)
    }

    /// The build the session reads, if it has pinned one yet.
    pub fn current(&self) -> Option<Arc<Pin>> {
        self.pin.read().unwrap().clone()
    }

    /// The build the session reads, pinning one now if it hasn't. Blocking.
    pub fn pin(&self) -> ToolResult<Arc<Pin>> {
        if let Some(pin) = self.current() {
            return Ok(pin);
        }
        let pin = Arc::new(self.read_pin()?);
        let mut slot = self.pin.write().unwrap();
        // Another call may have pinned meanwhile; the first one stands.
        Ok(slot.get_or_insert(pin).clone())
    }

    /// Move the session to the live build (`index_info(refresh: true)`). Blocking.
    pub fn refresh(&self) -> ToolResult<Arc<Pin>> {
        let pin = Arc::new(self.read_pin()?);
        *self.pin.write().unwrap() = Some(pin.clone());
        Ok(pin)
    }

    /// The live build's version, read now; None when the source can't be reached.
    pub fn live_version(&self) -> Option<String> {
        let bytes = self.read_index_file("manifest.json").ok()?;
        let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
        value["version"].as_str().map(str::to_string)
    }

    fn read_index_file(&self, path: &str) -> anyhow::Result<Vec<u8>> {
        if Sources::is_url(&self.index) {
            fetch_url(&format!("{}/{}", self.index, path))
        } else {
            let file = PathBuf::from(&self.index).join(path);
            Ok(std::fs::read(&file)?)
        }
    }

    fn read_pin(&self) -> ToolResult<Pin> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let pinned_at = stare::manifest::rfc3339_utc(now);
        if let Some(version) = &self.explicit_version {
            return self.read_version(version, pinned_at);
        }
        let (bytes, source) = match self.read_index_file("manifest.json") {
            Ok(bytes) => {
                let _ = config::cache_set("bins", crate::MANIFEST_CACHE_KEY, &bytes);
                (bytes, self.index.clone())
            }
            Err(e) => match config::cache_get("bins", crate::MANIFEST_CACHE_KEY) {
                Some(bytes) => (bytes, "offline".to_string()),
                None => {
                    let url = format!("{}/manifest.json", self.index);
                    return Err(
                        ToolError::from_engine(&e, !Sources::is_url(&self.index)).with_url(url)
                    );
                }
            },
        };
        let root = parse_manifest(&bytes)?;
        let version = root.version.clone();
        let live_version = (source != "offline").then(|| version.clone()).flatten();
        // The build's own manifest is immutable under its version; the root's copy is
        // the same build with `base`, which serves when the build's own can't be read.
        let manifest = match (&version, &root.base) {
            (Some(v), Some(base)) if stare::manifest::is_data_version(v) => {
                let key = format!("v/{v}/manifest.json");
                let own = config::cache_get("bins", &key).or_else(|| {
                    let bytes = self.read_index_file(&key).ok()?;
                    let _ = config::cache_set("bins", &key, &bytes);
                    Some(bytes)
                });
                match own.map(|b| parse_manifest(&b)).transpose()? {
                    Some(mut own) => {
                        own.base = Some(base.clone());
                        own
                    }
                    None => root,
                }
            }
            _ => root,
        };
        Ok(Pin {
            version,
            pinned_at,
            live_version,
            source,
            sources: Arc::new(Sources::with_manifest(
                self.index.clone(),
                self.data.clone(),
                Some(manifest),
            )),
        })
    }

    /// Pin `--index-version`'s build: its own manifest, under `v/<version>/`.
    fn read_version(&self, version: &str, pinned_at: String) -> ToolResult<Pin> {
        if !stare::manifest::is_data_version(version) {
            return Err(ToolError::new(
                Code::BadInput,
                format!("not an index version: {version:?} (they look like v2026.10.22)"),
            ));
        }
        let key = format!("v/{version}/manifest.json");
        let bytes = match config::cache_get("bins", &key) {
            Some(bytes) => bytes,
            None => {
                let bytes = self.read_index_file(&key).map_err(|e| {
                    ToolError::from_engine(&e, !Sources::is_url(&self.index))
                        .with_url(format!("{}/{key}", self.index))
                })?;
                let _ = config::cache_set("bins", &key, &bytes);
                bytes
            }
        };
        let mut manifest = parse_manifest(&bytes)?;
        manifest.base = Some(format!("v/{version}/"));
        Ok(Pin {
            version: Some(version.to_string()),
            pinned_at,
            live_version: self.live_version(),
            source: self.index.clone(),
            sources: Arc::new(Sources::with_manifest(
                self.index.clone(),
                self.data.clone(),
                Some(manifest),
            )),
        })
    }
}

/// A manifest in a format this binary reads; a newer `format` or `idx` is
/// `index_too_new`, never a guess.
pub fn parse_manifest(bytes: &[u8]) -> ToolResult<stare::manifest::Manifest> {
    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|e| ToolError::new(Code::DataError, format!("manifest.json: {e}")))?;
    let newer = |field: &str, known: u32| {
        value[field]
            .as_u64()
            .is_some_and(|n| n > u64::from(known))
            .then(|| {
                ToolError::new(
                    Code::IndexTooNew,
                    format!(
                        "the index's manifest has {field} {}, and this stare reads {field} {known}; update stare",
                        value[field]
                    ),
                )
            })
    };
    if let Some(e) = newer("format", stare::manifest::FORMAT) {
        return Err(e);
    }
    if let Some(e) = newer("idx", stare::idx::FORMAT) {
        return Err(e);
    }
    stare::manifest::Manifest::parse(bytes)
        .map_err(|e| ToolError::new(Code::DataError, format!("manifest.json: {e:#}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_newer_format_is_index_too_new() {
        let e = parse_manifest(br#"{"format": 3, "reporters": {}}"#).unwrap_err();
        assert_eq!(e.code, Code::IndexTooNew);
        let e = parse_manifest(br#"{"format": 2, "idx": 2, "reporters": {}}"#).unwrap_err();
        assert_eq!(e.code, Code::IndexTooNew);
        assert!(parse_manifest(br#"{"format": 2, "idx": 1, "reporters": {}}"#).is_ok());
        assert_eq!(
            parse_manifest(b"not json").unwrap_err().code,
            Code::DataError
        );
    }
}
