/// Case data extracted from Harvard CAP zip files.

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

        let case = extract_from_zip(&zip_bytes, "0647-01")
            .expect("should extract case 0647-01 from zip");

        assert_eq!(case.name_abbreviation, "D'Elia & Marks Co. v. Lyon");
        assert_eq!(case.decision_date, "1943-05-11");
        assert_eq!(case.citations[0].cite, "31 A.2d 647");
        assert!(!case.casebody.opinions.is_empty());
        assert!(case.casebody.opinions[0].text.len() > 100);
    }

    #[test]
    fn extract_nonexistent_case_returns_error() {
        let zip_bytes = std::fs::read("tests/fixtures/a2d-31.zip")
            .expect("test fixture a2d-31.zip missing");

        let result = extract_from_zip(&zip_bytes, "9999-99");
        assert!(result.is_err());
    }

    #[test]
    fn list_cases_from_zip() {
        let zip_bytes = std::fs::read("tests/fixtures/a2d-31.zip")
            .expect("test fixture a2d-31.zip missing");

        let cases = list_cases_in_zip(&zip_bytes)
            .expect("should list cases");

        // a2d/31 has ~20 cases
        assert!(cases.len() > 10);
        assert!(cases.contains(&"0647-01".to_string()));
    }
}
