//! citare's reporter, edition and court tables, as one data bundle
//! (citare's `docs/data-bundle.md`).
//!
//! With the default `embedded-data` feature the bundle is compiled in and
//! loads itself on first use. stare-wasm builds without it; the site serves
//! the bundle as `/data/citare/v1/<file_name>` and the page hands it to
//! [`load`] before detecting citations (#117).

pub use citare_core::data::{is_available, LoadError, FORMAT_VERSION};

/// Install a data bundle for every later citation lookup. Call it once,
/// before the first; a second call fails with [`LoadError::AlreadyLoaded`].
pub fn load(bytes: &[u8]) -> Result<(), LoadError> {
    citare_core::data::load(bytes)
}

/// The lowercase hex SHA-256 of a bundle.
pub fn sha256(bytes: &[u8]) -> String {
    citare_core::data::content_hash(bytes)
}

/// The name a bundle is published under, `citare-data-<first 16 hex digits
/// of its SHA-256>.bin`, so a name never refers to two different files.
pub fn file_name(bytes: &[u8]) -> String {
    format!("citare-data-{}.bin", &sha256(bytes)[..16])
}

/// The bundle compiled into this build.
#[cfg(feature = "embedded-data")]
pub fn embedded() -> &'static [u8] {
    citare_core::data::EMBEDDED_BUNDLE
}

#[cfg(all(test, feature = "embedded-data"))]
mod tests {
    use super::*;

    #[test]
    fn embedded_bundle_is_a_current_format_bundle() {
        let bytes = embedded();
        assert_eq!(&bytes[..8], b"CITDATA\0");
        assert_eq!(u16::from_le_bytes([bytes[8], bytes[9]]), FORMAT_VERSION);
        assert!(is_available());
    }

    #[test]
    fn file_name_is_the_hash_prefix() {
        let name = file_name(embedded());
        assert_eq!(name.len(), "citare-data-.bin".len() + 16);
        assert!(name.starts_with("citare-data-"));
        assert!(sha256(embedded()).starts_with(&name[12..28]));
    }
}
