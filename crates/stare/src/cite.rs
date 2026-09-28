//! Citation detection and resolution using citare-core.
//!
//! Wraps citare's get_citations to produce structured results
//! with Harvard CAP slugs for direct index resolution.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;

/// A detected citation with enough info to resolve via stare.
#[derive(Debug, Serialize, Deserialize)]
pub struct DetectedCitation {
    /// The raw matched text (e.g., "31 A.2d 647")
    pub matched_text: String,
    /// Citation type: "FullCaseCitation", "FullLawCitation", "IdCitation", etc.
    pub citation_type: String,
    /// Byte span (UTF-8) in the source text, as returned by citare_core.
    /// This is Rust's native string-indexing unit; it is neither Unicode
    /// scalar values (code points) nor UTF-16 code units. Callers that hand
    /// spans to JavaScript or to the gorsuch-library page viewer must convert
    /// first; see `spans_to_char_offsets` below, which stare-wasm applies at
    /// the WASM boundary.
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
        return Some(format!(
            "https://www.law.cornell.edu/uscode/text/{}/{}",
            title, section
        ));
    }

    // Statutes at Large: "56 Stat. 195"
    if let Some(caps) = regex::Regex::new(r"(\d+)\s+Stat\.\s+(\d+)")
        .ok()
        .and_then(|re| re.captures(text))
    {
        let vol = caps.get(1)?.as_str();
        let page = caps.get(2)?.as_str();
        return Some(format!(
            "https://www.govinfo.gov/content/pkg/STATUTE-{}/pdf/STATUTE-{}-Pg{}.pdf",
            vol, vol, page
        ));
    }

    // CFR: "40 C.F.R. § 122.1"
    if let Some(caps) = regex::Regex::new(r"(\d+)\s+C\.?F\.?R\.?\s*(?:§+\s*)?(\d[\d.]*)")
        .ok()
        .and_then(|re| re.captures(text))
    {
        let title = caps.get(1)?.as_str();
        let section = caps.get(2)?.as_str();
        return Some(format!(
            "https://www.ecfr.gov/current/title-{}/section-{}",
            title, section
        ));
    }

    None
}

/// A citation span's byte offset did not fall on a Unicode char boundary in
/// the text it was supposedly detected from.
///
/// This should never happen: citation spans come from regex matches over
/// `text`, and a regex match never splits a codepoint. If it does happen,
/// something upstream is broken (citare_core, or a caller passing spans
/// alongside the wrong text), and silently returning the raw byte offset as
/// though it were a char offset would reintroduce the exact bug
/// `spans_to_char_offsets` exists to fix, just one level down.
#[derive(Debug, PartialEq, Eq)]
pub struct SpanBoundaryError {
    /// The byte offset that did not land on a char boundary.
    pub byte_offset: usize,
}

impl fmt::Display for SpanBoundaryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "byte offset {} is not on a char boundary",
            self.byte_offset
        )
    }
}

impl std::error::Error for SpanBoundaryError {}

/// Convert `DetectedCitation::span` from UTF-8 byte offsets to Unicode scalar
/// value (char) offsets into `text`, in place.
///
/// citare_core's `Citation::span()` returns byte offsets, Rust's native
/// string-indexing unit. Neither JavaScript (which indexes strings by UTF-16
/// code unit) nor gorsuch-library's shared page viewer (which defines offsets
/// as Unicode code points and converts to UTF-16 only where it touches the
/// DOM) can use bytes directly. This is the boundary conversion: stare-wasm
/// calls it before serializing citations for JS, so `span` means one thing
/// (bytes) everywhere inside Rust and another (chars) only once it crosses
/// into JS, matching the page viewer's convention.
///
/// Returns `Err(SpanBoundaryError)` on the first span endpoint that doesn't
/// land on a char boundary in `text`, instead of silently passing the byte
/// offset through mislabeled as a char offset. `citations` is left partially
/// converted if this happens; callers that hit this error have a bug
/// upstream to fix, not a value to recover from.
pub fn spans_to_char_offsets(
    text: &str,
    citations: &mut [DetectedCitation],
) -> Result<(), SpanBoundaryError> {
    // Map every char boundary's byte offset to its Unicode scalar value
    // index. Citation spans always fall on char boundaries (they come from
    // regex matches over `text`), so every valid span endpoint is a key
    // here; anything else is the invariant violation this function guards.
    let mut char_at_byte: HashMap<usize, usize> = HashMap::new();
    let mut count = 0usize;
    for (byte_offset, _) in text.char_indices() {
        char_at_byte.insert(byte_offset, count);
        count += 1;
    }
    char_at_byte.insert(text.len(), count);

    for c in citations.iter_mut() {
        let (start, end) = c.span;
        let start_char = *char_at_byte
            .get(&start)
            .ok_or(SpanBoundaryError { byte_offset: start })?;
        let end_char = *char_at_byte
            .get(&end)
            .ok_or(SpanBoundaryError { byte_offset: end })?;
        c.span = (start_char, end_char);
    }
    Ok(())
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
        let c = cites
            .iter()
            .find(|c| c.matched_text.contains("A.2d"))
            .expect("should find A.2d citation");
        assert_eq!(c.harvard_slug.as_deref(), Some("a2d"));
        assert_eq!(c.volume.as_deref(), Some("31"));
        assert_eq!(c.page.as_deref(), Some("647"));
    }

    #[test]
    fn detect_us_citation() {
        let cites = detect_citations("Roe v. Wade, 410 U.S. 113 (1973).");
        assert!(!cites.is_empty(), "should detect at least one citation");
        for c in &cites {
            eprintln!(
                "  type={} text={:?} slug={:?} vol={:?} page={:?}",
                c.citation_type, c.matched_text, c.harvard_slug, c.volume, c.page
            );
        }
        let c = cites
            .iter()
            .find(|c| c.matched_text.contains("U.S."))
            .expect("should find U.S. citation");
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
        let c = cites
            .iter()
            .find(|c| c.matched_text.contains("A.2d"))
            .unwrap();
        assert!(
            c.external_url.is_none(),
            "Case citations shouldn't have external URL"
        );
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

    /// citare_core's span() is a UTF-8 byte span. Non-ASCII text before a
    /// citation (section sign, curly quotes, an accented name, an emoji)
    /// pushes the byte offset well past the Unicode scalar value (char)
    /// offset gorsuch-library's page viewer expects. spans_to_char_offsets
    /// is the boundary conversion; this asserts it slices the original
    /// text correctly when indexed by chars, not bytes.
    #[test]
    fn spans_to_char_offsets_slices_text_with_multibyte_prefix() {
        let text =
            "See \u{a7} 123, \u{201c}curly\u{201d} by Fran\u{e7}ois \u{1f44d}, 31 A.2d 647 (1943).";
        let mut cites = detect_citations(text);
        let cite = cites
            .iter_mut()
            .find(|c| c.matched_text.contains("A.2d"))
            .expect("should detect A.2d citation");

        let byte_start = cite.span.0;

        spans_to_char_offsets(text, std::slice::from_mut(cite))
            .expect("all spans in this text land on char boundaries");
        let (start, end) = cite.span;

        // The multibyte prefix (section sign, curly quotes, accented e, a
        // four-byte emoji) makes the byte offset strictly greater than the
        // char offset; if this fails, nothing was converted.
        assert!(
            start < byte_start,
            "char offset ({start}) should be less than byte offset ({byte_start}) given the multibyte prefix"
        );

        // The real assertion: char offsets must slice the original text
        // (indexed by Unicode scalar value, the unit gorsuch-library uses)
        // back to the exact matched text.
        let chars: Vec<char> = text.chars().collect();
        let sliced: String = chars[start..end].iter().collect();
        assert_eq!(sliced, cite.matched_text);
    }

    /// A byte offset that lands mid-character should never occur in
    /// practice (citation spans come from regex matches, which never split
    /// a codepoint), but if it does, spans_to_char_offsets must not
    /// silently hand back the raw byte value relabeled as a char offset.
    /// That's the same bug this function exists to fix, just moved one
    /// level down. It must be reported as an error instead.
    #[test]
    fn spans_to_char_offsets_rejects_non_boundary_span() {
        let text = "caf\u{e9}"; // 'é' is bytes 3..5; byte 4 is mid-character
        let mut citations = vec![DetectedCitation {
            matched_text: "?".to_string(),
            citation_type: "Test".to_string(),
            span: (4, 5),
            harvard_slug: None,
            volume: None,
            page: None,
            reporter: None,
            year: None,
            external_url: None,
        }];

        let result = spans_to_char_offsets(text, &mut citations);
        assert!(
            result.is_err(),
            "a span starting mid-character must be rejected, not passed through as if 4 were a valid char offset"
        );
    }
}
