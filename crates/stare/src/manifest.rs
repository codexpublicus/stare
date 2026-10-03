//! The index manifest (`manifest.json` at the root of the index): which volumes are
//! indexed, and how a cited volume number maps onto CAP's volume folders.
//!
//! A volume is named by its CAP folder, a string: usually the volume number (`"138"`),
//! but CAP splits some volumes over two or three folders (`"138"` and `"138-2"`), and a
//! few folders aren't numbers at all (`"33-suppl"`, `"81-12"` for 81½). A citation names
//! only the number, so `138 A.3d 1012` has to pick a folder by page.
//!
//! Format 2, written by `stare-admin build-manifest`:
//!
//! ```json
//! {
//!   "format": 2,
//!   "volumes": 40622,
//!   "entries": 6920598,
//!   "reporters": { "a3d": ["1", "2", "138", "138-2"] },
//!   "parts": {
//!     "a3d": {
//!       "138": [
//!         { "volume": "138", "first_page": 8, "last_page": 1221 },
//!         { "volume": "138-2", "first_page": 2, "last_page": 1263 }
//!       ]
//!     }
//!   }
//! }
//! ```
//!
//! `parts` lists only volume numbers CAP split over more than one folder, each part with
//! the range of pages its index covers. The ranges can overlap (a3d's second parts are a
//! second source for the same book, not its second half), so a range only rules a part
//! out; the part's index decides.
//!
//! The legacy format (format 1, everything before it) is the bare reporter map with
//! integer volumes, `{"a2d": [1, 2, 31]}`. It can't name split volumes, so reading it,
//! [`Manifest::candidates`] guesses `<volume>-2`, the folder name every second part in
//! CAP has.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::BTreeMap;

pub const FORMAT: u32 = 2;

/// One folder of a volume number CAP split over several folders.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Part {
    pub volume: String,
    pub first_page: u32,
    pub last_page: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Manifest {
    /// Reporter slug → volume folders, in [`compare_volumes`] order.
    pub reporters: BTreeMap<String, Vec<String>>,
    /// Reporter slug → volume number → its parts, in folder order.
    pub parts: BTreeMap<String, BTreeMap<String, Vec<Part>>>,
    /// Total volumes and index entries, as the builder counted them (format 2 only).
    pub volumes: Option<u64>,
    pub entries: Option<u64>,
    /// Read from the legacy format, which can't describe split volumes.
    pub legacy: bool,
}

#[derive(Serialize, Deserialize)]
struct Format2 {
    format: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    volumes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    entries: Option<u64>,
    reporters: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    parts: BTreeMap<String, BTreeMap<String, Vec<Part>>>,
}

/// Whether `s` can name a volume folder: an ASCII digit first, then digits, lowercase
/// letters and hyphens (`138`, `138-2`, `33-suppl`). Anything else could escape a path
/// or URL it's joined into.
pub fn is_volume_key(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_digit() || c.is_ascii_lowercase() || c == '-')
        && !s.ends_with('-')
}

/// The leading volume number of a folder name: `138-2` → 138.
fn leading_number(s: &str) -> Option<u64> {
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// Order volume folders by number, then by the rest of the name: `9`, `10`, `138`,
/// `138-2`, `139`.
pub fn compare_volumes(a: &str, b: &str) -> Ordering {
    leading_number(a)
        .cmp(&leading_number(b))
        .then_with(|| a.len().cmp(&b.len()))
        .then_with(|| a.cmp(b))
}

impl Manifest {
    /// Parse either format. Volumes may be numbers or strings in either.
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let value: serde_json::Value =
            serde_json::from_slice(bytes).context("manifest.json is not JSON")?;
        let obj = value
            .as_object()
            .context("manifest.json is not a JSON object")?;
        if obj.contains_key("format") {
            let f: Format2 = serde_json::from_value(value.clone())
                .context("manifest.json doesn't match format 2")?;
            if f.format != FORMAT {
                bail!("unsupported manifest format {}", f.format);
            }
            let mut m = Manifest {
                reporters: f.reporters,
                parts: f.parts,
                volumes: f.volumes,
                entries: f.entries,
                legacy: false,
            };
            m.normalize()?;
            return Ok(m);
        }
        let mut m = Manifest {
            legacy: true,
            ..Default::default()
        };
        for (reporter, volumes) in obj {
            let volumes = volumes
                .as_array()
                .with_context(|| format!("manifest: {} is not a list of volumes", reporter))?;
            let keys = volumes
                .iter()
                .map(|v| match v {
                    serde_json::Value::Number(n) => Ok(n.to_string()),
                    serde_json::Value::String(s) => Ok(s.clone()),
                    _ => bail!("manifest: bad volume {} under {}", v, reporter),
                })
                .collect::<Result<Vec<_>>>()?;
            m.reporters.insert(reporter.clone(), keys);
        }
        m.normalize()?;
        Ok(m)
    }

    fn normalize(&mut self) -> Result<()> {
        for (reporter, volumes) in &mut self.reporters {
            if let Some(bad) = volumes.iter().find(|v| !is_volume_key(v)) {
                bail!("manifest: bad volume {:?} under {}", bad, reporter);
            }
            volumes.sort_by(|a, b| compare_volumes(a, b));
            volumes.dedup();
        }
        for (reporter, numbers) in &self.parts {
            for parts in numbers.values() {
                if let Some(bad) = parts.iter().find(|p| !is_volume_key(&p.volume)) {
                    bail!("manifest: bad part {:?} under {}", bad.volume, reporter);
                }
            }
        }
        Ok(())
    }

    pub fn to_json(&self) -> Result<String> {
        let f = Format2 {
            format: FORMAT,
            volumes: self.volumes,
            entries: self.entries,
            reporters: self.reporters.clone(),
            parts: self.parts.clone(),
        };
        Ok(serde_json::to_string_pretty(&f)?)
    }

    pub fn volumes(&self, reporter: &str) -> &[String] {
        self.reporters
            .get(reporter)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    pub fn has_volume(&self, reporter: &str, volume: &str) -> bool {
        self.volumes(reporter).iter().any(|v| v == volume)
    }

    /// The folders to look `page` up in, in order, for a citation to `volume` (as cited,
    /// e.g. `138`). A volume CAP didn't split is just itself. For a split one, the parts
    /// whose page range holds `page`. A folder name (`138-2`) is itself.
    pub fn candidates(&self, reporter: &str, volume: &str, page: u32) -> Vec<String> {
        if let Some(parts) = self.parts.get(reporter).and_then(|n| n.get(volume)) {
            return parts
                .iter()
                .filter(|p| p.first_page <= page && page <= p.last_page)
                .map(|p| p.volume.clone())
                .collect();
        }
        let plain = volume.chars().all(|c| c.is_ascii_digit());
        if self.legacy && plain {
            return vec![volume.to_string(), format!("{}-2", volume)];
        }
        vec![volume.to_string()]
    }
}

/// Where a citation landed: the volume folder and the page's `.bin` entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Located {
    pub volume: String,
    /// The first case at the page, or [`crate::index::LONG_NAME`] when the page's cases
    /// are all in the folder's `.multi` file.
    pub case_file: String,
}

/// Look `page` up in each candidate folder's index, in order, and return the first that
/// has a case starting there. `read_bin` fetches a folder's `.bin`; a folder whose index
/// can't be read is skipped, so a guessed part that doesn't exist costs nothing.
pub fn locate<F>(candidates: &[String], page: u32, mut read_bin: F) -> Result<Located>
where
    F: FnMut(&str) -> Result<Vec<u8>>,
{
    let mut first_error = None;
    for volume in candidates {
        match read_bin(volume) {
            Ok(bin) => {
                if let Some(case_file) = crate::index::lookup(&bin, page as usize) {
                    return Ok(Located {
                        volume: volume.clone(),
                        case_file: case_file.to_string(),
                    });
                }
            }
            Err(e) => {
                first_error.get_or_insert(e);
            }
        }
    }
    match first_error {
        // Only the first candidate is the volume as cited; its failure is the one to report.
        Some(e) if candidates.len() == 1 => Err(e),
        _ => bail!(
            "no case at page {} in volume {}",
            page,
            candidates.join(" or ")
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// a3d 138's two CAP folders' real indexes. 138 A.3d 1012 (Brooks v. Powers) is only
    /// in the second; 138 A.3d 8 is in both.
    fn read_a3d_138(volume: &str) -> Result<Vec<u8>> {
        let path = format!("tests/fixtures/a3d-{}.bin", volume);
        std::fs::read(&path).with_context(|| format!("no index {}", path))
    }

    #[test]
    fn locate_picks_the_part_that_has_the_page() {
        for manifest in [
            Manifest::parse(br#"{"a3d": [138]}"#).unwrap(),
            Manifest::parse(
                br#"{"format": 2, "reporters": {"a3d": ["138", "138-2"]}, "parts": {"a3d": {"138": [
                  {"volume": "138", "first_page": 8, "last_page": 1221},
                  {"volume": "138-2", "first_page": 2, "last_page": 1263}]}}}"#,
            )
            .unwrap(),
        ] {
            let candidates = manifest.candidates("a3d", "138", 1012);
            let found = locate(&candidates, 1012, read_a3d_138).unwrap();
            assert_eq!(found.volume, "138-2");
            assert_eq!(found.case_file, "1012-01");

            let candidates = manifest.candidates("a3d", "138", 8);
            let found = locate(&candidates, 8, read_a3d_138).unwrap();
            assert_eq!(found.volume, "138");
            assert_eq!(found.case_file, "0008-01");
        }
    }

    #[test]
    fn locate_skips_a_missing_part_and_reports_the_page() {
        let candidates = vec!["138".to_string(), "138-3".to_string()];
        let err = locate(&candidates, 1012, read_a3d_138).unwrap_err();
        assert_eq!(
            err.to_string(),
            "no case at page 1012 in volume 138 or 138-3"
        );
    }

    #[test]
    fn locate_reports_a_missing_unsplit_volume_as_such() {
        let err = locate(&["999".to_string()], 1, read_a3d_138).unwrap_err();
        assert!(err.to_string().starts_with("no index"), "{err}");
    }

    fn a3d() -> Manifest {
        Manifest::parse(
            br#"{
              "format": 2, "volumes": 4, "entries": 10,
              "reporters": {"a3d": ["138-2", "9", "138", "10"], "tca": ["1", "1-2"]},
              "parts": {
                "a3d": {"138": [
                  {"volume": "138", "first_page": 8, "last_page": 1221},
                  {"volume": "138-2", "first_page": 2, "last_page": 1263}
                ]},
                "tca": {"1": [
                  {"volume": "1", "first_page": 1, "last_page": 874},
                  {"volume": "1-2", "first_page": 880, "last_page": 1480}
                ]}
              }
            }"#,
        )
        .unwrap()
    }

    #[test]
    fn volume_keys() {
        for ok in ["1", "138", "138-2", "33-suppl", "81-12"] {
            assert!(is_volume_key(ok), "{ok}");
        }
        for bad in ["", "-2", "a3d", "138/2", "138 2", "../1", "138-", "13A"] {
            assert!(!is_volume_key(bad), "{bad}");
        }
    }

    #[test]
    fn volumes_sort_by_number_then_part() {
        let m = a3d();
        assert_eq!(m.volumes("a3d"), ["9", "10", "138", "138-2"]);
    }

    #[test]
    fn parses_legacy_integer_manifest() {
        let m = Manifest::parse(br#"{"a2d": [31, 2], "us": [3]}"#).unwrap();
        assert!(m.legacy);
        assert_eq!(m.volumes("a2d"), ["2", "31"]);
        assert!(m.has_volume("us", "3"));
        assert!(!m.has_volume("us", "4"));
    }

    #[test]
    fn round_trips_format_2() {
        let m = a3d();
        let again = Manifest::parse(m.to_json().unwrap().as_bytes()).unwrap();
        assert_eq!(again, m);
        assert_eq!(again.entries, Some(10));
    }

    #[test]
    fn rejects_unsafe_volume_names() {
        assert!(Manifest::parse(br#"{"a2d": ["../31"]}"#).is_err());
        assert!(Manifest::parse(br#"{"format": 2, "reporters": {"a2d": ["31/x"]}}"#).is_err());
        assert!(Manifest::parse(br#"{"format": 3, "reporters": {}}"#).is_err());
    }

    #[test]
    fn unsplit_volume_is_its_own_candidate() {
        assert_eq!(a3d().candidates("a3d", "9", 100), ["9"]);
    }

    #[test]
    fn overlapping_parts_are_both_candidates() {
        // a3d/138 and 138-2 both cover page 1012; the indexes decide.
        assert_eq!(a3d().candidates("a3d", "138", 1012), ["138", "138-2"]);
        // Page 2 is only in 138-2's range.
        assert_eq!(a3d().candidates("a3d", "138", 2), ["138-2"]);
        assert!(a3d().candidates("a3d", "138", 5000).is_empty());
    }

    #[test]
    fn disjoint_parts_pick_by_range() {
        assert_eq!(a3d().candidates("tca", "1", 900), ["1-2"]);
        assert_eq!(a3d().candidates("tca", "1", 12), ["1"]);
    }

    #[test]
    fn folder_name_is_its_own_candidate() {
        assert_eq!(a3d().candidates("a3d", "138-2", 1012), ["138-2"]);
    }

    #[test]
    fn legacy_manifest_guesses_a_second_part() {
        let m = Manifest::parse(br#"{"a3d": [138]}"#).unwrap();
        assert_eq!(m.candidates("a3d", "138", 1012), ["138", "138-2"]);
        assert_eq!(m.candidates("a3d", "138-2", 1012), ["138-2"]);
    }
}
