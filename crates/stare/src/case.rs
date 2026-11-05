//! Case data extracted from Harvard CAP zip files.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Read;

#[derive(Debug, Deserialize, Serialize)]
pub struct CaseJson {
    pub id: u64,
    pub name: String,
    pub name_abbreviation: String,
    pub decision_date: String,
    pub citations: Vec<Citation>,
    pub court: Court,
    pub jurisdiction: Jurisdiction,
    pub casebody: CaseBody,
    /// Where the record came from. CAP's case JSON has none, which reads as CAP; a
    /// CourtListener record (`crate::cl`) has `{"name": "courtlistener", ...}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Source>,
    /// The record's licence. A CourtListener record carries the Public Domain Mark 1.0
    /// CourtListener puts on its bulk data ([`crate::license::PUBLIC_DOMAIN_MARK`], D65);
    /// CAP's case JSON has none (the case files are CC0, as CAP published them).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<crate::license::Stated>,
    /// Who the record credits: CourtListener (Free Law Project) and the export it came
    /// from, in a CourtListener record (D65).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attribution: Option<Attribution>,
}

/// A record's `attribution` (docs/plans/courtlistener-mirror.md, "The record").
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct Attribution {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// The export the record came from (`2026-09-30`), the same as `source.export`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub export: Option<String>,
}

impl CaseJson {
    /// Parse one case record: a CAP case JSON or a CourtListener record, which has
    /// the same shape plus `source`.
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        serde_json::from_slice(bytes).context("failed to parse case JSON")
    }

    /// The record's source name: `source.name`, or `"cap"` when it has no `source`.
    pub fn source_name(&self) -> &str {
        self.source.as_ref().map_or("cap", |s| s.name.as_str())
    }
}

/// A record's `source` block (docs/plans/courtlistener-mirror.md, "The record").
/// Everything but `name` is optional, so a reader takes a record from any export.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct Source {
    pub name: String,
    /// The export the record was built from (`2026-09-30`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub export: Option<String>,
    /// The first export the case appeared in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_seen: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ids: Option<SourceIds>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub docket_number: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub precedential_status: Option<String>,
    /// Which CourtListener opinion field the text came from (`html_with_citations`), or
    /// one per opinion when they came from different fields.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_field: Option<TextField>,
    /// The case's page on the source's own site.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Set when CourtListener blocks the case, or its docket, from search engines.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cl_blocked: Option<ClBlocked>,
}

/// `source.text_field`: one field name for the whole case, or a list, one name per entry
/// of `casebody.opinions` in the same order, when the opinions came from different fields.
/// Either shape serializes as it was read.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum TextField {
    One(String),
    PerOpinion(Vec<String>),
}

/// `source.cl_blocked` (the index builder's `blocking.py`): CourtListener's blocked flags for
/// the cluster and its docket, and the blocking rules that match the case. CourtListener
/// doesn't publish why it blocked an item, so `reasons` is an inference, and
/// `reason_basis` says so. Nothing is hidden for it; the viewer shows a provenance line.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct ClBlocked {
    #[serde(default)]
    pub blocked: bool,
    #[serde(default)]
    pub date_blocked: Option<String>,
    #[serde(default)]
    pub docket_blocked: bool,
    /// Reason codes: `id-number`, `unpublished-30y`, `keyword:<term>`, `court-category`,
    /// `bankruptcy-docket` or `unknown`.
    #[serde(default)]
    pub reasons: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_basis: Option<String>,
    /// Reasons the export can't confirm, each with why.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub unverifiable: BTreeMap<String, String>,
}

/// The provenance line's wording. Placeholder; the owner chooses the final text.
pub const CL_BLOCKED_NOTICE: &str = "CourtListener excludes this case from search engines.";

impl ClBlocked {
    /// The provenance line: the notice and the inferred reasons, e.g.
    /// "CourtListener excludes this case from search engines. (inferred: unpublished
    /// within 30 years)". Mirrors `blockedLineHtml` in `web/public/js/cl.js`.
    pub fn notice(&self) -> String {
        let known: Vec<String> = self
            .reasons
            .iter()
            .filter(|r| r.as_str() != "unknown")
            .map(|r| {
                let phrase = reason_phrase(r);
                if self.unverifiable.contains_key(r) {
                    format!("{phrase}, unverified")
                } else {
                    phrase
                }
            })
            .collect();
        if known.is_empty() {
            format!("{CL_BLOCKED_NOTICE} (reason unknown)")
        } else {
            format!("{CL_BLOCKED_NOTICE} (inferred: {})", known.join("; "))
        }
    }
}

/// A short readable phrase for one `cl_blocked` reason code; an unrecognized code as is.
pub fn reason_phrase(code: &str) -> String {
    match code {
        "id-number" => "a redacted ID number in the text".into(),
        "unpublished-30y" => "unpublished within 30 years".into(),
        "court-category" => "a military, tax or similar court within 30 years".into(),
        "bankruptcy-docket" => "a bankruptcy docket".into(),
        "keyword:minor+child" => "mentions \"minor\" and \"child\" within 30 years".into(),
        _ => match code.strip_prefix("keyword:") {
            Some(term) => format!("mentions \"{term}\" within 30 years"),
            None => code.into(),
        },
    }
}

/// CourtListener's ids for a record: its cluster, docket and opinions.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct SourceIds {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cluster: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub docket: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub opinions: Vec<u64>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Citation {
    #[serde(rename = "type")]
    pub cite_type: String,
    pub cite: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Court {
    pub name: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Jurisdiction {
    pub name_long: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct CaseBody {
    pub opinions: Vec<Opinion>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Opinion {
    pub text: String,
    #[serde(rename = "type")]
    pub opinion_type: String,
    #[serde(default)]
    pub author: Option<String>,
}

/// Metadata for a case within a volume (from CasesMetadata.json in the zip).
#[derive(Debug, Deserialize, Serialize)]
pub struct CaseMetaEntry {
    pub id: u64,
    pub name_abbreviation: String,
    pub decision_date: String,
    pub first_page: String,
    pub last_page: String,
    pub file_name: String,
    #[serde(default)]
    pub first_page_order: Option<u32>,
    #[serde(default)]
    pub last_page_order: Option<u32>,
    #[serde(default)]
    pub citations: Vec<Citation>,
}

/// Extract and parse CasesMetadata.json from a zip.
pub fn extract_cases_metadata(zip_bytes: &[u8]) -> Result<Vec<CaseMetaEntry>> {
    let json_str = extract_file_from_zip(zip_bytes, "metadata/CasesMetadata.json")?;
    let entries: Vec<CaseMetaEntry> =
        serde_json::from_str(&json_str).context("failed to parse CasesMetadata.json")?;
    Ok(entries)
}

/// Get the page order range for a specific case file within a volume.
/// Returns (first_page_order, last_page_order) if available.
pub fn get_page_orders(zip_bytes: &[u8], case_file: &str) -> Result<Option<(u32, u32)>> {
    let metadata = extract_cases_metadata(zip_bytes)?;
    let entry = metadata.iter().find(|e| e.file_name == case_file);
    match entry {
        Some(e) => match (e.first_page_order, e.last_page_order) {
            (Some(first), Some(last)) => Ok(Some((first, last))),
            _ => Ok(None),
        },
        None => Ok(None),
    }
}

/// Extract a raw file from a zip by path. Returns the file contents as a string.
pub fn extract_file_from_zip(zip_bytes: &[u8], path: &str) -> Result<String> {
    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(cursor)?;
    let mut file = archive
        .by_name(path)
        .with_context(|| format!("{} not found in zip", path))?;
    let mut contents = String::new();
    file.read_to_string(&mut contents)?;
    Ok(contents)
}

/// Extract a case JSON from a zip file's bytes by case filename (e.g. "0647-01").
pub fn extract_from_zip(zip_bytes: &[u8], case_file: &str) -> Result<CaseJson> {
    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(cursor)?;

    let json_path = format!("json/{}.json", case_file);
    let mut file = archive
        .by_name(&json_path)
        .with_context(|| format!("case file {} not found in zip", case_file))?;

    let mut contents = String::new();
    file.read_to_string(&mut contents)?;
    let case: CaseJson = serde_json::from_str(&contents)
        .with_context(|| format!("failed to parse JSON for case {}", case_file))?;
    Ok(case)
}

/// List all case filenames in a zip (e.g. ["0647-01", "0649-01", ...]).
pub fn list_cases_in_zip(zip_bytes: &[u8]) -> Result<Vec<String>> {
    let cursor = std::io::Cursor::new(zip_bytes);
    let archive = zip::ZipArchive::new(cursor)?;
    let mut cases = Vec::new();
    for i in 0..archive.len() {
        let name = archive.name_for_index(i).context("invalid zip entry")?;
        if let Some(rest) = name.strip_prefix("json/") {
            if let Some(case_file) = rest.strip_suffix(".json") {
                if !case_file.is_empty() {
                    cases.push(case_file.to_string());
                }
            }
        }
    }
    if cases.is_empty() {
        bail!("no case JSON files found in zip");
    }
    Ok(cases)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_case_from_zip_bytes() {
        let zip_bytes = std::fs::read("tests/fixtures/a2d-31.zip")
            .expect("test fixture a2d-31.zip missing — run: wget -O tests/fixtures/a2d-31.zip https://static.case.law/a2d/31.zip");

        let case =
            extract_from_zip(&zip_bytes, "0647-01").expect("should extract case 0647-01 from zip");

        assert_eq!(case.name_abbreviation, "D'Elia & Marks Co. v. Lyon");
        assert_eq!(case.decision_date, "1943-05-11");
        assert_eq!(case.citations[0].cite, "31 A.2d 647");
        assert!(!case.casebody.opinions.is_empty());
        assert!(case.casebody.opinions[0].text.len() > 100);
    }

    #[test]
    fn cap_case_json_parses_unchanged_and_reads_as_cap() {
        let zip_bytes = std::fs::read("tests/fixtures/a2d-31.zip").unwrap();
        let raw = extract_file_from_zip(&zip_bytes, "json/0647-01.json").unwrap();
        let original: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(original.get("source").is_none());

        let case = CaseJson::parse(raw.as_bytes()).unwrap();
        assert_eq!(case.source, None);
        assert_eq!(case.source_name(), "cap");
        // Serialized again, a CAP case has no `source` key either.
        let again = serde_json::to_value(&case).unwrap();
        assert!(again.get("source").is_none());
        assert_eq!(again["name_abbreviation"], original["name_abbreviation"]);
    }

    #[test]
    fn courtlistener_record_parses_with_its_source() {
        let case = CaseJson::parse(include_bytes!("../tests/fixtures/cl-record.json")).unwrap();
        assert_eq!(case.source_name(), "courtlistener");
        let source = case.source.as_ref().unwrap();
        assert_eq!(source.export.as_deref(), Some("2026-09-30"));
        assert_eq!(source.docket_number.as_deref(), Some("J-12-2021"));
        let ids = source.ids.as_ref().unwrap();
        assert_eq!(ids.cluster, Some(9876543));
        assert_eq!(ids.opinions, [11111, 11112]);
        assert_eq!(case.citations[0].cite, "250 A.3d 100");
        assert_eq!(case.casebody.opinions.len(), 2);
        // The Public Domain Mark, crediting CourtListener and the export (D65).
        assert_eq!(
            case.license,
            Some(crate::license::PUBLIC_DOMAIN_MARK.into())
        );
        let credit = case.attribution.as_ref().unwrap();
        assert_eq!(credit.name, crate::license::COURTLISTENER.name);
        assert_eq!(credit.publisher.as_deref(), Some("Free Law Project"));
        assert_eq!(
            credit.url.as_deref(),
            Some("https://www.courtlistener.com/")
        );
        assert_eq!(credit.export, source.export);
        let again = serde_json::to_value(&case).unwrap();
        assert_eq!(again["license"]["id"], "CC-PDM-1.0");
        assert_eq!(again["attribution"]["export"], "2026-09-30");

        // Only `name` is required in `source`.
        let bare = br#"{"id": 1, "name": "A v. B", "name_abbreviation": "A v. B",
            "decision_date": "2021-01-01", "citations": [], "court": {"name": "C"},
            "jurisdiction": {"name_long": "J"}, "casebody": {"opinions": []},
            "source": {"name": "courtlistener"}}"#;
        let case = CaseJson::parse(bare).unwrap();
        assert_eq!(
            case.source.unwrap(),
            Source {
                name: "courtlistener".into(),
                ..Default::default()
            }
        );
    }

    #[test]
    fn text_field_reads_a_string_or_a_list_and_writes_it_back_the_same() {
        let case = CaseJson::parse(include_bytes!("../tests/fixtures/cl-record.json")).unwrap();
        let source = case.source.as_ref().unwrap();
        assert_eq!(
            source.text_field,
            Some(TextField::One("html_with_citations".into()))
        );
        let again = serde_json::to_value(&case).unwrap();
        assert_eq!(again["source"]["text_field"], "html_with_citations");

        let case =
            CaseJson::parse(include_bytes!("../tests/fixtures/cl-record-blocked.json")).unwrap();
        let source = case.source.as_ref().unwrap();
        assert_eq!(
            source.text_field,
            Some(TextField::PerOpinion(vec![
                "html_with_citations".into(),
                "plain_text".into()
            ]))
        );
        let again = serde_json::to_value(&case).unwrap();
        assert_eq!(
            again["source"]["text_field"],
            serde_json::json!(["html_with_citations", "plain_text"])
        );
    }

    #[test]
    fn cl_blocked_reads_the_record_block_and_says_why_as_an_inference() {
        let case = CaseJson::parse(include_bytes!("../tests/fixtures/cl-record.json")).unwrap();
        assert_eq!(case.source.unwrap().cl_blocked, None);

        let raw = include_bytes!("../tests/fixtures/cl-record-blocked.json");
        let case = CaseJson::parse(raw).unwrap();
        let blocked = case.source.as_ref().unwrap().cl_blocked.clone().unwrap();
        assert!(blocked.blocked);
        assert!(!blocked.docket_blocked);
        assert_eq!(blocked.date_blocked.as_deref(), Some("2021-04-23"));
        assert_eq!(blocked.reasons, ["id-number", "unpublished-30y"]);
        assert_eq!(
            blocked.reason_basis.as_deref(),
            Some("inferred from CourtListener's published blocking rules")
        );
        assert!(blocked.unverifiable.is_empty());
        assert_eq!(
            blocked.notice(),
            "CourtListener excludes this case from search engines. \
             (inferred: a redacted ID number in the text; unpublished within 30 years)"
        );
        // The block serializes as it was read.
        let original: serde_json::Value = serde_json::from_slice(raw).unwrap();
        let again = serde_json::to_value(&case).unwrap();
        assert_eq!(
            again["source"]["cl_blocked"],
            original["source"]["cl_blocked"]
        );

        let docket: ClBlocked = serde_json::from_str(
            r#"{"blocked": false, "date_blocked": null, "docket_blocked": true,
                "reasons": ["bankruptcy-docket", "keyword:minor+child", "keyword:asylum"],
                "reason_basis": "inferred from CourtListener's published blocking rules",
                "unverifiable": {"bankruptcy-docket": "no docket entries"}}"#,
        )
        .unwrap();
        assert_eq!(docket.date_blocked, None);
        assert_eq!(
            docket.notice(),
            "CourtListener excludes this case from search engines. (inferred: a bankruptcy \
             docket, unverified; mentions \"minor\" and \"child\" within 30 years; mentions \"asylum\" within 30 years)"
        );
        let unknown = ClBlocked {
            blocked: true,
            reasons: vec!["unknown".into()],
            ..Default::default()
        };
        assert_eq!(
            unknown.notice(),
            "CourtListener excludes this case from search engines. (reason unknown)"
        );
        assert_eq!(reason_phrase("new-rule"), "new-rule");
    }

    #[test]
    fn extract_nonexistent_case_returns_error() {
        let zip_bytes =
            std::fs::read("tests/fixtures/a2d-31.zip").expect("test fixture a2d-31.zip missing");

        let result = extract_from_zip(&zip_bytes, "9999-99");
        assert!(result.is_err());
    }

    #[test]
    fn list_cases_from_zip() {
        let zip_bytes =
            std::fs::read("tests/fixtures/a2d-31.zip").expect("test fixture a2d-31.zip missing");

        let cases = list_cases_in_zip(&zip_bytes).expect("should list cases");

        // a2d/31 has ~20 cases
        assert!(cases.len() > 10);
        assert!(cases.contains(&"0647-01".to_string()));
    }
}
