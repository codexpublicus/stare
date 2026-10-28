pub mod download;
pub mod engine;
pub mod http;

/// Where the last index manifest fetched is saved, under the cache's `bins` directory.
/// `bins` is laid out like the index source (the manifest, then each file at its
/// path under the manifest's `base`), so it can be used as one: `--index <cache>/bins`.
pub const MANIFEST_CACHE_KEY: &str = "manifest.json";

/// Whether a source string is a URL (as opposed to a local filesystem path).
pub fn is_url(s: &str) -> bool {
    s.starts_with("http://") || s.starts_with("https://") || s.starts_with("ipfs://")
}
