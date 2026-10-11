//! CourtListener records: the `.cl` sidecar that maps a volume's pages to records, and
//! where the sidecar and the records are (docs/plans/courtlistener-mirror.md, "Storage"
//! and "Index").
//!
//! Every CourtListener path stare reads is built here, and on the site in
//! `web/public/js/sources.js`. The storage layout is not settled (one object per case or
//! per-volume zips), so nothing else names one.
//!
//! A sidecar is text, one line per record: `page,cluster_id,hash`. Several clusters can
//! start on one page; they keep the sidecar's order. `hash` is the first 16 hex digits
//! of the record's SHA-256, so a record's path changes only when its content does:
//!
//! ```text
//! 100,9876543,0f3a9c2e7b1d4a65
//! 100,9876544,a1b2c3d4e5f60718
//! 112,9876601,77e0c1d2b3a49586
//! ```

use crate::case::CaseJson;
use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::io::Read;

/// Where CourtListener records are, relative to the data bucket's root.
pub const RECORD_PREFIX: &str = "cl/c";

/// The data bucket's root. The CLI's data source is the `cap/` prefix under it
/// (`https://data.stare.pub/cap`); see [`data_base_for`].
pub const DEFAULT_DATA_BASE: &str = "https://data.stare.pub";

/// One sidecar line: a record that starts at `page`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Entry {
    pub page: u32,
    pub cluster_id: u64,
    pub hash: String,
}

/// A parsed sidecar. Lines that don't parse are skipped, so one bad line doesn't hide
/// the rest of the volume; `malformed` has their 1-based line numbers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Sidecar {
    pub entries: Vec<Entry>,
    pub malformed: Vec<usize>,
}

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

fn parse_line(line: &str) -> Option<Entry> {
    let mut fields = line.split(',');
    let (page, cluster, hash) = (fields.next()?, fields.next()?, fields.next()?);
    if fields.next().is_some() {
        return None;
    }
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(page) || !digits(cluster) || !is_hash(hash) {
        return None;
    }
    Some(Entry {
        page: page.parse().ok()?,
        cluster_id: cluster.parse().ok()?,
        hash: hash.to_string(),
    })
}

/// Parse a sidecar. Blank lines are ignored; whitespace around a line is trimmed.
pub fn parse_sidecar(text: &str) -> Sidecar {
    let mut sidecar = Sidecar::default();
    for (i, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match parse_line(line) {
            Some(entry) => sidecar.entries.push(entry),
            None => sidecar.malformed.push(i + 1),
        }
    }
    sidecar
}

impl Sidecar {
    /// The records that start at `page`, in the sidecar's order.
    pub fn lookup(&self, page: u32) -> Vec<&Entry> {
        self.entries.iter().filter(|e| e.page == page).collect()
    }
}

/// A volume's sidecar, relative to the index build's directory (the manifest's `base`):
/// `<reporter>/<volume>.cl`, next to its `.bin`.
pub fn sidecar_path(reporter: &str, volume: &str) -> Result<String> {
    if !is_reporter_slug(reporter) {
        bail!("bad reporter slug {:?}", reporter);
    }
    if !crate::manifest::is_volume_key(volume) {
        bail!("bad volume {:?}", volume);
    }
    Ok(format!("{}/{}.cl", reporter, volume))
}

/// A volume's sidecar URL (or path) under an index root, `index_base` being the index
/// source plus the manifest's `base` (`https://idx.stare.pub/v/v2026.10.05`).
pub fn sidecar_url(index_base: &str, reporter: &str, volume: &str) -> Result<String> {
    Ok(format!(
        "{}/{}",
        index_base.trim_end_matches('/'),
        sidecar_path(reporter, volume)?
    ))
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
    const H2: &str = "a1b2c3d4e5f60718";

    #[test]
    fn parses_lines_and_keeps_shared_pages_in_order() {
        let text = format!("100,9876543,{H1}\n100,9876544,{H2}\n112,9876601,{H1}\n");
        let s = parse_sidecar(&text);
        assert!(s.malformed.is_empty());
        assert_eq!(s.entries.len(), 3);
        let at_100: Vec<u64> = s.lookup(100).iter().map(|e| e.cluster_id).collect();
        assert_eq!(at_100, [9876543, 9876544]);
        assert_eq!(s.lookup(112)[0].hash, H1);
        assert!(s.lookup(101).is_empty());
    }

    #[test]
    fn skips_malformed_lines_and_reports_them() {
        let text = [
            &format!("100,1,{H1}") as &str,
            "",
            "  ",
            "100,2",                        // 4: too few fields
            &format!("100,3,{H1},extra"),   // 5: too many
            &format!("x,4,{H1}"),           // 6: page not a number
            &format!("100,-5,{H1}"),        // 7: negative id
            "100,6,0F3A9C2E7B1D4A65",       // 8: uppercase hash
            "100,7,0f3a9c2e",               // 9: short hash
            &format!("100,8,../../{H1}"),   // 10: not a hash at all
            &format!("99999999999,9,{H1}"), // 11: page past u32
            &format!(" 101,10,{H2} \r"),    // 12: fine once trimmed
        ]
        .join("\n");
        let s = parse_sidecar(&text);
        let ids: Vec<u64> = s.entries.iter().map(|e| e.cluster_id).collect();
        assert_eq!(ids, [1, 10]);
        assert_eq!(s.malformed, [4, 5, 6, 7, 8, 9, 10, 11]);
    }

    #[test]
    fn empty_sidecar_has_nothing() {
        assert_eq!(parse_sidecar(""), Sidecar::default());
    }

    #[test]
    fn builds_record_and_sidecar_urls() {
        assert_eq!(
            record_url("https://data.stare.pub", 9876543, H1).unwrap(),
            "https://data.stare.pub/cl/c/9876543/0f3a9c2e7b1d4a65.json.gz"
        );
        assert_eq!(
            record_url("https://data.stare.pub/", 1, H1).unwrap(),
            "https://data.stare.pub/cl/c/1/0f3a9c2e7b1d4a65.json.gz"
        );
        assert!(record_url("https://data.stare.pub", 1, "../x").is_err());
        assert_eq!(
            sidecar_url("https://idx.stare.pub/v/v2026.10.05/", "a3d", "250").unwrap(),
            "https://idx.stare.pub/v/v2026.10.05/a3d/250.cl"
        );
        assert_eq!(sidecar_path("a3d", "138-2").unwrap(), "a3d/138-2.cl");
        assert!(sidecar_path("../a3d", "250").is_err());
        assert!(sidecar_path("A3d", "250").is_err());
        assert!(sidecar_path("a3d", "../250").is_err());
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
