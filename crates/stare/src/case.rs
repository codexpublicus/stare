//! Case data extracted from Harvard CAP zip files.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
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
    /// Which CourtListener opinion field the text came from (`html_with_citations`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_field: Option<String>,
    /// The case's page on the source's own site.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
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
