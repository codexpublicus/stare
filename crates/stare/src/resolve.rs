/// Core resolve: (reporter_slug, volume, page) → CaseResult
///
/// Works against a local filesystem path or remote URL.

use crate::case::{self, CaseJson};
use crate::index;
use anyhow::{bail, Context, Result};

pub struct CaseResult {
    pub case_file: String,
    pub case: CaseJson,
}

/// Resolve a citation from local files.
///
/// Expects:
///   {base_path}/{reporter}/{volume}.bin  (citation index)
///   {base_path}/{reporter}/{volume}.zip  (case data)
pub fn resolve_local(
    base_path: &std::path::Path,
    reporter: &str,
    volume: u32,
    page: u32,
) -> Result<CaseResult> {
    let bin_path = base_path.join(reporter).join(format!("{}.bin", volume));
    let bin_data = std::fs::read(&bin_path)
        .with_context(|| format!("failed to read index: {}", bin_path.display()))?;

    let case_file = index::lookup(&bin_data, page as usize)
        .with_context(|| format!("no case at page {} in {}/{}", page, reporter, volume))?;

    let zip_path = base_path.join(reporter).join(format!("{}.zip", volume));
    let zip_data = std::fs::read(&zip_path)
        .with_context(|| format!("failed to read zip: {}", zip_path.display()))?;

    let case = case::extract_from_zip(&zip_data, case_file)
        .with_context(|| format!("failed to extract case {} from zip", case_file))?;

    Ok(CaseResult {
        case_file: case_file.to_string(),
        case,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index;
    use std::io::Write;

    /// Build a test directory with .bin + .zip for a2d/31
    fn setup_test_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let reporter_dir = dir.path().join("a2d");
        std::fs::create_dir_all(&reporter_dir).unwrap();

        // Build .bin index from the actual zip's CasesMetadata
        let zip_bytes = std::fs::read("tests/fixtures/a2d-31.zip")
            .expect("test fixture missing");
        let cases = case::list_cases_in_zip(&zip_bytes).unwrap();
        let case_pages: Vec<(&str, usize)> = cases
            .iter()
            .map(|c| {
                let page: usize = c.split('-').next().unwrap().parse().unwrap();
                (c.as_str(), page)
            })
            .collect();
        let bin_data = index::build(&case_pages);
        let bin_path = reporter_dir.join("31.bin");
        std::fs::File::create(&bin_path)
            .unwrap()
            .write_all(&bin_data)
            .unwrap();

        // Copy the zip
        std::fs::copy("tests/fixtures/a2d-31.zip", reporter_dir.join("31.zip")).unwrap();

        dir
    }

    #[test]
    fn resolve_known_case() {
        let dir = setup_test_dir();
        let result = resolve_local(dir.path(), "a2d", 31, 647).unwrap();

        assert_eq!(result.case_file, "0647-01");
        assert_eq!(result.case.name_abbreviation, "D'Elia & Marks Co. v. Lyon");
        assert_eq!(result.case.decision_date, "1943-05-11");
        assert_eq!(result.case.citations[0].cite, "31 A.2d 647");
    }

    #[test]
    fn resolve_empty_page_returns_error() {
        let dir = setup_test_dir();
        // Page 648 has no case starting there (case 0647-01 spans pages 647-649)
        let result = resolve_local(dir.path(), "a2d", 31, 648);
        assert!(result.is_err());
    }

    #[test]
    fn resolve_nonexistent_reporter_returns_error() {
        let dir = setup_test_dir();
        let result = resolve_local(dir.path(), "fake", 31, 647);
        assert!(result.is_err());
    }
}
