//! CourtListener records: where they are, and how to read one
//! (docs/plans/courtlistener-mirror.md, "Storage").
//!
//! A record is CAP's case JSON plus a `source` block, stored once per case at
//! `cl/c/<cluster_id>/<hash>.json.gz` in the data bucket; `hash` is the first 16 hex
//! digits of the record's SHA-256, so a record's path changes only when its content does.
//! The unified index ([`crate::idx`]) points at records with `cl` lines.
//!
//! Every CourtListener record path stare reads is built here, and on the site in
//! `web/public/js/sources.js`.

use crate::case::CaseJson;
use anyhow::{bail, Context, Result};
use std::io::Read;

/// Where CourtListener records are, relative to the data bucket's root.
pub const RECORD_PREFIX: &str = "cl/c";

/// The data bucket's root. The CLI's data source is the `cap/` prefix under it
/// (`https://data.stare.pub/cap`); see [`data_base_for`].
pub const DEFAULT_DATA_BASE: &str = "https://data.stare.pub";

/// Whether `s` is a record hash: 16 lowercase hex digits.
pub fn is_hash(s: &str) -> bool {
    s.len() == 16
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Whether `s` can be a reporter slug in a path: lowercase ASCII letters, digits and
/// hyphens, starting with a letter or digit (`a3d`, `cal-app-4th`).
pub fn is_reporter_slug(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('-')
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// A record's path relative to the data bucket's root: `cl/c/<cluster_id>/<hash>.json.gz`.
pub fn record_path(cluster_id: u64, hash: &str) -> Result<String> {
    if !is_hash(hash) {
        bail!("bad record hash {:?}", hash);
    }
    Ok(format!("{}/{}/{}.json.gz", RECORD_PREFIX, cluster_id, hash))
}

/// A record's URL (or path) under the data bucket's root.
pub fn record_url(data_base: &str, cluster_id: u64, hash: &str) -> Result<String> {
    Ok(format!(
        "{}/{}",
        data_base.trim_end_matches('/'),
        record_path(cluster_id, hash)?
    ))
}

/// The data bucket's root for a CAP data source: the source without its trailing
/// `/cap` (`https://data.stare.pub/cap` → `https://data.stare.pub`). A source that
/// doesn't end in `cap` is taken as the root itself.
pub fn data_base_for(data_source: &str) -> &str {
    let trimmed = data_source.trim_end_matches('/');
    trimmed.strip_suffix("/cap").unwrap_or(trimmed)
}

/// Decode a record: gzip, as stored, or plain JSON (a server that already undid the
/// gzip with `Content-Encoding`).
pub fn decode_record(bytes: &[u8]) -> Result<CaseJson> {
    if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut json = Vec::new();
        flate2::read::GzDecoder::new(bytes)
            .read_to_end(&mut json)
            .context("failed to gunzip CourtListener record")?;
        CaseJson::parse(&json)
    } else {
        CaseJson::parse(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const H1: &str = "0f3a9c2e7b1d4a65";

    #[test]
    fn builds_record_urls() {
        assert_eq!(
            record_url("https://data.stare.pub", 9876543, H1).unwrap(),
            "https://data.stare.pub/cl/c/9876543/0f3a9c2e7b1d4a65.json.gz"
        );
        assert_eq!(
            record_url("https://data.stare.pub/", 1, H1).unwrap(),
            "https://data.stare.pub/cl/c/1/0f3a9c2e7b1d4a65.json.gz"
        );
        assert!(record_url("https://data.stare.pub", 1, "../x").is_err());
    }

    #[test]
    fn data_base_drops_the_cap_prefix() {
        assert_eq!(
            data_base_for("https://data.stare.pub/cap"),
            "https://data.stare.pub"
        );
        assert_eq!(
            data_base_for("https://data.stare.pub/cap/"),
            "https://data.stare.pub"
        );
        assert_eq!(data_base_for("/srv/codex-data/cap"), "/srv/codex-data");
        assert_eq!(
            data_base_for("https://mirror.example"),
            "https://mirror.example"
        );
        assert_eq!(
            data_base_for("https://x.example/capital"),
            "https://x.example/capital"
        );
    }

    #[test]
    fn decodes_gzipped_and_plain_records() {
        let json = include_bytes!("../tests/fixtures/cl-record.json");
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(json).unwrap();
        let gz = gz.finish().unwrap();
        let a = decode_record(&gz).unwrap();
        let b = decode_record(json).unwrap();
        assert_eq!(a.name_abbreviation, "Smith v. Jones");
        assert_eq!(a.source, b.source);
        assert!(decode_record(&[0x1f, 0x8b, 0, 0]).is_err());
    }
}
