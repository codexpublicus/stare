pub mod download;

/// Whether a source string is a URL (as opposed to a local filesystem path).
pub fn is_url(s: &str) -> bool {
    s.starts_with("http://") || s.starts_with("https://") || s.starts_with("ipfs://")
}
