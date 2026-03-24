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
    /// Citation type: "FullCaseCitation", "FullLawCitation", "IdCitation", etc.
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
    /// External URL for statutes/regulations (Cornell, govinfo, ecfr)
    pub external_url: Option<String>,
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

            let mut det = DetectedCitation {
                matched_text: c.matched_text().to_string(),
                citation_type: c.type_name().to_string(),
                span: (start, end),
                harvard_slug,
                volume: groups.get("volume").cloned().flatten(),
                page: groups.get("page").cloned().flatten(),
                reporter: groups.get("reporter").cloned().flatten(),
                year: c.resource_common().and_then(|r| r.year),
                external_url: None,
            };
            // Generate external URL for statutes/regulations
            if det.harvard_slug.is_none() {
                det.external_url = external_url(&det);
            }
            det
        })
        .collect()
}

/// Generate an external URL for a statute/regulation citation.
/// Returns None for case citations (which we resolve ourselves).
pub fn external_url(citation: &DetectedCitation) -> Option<String> {
    let text = &citation.matched_text;

    // U.S. Code: "42 U.S.C. § 1983"
    if let Some(caps) = regex::Regex::new(r"(\d+)\s+U\.?S\.?C\.?\s*(?:§+\s*)?(\d[\d.a-z-]*)")
        .ok()
        .and_then(|re| re.captures(text))
    {
        let title = caps.get(1)?.as_str();
        let section = caps.get(2)?.as_str();
        return Some(format!("https://www.law.cornell.edu/uscode/text/{}/{}", title, section));
    }

    // Statutes at Large: "56 Stat. 195"
    if let Some(caps) = regex::Regex::new(r"(\d+)\s+Stat\.\s+(\d+)")
        .ok()
        .and_then(|re| re.captures(text))
    {
        let vol = caps.get(1)?.as_str();
        let page = caps.get(2)?.as_str();
        return Some(format!("https://www.govinfo.gov/content/pkg/STATUTE-{}/pdf/STATUTE-{}-Pg{}.pdf", vol, vol, page));
    }

    // CFR: "40 C.F.R. § 122.1"
    if let Some(caps) = regex::Regex::new(r"(\d+)\s+C\.?F\.?R\.?\s*(?:§+\s*)?(\d[\d.]*)")
        .ok()
        .and_then(|re| re.captures(text))
    {
        let title = caps.get(1)?.as_str();
        let section = caps.get(2)?.as_str();
        return Some(format!("https://www.ecfr.gov/current/title-{}/section-{}", title, section));
    }

    None
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
    fn statute_gets_external_url() {
        let cites = detect_citations("See 42 U.S.C. § 1983 and 56 Stat. 195.");
        let usc = cites.iter().find(|c| c.matched_text.contains("U.S.C."));
        let stat = cites.iter().find(|c| c.matched_text.contains("Stat."));

        if let Some(c) = usc {
            assert!(c.external_url.is_some(), "USC should have external URL");
            assert!(c.external_url.as_ref().unwrap().contains("cornell.edu"));
        }
        if let Some(c) = stat {
            assert!(c.external_url.is_some(), "Stat should have external URL");
            assert!(c.external_url.as_ref().unwrap().contains("govinfo.gov"));
        }
    }

    #[test]
    fn case_citation_no_external_url() {
        let cites = detect_citations("See 31 A.2d 647.");
        let c = cites.iter().find(|c| c.matched_text.contains("A.2d")).unwrap();
        assert!(c.external_url.is_none(), "Case citations shouldn't have external URL");
        assert!(c.harvard_slug.is_some());
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
