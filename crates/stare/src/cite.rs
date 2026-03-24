/// Citation detection and resolution using citare-core.
///
/// Wraps citare's get_citations to produce structured results
/// with Harvard CAP slugs for direct index resolution.

use serde::{Deserialize, Serialize};

/// A detected citation with enough info to resolve via stare.
#[derive(Debug, Serialize, Deserialize)]
pub struct DetectedCitation {
    /// The raw matched text (e.g., "31 A.2d 647")
    pub matched_text: String,
    /// Citation type: "FullCase", "ShortCase", "FullLaw", "Id", "Supra", etc.
    pub citation_type: String,
    /// Character span in the source text
    pub span: (usize, usize),
    /// Harvard CAP slug if available (e.g., "a2d")
    pub harvard_slug: Option<String>,
    /// Volume number from the citation groups
    pub volume: Option<String>,
    /// Page number from the citation groups
    pub page: Option<String>,
    /// Reporter abbreviation from the citation groups
    pub reporter: Option<String>,
    /// Year if detected
    pub year: Option<i32>,
}

/// Detect all citations in a text using citare-core.
pub fn detect_citations(text: &str) -> Vec<DetectedCitation> {
    let citations = citare_core::get_citations(text, false, "", &[]);

    citations
        .iter()
        .map(|c| {
            let (start, end) = c.span();
            let groups = &c.common().groups;

            let harvard_slug = c
                .resource_common()
                .and_then(|r| r.edition_guess.as_ref())
                .and_then(|e| e.harvard_slug.clone())
                .or_else(|| {
                    c.resource_common()
                        .and_then(|r| r.all_editions.first())
                        .and_then(|e| e.harvard_slug.clone())
                });

            DetectedCitation {
                matched_text: c.matched_text().to_string(),
                citation_type: c.type_name().to_string(),
                span: (start, end),
                harvard_slug,
                volume: groups.get("volume").cloned().flatten(),
                page: groups.get("page").cloned().flatten(),
                reporter: groups.get("reporter").cloned().flatten(),
                year: c.resource_common().and_then(|r| r.year),
            }
        })
        .collect()
}

/// Filter to only citations that have a Harvard slug (resolvable via our index).
pub fn resolvable_citations(citations: &[DetectedCitation]) -> Vec<&DetectedCitation> {
    citations
        .iter()
        .filter(|c| c.harvard_slug.is_some() && c.volume.is_some() && c.page.is_some())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_case_citation() {
        let cites = detect_citations("See D'Elia & Marks Co. v. Lyon, 31 A.2d 647 (1943).");
        assert!(!cites.is_empty(), "should detect at least one citation");
        let c = cites.iter().find(|c| c.matched_text.contains("A.2d")).expect("should find A.2d citation");
        assert_eq!(c.harvard_slug.as_deref(), Some("a2d"));
        assert_eq!(c.volume.as_deref(), Some("31"));
        assert_eq!(c.page.as_deref(), Some("647"));
    }

    #[test]
    fn detect_us_citation() {
        let cites = detect_citations("Roe v. Wade, 410 U.S. 113 (1973).");
        assert!(!cites.is_empty(), "should detect at least one citation");
        for c in &cites {
            eprintln!("  type={} text={:?} slug={:?} vol={:?} page={:?}", c.citation_type, c.matched_text, c.harvard_slug, c.volume, c.page);
        }
        let c = cites.iter().find(|c| c.matched_text.contains("U.S.")).expect("should find U.S. citation");
        assert_eq!(c.harvard_slug.as_deref(), Some("us"));
        assert_eq!(c.volume.as_deref(), Some("410"));
        assert_eq!(c.page.as_deref(), Some("113"));
    }

    #[test]
    fn no_slug_for_unknown_reporter() {
        let cites = detect_citations("Some text with no citations.");
        assert!(cites.is_empty());
    }

    #[test]
    fn resolvable_filters_correctly() {
        let cites = detect_citations("See 31 A.2d 647 and Id. at 5.");
        let resolvable = resolvable_citations(&cites);
        // FullCase should be resolvable, Id should not (no slug/volume/page)
        assert!(resolvable.iter().any(|c| c.matched_text == "31 A.2d 647"));
        assert!(!resolvable.iter().any(|c| c.citation_type == "Id"));
    }
}
