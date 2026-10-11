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
//!   "version": "v2026.10.03",
//!   "generated_at": "2026-10-03T17:04:12Z",
//!   "base": "v/v2026.10.03/",
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
//! `version` is the index's CalVer data version (`vYYYY.MM.DD`, with `.N` for a second
//! release the same day) and `generated_at` is when the manifest was built (RFC 3339,
//! UTC). Both are optional to readers: manifests written before them have neither. The
//! site and the CLI cache index files under their versioned paths, so a new version is
//! a new set of cache keys.
//!
//! `base` says where this build's index files are, relative to the manifest: a volume's
//! `.bin` is at `<base><reporter>/<volume>.bin`. Each build is uploaded once under
//! `v/<version>/` and never changed; the root `manifest.json` is the live build's own
//! manifest with `base` added, so publishing or rolling back a build is one write. A
//! manifest without `base` (a build's own, or one from before the versioned layout)
//! has its files next to it. `stare-admin build-manifest` never writes `base`.
//!
//! `parts` lists only volume numbers CAP split over more than one folder, each part with
//! the range of pages its index covers. The ranges can overlap (a3d's second parts are a
//! second source for the same book, not its second half), so a range only rules a part
//! out; the part's index decides.
//!
//! `idx`, when present, is the unified per-volume index's format ([`crate::idx`]): the
//! build has `<base><reporter>/<volume>.idx.gz` for every volume, from every source, and
//! readers that know the format read it instead of the `.bin`/`.multi` files. Then
//! `reporters` covers every source: a reporter or volume only CourtListener has is listed
//! too, under the volume as cited. `volumes` and `entries` still count CAP's folders and
//! their cases, which batch-index checks them against. A manifest without `idx` has only
//! the `.bin`/`.multi` files.
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
    /// The index's data version (`vYYYY.MM.DD[.N]`) and when the manifest was built
    /// (format 2 only; absent from manifests written before them).
    pub version: Option<String>,
    pub generated_at: Option<String>,
    /// Where the index files are, relative to the manifest (`v/v2026.10.03/`); see
    /// [`Manifest::index_path`].
    pub base: Option<String>,
    /// The unified index's format ([`crate::idx::FORMAT`]) when the build has `.idx.gz`
    /// files (format 2 only).
    pub idx: Option<u32>,
    /// Read from the legacy format, which can't describe split volumes.
    pub legacy: bool,
}

#[derive(Serialize, Deserialize)]
struct Format2 {
    format: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    generated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    base: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    volumes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    entries: Option<u64>,
    reporters: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    parts: BTreeMap<String, BTreeMap<String, Vec<Part>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    idx: Option<u32>,
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

/// Whether `s` can be a manifest's `base`: one or more path segments of ASCII letters,
/// digits, `.`, `_` and `-`, each followed by `/` (`v/v2026.10.03/`). No `.` or `..`
/// segment, no leading slash and no scheme, so it can't leave the index's origin.
pub fn is_index_base(s: &str) -> bool {
    let Some(body) = s.strip_suffix('/') else {
        return false;
    };
    !body.is_empty()
        && body.split('/').all(|seg| {
            !seg.is_empty()
                && seg != "."
                && seg != ".."
                && seg
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        })
}

/// Whether `s` is a CalVer data version: `vYYYY.MM.DD`, or `vYYYY.MM.DD.N` for a later
/// release the same day, with a real month and day.
pub fn is_data_version(s: &str) -> bool {
    let Some(rest) = s.strip_prefix('v') else {
        return false;
    };
    let fields: Vec<&str> = rest.split('.').collect();
    if !(3..=4).contains(&fields.len()) {
        return false;
    }
    let widths = [4, 2, 2];
    let digits = |f: &str| !f.is_empty() && f.chars().all(|c| c.is_ascii_digit());
    if !fields.iter().all(|f| digits(f)) {
        return false;
    }
    if fields.iter().zip(widths).any(|(f, w)| f.len() != w) {
        return false;
    }
    if fields.len() == 4 && (fields[3].starts_with('0') || fields[3].len() > 4) {
        return false;
    }
    let month: u32 = fields[1].parse().unwrap_or(0);
    let day: u32 = fields[2].parse().unwrap_or(0);
    (1..=12).contains(&month) && (1..=31).contains(&day)
}

/// The UTC calendar date and time of `secs` seconds since the Unix epoch, as
/// `(year, month, day, hour, minute, second)`.
fn civil(secs: u64) -> (u64, u64, u64, u64, u64, u64) {
    // Howard Hinnant's days-to-civil algorithm, for dates after 1970.
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z % 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
    (year, month, day, rem / 3600, rem % 3600 / 60, rem % 60)
}

/// The data version for a build on the UTC date of `secs`: `vYYYY.MM.DD`.
pub fn data_version_for(secs: u64) -> String {
    let (y, m, d, ..) = civil(secs);
    format!("v{:04}.{:02}.{:02}", y, m, d)
}

/// `secs` as an RFC 3339 UTC timestamp: `2026-10-03T17:04:12Z`.
pub fn rfc3339_utc(secs: u64) -> String {
    let (y, mo, d, h, mi, s) = civil(secs);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, mo, d, h, mi, s)
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
                version: f.version,
                generated_at: f.generated_at,
                base: f.base,
                idx: f.idx,
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
        if let Some(base) = &self.base {
            if !is_index_base(base) {
                bail!("manifest: bad base {:?}", base);
            }
        }
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
            version: self.version.clone(),
            generated_at: self.generated_at.clone(),
            base: self.base.clone(),
            volumes: self.volumes,
            entries: self.entries,
            reporters: self.reporters.clone(),
            parts: self.parts.clone(),
            idx: self.idx,
        };
        Ok(serde_json::to_string_pretty(&f)?)
    }

    /// The path of an index file (`a3d/138.bin`) relative to the manifest's location:
    /// under `base` when the manifest has one, next to the manifest otherwise.
    pub fn index_path(&self, path: &str) -> String {
        format!("{}{}", self.base.as_deref().unwrap_or(""), path)
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

    /// Whether CAP holds `volume` as cited: the folder itself, or parts of a volume
    /// CAP split over several folders.
    pub fn holds_cap_volume(&self, reporter: &str, volume: &str) -> bool {
        self.has_volume(reporter, volume)
            || self
                .parts
                .get(reporter)
                .is_some_and(|p| p.contains_key(volume))
    }

    /// Whether the build has the unified index in a format this reader knows.
    pub fn has_idx(&self) -> bool {
        self.idx == Some(crate::idx::FORMAT)
    }

    /// The volume as cited whose unified index file holds `folder`'s cases, when `folder`
    /// is a split volume's folder not named for its number (`a3d/138-2` → `138`).
    pub fn folded_into(&self, reporter: &str, folder: &str) -> Option<&str> {
        self.parts.get(reporter)?.iter().find_map(|(number, list)| {
            (number != folder && list.iter().any(|p| p.volume == folder)).then_some(number.as_str())
        })
    }

    /// The volumes of `reporter` that have a unified index file: every listed volume but
    /// the folders folded into a split volume's file (`a3d/138-2`, whose cases are in
    /// `a3d/138.idx.gz`), plus a split volume's number when no folder has its name.
    pub fn idx_volumes(&self, reporter: &str) -> Vec<String> {
        let parts = self.parts.get(reporter);
        let folded = |v: &str| {
            parts.is_some_and(|p| {
                p.iter()
                    .any(|(number, list)| number != v && list.iter().any(|x| x.volume == v))
            })
        };
        let mut out: Vec<String> = self
            .volumes(reporter)
            .iter()
            .filter(|v| !folded(v))
            .cloned()
            .collect();
        for number in parts.into_iter().flat_map(|p| p.keys()) {
            if !out.contains(number) {
                out.push(number.clone());
            }
        }
        out.sort_by(|a, b| compare_volumes(a, b));
        out
    }

    /// Whether the index holds `volume` as cited, from any source: listed itself, or the
    /// number of a volume CAP split over several folders.
    pub fn holds_volume(&self, reporter: &str, volume: &str) -> bool {
        self.holds_cap_volume(reporter, volume)
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
    fn round_trips_version_and_generated_at() {
        let mut m = a3d();
        assert_eq!(m.version, None);
        m.version = Some("v2026.10.03".into());
        m.generated_at = Some("2026-10-03T17:04:12Z".into());
        let json = m.to_json().unwrap();
        let raw: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(raw["version"], "v2026.10.03");
        assert_eq!(raw["generated_at"], "2026-10-03T17:04:12Z");
        assert_eq!(raw["format"], 2);
        assert_eq!(Manifest::parse(json.as_bytes()).unwrap(), m);
    }

    #[test]
    fn unversioned_manifest_writes_no_version_key() {
        let raw: serde_json::Value = serde_json::from_str(&a3d().to_json().unwrap()).unwrap();
        assert!(raw.get("version").is_none());
        assert!(raw.get("generated_at").is_none());
    }

    #[test]
    fn base_places_index_files() {
        let mut m = a3d();
        assert_eq!(m.index_path("a3d/138.bin"), "a3d/138.bin");
        m.base = Some("v/v2026.10.03/".into());
        assert_eq!(m.index_path("a3d/138.bin"), "v/v2026.10.03/a3d/138.bin");
        let again = Manifest::parse(m.to_json().unwrap().as_bytes()).unwrap();
        assert_eq!(again.base.as_deref(), Some("v/v2026.10.03/"));
        assert_eq!(again, m);
    }

    #[test]
    fn index_bases() {
        for ok in ["v/v2026.10.03/", "v/v2026.10.03.1/", "builds/x_y-z/"] {
            assert!(is_index_base(ok), "{ok}");
        }
        for bad in [
            "",
            "/",
            "v/v2026.10.03",
            "/v/v2026.10.03/",
            "v//",
            "../v/",
            "v/../../",
            "./",
            "https://evil.example/",
            "v/a b/",
            "v\\x/",
        ] {
            assert!(!is_index_base(bad), "{bad}");
        }
        assert!(Manifest::parse(br#"{"format": 2, "base": "../x/", "reporters": {}}"#).is_err());
        assert!(
            Manifest::parse(br#"{"format": 2, "base": "v/v2026.10.03/", "reporters": {}}"#).is_ok()
        );
    }

    #[test]
    fn data_versions() {
        for ok in ["v2026.10.03", "v2026.10.03.1", "v2026.12.31.12"] {
            assert!(is_data_version(ok), "{ok}");
        }
        for bad in [
            "",
            "2026.10.03",
            "v2026.10.3",
            "v26.10.03",
            "v2026.13.03",
            "v2026.10.00",
            "v2026.10.03.0",
            "v2026.10.03.",
            "v2026.10.03.1.2",
            "v2026-10-03",
        ] {
            assert!(!is_data_version(bad), "{bad}");
        }
    }

    #[test]
    fn dates_from_epoch_seconds() {
        assert_eq!(data_version_for(0), "v1970.01.01");
        assert_eq!(rfc3339_utc(0), "1970-01-01T00:00:00Z");
        // 2026-10-03T17:04:12Z
        assert_eq!(data_version_for(1_791_047_052), "v2026.10.03");
        assert_eq!(rfc3339_utc(1_791_047_052), "2026-10-03T17:04:12Z");
        // A leap day, and the last second of a year.
        assert_eq!(rfc3339_utc(1_709_164_800), "2024-02-29T00:00:00Z");
        assert_eq!(rfc3339_utc(1_767_225_599), "2025-12-31T23:59:59Z");
    }

    #[test]
    fn reads_and_round_trips_idx() {
        let m = Manifest::parse(
            br#"{"format": 2, "idx": 1, "reporters": {"a3d": ["213"], "ny-slip-op": ["2019"]}}"#,
        )
        .unwrap();
        assert_eq!(m.idx, Some(1));
        assert!(m.has_idx());
        assert!(m.holds_volume("ny-slip-op", "2019"));
        assert_eq!(Manifest::parse(m.to_json().unwrap().as_bytes()).unwrap(), m);
        let future = Manifest::parse(br#"{"format": 2, "idx": 2, "reporters": {}}"#).unwrap();
        assert!(!future.has_idx());
    }

    #[test]
    fn idx_volumes_fold_split_folders() {
        let m = a3d();
        assert_eq!(m.idx_volumes("a3d"), ["9", "10", "138"]);
        assert_eq!(m.idx_volumes("tca"), ["1"]);
        assert!(m.idx_volumes("nope").is_empty());
        assert_eq!(m.folded_into("a3d", "138-2"), Some("138"));
        assert_eq!(m.folded_into("a3d", "138"), None);
        assert_eq!(m.folded_into("a3d", "9"), None);
    }

    #[test]
    fn manifests_without_idx_parse_unchanged() {
        // The live manifest's shape before the unified index, and #148's `cl` block,
        // which nothing published and readers now ignore.
        let m = Manifest::parse(
            br#"{"format": 2, "version": "v2026.10.05", "generated_at": "2026-10-05T07:11:49Z",
                 "base": "v/v2026.10.05/", "volumes": 1, "entries": 2, "reporters": {"a2d": ["31"]},
                 "cl": {"export": "2026-09-30", "reporters": {"a3d": ["250"]}}}"#,
        )
        .unwrap();
        assert_eq!(m.idx, None);
        assert!(!m.has_idx());
        let raw: serde_json::Value = serde_json::from_str(&m.to_json().unwrap()).unwrap();
        assert!(raw.get("idx").is_none());
        assert!(raw.get("cl").is_none());
        assert!(!Manifest::parse(br#"{"a2d": [31]}"#).unwrap().has_idx());
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
