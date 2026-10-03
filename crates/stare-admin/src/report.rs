//! The build report: `report.json`, written next to an index build by `build-report`.
//!
//! Its schema is `schemas/index-report.v1.schema.json`; a change that breaks a reader
//! bumps [`FORMAT`] and the schema's file name. `batch-index --results` records what
//! indexing each volume found ([`BatchResults`]), and `build-report` adds the build's
//! identity, the manifest's split-volume counts, a digest of each volume's index files
//! and, given the previous build's report, what changed since it.

use anyhow::Context;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use crate::{Allowlist, VolumeReport};

/// The report format this stare-admin writes and reads as `--previous`.
pub const FORMAT: u32 = 1;

/// The format of the file `batch-index --results` writes.
pub const RESULTS_FORMAT: u32 = 1;

/// What `batch-index` found, per `reporter/volume`: written by `--results` and read by
/// `build-report`.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct BatchResults {
    pub format: u32,
    /// Every volume that was indexed, whether or not it passed the check.
    pub volumes: BTreeMap<String, VolumeReport>,
    /// Volumes that couldn't be indexed, with the error.
    pub errors: BTreeMap<String, String>,
    /// The `--allow` file the batch ran with.
    pub allow: Allowlist,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Report {
    pub format: u32,
    pub version: String,
    pub generated_at: String,
    pub build: Build,
    pub totals: Totals,
    pub reporters: BTreeMap<String, ReporterCounts>,
    pub allowed: Vec<Allowed>,
    pub failed: Vec<Failed>,
    pub volumes: BTreeMap<String, BTreeMap<String, VolumeCounts>>,
    pub diff: Option<Diff>,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct Build {
    pub stare_tag: Option<String>,
    pub stare_commit: Option<String>,
    pub stare_admin: String,
    pub citare: Option<String>,
    pub cap_release: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: String,
    pub duration_seconds: Option<u64>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Totals {
    pub reporters: u64,
    pub volumes: u64,
    pub split_volumes: Option<u64>,
    pub split_parts: Option<u64>,
    pub cases: u64,
    pub entries: u64,
    pub shortfall: u64,
    pub labeled: u64,
    pub long_names: u64,
    pub allowed: u64,
    pub failed: u64,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReporterCounts {
    pub volumes: u64,
    pub cases: u64,
    pub entries: u64,
    pub shortfall: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Allowed {
    pub volume: String,
    pub reason: String,
    pub problems: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FailureKind {
    /// The volume couldn't be indexed.
    Error,
    /// Its index failed the check, and it isn't allow-listed.
    Check,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Failed {
    pub volume: String,
    pub kind: FailureKind,
    pub reason: String,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VolumeCounts {
    pub cases: u64,
    pub entries: u64,
    /// The first 16 hex digits of the SHA-256 of the .bin, then the .multi.
    pub digest: Option<String>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diff {
    pub previous_version: String,
    pub previous_generated_at: String,
    pub volumes_added: Vec<String>,
    pub volumes_removed: Vec<String>,
    pub volumes_changed: Vec<String>,
    pub counts_changed: Vec<CountsChanged>,
    pub reporters: BTreeMap<String, ReporterDiff>,
    pub totals: TotalsDiff,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CountsChanged {
    pub volume: String,
    pub cases: [u64; 2],
    pub entries: [u64; 2],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReporterDiff {
    pub entries: [u64; 2],
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TotalsDiff {
    pub volumes: [u64; 2],
    pub cases: [u64; 2],
    pub entries: [u64; 2],
}

/// Who built the index from what, as `build-report`'s flags give it.
#[derive(Debug, Default, Clone)]
pub struct Identity {
    pub version: String,
    pub stare_tag: Option<String>,
    pub stare_commit: Option<String>,
    pub cap_release: Option<String>,
    pub started_at: Option<String>,
}

impl Report {
    pub fn parse(bytes: &[u8]) -> anyhow::Result<Report> {
        let raw: serde_json::Value = serde_json::from_slice(bytes)?;
        match raw.get("format").and_then(|f| f.as_u64()) {
            Some(f) if f == u64::from(FORMAT) => {}
            Some(f) => anyhow::bail!("report format {f}; this stare-admin reads format {FORMAT}"),
            None => anyhow::bail!("not a build report: no format"),
        }
        Ok(serde_json::from_value(raw)?)
    }

    pub fn to_json(&self) -> anyhow::Result<String> {
        Ok(serde_json::to_string_pretty(self)? + "\n")
    }
}

/// Split `reporter/volume` into its two parts.
fn split_key(key: &str) -> (&str, &str) {
    key.split_once('/').unwrap_or(("", key))
}

/// The first 16 hex digits of the SHA-256 of a volume's .bin and then its .multi, or
/// None when there's no .bin.
pub fn volume_digest(bin_path: &Path) -> anyhow::Result<Option<String>> {
    let bin = match std::fs::read(bin_path) {
        Ok(bin) => bin,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).with_context(|| format!("failed to read {}", bin_path.display())),
    };
    let mut hash = Sha256::new();
    hash.update(&bin);
    let multi_path = bin_path.with_extension("multi");
    match std::fs::read(&multi_path) {
        Ok(multi) => {
            hash.update(b"\0multi\0");
            hash.update(&multi);
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(e).with_context(|| format!("failed to read {}", multi_path.display()))
        }
    }
    Ok(Some(
        hash.finalize()[..8]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    ))
}

/// Seconds since the epoch for an RFC 3339 UTC timestamp as `rfc3339_utc` writes it
/// (`2026-10-03T17:04:12Z`).
pub fn parse_rfc3339_utc(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() != 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[19] != b'Z' {
        return None;
    }
    if b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<u64> {
        let part = s.get(r)?;
        part.bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| part.parse().ok())?
    };
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, sec) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1970..=9999).contains(&y) || !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    if h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    // Days from the civil date (Howard Hinnant's algorithm, the inverse of
    // stare::manifest's).
    let (y, m) = if mo <= 2 {
        (y - 1, mo + 9)
    } else {
        (y, mo - 3)
    };
    let era = y / 400;
    let yoe = y - era * 400;
    let doy = (153 * m + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = (era * 146_097 + doe).checked_sub(719_468)?;
    let secs = days * 86_400 + h * 3600 + mi * 60 + sec;
    (stare::manifest::rfc3339_utc(secs) == s).then_some(secs)
}

/// Build the report for the index in `build_dir` from what `batch-index` found.
///
/// `manifest` is the build's manifest.json when build-manifest ran; `now` is when the
/// report is written, in seconds since the epoch.
pub fn build_report(
    build_dir: &Path,
    results: &BatchResults,
    manifest: Option<&stare::manifest::Manifest>,
    identity: &Identity,
    previous: Option<&Report>,
    now: u64,
) -> anyhow::Result<Report> {
    let digests: Vec<(&String, Option<String>)> = results
        .volumes
        .par_iter()
        .map(|(key, _)| {
            let (reporter, volume) = split_key(key);
            let bin = build_dir.join(reporter).join(format!("{volume}.bin"));
            volume_digest(&bin).map(|d| (key, d))
        })
        .collect::<anyhow::Result<_>>()?;
    let digests: BTreeMap<&String, Option<String>> = digests.into_iter().collect();

    let mut totals = Totals::default();
    let mut reporters: BTreeMap<String, ReporterCounts> = BTreeMap::new();
    let mut volumes: BTreeMap<String, BTreeMap<String, VolumeCounts>> = BTreeMap::new();
    let mut failed = Vec::new();
    for (key, v) in &results.volumes {
        let (reporter, volume) = split_key(key);
        let (cases, entries) = (v.cases as u64, v.entries as u64);
        let shortfall = cases.saturating_sub(entries);
        let r = reporters.entry(reporter.to_string()).or_default();
        r.volumes += 1;
        r.cases += cases;
        r.entries += entries;
        r.shortfall += shortfall;
        totals.volumes += 1;
        totals.cases += cases;
        totals.entries += entries;
        totals.shortfall += shortfall;
        totals.labeled += v.labeled as u64;
        totals.long_names += v.long_names as u64;
        volumes.entry(reporter.to_string()).or_default().insert(
            volume.to_string(),
            VolumeCounts {
                cases,
                entries,
                digest: digests[key].clone(),
            },
        );
        if !v.problems.is_empty() {
            if results.allow.contains_key(key) {
                totals.allowed += 1;
            } else {
                failed.push(Failed {
                    volume: key.clone(),
                    kind: FailureKind::Check,
                    reason: v.problems.join("; "),
                });
            }
        }
    }
    for (key, error) in &results.errors {
        failed.push(Failed {
            volume: key.clone(),
            kind: FailureKind::Error,
            reason: error.clone(),
        });
    }
    failed.sort_by(|a, b| a.volume.cmp(&b.volume));
    totals.failed = failed.len() as u64;
    totals.reporters = reporters.len() as u64;

    let allowed = results
        .allow
        .iter()
        .map(|(volume, reason)| Allowed {
            volume: volume.clone(),
            reason: reason.clone(),
            problems: results
                .volumes
                .get(volume)
                .map(|v| v.problems.clone())
                .unwrap_or_default(),
        })
        .collect();

    if let Some(m) = manifest {
        if let Some(v) = m.version.as_deref().filter(|v| *v != identity.version) {
            anyhow::bail!(
                "the build's manifest.json is version {v}, not {}",
                identity.version
            );
        }
        totals.split_volumes = Some(m.parts.values().map(|n| n.len() as u64).sum());
        totals.split_parts = Some(
            m.parts
                .values()
                .flat_map(|n| n.values())
                .map(|p| p.len() as u64)
                .sum(),
        );
    }

    let finished_at = stare::manifest::rfc3339_utc(now);
    let started = match identity.started_at.as_deref() {
        Some(s) => Some(parse_rfc3339_utc(s).with_context(|| {
            format!("--started-at {s:?} isn't an RFC 3339 UTC time like 2026-10-03T17:04:12Z")
        })?),
        None => None,
    };
    let build = Build {
        stare_tag: identity.stare_tag.clone(),
        stare_commit: identity.stare_commit.clone(),
        stare_admin: env!("CARGO_PKG_VERSION").to_string(),
        citare: Some(env!("STARE_CITARE_VERSION"))
            .filter(|v| !v.is_empty())
            .map(String::from),
        cap_release: identity.cap_release.clone(),
        started_at: identity.started_at.clone(),
        finished_at: finished_at.clone(),
        duration_seconds: started.map(|s| now.saturating_sub(s)),
    };

    let mut report = Report {
        format: FORMAT,
        version: identity.version.clone(),
        generated_at: finished_at,
        build,
        totals,
        reporters,
        allowed,
        failed,
        volumes,
        diff: None,
    };
    report.diff = previous.map(|p| diff(p, &report));
    Ok(report)
}

/// What changed from `before` to `after`.
pub fn diff(before: &Report, after: &Report) -> Diff {
    let flat = |r: &Report| -> BTreeMap<String, VolumeCounts> {
        r.volumes
            .iter()
            .flat_map(|(reporter, vols)| {
                vols.iter()
                    .map(move |(v, c)| (format!("{reporter}/{v}"), c.clone()))
            })
            .collect()
    };
    let (old, new) = (flat(before), flat(after));
    let mut d = Diff {
        previous_version: before.version.clone(),
        previous_generated_at: before.generated_at.clone(),
        ..Default::default()
    };
    for (key, n) in &new {
        match old.get(key) {
            None => d.volumes_added.push(key.clone()),
            Some(o) if o != n => {
                d.volumes_changed.push(key.clone());
                if (o.cases, o.entries) != (n.cases, n.entries) {
                    d.counts_changed.push(CountsChanged {
                        volume: key.clone(),
                        cases: [o.cases, n.cases],
                        entries: [o.entries, n.entries],
                    });
                }
            }
            Some(_) => {}
        }
    }
    d.volumes_removed = old
        .keys()
        .filter(|k| !new.contains_key(*k))
        .cloned()
        .collect();
    let names: BTreeSet<&String> = before
        .reporters
        .keys()
        .chain(after.reporters.keys())
        .collect();
    for name in names {
        let entries = |r: &Report| r.reporters.get(name).map_or(0, |c| c.entries);
        let pair = [entries(before), entries(after)];
        if pair[0] != pair[1] {
            d.reporters
                .insert(name.clone(), ReporterDiff { entries: pair });
        }
    }
    d.totals = TotalsDiff {
        volumes: [before.totals.volumes, after.totals.volumes],
        cases: [before.totals.cases, after.totals.cases],
        entries: [before.totals.entries, after.totals.entries],
    };
    d
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const SCHEMA: &str = include_str!("../../../schemas/index-report.v1.schema.json");

    /// Check `value` against the subset of JSON Schema the report schema uses: `$ref`
    /// within the file, `type`, `const`, `enum`, `oneOf`, `required`, `properties`,
    /// `additionalProperties`, `items`, `minItems`, `maxItems`, `minimum`, `pattern`.
    /// Fails on any other keyword, so the schema can't quietly outgrow the check.
    fn validate(root: &Value, schema: &Value, value: &Value, path: &str, errors: &mut Vec<String>) {
        let schema = match schema.get("$ref").and_then(Value::as_str) {
            Some(r) => {
                let name = r.strip_prefix("#/$defs/").expect("local $ref");
                &root["$defs"][name]
            }
            None => schema,
        };
        const KNOWN: &[&str] = &[
            "$schema",
            "$id",
            "$ref",
            "$defs",
            "title",
            "description",
            "type",
            "const",
            "enum",
            "oneOf",
            "required",
            "properties",
            "additionalProperties",
            "items",
            "minItems",
            "maxItems",
            "minimum",
            "pattern",
        ];
        for key in schema.as_object().expect("schema object").keys() {
            assert!(
                KNOWN.contains(&key.as_str()),
                "unsupported keyword {key} at {path}"
            );
        }
        if let Some(types) = schema.get("type") {
            let types: Vec<&str> = match types {
                Value::String(t) => vec![t.as_str()],
                Value::Array(ts) => ts.iter().filter_map(Value::as_str).collect(),
                _ => panic!("bad type at {path}"),
            };
            let ok = types.iter().any(|t| match *t {
                "object" => value.is_object(),
                "array" => value.is_array(),
                "string" => value.is_string(),
                "integer" => value.is_u64() || value.is_i64(),
                "null" => value.is_null(),
                "boolean" => value.is_boolean(),
                _ => panic!("unknown type {t}"),
            });
            if !ok {
                errors.push(format!("{path}: {value} is not {types:?}"));
                return;
            }
        }
        if let Some(c) = schema.get("const") {
            if c != value {
                errors.push(format!("{path}: {value} != {c}"));
            }
        }
        if let Some(options) = schema.get("enum").and_then(Value::as_array) {
            if !options.contains(value) {
                errors.push(format!("{path}: {value} not in {options:?}"));
            }
        }
        if let Some(options) = schema.get("oneOf").and_then(Value::as_array) {
            let passing = options
                .iter()
                .filter(|o| {
                    let mut e = Vec::new();
                    validate(root, o, value, path, &mut e);
                    e.is_empty()
                })
                .count();
            if passing != 1 {
                errors.push(format!("{path}: matches {passing} of oneOf"));
            }
        }
        if let (Some(min), Some(n)) = (
            schema.get("minimum").and_then(Value::as_i64),
            value.as_i64(),
        ) {
            if n < min {
                errors.push(format!("{path}: {n} < {min}"));
            }
        }
        if let (Some(p), Some(s)) = (
            schema.get("pattern").and_then(Value::as_str),
            value.as_str(),
        ) {
            if !regex::Regex::new(p).unwrap().is_match(s) {
                errors.push(format!("{path}: {s:?} doesn't match {p}"));
            }
        }
        if let Some(obj) = value.as_object() {
            for key in schema
                .get("required")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if !obj.contains_key(key.as_str().unwrap()) {
                    errors.push(format!("{path}: missing {key}"));
                }
            }
            let props = schema.get("properties").and_then(Value::as_object);
            for (key, v) in obj {
                let sub = format!("{path}.{key}");
                match (
                    props.and_then(|p| p.get(key)),
                    schema.get("additionalProperties"),
                ) {
                    (Some(s), _) => validate(root, s, v, &sub, errors),
                    (None, Some(Value::Bool(false))) => errors.push(format!("{sub}: not allowed")),
                    (None, Some(s)) if s.is_object() => validate(root, s, v, &sub, errors),
                    (None, _) => {}
                }
            }
        }
        if let Some(items) = value.as_array() {
            let len = items.len() as u64;
            if schema
                .get("minItems")
                .and_then(Value::as_u64)
                .is_some_and(|m| len < m)
            {
                errors.push(format!("{path}: too few items"));
            }
            if schema
                .get("maxItems")
                .and_then(Value::as_u64)
                .is_some_and(|m| len > m)
            {
                errors.push(format!("{path}: too many items"));
            }
            if let Some(s) = schema.get("items") {
                for (i, v) in items.iter().enumerate() {
                    validate(root, s, v, &format!("{path}[{i}]"), errors);
                }
            }
        }
    }

    fn assert_valid(report: &Report) {
        let root: Value = serde_json::from_str(SCHEMA).unwrap();
        let value: Value = serde_json::from_str(&report.to_json().unwrap()).unwrap();
        let mut errors = Vec::new();
        validate(&root, &root, &value, "$", &mut errors);
        assert!(errors.is_empty(), "{errors:#?}");
    }

    fn vol(cases: usize, entries: usize, problems: &[&str]) -> VolumeReport {
        VolumeReport {
            cases,
            entries,
            labeled: 1,
            long_names: 0,
            problems: problems.iter().map(|p| p.to_string()).collect(),
        }
    }

    /// A build directory holding a .bin for each volume in `results`, and those results.
    fn build(results: &BatchResults) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for key in results.volumes.keys() {
            let (reporter, volume) = split_key(key);
            std::fs::create_dir_all(dir.path().join(reporter)).unwrap();
            std::fs::write(dir.path().join(reporter).join(format!("{volume}.bin")), key).unwrap();
        }
        dir
    }

    fn results() -> BatchResults {
        BatchResults {
            format: RESULTS_FORMAT,
            volumes: BTreeMap::from([
                ("a2d/31".into(), vol(10, 10, &[])),
                (
                    "a2d/32".into(),
                    vol(5, 4, &["index holds 4 entries for 5 cases"]),
                ),
                ("a3d/138".into(), vol(7, 7, &[])),
                (
                    "a3d/138-2".into(),
                    vol(3, 2, &["not found at their own page: 0002-01"]),
                ),
            ]),
            errors: BTreeMap::from([("ga/1".into(), "failed to read ga/1.zip".into())]),
            allow: BTreeMap::from([
                (
                    "a2d/32".into(),
                    "CAP's metadata lists a case it has no file for".into(),
                ),
                ("us/1".into(), "kept from an earlier build".into()),
            ]),
        }
    }

    fn identity() -> Identity {
        Identity {
            version: "v2026.10.04".into(),
            stare_tag: Some("v2026.10.04.1".into()),
            stare_commit: Some("0123abc".into()),
            cap_release: Some("VolumesMetadata.json sha256:abcd".into()),
            started_at: Some("2026-10-04T10:00:00Z".into()),
        }
    }

    const NOW: u64 = 1_791_108_900; // 2026-10-04T10:15:00Z

    #[test]
    fn report_counts_reporters_exceptions_and_failures() {
        let results = results();
        let dir = build(&results);
        let r = build_report(dir.path(), &results, None, &identity(), None, NOW).unwrap();
        assert_valid(&r);

        assert_eq!(r.format, 1);
        assert_eq!(r.version, "v2026.10.04");
        assert_eq!(r.generated_at, "2026-10-04T10:15:00Z");
        assert_eq!(r.build.duration_seconds, Some(900));
        assert_eq!(r.build.stare_tag.as_deref(), Some("v2026.10.04.1"));
        assert_eq!(r.build.stare_admin, env!("CARGO_PKG_VERSION"));
        assert!(r.build.citare.as_deref().is_some_and(|c| !c.is_empty()));

        assert_eq!(
            r.totals,
            Totals {
                reporters: 2,
                volumes: 4,
                split_volumes: None,
                split_parts: None,
                cases: 25,
                entries: 23,
                shortfall: 2,
                labeled: 4,
                long_names: 0,
                allowed: 1,
                failed: 2,
            }
        );
        assert_eq!(
            r.reporters["a2d"],
            ReporterCounts {
                volumes: 2,
                cases: 15,
                entries: 14,
                shortfall: 1
            }
        );
        assert_eq!(r.reporters["a3d"].shortfall, 1);

        // Every allow-file entry, with what the check found (nothing for a volume that
        // passed or isn't in the build).
        assert_eq!(
            r.allowed,
            [
                Allowed {
                    volume: "a2d/32".into(),
                    reason: "CAP's metadata lists a case it has no file for".into(),
                    problems: vec!["index holds 4 entries for 5 cases".into()],
                },
                Allowed {
                    volume: "us/1".into(),
                    reason: "kept from an earlier build".into(),
                    problems: vec![],
                },
            ]
        );
        assert_eq!(
            r.failed,
            [
                Failed {
                    volume: "a3d/138-2".into(),
                    kind: FailureKind::Check,
                    reason: "not found at their own page: 0002-01".into(),
                },
                Failed {
                    volume: "ga/1".into(),
                    kind: FailureKind::Error,
                    reason: "failed to read ga/1.zip".into(),
                },
            ]
        );
        // A volume that couldn't be indexed has no counts.
        assert!(!r.volumes.contains_key("ga"));
        let d = r.volumes["a3d"]["138-2"].digest.as_deref().unwrap();
        assert_eq!(d.len(), 16);
        assert!(r.diff.is_none());
    }

    #[test]
    fn report_takes_split_counts_from_the_manifest_and_checks_its_version() {
        let results = results();
        let dir = build(&results);
        let manifest = stare::manifest::Manifest::parse(
            json!({
                "format": 2, "version": "v2026.10.04", "volumes": 4, "entries": 23,
                "reporters": {"a2d": ["31", "32"], "a3d": ["138", "138-2"]},
                "parts": {"a3d": {"138": [
                    {"volume": "138", "first_page": 1, "last_page": 9},
                    {"volume": "138-2", "first_page": 10, "last_page": 20}
                ]}}
            })
            .to_string()
            .as_bytes(),
        )
        .unwrap();
        let r = build_report(
            dir.path(),
            &results,
            Some(&manifest),
            &identity(),
            None,
            NOW,
        )
        .unwrap();
        assert_eq!(
            (r.totals.split_volumes, r.totals.split_parts),
            (Some(1), Some(2))
        );
        assert_valid(&r);

        let other = Identity {
            version: "v2026.10.05".into(),
            ..identity()
        };
        let err =
            build_report(dir.path(), &results, Some(&manifest), &other, None, NOW).unwrap_err();
        assert!(err.to_string().contains("version v2026.10.04"), "{err}");
    }

    #[test]
    fn diff_lists_added_removed_and_changed_volumes_and_reporter_deltas() {
        let before_results = results();
        let before_dir = build(&before_results);
        let before = build_report(
            before_dir.path(),
            &before_results,
            None,
            &identity(),
            None,
            NOW,
        )
        .unwrap();

        // The next build: a2d/32 now indexes every case, a3d/138's files changed with
        // the same counts, a2d/31 is untouched, a3d/138-2 is gone, and ne/1 is new.
        let mut after_results = results();
        after_results
            .volumes
            .insert("a2d/32".into(), vol(5, 5, &[]));
        after_results.volumes.remove("a3d/138-2");
        after_results.volumes.insert("ne/1".into(), vol(4, 4, &[]));
        let after_dir = build(&after_results);
        std::fs::write(after_dir.path().join("a3d/138.multi"), "1,0001-02\n").unwrap();
        let next = Identity {
            version: "v2026.10.05".into(),
            ..identity()
        };
        let after = build_report(
            after_dir.path(),
            &after_results,
            None,
            &next,
            Some(&before),
            NOW + 86_400,
        )
        .unwrap();
        assert_valid(&after);

        let d = after.diff.as_ref().unwrap();
        assert_eq!(d.previous_version, "v2026.10.04");
        assert_eq!(d.previous_generated_at, "2026-10-04T10:15:00Z");
        assert_eq!(d.volumes_added, ["ne/1"]);
        assert_eq!(d.volumes_removed, ["a3d/138-2"]);
        assert_eq!(d.volumes_changed, ["a2d/32", "a3d/138"]);
        assert_eq!(
            d.counts_changed,
            [CountsChanged {
                volume: "a2d/32".into(),
                cases: [5, 5],
                entries: [4, 5]
            }]
        );
        assert_eq!(
            d.reporters,
            BTreeMap::from([
                ("a2d".to_string(), ReporterDiff { entries: [14, 15] }),
                ("a3d".to_string(), ReporterDiff { entries: [9, 7] }),
                ("ne".to_string(), ReporterDiff { entries: [0, 4] }),
            ])
        );
        assert_eq!(
            d.totals,
            TotalsDiff {
                volumes: [4, 4],
                cases: [25, 26],
                entries: [23, 26]
            }
        );

        // The same build against itself changes nothing.
        let same = diff(&before, &before);
        assert!(same.volumes_added.is_empty() && same.volumes_removed.is_empty());
        assert!(same.volumes_changed.is_empty() && same.reporters.is_empty());
    }

    #[test]
    fn report_round_trips_and_refuses_another_format() {
        let results = results();
        let dir = build(&results);
        let r = build_report(dir.path(), &results, None, &identity(), None, NOW).unwrap();
        let json = r.to_json().unwrap();
        assert_eq!(Report::parse(json.as_bytes()).unwrap(), r);

        let mut raw: Value = serde_json::from_str(&json).unwrap();
        raw["format"] = json!(2);
        let err = Report::parse(raw.to_string().as_bytes()).unwrap_err();
        assert!(err.to_string().contains("format 2"), "{err}");
        assert!(Report::parse(b"{}").is_err());
    }

    #[test]
    fn digest_covers_the_bin_and_the_multi() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("1.bin");
        assert_eq!(volume_digest(&bin).unwrap(), None);
        std::fs::write(&bin, b"bin").unwrap();
        let plain = volume_digest(&bin).unwrap().unwrap();
        std::fs::write(dir.path().join("1.multi"), "1,0001-02\n").unwrap();
        let with_multi = volume_digest(&bin).unwrap().unwrap();
        assert_ne!(plain, with_multi);
        assert!(with_multi.chars().all(|c| c.is_ascii_hexdigit()) && with_multi.len() == 16);
    }

    #[test]
    fn rfc3339_parses_what_the_manifest_writes() {
        for secs in [0, 951_782_400, 1_791_108_900, 4_102_444_799] {
            let s = stare::manifest::rfc3339_utc(secs);
            assert_eq!(parse_rfc3339_utc(&s), Some(secs), "{s}");
        }
        for bad in [
            "2026-10-04 10:00:00Z",
            "2026-10-04T10:00:00",
            "2026-02-30T00:00:00Z",
            "x",
        ] {
            assert_eq!(parse_rfc3339_utc(bad), None, "{bad}");
        }
    }
}
