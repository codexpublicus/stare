//! Citation detection and resolution using citare-core.
//!
//! Wraps citare's get_citations to produce structured results
//! with Harvard CAP slugs for direct index resolution, and its
//! resolve_citations to tie each short form to the full citation it
//! refers to.

use std::collections::HashMap;

use citare_core::Citation;
use serde::{Deserialize, Serialize};

/// The citation types that refer back to an earlier full citation instead
/// of naming a case themselves: `997 P.2d at 1023`, `Id. at 5`,
/// `Martel, supra, 275 Conn. at 46`. Their own page is a pin page, never a
/// first page, so they are looked up only through their antecedent.
pub const SHORT_FORM_TYPES: [&str; 4] = [
    "ShortCaseCitation",
    "IdCitation",
    "SupraCitation",
    "ReferenceCitation",
];

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
    /// First page from the citation groups. `None` for a blank page
    /// (`1 U.S. ___`), which can't be looked up, and for a short form,
    /// whose page is a pin page (see `pin`).
    pub page: Option<String>,
    /// Reporter abbreviation from the citation groups
    pub reporter: Option<String>,
    /// Year if detected
    pub year: Option<i32>,
    /// External URL for statutes/regulations (Cornell, govinfo, eCFR and
    /// the state legislatures listed in `external_url`)
    pub external_url: Option<String>,
    /// Places to look for a full case citation stare.pub may not hold
    /// (CourtListener's citation lookup, then a Google Scholar search).
    /// Filled for every full case citation with a volume, reporter and
    /// page, because only the caller knows whether the index has the
    /// case; callers show these only when it doesn't. Empty otherwise.
    #[serde(default)]
    pub case_links: Vec<CaseLink>,
    /// The pin cite as written, without a leading "at" or comma: `1023`
    /// for `997 P.2d at 1023`, `5` for `Id. at 5`, `46 n.3`. `None` when
    /// the citation has none.
    #[serde(default)]
    pub pin: Option<String>,
    /// For a short form (see `SHORT_FORM_TYPES`), the full citation
    /// citare's `resolve_citations` ties it to. A short form is looked up
    /// through this, never through its own pin page; `None` means citare
    /// couldn't tell which earlier citation it refers to, and then it
    /// isn't looked up at all. Always `None` for a full citation.
    #[serde(default)]
    pub antecedent: Option<Antecedent>,
}

/// The full citation a short form refers to: what a reader looks up to
/// follow the short form. The same fields as the full citation's own
/// `DetectedCitation`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Antecedent {
    pub matched_text: String,
    pub citation_type: String,
    /// Same unit as `DetectedCitation::span`: bytes in Rust, chars once
    /// `spans_to_char_offsets` has run.
    pub span: (usize, usize),
    pub harvard_slug: Option<String>,
    pub volume: Option<String>,
    pub page: Option<String>,
    pub reporter: Option<String>,
    pub year: Option<i32>,
    pub external_url: Option<String>,
    #[serde(default)]
    pub case_links: Vec<CaseLink>,
}

impl DetectedCitation {
    /// Whether this is a short form, which refers to an earlier citation.
    pub fn is_short_form(&self) -> bool {
        SHORT_FORM_TYPES.contains(&self.citation_type.as_str())
    }

    fn as_antecedent(&self) -> Antecedent {
        Antecedent {
            matched_text: self.matched_text.clone(),
            citation_type: self.citation_type.clone(),
            span: self.span,
            harvard_slug: self.harvard_slug.clone(),
            volume: self.volume.clone(),
            page: self.page.clone(),
            reporter: self.reporter.clone(),
            year: self.year,
            external_url: self.external_url.clone(),
            case_links: self.case_links.clone(),
        }
    }
}

/// A citation's pin cite as citare found it, if it has one.
fn pin_cite(c: &Citation) -> Option<&str> {
    match c {
        Citation::FullCase(d) => d.metadata.case.pin_cite.as_deref(),
        Citation::ShortCase(d) => d.metadata.case.pin_cite.as_deref(),
        Citation::FullLaw(d) => d.metadata.pin_cite.as_deref(),
        Citation::FullJournal(d) => d.metadata.pin_cite.as_deref(),
        Citation::Supra(d) => d.metadata.pin_cite.as_deref(),
        Citation::Id(d) => d.metadata.pin_cite.as_deref(),
        Citation::Reference(d) => d.metadata.pin_cite.as_deref(),
        Citation::Unknown(_) => None,
    }
}

/// `at 1023`, `, 1023` and ` 1023` all become `1023`.
fn normalize_pin(pin: &str) -> Option<String> {
    let p = pin.trim_start_matches([',', ' ']);
    let p = p.strip_prefix("at ").unwrap_or(p);
    let p = p.trim().trim_end_matches([',', '.', ';']).trim();
    (!p.is_empty()).then(|| p.to_string())
}

/// A link to a source outside stare.pub for a case citation (#7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaseLink {
    /// Where the link goes: "courtlistener" or "google_scholar".
    pub source: String,
    /// What the reader gets there: "full_text" (a citation lookup that
    /// lands on the opinion, or a list when the citation is ambiguous) or
    /// "search" (a search results page).
    pub kind: String,
    pub url: String,
}

/// Detect all citations in a text using citare-core.
pub fn detect_citations(text: &str) -> Vec<DetectedCitation> {
    let citations = citare_core::get_citations(text, false, "", &[]);

    let mut detected: Vec<DetectedCitation> = citations
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
                case_links: Vec::new(),
                pin: pin_cite(c).and_then(normalize_pin),
                antecedent: None,
            };
            // A short form's page is its pin page, not where a case starts.
            // citare doesn't always report it as the pin cite too
            // (`TC, ¶ 10, 431 P.3d at 565`).
            if det.is_short_form() {
                if det.pin.is_none() {
                    det.pin = det.page.take();
                }
                det.page = None;
            }
            // Generate external URL for statutes/regulations. citare gives
            // some law citations a reporter's slug ("N.Y. Penal Law" gets
            // "ny"), so a law citation is checked whatever its slug.
            if det.citation_type == "FullLawCitation" || det.harvard_slug.is_none() {
                det.external_url = external_url(&det);
            }
            det.case_links = case_links(&det);
            det
        })
        .collect();

    // Tie each short form to its antecedent. citare's resolutions map each
    // resource (keyed by its first full citation) to every citation that
    // refers to it; a citation is identified by its span, which no two
    // citations share.
    let position: HashMap<(usize, usize), usize> = citations
        .iter()
        .enumerate()
        .map(|(i, c)| (c.span(), i))
        .collect();
    let mut antecedent_of: HashMap<usize, usize> = HashMap::new();
    for (resource, cites) in citare_core::resolve_citations(&citations) {
        let Some(&full) = position.get(&resource.citation.span()) else {
            continue;
        };
        for c in &cites {
            if let Some(&i) = position.get(&c.span()) {
                antecedent_of.insert(i, full);
            }
        }
    }
    for i in 0..detected.len() {
        if !detected[i].is_short_form() {
            continue;
        }
        if let Some(&full) = antecedent_of.get(&i) {
            if !detected[full].is_short_form() {
                detected[i].antecedent = Some(detected[full].as_antecedent());
            }
        }
    }
    detected
}

/// Compile a pattern once and keep it for the life of the process.
macro_rules! regex {
    ($re:literal) => {{
        static RE: std::sync::LazyLock<regex::Regex> =
            std::sync::LazyLock::new(|| regex::Regex::new($re).expect("valid regex"));
        &*RE
    }};
}

/// Generate an external URL for a statute/regulation citation.
/// Returns None for case citations (which we resolve ourselves).
///
/// This is the one place statute and regulation URLs are built. Every
/// pattern here is deterministic from the citation alone and was checked
/// against the live site when it was added; a state is listed only when
/// its legislature publishes a URL per section that needs nothing but the
/// section number, and its robots.txt allowed the check:
///
/// - U.S.C. and U.S.C.A.: Cornell LII
/// - Stat., Pub. L. and Fed. Reg.: govinfo's link service, which finds the
///   law or the issue holding any page, not only a first page. Public laws
///   are there from the 104th Congress on.
/// - C.F.R.: eCFR
/// - Arizona, Michigan, Minnesota and Virginia: the legislature's own site
pub fn external_url(citation: &DetectedCitation) -> Option<String> {
    let text = &citation.matched_text;

    // The abbreviations allow whitespace between their letters, since
    // citare finds spaced forms such as "18 U. S. C. § 4241" too.

    // U.S. Code: "42 U.S.C. § 1983", "42 U. S. C. § 1983", "42 U.S.C.A. § 1983"
    if let Some(caps) =
        regex!(r"(\d+)\s+U\.?\s*S\.?\s*C\.?(?:\s*A\.?)?\s*(?:§+\s*)?(\d[\d.a-z-]*)").captures(text)
    {
        return Some(format!(
            "https://www.law.cornell.edu/uscode/text/{}/{}",
            &caps[1], &caps[2]
        ));
    }

    // Statutes at Large: "56 Stat. 195", "124 Stat. 1,025"
    if let Some(caps) = regex!(r"(\d+)\s+Stat\.\s+(\d[\d,]*)").captures(text) {
        return Some(format!(
            "https://www.govinfo.gov/link/statute/{}/{}",
            &caps[1],
            caps[2].replace(',', "")
        ));
    }

    // Public laws: "Pub. L. No. 111-148", "Pub. L. 104-104"
    if let Some(caps) = regex!(r"^Pub\.\s*L\.\s*(?:No\.\s*)?(\d+)-(\d+)").captures(text) {
        let congress: u32 = caps[1].parse().ok()?;
        if congress < 104 {
            return None;
        }
        return Some(format!(
            "https://www.govinfo.gov/link/plaw/{}/public/{}",
            congress, &caps[2]
        ));
    }

    // Federal Register: "85 Fed. Reg. 12345", "85 Fed. Reg. 12,345"
    if let Some(caps) = regex!(r"(\d+)\s+Fed\.\s*Reg\.\s+(\d[\d,]*)").captures(text) {
        return Some(format!(
            "https://www.govinfo.gov/link/fr/{}/{}",
            &caps[1],
            caps[2].replace(',', "")
        ));
    }

    // CFR: "40 C.F.R. § 122.1", "40 C. F. R. § 122.1"
    if let Some(caps) = regex!(r"(\d+)\s+C\.?\s*F\.?\s*R\.?\s*(?:§+\s*)?(\d[\d.]*)").captures(text)
    {
        return Some(format!(
            "https://www.ecfr.gov/current/title-{}/section-{}",
            &caps[1], &caps[2]
        ));
    }

    // State codes. Anchored at the start, so "W. Va. Code" is not Virginia.

    // Arizona: "Ariz. Rev. Stat. Ann. § 13-1105", "... § 13-3601.01". The
    // file name pads the section to five digits.
    if let Some(caps) =
        regex!(r"^Ariz\.\s*Rev\.\s*Stat\.(?:\s*Ann\.)?\s*§*\s*(\d+)-(\d+)(?:\.(\d+))?")
            .captures(text)
    {
        let section: u32 = caps[2].parse().ok()?;
        let sub = caps
            .get(3)
            .map(|m| format!("-{}", m.as_str()))
            .unwrap_or_default();
        return Some(format!(
            "https://www.azleg.gov/viewdocument/?docName=https://www.azleg.gov/ars/{}/{:05}{}.htm",
            &caps[1], section, sub
        ));
    }

    // Michigan: "Mich. Comp. Laws § 750.316", "... Ann. § 600.2912". The
    // site takes lettered sections too (mcl-600-2912a), though citare
    // v0.5.0 still stops "§ 600.2912a" at "600".
    if let Some(caps) =
        regex!(r"^Mich\.\s*Comp\.\s*Laws(?:\s*Ann\.)?\s*§*\s*(\d+)\.(\d+[a-z]*)").captures(text)
    {
        return Some(format!(
            "https://www.legislature.mi.gov/Laws/MCL?objectName=mcl-{}-{}",
            &caps[1], &caps[2]
        ));
    }

    // Minnesota: "Minn. Stat. § 609.185", "Minn. Stat. Ann. § 13D.01"
    if let Some(caps) =
        regex!(r"^Minn\.\s*Stat\.(?:\s*Ann\.)?\s*§*\s*(\d+[A-Z]?\.\d+[A-Za-z]*)").captures(text)
    {
        return Some(format!(
            "https://www.revisor.mn.gov/statutes/cite/{}",
            &caps[1]
        ));
    }

    // Virginia: "Va. Code Ann. § 18.2-32", "... § 8.01-581.15"
    if let Some(caps) =
        regex!(r"^Va\.\s*Code(?:\s*Ann\.)?\s*§*\s*(\d+(?:\.\d+)?-\d+(?:\.\d+)*)").captures(text)
    {
        return Some(format!("https://law.lis.virginia.gov/vacode/{}/", &caps[1]));
    }

    None
}

/// Percent-encode everything but RFC 3986's unreserved characters, for a
/// URL path segment.
fn encode_path_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

/// Encode a query value as a form field: spaces become `+`.
fn encode_query_value(s: &str) -> String {
    s.split(' ')
        .map(encode_path_segment)
        .collect::<Vec<_>>()
        .join("+")
}

/// Links to sources outside stare.pub for a full case citation (#7), in
/// the order to offer them: CourtListener's citation lookup, which needs
/// no account and lands on the opinion, then a Google Scholar case law
/// search for the citation as a phrase. Empty for anything but a full case
/// citation with a volume, reporter and page.
///
/// This is the one place case link-out URLs are built, beside
/// `external_url`, so the website, the CLI and a later MCP server offer
/// the same links.
pub fn case_links(citation: &DetectedCitation) -> Vec<CaseLink> {
    if citation.citation_type != "FullCaseCitation" {
        return Vec::new();
    }
    let (Some(volume), Some(reporter), Some(page)) = (
        citation.volume.as_deref(),
        citation.reporter.as_deref(),
        citation.page.as_deref(),
    ) else {
        return Vec::new();
    };
    let phrase = format!("\"{} {} {}\"", volume, reporter, page);
    vec![
        CaseLink {
            source: "courtlistener".into(),
            kind: "full_text".into(),
            url: format!(
                "https://www.courtlistener.com/c/{}/{}/{}/",
                encode_path_segment(reporter),
                encode_path_segment(volume),
                encode_path_segment(page)
            ),
        },
        CaseLink {
            source: "google_scholar".into(),
            kind: "search".into(),
            url: format!(
                "https://scholar.google.com/scholar?hl=en&as_sdt=2006&q={}",
                encode_query_value(&phrase)
            ),
        },
    ]
}

/// A citation span that could not be converted from UTF-8 byte offsets to
/// Unicode scalar value (char) offsets, because an endpoint fell inside a
/// multi-byte character or past the end of the text.
///
/// This should never happen: citation spans come from regex matches over
/// `text`, and a regex match never splits a codepoint. If it does happen,
/// something upstream is broken (citare_core, or a caller passing spans
/// alongside the wrong text), and silently returning the raw byte offset as
/// though it were a char offset would reintroduce the exact bug
/// `spans_to_char_offsets` exists to fix, just one level down.
pub type SpanOffsetError = citare_core::offsets::OffsetError;

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
/// into JS, matching the page viewer's convention. The conversion itself is
/// citare's `OffsetMap` with `OffsetUnit::Chars`.
///
/// Returns `Err` on the first span endpoint that isn't a char boundary in
/// `text`, instead of silently passing the byte offset through mislabeled as
/// a char offset. `citations` is left partially converted if this happens;
/// callers that hit this error have a bug upstream to fix, not a value to
/// recover from.
pub fn spans_to_char_offsets(
    text: &str,
    citations: &mut [DetectedCitation],
) -> Result<(), SpanOffsetError> {
    use citare_core::offsets::{OffsetMap, OffsetUnit};

    let map = OffsetMap::new(text);
    for c in citations.iter_mut() {
        c.span = map.convert_span(c.span, OffsetUnit::Chars)?;
        if let Some(a) = c.antecedent.as_mut() {
            a.span = map.convert_span(a.span, OffsetUnit::Chars)?;
        }
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

    /// Every statute and regulation pattern `external_url` knows, with the
    /// URL each should build. Each URL's form was checked against the live
    /// site when the pattern was added.
    #[test]
    fn external_url_patterns() {
        let cases = [
            // U.S.C.A. links to the same Cornell page as the U.S.C.
            (
                "See 42 U.S.C.A. § 1983.",
                "https://www.law.cornell.edu/uscode/text/42/1983",
            ),
            // govinfo's link service accepts a page inside a law, not only
            // the first page, and drops the thousands comma.
            (
                "See 124 Stat. 119.",
                "https://www.govinfo.gov/link/statute/124/119",
            ),
            (
                "See 124 Stat. 1,025.",
                "https://www.govinfo.gov/link/statute/124/1025",
            ),
            (
                "See Pub. L. No. 111-148.",
                "https://www.govinfo.gov/link/plaw/111/public/148",
            ),
            (
                "See Pub. L. 104-104.",
                "https://www.govinfo.gov/link/plaw/104/public/104",
            ),
            (
                "See 85 Fed. Reg. 12345 (Mar. 2, 2020).",
                "https://www.govinfo.gov/link/fr/85/12345",
            ),
            (
                "See 85 Fed. Reg. 12,345.",
                "https://www.govinfo.gov/link/fr/85/12345",
            ),
            (
                "See Ariz. Rev. Stat. Ann. § 13-1105.",
                "https://www.azleg.gov/viewdocument/?docName=https://www.azleg.gov/ars/13/01105.htm",
            ),
            (
                "See Ariz. Rev. Stat. Ann. § 13-3601.01.",
                "https://www.azleg.gov/viewdocument/?docName=https://www.azleg.gov/ars/13/03601-01.htm",
            ),
            (
                "See Mich. Comp. Laws § 750.316.",
                "https://www.legislature.mi.gov/Laws/MCL?objectName=mcl-750-316",
            ),
            (
                "See Mich. Comp. Laws Ann. § 600.2912.",
                "https://www.legislature.mi.gov/Laws/MCL?objectName=mcl-600-2912",
            ),
            (
                "See Minn. Stat. § 609.185.",
                "https://www.revisor.mn.gov/statutes/cite/609.185",
            ),
            (
                "See Minn. Stat. Ann. § 609.185.",
                "https://www.revisor.mn.gov/statutes/cite/609.185",
            ),
            (
                "See Va. Code Ann. § 18.2-32.",
                "https://law.lis.virginia.gov/vacode/18.2-32/",
            ),
            (
                "See Va. Code Ann. § 8.01-581.15.",
                "https://law.lis.virginia.gov/vacode/8.01-581.15/",
            ),
        ];
        for (text, url) in cases {
            assert_eq!(sole_external_url(text).as_deref(), Some(url), "{text}");
        }
    }

    /// Law citations with no deterministic per-section URL stay unlinked:
    /// public laws before the 104th Congress (govinfo's link service has
    /// none), state codes not in the list, and a Michigan section citare
    /// cut short.
    #[test]
    fn external_url_none_without_a_pattern() {
        for text in [
            "See Pub. L. No. 93-205.",
            "See Mich. Comp. Laws § 600.2912a.",
            "See Ga. Code Ann. § 16-5-1.",
            "See Colo. Rev. Stat. § 18-3-102.",
        ] {
            assert_eq!(sole_external_url(text), None, "{text}");
        }
    }

    /// citare gives "N.Y. Penal Law" the slug "ny". A law citation is still
    /// checked for an external URL, and gets no case links.
    #[test]
    fn law_citation_with_a_slug_gets_no_case_links() {
        let cites = detect_citations("See N.Y. Penal Law § 125.25.");
        assert_eq!(cites.len(), 1);
        assert_eq!(cites[0].citation_type, "FullLawCitation");
        assert!(cites[0].case_links.is_empty());
    }

    #[test]
    fn case_links_for_a_case_citation() {
        let cites = detect_citations("Axon Enterprise, Inc. v. FTC, 598 U.S. 175 (2023).");
        let c = cites
            .iter()
            .find(|c| c.matched_text == "598 U.S. 175")
            .expect("should detect 598 U.S. 175");
        assert_eq!(
            c.case_links,
            vec![
                CaseLink {
                    source: "courtlistener".into(),
                    kind: "full_text".into(),
                    url: "https://www.courtlistener.com/c/U.S./598/175/".into(),
                },
                CaseLink {
                    source: "google_scholar".into(),
                    kind: "search".into(),
                    url:
                        "https://scholar.google.com/scholar?hl=en&as_sdt=2006&q=%22598+U.S.+175%22"
                            .into(),
                },
            ]
        );
    }

    /// A reporter with a space is percent-encoded in CourtListener's path
    /// and joined with `+` in Scholar's query.
    #[test]
    fn case_links_encode_reporter_spaces() {
        let cites = detect_citations("See 143 S. Ct. 1 (2022).");
        let c = cites
            .iter()
            .find(|c| c.matched_text == "143 S. Ct. 1")
            .expect("should detect 143 S. Ct. 1");
        let urls: Vec<&str> = c.case_links.iter().map(|l| l.url.as_str()).collect();
        assert_eq!(
            urls,
            [
                "https://www.courtlistener.com/c/S.%20Ct./143/1/",
                "https://scholar.google.com/scholar?hl=en&as_sdt=2006&q=%22143+S.+Ct.+1%22",
            ]
        );
    }

    /// No page, no link: `599 U.S. ___` has nothing to look up. Statutes
    /// and short forms get none either.
    #[test]
    fn case_links_empty_without_a_full_case_citation() {
        for text in [
            "See Smith v. Jones, 599 U.S. ___ (2023).",
            "See 42 U.S.C. § 1983.",
        ] {
            for c in detect_citations(text) {
                assert!(c.case_links.is_empty(), "{text}: {:?}", c.matched_text);
            }
        }
        let cites = detect_citations("See 31 A.2d 647. Id. at 650.");
        let id = cites
            .iter()
            .find(|c| c.citation_type != "FullCaseCitation")
            .expect("should detect Id.");
        assert!(id.case_links.is_empty());
    }

    #[test]
    fn case_links_serialize_for_js() {
        let cites = detect_citations("See 598 U.S. 175.");
        let json = serde_json::to_value(&cites[0]).unwrap();
        assert_eq!(json["case_links"][0]["source"], "courtlistener");
        assert_eq!(json["case_links"][1]["kind"], "search");
    }

    /// The one citation of `ty` in `cites` whose text is `raw`.
    fn find<'a>(cites: &'a [DetectedCitation], ty: &str, raw: &str) -> &'a DetectedCitation {
        cites
            .iter()
            .find(|c| c.citation_type == ty && c.matched_text == raw)
            .unwrap_or_else(|| panic!("no {ty} {raw:?} in {cites:#?}"))
    }

    /// #120: `997 P.2d at 1023` refers to Roe, which starts at 1021. It was
    /// looked up at its pin page, 1023, where Burnett v. State starts. It
    /// now carries Roe's citation, and no page of its own.
    #[test]
    fn short_cite_refers_to_its_antecedent_not_its_pin_page() {
        let cites = detect_citations(
            "Roe v. Board of County Commissioners, 997 P.2d 1021 (Wyo. 2000). Roe, 997 P.2d at 1023.",
        );
        let short = find(&cites, "ShortCaseCitation", "997 P.2d at 1023");
        assert_eq!(short.page, None, "a pin page is not a first page");
        assert_eq!(short.pin.as_deref(), Some("1023"));
        let a = short.antecedent.as_ref().expect("antecedent");
        assert_eq!(a.matched_text, "997 P.2d 1021");
        assert_eq!(a.citation_type, "FullCaseCitation");
        assert_eq!(a.harvard_slug.as_deref(), Some("p2d"));
        assert_eq!(a.volume.as_deref(), Some("997"));
        assert_eq!(a.page.as_deref(), Some("1021"));
        assert!(resolvable_citations(&cites)
            .iter()
            .all(|c| c.matched_text == "997 P.2d 1021"));
        // A full citation has no antecedent.
        assert!(find(&cites, "FullCaseCitation", "997 P.2d 1021")
            .antecedent
            .is_none());
    }

    /// citare reports no pin cite for `TC, ¶ 10, 431 P.3d at 565`; the
    /// pin page is still the pin.
    #[test]
    fn short_cite_pin_falls_back_to_its_page() {
        let cites =
            detect_citations("TC v. Wyo., 431 P.3d 560 (Wyo. 2018). TC, ¶ 10, 431 P.3d at 565.");
        let short = find(&cites, "ShortCaseCitation", "431 P.3d at 565");
        assert_eq!(short.pin.as_deref(), Some("565"));
        assert_eq!(short.page, None);
        assert_eq!(
            short.antecedent.as_ref().unwrap().page.as_deref(),
            Some("560")
        );
    }

    /// Each Id. refers to the citation before it, through a chain of Id.s,
    /// and two Id.s with the same text can refer to different cases.
    #[test]
    fn id_chain_follows_the_preceding_citation() {
        let text = "See Lyon, 31 A.2d 647 (1943). Id. at 650. Id. at 651. \
                    Roe v. Wade, 410 U.S. 113 (1973). Id. at 120.";
        let cites = detect_citations(text);
        let ids: Vec<&DetectedCitation> = cites
            .iter()
            .filter(|c| c.citation_type == "IdCitation")
            .collect();
        assert_eq!(ids.len(), 3, "{cites:#?}");
        let to: Vec<(&str, Option<&str>)> = ids
            .iter()
            .map(|c| {
                (
                    c.antecedent.as_ref().unwrap().matched_text.as_str(),
                    c.pin.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            to,
            [
                ("31 A.2d 647", Some("650")),
                ("31 A.2d 647", Some("651")),
                ("410 U.S. 113", Some("120")),
            ]
        );
        assert!(ids.iter().all(|c| c.page.is_none()));
    }

    #[test]
    fn supra_refers_to_the_named_case() {
        let cites = detect_citations(
            "Martel v. Metropolitan District Commission, 275 Conn. 38 (2005). \
             The court agreed. Martel, supra, at 46.",
        );
        let supra = cites
            .iter()
            .find(|c| c.citation_type == "SupraCitation")
            .expect("supra");
        let a = supra.antecedent.as_ref().expect("antecedent");
        assert_eq!(a.matched_text, "275 Conn. 38");
        assert_eq!(a.harvard_slug.as_deref(), Some("conn"));
        assert_eq!(supra.pin.as_deref(), Some("46"));
    }

    /// A short cite to a case stare.pub may not hold carries the
    /// antecedent's outside links, so it can link out the same way.
    #[test]
    fn short_cite_carries_its_antecedents_case_links() {
        let cites = detect_citations(
            "Axon Enterprise, Inc. v. FTC, 598 U.S. 175 (2023). Axon, 598 U.S. at 180.",
        );
        let short = find(&cites, "ShortCaseCitation", "598 U.S. at 180");
        assert!(short.case_links.is_empty());
        let a = short.antecedent.as_ref().expect("antecedent");
        assert_eq!(
            a.case_links[0].url,
            "https://www.courtlistener.com/c/U.S./598/175/"
        );
    }

    /// An Id. with nothing before it, and a short cite to a volume no
    /// earlier citation names, have no antecedent and no page.
    #[test]
    fn short_form_without_antecedent_has_none() {
        let cites = detect_citations("Id. at 5. See also 997 P.2d at 1023.");
        assert_eq!(cites.len(), 2, "{cites:#?}");
        for c in &cites {
            assert!(c.is_short_form());
            assert!(c.antecedent.is_none());
            assert_eq!(c.page, None);
        }
    }

    /// Antecedent spans are converted to char offsets with the rest.
    #[test]
    fn antecedent_span_in_char_offsets() {
        let text = "\u{a7} Fran\u{e7}ois v. Roe, 997 P.2d 1021 (2000). Id. at 1023.";
        let mut cites = detect_citations(text);
        spans_to_char_offsets(text, &mut cites).unwrap();
        let id = find(&cites, "IdCitation", "Id.");
        let (start, end) = id.antecedent.as_ref().unwrap().span;
        let chars: Vec<char> = text.chars().collect();
        assert_eq!(
            chars[start..end].iter().collect::<String>(),
            "997 P.2d 1021"
        );
        let json = serde_json::to_value(id).unwrap();
        assert_eq!(json["antecedent"]["page"], "1021");
        assert_eq!(json["pin"], "1023");
        assert!(json["page"].is_null());
    }

    /// The external URL for the one citation `text` should contain.
    fn sole_external_url(text: &str) -> Option<String> {
        let cites = detect_citations(text);
        assert_eq!(cites.len(), 1, "expected one citation in {text:?}");
        cites.into_iter().next().unwrap().external_url
    }

    #[test]
    fn statute_external_url_allows_spaced_abbreviations() {
        let cases = [
            (
                "See 18 U.S.C. § 4241.",
                "https://www.law.cornell.edu/uscode/text/18/4241",
            ),
            (
                "See 18 U. S. C. § 4241.",
                "https://www.law.cornell.edu/uscode/text/18/4241",
            ),
            (
                "See 42 U.S.C. §§ 1983.",
                "https://www.law.cornell.edu/uscode/text/42/1983",
            ),
            (
                "See 42 U. S. C. §§ 1983.",
                "https://www.law.cornell.edu/uscode/text/42/1983",
            ),
            (
                "See 26 U. S. C. § 501(c)(3).",
                "https://www.law.cornell.edu/uscode/text/26/501",
            ),
            (
                "See 18 USC § 4241.",
                "https://www.law.cornell.edu/uscode/text/18/4241",
            ),
            (
                "See 18 U.S.C. §4241.",
                "https://www.law.cornell.edu/uscode/text/18/4241",
            ),
            (
                "See 40 C.F.R. § 122.1.",
                "https://www.ecfr.gov/current/title-40/section-122.1",
            ),
            (
                "See 40 C. F. R. § 122.1.",
                "https://www.ecfr.gov/current/title-40/section-122.1",
            ),
            (
                "See 56 Stat. 195.",
                "https://www.govinfo.gov/link/statute/56/195",
            ),
        ];
        for (text, url) in cases {
            assert_eq!(sole_external_url(text).as_deref(), Some(url), "{text}");
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

    /// A blank page (`1 U.S. ___`, a slip opinion not yet paginated) has
    /// no page: citare reports it as `None`, as eyecite does, so it
    /// must never reach an index lookup as the page "___".
    #[test]
    fn blank_page_is_none_and_not_resolvable() {
        let text = "See Smith v. Jones, 599 U.S. ___ (2023).";
        let cites = detect_citations(text);
        let c = cites
            .iter()
            .find(|c| c.matched_text.contains("U.S."))
            .expect("should detect the U.S. citation");
        assert_eq!(c.harvard_slug.as_deref(), Some("us"));
        assert_eq!(c.volume.as_deref(), Some("599"));
        assert_eq!(c.page, None);
        assert!(
            c.matched_text.ends_with("___"),
            "matched_text keeps the underscores"
        );
        assert!(resolvable_citations(&cites).is_empty());

        let json = serde_json::to_value(c).unwrap();
        assert!(
            json["page"].is_null(),
            "JS must see page: null, not \"___\""
        );
    }

    /// citare v0.4.0 panicked on about 2% of real opinions: the case-name
    /// scan sliced the text at a fixed byte distance (300) from the
    /// citation, and a multibyte character straddling that byte (here a
    /// curly apostrophe, three bytes) put the slice inside a char. v0.4.1
    /// keeps every span on a char boundary. This runs the same path the
    /// WASM runs: detect, then convert spans to char offsets.
    #[test]
    fn multibyte_char_at_case_name_scan_boundary() {
        let text = format!(
            "Foo v. Bar, 547 So.2d 1034 {}\u{2019}s house.",
            "x".repeat(297)
        );
        let mut cites = detect_citations(&text);
        let cite = cites
            .iter()
            .position(|c| c.matched_text == "547 So.2d 1034")
            .expect("should detect the So.2d citation");
        spans_to_char_offsets(&text, &mut cites).expect("every span lands on a char boundary");

        let (start, end) = cites[cite].span;
        let chars: Vec<char> = text.chars().collect();
        let sliced: String = chars[start..end].iter().collect();
        assert_eq!(sliced, "547 So.2d 1034");
    }
}
