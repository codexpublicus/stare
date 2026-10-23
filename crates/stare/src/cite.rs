//! Citation detection and resolution using citare-core.
//!
//! Wraps citare's get_citations to produce structured results
//! with Harvard CAP slugs for direct index resolution, and its
//! resolve_citations to tie each short form to the full citation it
//! refers to.

use std::collections::HashMap;

use citare_core::Citation;
use serde::{Deserialize, Serialize};

/// Compile a pattern once and keep it for the life of the process.
macro_rules! regex {
    ($re:literal) => {{
        static RE: std::sync::LazyLock<regex::Regex> =
            std::sync::LazyLock::new(|| regex::Regex::new($re).expect("valid regex"));
        &*RE
    }};
}

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
    /// citare's slug for the edition (citare#71): CAP's slug where CAP has the
    /// reporter, else one derived from the edition name (`ny-slip-op`). The
    /// index is looked up by this, under `<slug>/<volume>`. `None` for laws,
    /// journals and citations with no edition. Loaded with a data bundle older
    /// than citare v0.6.0, which has no slugs, it is `harvard_slug` instead.
    #[serde(default)]
    pub slug: Option<String>,
    /// Volume number from the citation groups
    pub volume: Option<String>,
    /// First page from the citation groups. `None` for a blank page
    /// (`1 U.S. ___`), which can't be looked up, and for a short form,
    /// whose page is a pin page (see `pin`).
    pub page: Option<String>,
    /// Reporter abbreviation from the citation groups
    pub reporter: Option<String>,
    /// The edition citare read `reporter` as, when it matched only as a
    /// variation of an edition with another name (citare#86): `127 Ohio 545`
    /// is the Ohio State Reports, `Ohio St.`, since the Ohio Reports end at
    /// volume 20. `None` when the reporter is an edition's own name or a
    /// spacing of it (`U. S.`), and for laws and journals.
    #[serde(default)]
    pub corrected_reporter: Option<String>,
    /// Whether the citation is to an official reporter: a state's
    /// (reporters-db's `state` reporters, `Neb.`, `Pa. Super.`) or the U.S.
    /// Reports. Of a parallel run's printings stare.pub holds, the official
    /// one shows by default (#160).
    #[serde(default)]
    pub official: bool,
    /// Year if detected
    pub year: Option<i32>,
    /// External URL for statutes/regulations (Cornell, govinfo, eCFR and
    /// the state legislatures in `STATE_CODES`)
    pub external_url: Option<String>,
    /// For a statute or regulation (`FullLawCitation`), its parts as
    /// citare splits them. A law citation has this whether or not
    /// `external_url` can link it, so a reader can tell a statute without a
    /// link from a case stare.pub hasn't indexed. `None` otherwise.
    #[serde(default)]
    pub law: Option<LawRef>,
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
    /// For a full case citation, the case name as the citing text gives it:
    /// citare's plaintiff and defendant (`Roe v. Board of County
    /// Commissioners`), or the one of them it found. `None` when it found
    /// neither, and for anything but a full case citation. It is the citing
    /// text's name for the case, not the cited case's own.
    #[serde(default)]
    pub case_name: Option<String>,
    /// For a full case citation that is a parallel citation of the one
    /// before it (`123 Ill. 2d 45, 524 N.E.2d 1`, which citare reads as one
    /// case name with two citations), the index in this list of the first
    /// citation of the run. `None` for the first, and for any other citation.
    #[serde(default)]
    pub parallel_of: Option<usize>,
    /// For a full case citation with no case name of its own that the text cites as
    /// another's subsequent history (`Segreto v. Bristol, 71 Conn. App. 844, 804 A.2d
    /// 928, cert. denied, 261 Conn. 941, 808 A.2d 1132`), the name the citation it
    /// follows gives (`Segreto v. Bristol`): the same case's, a later decision in it.
    /// Every printing of such a run has it. `None` for any other citation, and for
    /// history that names the case anew (`aff'd sub nom.`). Used to pick the case at a
    /// page several cases start on (#212).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_name: Option<String>,
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
    #[serde(default)]
    pub slug: Option<String>,
    pub volume: Option<String>,
    pub page: Option<String>,
    pub reporter: Option<String>,
    #[serde(default)]
    pub corrected_reporter: Option<String>,
    #[serde(default)]
    pub official: bool,
    pub year: Option<i32>,
    pub external_url: Option<String>,
    #[serde(default)]
    pub law: Option<LawRef>,
    #[serde(default)]
    pub case_links: Vec<CaseLink>,
}

/// A statute or regulation citation's parts, in the shape of citare's
/// `law` object (codexpublicus/citare#69, `Citation::law()`): the
/// jurisdiction, the code, and the `subject`, `title`, `chapter` and
/// `section` where the citation has them (`42 Pa. Cons. Stat. § 5524` has
/// title `42`; `N.Y. Penal Law § 125.25` has subject `Penal`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LawRef {
    /// reporters-db's name for the jurisdiction (`Pennsylvania`, `District
    /// of Columbia`, `United States`); `None` when nothing names it.
    pub jurisdiction: Option<String>,
    /// The code (`Pa. Cons. Stat.`, `N.Y. Penal Law`).
    pub code: String,
    pub subject: Option<String>,
    pub title: Option<String>,
    #[serde(default)]
    pub chapter: Option<String>,
    /// The section without subsections (`52-557n`).
    pub section: Option<String>,
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
            slug: self.slug.clone(),
            volume: self.volume.clone(),
            page: self.page.clone(),
            reporter: self.reporter.clone(),
            corrected_reporter: self.corrected_reporter.clone(),
            official: self.official,
            year: self.year,
            external_url: self.external_url.clone(),
            law: self.law.clone(),
            case_links: self.case_links.clone(),
        }
    }
}

/// Whether the text between two full case citations says the second is the first's
/// subsequent history: a pin cite or two and a parenthetical at most, then `cert.
/// denied`, `aff'd`, `rev'd` and the like, and nothing else. `aff'd sub nom.` names
/// the case anew, so it isn't.
fn is_subsequent_history(gap: &str) -> bool {
    regex!(
        r"(?ix)^[\s,;\[]*
        (?:(?:at\s+)?\d+(?:[-\x{2013}]\d+)?(?:\s*nn?\.\s*\d+)?[\s,]*)*
        (?:[(\[][^()\[\]]*[)\]][\s,;]*)*
        (?:
            cert(?:iorari|if(?:ication)?)?[.,]?\s+(?:denied|den\.|dismissed|granted)
            | aff['\x{2019}]?d(?:\s+o\.b\.)? | affirmed | rev['\x{2019}]?d | reversed | vacated | modified
            | appeal\s+(?:denied|dismissed)
            | review\s+denied
            | petition\s+for\s+(?:review|certification|certiorari)\s+denied
            | (?:reh(?:earin)?['\x{2019}]?g|reh\.|rehearing)\s+denied
        )
        (?:,?\s+(?:in\s+part|on\s+other\s+grounds|per\s+curiam|mem\.))*
        [\s,]*$"
    )
    .is_match(gap)
}

/// A full case citation's parties, as `DetectedCitation::case_name` gives them.
fn case_name(c: &Citation) -> Option<String> {
    let Citation::FullCase(d) = c else {
        return None;
    };
    let party = |p: &Option<String>| {
        p.as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let name = match (party(&d.metadata.plaintiff), party(&d.metadata.defendant)) {
        (Some(p), Some(d)) => format!("{p} v. {d}"),
        (p, d) => p.or(d)?,
    };
    // `Id., (1990), 52 Ohio St.3d 155` names the case by an id. citation,
    // which citare v0.7.0 resolves to the citation after it (citare#84) and
    // reports as that citation's case name. It names no case.
    (!regex!(r"(?i)^(?:id|ibid)\.").is_match(&name)).then_some(name)
}

/// Whether a case citation is to an official reporter (see
/// `DetectedCitation::official`), by the edition citare reads it as.
fn official(c: &Citation) -> bool {
    let Some(r) = c.resource_common() else {
        return false;
    };
    r.edition_guess
        .as_ref()
        .or_else(|| r.all_editions.first())
        .is_some_and(|e| e.reporter.cite_type == "state" || e.slug.as_deref() == Some("us"))
}

/// The edition a case citation's reporter was read as when it matched only
/// as a variation of an edition with another name (see
/// `DetectedCitation::corrected_reporter`).
fn corrected_reporter(c: &Citation) -> Option<String> {
    let r = c.resource_common()?;
    if !r.exact_editions.is_empty() || r.variation_editions.is_empty() {
        return None;
    }
    let corrected = c.corrected_reporter()?;
    let squash = |s: &str| s.split_whitespace().collect::<String>();
    let cited = c.common().groups.get("reporter").cloned().flatten();
    (cited.as_deref().map(squash) != Some(squash(&corrected))).then_some(corrected)
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
    let slugs = data_has_slugs();

    let mut detected: Vec<DetectedCitation> = citations
        .iter()
        .map(|c| {
            let (start, end) = c.span();
            let groups = &c.common().groups;

            let edition_field = |field: fn(&citare_core::Edition) -> &Option<String>| {
                c.resource_common()
                    .and_then(|r| r.edition_guess.as_ref())
                    .and_then(|e| field(e).clone())
                    .or_else(|| {
                        c.resource_common()
                            .and_then(|r| r.all_editions.first())
                            .and_then(|e| field(e).clone())
                    })
            };
            let harvard_slug = edition_field(|e| &e.harvard_slug);
            let slug = if slugs {
                edition_field(|e| &e.slug)
            } else {
                harvard_slug.clone()
            };

            let mut det = DetectedCitation {
                matched_text: c.matched_text().to_string(),
                citation_type: c.type_name().to_string(),
                span: (start, end),
                harvard_slug,
                slug,
                volume: groups.get("volume").cloned().flatten(),
                page: groups.get("page").cloned().flatten(),
                reporter: groups.get("reporter").cloned().flatten(),
                corrected_reporter: corrected_reporter(c),
                official: official(c),
                year: c.resource_common().and_then(|r| r.year),
                external_url: None,
                law: None,
                case_links: Vec::new(),
                pin: pin_cite(c).and_then(normalize_pin),
                antecedent: None,
                case_name: case_name(c),
                parallel_of: None,
                history_name: None,
            };
            if det.citation_type == "FullLawCitation" {
                det.law = c.law().map(LawRef::from);
                // citare can stop a section short: `D.C. Code § 22–2101`
                // (an en dash) gives section `22`, `Neb. Rev. Stat. §
                // 60-6,196` gives `60-6`. A section the text runs on past
                // is not the one cited, so it isn't linked.
                if let Some(law) = det.law.as_mut() {
                    let cut = law.section.as_deref().is_some_and(|sec| {
                        det.matched_text.ends_with(sec)
                            && regex!(r"^(?:[,.\-\u{2010}-\u{2014}]\d|\w)").is_match(&text[end..])
                    });
                    if cut {
                        law.section = None;
                    }
                }
            }
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
            if det.citation_type == "FullLawCitation" || det.slug.is_none() {
                det.external_url = external_url(&det);
            }
            det.case_links = case_links(&det);
            det
        })
        .collect();

    // A full case citation that shares its case name's span with the full case
    // citation just before it is a parallel citation of the same case, as
    // citare's own find step reads it (it copies the parties across).
    for i in 1..citations.len() {
        if let (Citation::FullCase(cur), Citation::FullCase(pre)) =
            (&citations[i], &citations[i - 1])
        {
            let start = cur.resource.common.full_span_start;
            if start.is_some() && start == pre.resource.common.full_span_start {
                detected[i].parallel_of = Some(detected[i - 1].parallel_of.unwrap_or(i - 1));
            }
        }
    }

    // A nameless full case citation in the subsequent history of the full case citation
    // just before it is a later decision in the same case, under the same name (#212).
    for i in 1..detected.len() {
        if detected[i].citation_type != "FullCaseCitation" || detected[i].case_name.is_some() {
            continue;
        }
        if let Some(head) = detected[i].parallel_of {
            detected[i].history_name = detected[head].history_name.clone();
            continue;
        }
        let prev = &detected[i - 1];
        if prev.citation_type != "FullCaseCitation" {
            continue;
        }
        let gap = text.get(prev.span.1..detected[i].span.0).unwrap_or("");
        if is_subsequent_history(gap) {
            detected[i].history_name = prev.case_name.clone().or(prev.history_name.clone());
        }
    }

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
/// - state codes: the rows of `STATE_CODES` with a URL, each on the
///   state's own site
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

    // State codes, by the code citare names (see `STATE_CODES`).
    citation.law.as_ref().and_then(state_code_url)
}

impl From<citare_core::models::citation::LawFields> for LawRef {
    fn from(l: citare_core::models::citation::LawFields) -> Self {
        LawRef {
            jurisdiction: l.jurisdiction,
            code: l.code,
            subject: l.subject,
            title: l.title,
            chapter: l.chapter,
            section: l.section,
        }
    }
}

/// One state's code: the names citare gives it and how to build a
/// section's URL on the state's own site.
struct StateCode {
    /// reporters-db's name for the jurisdiction, as citare's `law` gives it.
    jurisdiction: &'static str,
    /// The code's names, as citare's `law.code` or `reporter` group gives
    /// them, compared by `code_key`: without spaces, periods, case or a
    /// final "Ann.". A name ending in ` *` is a prefix, for a state with a
    /// code per subject (`N.Y. *` matches `N.Y. Penal Law` and `N.Y.`, not
    /// `N.Y.C. Admin. Code`).
    names: &'static [&'static str],
    /// The URL for one section, or `None` when the citation lacks a part
    /// the URL needs. A code listed without one is a statute stare.pub
    /// knows but can't link; the comment beside it says why.
    url: Option<fn(&LawRef) -> Option<String>>,
}

/// State codes, by jurisdiction. A code is linked only when its
/// legislature (or the state's official code site) publishes a page per
/// section whose URL needs nothing but the citation's own parts, that page
/// returned the section's text when the pattern was added, and robots.txt
/// allowed the check. Adding a code is adding a row. A citation is matched
/// by its `law.jurisdiction` and `law.code` when citare names the
/// jurisdiction (codexpublicus/citare#69), and by the code alone when it
/// doesn't (citare leaves it out when a code's candidate editions disagree).
static STATE_CODES: &[StateCode] = &[
    // Arizona: "Ariz. Rev. Stat. Ann. § 13-1105", "... § 13-3601.01". The
    // file name pads the section to five digits.
    StateCode {
        jurisdiction: "Arizona",
        names: &["Ariz. Rev. Stat."],
        url: Some(|l| {
            let caps = regex!(r"^(\d+)-(\d+)(?:\.(\d+))?").captures(l.section.as_deref()?)?;
            let section: u32 = caps[2].parse().ok()?;
            let sub = caps
                .get(3)
                .map(|m| format!("-{}", m.as_str()))
                .unwrap_or_default();
            Some(format!(
                "https://www.azleg.gov/viewdocument/?docName=https://www.azleg.gov/ars/{}/{:05}{}.htm",
                &caps[1], section, sub
            ))
        }),
    },
    // Michigan: "Mich. Comp. Laws § 750.316", and lettered sections,
    // "§ 600.2912a" (mcl-600-2912a).
    StateCode {
        jurisdiction: "Michigan",
        names: &["Mich. Comp. Laws"],
        url: Some(|l| {
            let caps = regex!(r"^(\d+)\.(\d+[a-z]*)").captures(l.section.as_deref()?)?;
            Some(format!(
                "https://www.legislature.mi.gov/Laws/MCL?objectName=mcl-{}-{}",
                &caps[1], &caps[2]
            ))
        }),
    },
    // Minnesota: "Minn. Stat. § 609.185", "Minn. Stat. Ann. § 13D.01"
    StateCode {
        jurisdiction: "Minnesota",
        names: &["Minn. Stat."],
        url: Some(|l| {
            let m = regex!(r"^\d+[A-Z]?\.\d+[A-Za-z]*").find(l.section.as_deref()?)?;
            Some(format!(
                "https://www.revisor.mn.gov/statutes/cite/{}",
                m.as_str()
            ))
        }),
    },
    // Virginia: "Va. Code Ann. § 18.2-32", "... § 8.01-581.15"
    StateCode {
        jurisdiction: "Virginia",
        names: &["Va. Code"],
        url: Some(|l| {
            let m = regex!(r"^\d+(?:\.\d+)?-\d+(?:\.\d+)*").find(l.section.as_deref()?)?;
            Some(format!(
                "https://law.lis.virginia.gov/vacode/{}/",
                m.as_str()
            ))
        }),
    },
    // District of Columbia: "D.C. Code § 48-904.01". The council's site
    // shows en dashes but its URLs take hyphens.
    StateCode {
        jurisdiction: "District of Columbia",
        names: &["D.C. Code"],
        url: Some(|l| {
            let sec = l.section.as_deref()?.replace(['\u{2013}', '\u{2014}'], "-");
            let m = regex!(r"^\d+-\d+(?:\.\d+)?").find(&sec)?;
            Some(format!(
                "https://code.dccouncil.gov/us/dc/council/code/sections/{}",
                m.as_str()
            ))
        }),
    },
    // Florida: "Fla. Stat. § 782.04". The path groups chapters by hundred
    // and pads the chapter to four digits: 0700-0799/0782/Sections/0782.04.
    StateCode {
        jurisdiction: "Florida",
        names: &["Fla. Stat."],
        url: Some(|l| {
            let caps = regex!(r"^(\d+)\.(\d+)").captures(l.section.as_deref()?)?;
            let chapter: u32 = caps[1].parse().ok()?;
            let from = chapter / 100 * 100;
            Some(format!(
                "https://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL={:04}-{:04}/{:04}/Sections/{:04}.{}.html",
                from,
                from + 99,
                chapter,
                chapter,
                &caps[2]
            ))
        }),
    },
    // Maine: "19-A M.R.S. § 1653", "Me. Rev. Stat. Ann. tit. 17-A, § 201",
    // lettered sections ("§ 408-A"). One page per section, named by title
    // and section (title19-Asec1653.html). A range links to its first section.
    StateCode {
        jurisdiction: "Maine",
        names: &["Me. Rev. Stat.", "M.R.S.", "M.R.S.A."],
        url: Some(|l| {
            let title = regex!(r"^\d+(?:-[A-Z])?$").find(l.title.as_deref()?)?;
            let sec = regex!(r"^\d+(?:-[A-Z]+)?").find(l.section.as_deref()?)?;
            Some(format!(
                "https://legislature.maine.gov/statutes/{0}/title{0}sec{1}.html",
                title.as_str(),
                sec.as_str()
            ))
        }),
    },
    // Missouri: "Mo. Rev. Stat. § 537.080", "Mo. Ann. Stat. § 537.080"
    StateCode {
        jurisdiction: "Missouri",
        names: &["Mo. Rev. Stat.", "Mo. Ann. Stat.", "Mo. Stat."],
        url: Some(|l| {
            let m = regex!(r"^\d+\.\d+").find(l.section.as_deref()?)?;
            Some(format!(
                "https://revisor.mo.gov/main/OneSection.aspx?section={}",
                m.as_str()
            ))
        }),
    },
    // North Carolina: "N.C. Gen. Stat. § 50-13.4", "§ 15A-1340.14"; the
    // chapter is the part before the hyphen, letters and all.
    StateCode {
        jurisdiction: "North Carolina",
        names: &["N.C. Gen. Stat."],
        url: Some(|l| {
            let caps = regex!(r"^(\d+[A-Z]*)-\d+[A-Za-z]*(?:\.\d+[A-Za-z]*)?")
                .captures(l.section.as_deref()?)?;
            Some(format!(
                "https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/BySection/Chapter_{}/GS_{}.html",
                &caps[1], &caps[0]
            ))
        }),
    },
    // Nebraska: "Neb. Rev. Stat. § 84-917", "§ 60-6,196" (Nebraska's
    // section numbers have commas)
    StateCode {
        jurisdiction: "Nebraska",
        names: &["Neb. Rev. Stat."],
        url: Some(|l| {
            let m = regex!(r"^\d+-\d+(?:,\d+)?(?:\.\d+)?").find(l.section.as_deref()?)?;
            Some(format!(
                "https://nebraskalegislature.gov/laws/statutes.php?statute={}",
                m.as_str()
            ))
        }),
    },
    // New York: "N.Y. Penal Law § 125.25", "N.Y. Fam. Ct. Act § 413".
    // citare names the code in `subject`; the Senate's URLs take the law ID
    // and the section with its letters in upper case (214-A).
    StateCode {
        jurisdiction: "New York",
        names: &["N.Y. *"],
        url: Some(|l| {
            let law = subject_code(l, NY_LAWS)?;
            let m = regex!(r"^\d+(?:[.-]?[\dA-Za-z]+)*").find(l.section.as_deref()?)?;
            Some(format!(
                "https://www.nysenate.gov/legislation/laws/{}/{}",
                law,
                m.as_str().to_uppercase()
            ))
        }),
    },
    // Pennsylvania: "42 Pa. Cons. Stat. § 5524". A section's last two
    // digits are its number in the chapter the rest name (5524: chapter
    // 55, section 24); a decimal part is the subsection (2702.1).
    StateCode {
        jurisdiction: "Pennsylvania",
        names: &["Pa. Cons. Stat.", "Pa.C.S."],
        url: Some(|l| {
            let title = l.title.as_deref()?;
            let caps = regex!(r"^(\d+)(\d\d)(?:\.(\d+))?").captures(l.section.as_deref()?)?;
            Some(format!(
                "https://www.palegis.us/statutes/consolidated/view-statute?txtType=HTM&ttl={}&div=0&chapter={}&section={}&subsctn={}",
                title,
                &caps[1],
                &caps[2],
                caps.get(3).map_or("0", |m| m.as_str())
            ))
        }),
    },
    // Texas: "Tex. Penal Code Ann. § 19.02". One file per chapter, with an
    // anchor per section, on the legislature's statute file server.
    StateCode {
        jurisdiction: "Texas",
        names: &["Tex. *"],
        url: Some(|l| {
            let code = subject_code(l, TX_CODES)?;
            let caps = regex!(r"^(\d+[A-Z]?)\.\d+").captures(l.section.as_deref()?)?;
            Some(format!(
                "https://tcss.legis.texas.gov/resources/{0}/htm/{0}.{1}.htm#{2}",
                code, &caps[1], &caps[0]
            ))
        }),
    },
    // Wisconsin: "Wis. Stat. § 752.31". /document/ redirects to the page
    // under its subchapter, which the citation doesn't give.
    StateCode {
        jurisdiction: "Wisconsin",
        names: &["Wis. Stat."],
        url: Some(|l| {
            let m = regex!(r"^\d+\.\d+").find(l.section.as_deref()?)?;
            Some(format!(
                "https://docs.legis.wisconsin.gov/document/statutes/{}",
                m.as_str()
            ))
        }),
    },
    // West Virginia: "W. Va. Code § 61-11-18", "§ 17C-5-2", "§ 61-2-14a"
    StateCode {
        jurisdiction: "West Virginia",
        names: &["W. Va. Code"],
        url: Some(|l| {
            let m = regex!(r"^\d+[A-Z]*-\d+[A-Z]*-\d+[a-z]*").find(l.section.as_deref()?)?;
            Some(format!("https://code.wvlegislature.gov/{}/", m.as_str()))
        }),
    },
    // Known, not linked; each checked in October 2026.
    // Connecticut: cga.ct.gov has a page per chapter
    // (chap_926.htm#sec_52-584), and a section number doesn't name its
    // chapter. It needs a title-to-chapter table, built from the title
    // pages' section ranges.
    StateCode {
        jurisdiction: "Connecticut",
        names: &["Conn. Gen. Stat."],
        url: None,
    },
    // California: leginfo.legislature.ca.gov answers robots.txt and every
    // section page with a Cloudflare challenge, so nothing could be checked.
    StateCode {
        jurisdiction: "California",
        names: &["Cal. *"],
        url: None,
    },
    // New Jersey: the statutes are only in the NXT gateway, by internal IDs.
    StateCode {
        jurisdiction: "New Jersey",
        names: &["N.J. Stat."],
        url: None,
    },
    // Ohio: codes.ohio.gov's robots.txt is the one line "User-agent: *
    // Disallow: /", taken as disallowing everything.
    StateCode {
        jurisdiction: "Ohio",
        names: &["Ohio Rev. Code"],
        url: None,
    },
    // Oregon: one page per chapter, with no anchor per section.
    StateCode {
        jurisdiction: "Oregon",
        names: &["Or. Rev. Stat."],
        url: None,
    },
    // Pennsylvania Code (regulations): pacodeandbulletin.gov's robots.txt
    // disallows everything.
    StateCode {
        jurisdiction: "Pennsylvania",
        names: &["Pa. Code"],
        url: None,
    },
    // Wyoming: whole titles as PDFs only.
    StateCode {
        jurisdiction: "Wyoming",
        names: &["Wyo. Stat."],
        url: None,
    },
];

/// A code name compared without spaces, periods, case or a final "Ann.":
/// "Wyo.Stat.Ann." and "Wyo. Stat." are the same code.
fn code_key(name: &str) -> String {
    let key: String = name
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    match key.strip_suffix("ann") {
        Some(k) if !k.is_empty() => k.to_string(),
        _ => key,
    }
}

impl StateCode {
    /// Whether citare's code name `code` is one of this row's names.
    fn matches(&self, code: &str) -> bool {
        let code = code.trim();
        self.names.iter().any(|n| match n.strip_suffix(" *") {
            Some(prefix) => {
                code == prefix
                    || code
                        .strip_prefix(prefix)
                        .is_some_and(|rest| rest.starts_with(' '))
            }
            None => code_key(n) == code_key(code),
        })
    }
}

/// The `STATE_CODES` row for a code citare names `code`, if any.
fn state_code(code: &str) -> Option<&'static StateCode> {
    STATE_CODES.iter().find(|s| s.matches(code))
}

/// The code a citation names in `table` (`Penal` or `Educ. Law` to `PEN`):
/// its `subject`, or, when citare gives none, its code without the
/// jurisdiction's abbreviation (`N.Y. Penal Law` to `Penal Law`, `Tex. Fam.
/// Code Ann.` to `Fam. Code Ann.`). Compared by `code_key` without a final
/// "Law" or "Code".
fn subject_code(law: &LawRef, table: &[(&str, &'static str)]) -> Option<&'static str> {
    let key = |s: &str| {
        let k = code_key(s);
        match k.strip_suffix("law").or_else(|| k.strip_suffix("code")) {
            Some(k) if !k.is_empty() => k.to_string(),
            _ => k,
        }
    };
    let subject = match law.subject.as_deref() {
        Some(subject) => key(subject),
        None => key(law.code.trim().split_once(' ')?.1),
    };
    table
        .iter()
        .find(|(name, _)| key(name) == subject)
        .map(|(_, code)| *code)
}

/// New York's consolidated laws and court acts, by the subject citare
/// gives them, to the law IDs nysenate.gov uses: the Bluebook
/// abbreviation (`N.Y. Penal Law`) and the full name New York's own
/// courts cite (`Judiciary Law`, `Family Ct Act`).
const NY_LAWS: &[(&str, &str)] = &[
    ("Banking", "BNK"),
    ("Bus. Corp.", "BSC"),
    ("Business Corporation", "BSC"),
    ("C.P.L.R.", "CVP"),
    ("CPLR", "CVP"),
    ("Civ. Prac. L. & R.", "CVP"),
    ("Civil Practice Law and Rules", "CVP"),
    ("Civ. Rights", "CVR"),
    ("Civil Rights", "CVR"),
    ("Civ. Serv.", "CVS"),
    ("Civil Service", "CVS"),
    ("Correct.", "COR"),
    ("Correction", "COR"),
    ("Crim. Proc.", "CPL"),
    ("Criminal Procedure", "CPL"),
    ("Dom. Rel.", "DOM"),
    ("Domestic Relations", "DOM"),
    ("Educ.", "EDN"),
    ("Education", "EDN"),
    ("Elec.", "ELN"),
    ("Election", "ELN"),
    ("Env't Conserv.", "ENV"),
    ("Environmental Conservation", "ENV"),
    ("Est. Powers & Trusts", "EPT"),
    ("Estates, Powers and Trusts", "EPT"),
    ("Exec.", "EXC"),
    ("Executive", "EXC"),
    ("Fam. Ct. Act", "FCT"),
    ("Family Ct Act", "FCT"),
    ("Family Court Act", "FCT"),
    ("Gen. Bus.", "GBS"),
    ("General Business", "GBS"),
    ("Gen. Mun.", "GMU"),
    ("General Municipal", "GMU"),
    ("Gen. Oblig.", "GOB"),
    ("General Obligations", "GOB"),
    ("Ins.", "ISC"),
    ("Insurance", "ISC"),
    ("Jud.", "JUD"),
    ("Judiciary", "JUD"),
    ("Lab.", "LAB"),
    ("Labor", "LAB"),
    ("Ltd. Liab. Co.", "LLC"),
    ("Limited Liability Company", "LLC"),
    ("Mental Hyg.", "MHY"),
    ("Mental Hygiene", "MHY"),
    ("Penal", "PEN"),
    ("Pub. Health", "PBH"),
    ("Public Health", "PBH"),
    ("Real Prop.", "RPP"),
    ("Real Property", "RPP"),
    ("Real Prop. Acts.", "RPA"),
    ("Real Property Actions and Proceedings", "RPA"),
    ("Retire. & Soc. Sec.", "RSS"),
    ("Retirement and Social Security", "RSS"),
    ("Soc. Serv.", "SOS"),
    ("Social Services", "SOS"),
    ("Surr. Ct. Proc. Act", "SCP"),
    ("Surrogate's Court Procedure Act", "SCP"),
    ("Tax", "TAX"),
    ("Veh. & Traf.", "VAT"),
    ("Vehicle and Traffic", "VAT"),
    ("Workers' Comp.", "WKC"),
    ("Workers' Compensation", "WKC"),
];

/// Texas codes, by the subject citare gives them, to the abbreviations of
/// the legislature's statute files. Only codes whose sections are cited
/// with `§`: the Code of Criminal Procedure numbers articles.
const TX_CODES: &[(&str, &str)] = &[
    ("Bus. & Com.", "BC"),
    ("Civ. Prac. & Rem.", "CP"),
    ("Fam.", "FA"),
    ("Gov't", "GV"),
    ("Health & Safety", "HS"),
    ("Penal", "PE"),
    ("Prop.", "PR"),
];

/// The URL for a state statute's section: the `STATE_CODES` row for its
/// jurisdiction and code, or for its code alone when the jurisdiction is
/// unknown.
pub fn state_code_url(law: &LawRef) -> Option<String> {
    let row = match law.jurisdiction.as_deref() {
        Some(j) => STATE_CODES
            .iter()
            .filter(|s| s.jurisdiction.eq_ignore_ascii_case(j))
            .find(|s| s.matches(&law.code))?,
        None => state_code(&law.code)?,
    };
    (row.url?)(law)
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
    // A variation is looked up under the edition citare read it as:
    // CourtListener reads `127 Ohio 545` as the Ohio Reports, which have no
    // volume 127.
    let (Some(volume), Some(reporter), Some(page)) = (
        citation.volume.as_deref(),
        citation
            .corrected_reporter
            .as_deref()
            .or(citation.reporter.as_deref()),
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

/// A full case citation as the index build files it: the slugs of every
/// edition citare says it may be in, the one it guesses first, with the volume
/// and page as citare read them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditionSlugs {
    /// One, unless reporters that share an edition name were given slugs of
    /// their own (`Hill`: `hill` and `hill-sc`). A reader may land on any.
    pub slugs: Vec<String>,
    pub volume: String,
    pub page: String,
}

/// The full case citations citare finds in `text`, with their editions'
/// slugs. [`detect_citations`] looks a citation up under the first of them.
pub fn edition_slugs(text: &str) -> Vec<EditionSlugs> {
    citare_core::get_citations(text, false, "", &[])
        .iter()
        .filter(|c| c.type_name() == "FullCaseCitation")
        .filter_map(|c| {
            let r = c.resource_common()?;
            let groups = &c.common().groups;
            let mut slugs: Vec<String> = Vec::new();
            for e in r.edition_guess.iter().chain(&r.all_editions) {
                if let Some(s) = &e.slug {
                    if !slugs.contains(s) {
                        slugs.push(s.clone());
                    }
                }
            }
            Some(EditionSlugs {
                slugs,
                volume: groups.get("volume").cloned().flatten()?,
                page: groups.get("page").cloned().flatten()?,
            })
        })
        .filter(|e| !e.slugs.is_empty())
        .collect()
}

/// Every case-reporter edition name citare knows, with its slugs, sorted: the
/// contents of citare's `data/edition-slugs.json`.
pub fn edition_slug_table() -> std::collections::BTreeMap<String, Vec<String>> {
    let mut table: std::collections::BTreeMap<String, Vec<String>> = Default::default();
    for e in &citare_core::data::get().editions {
        if let Some(slug) = &e.slug {
            let slugs = table.entry(e.short_name.clone()).or_default();
            if !slugs.contains(slug) {
                slugs.push(slug.clone());
            }
        }
    }
    for slugs in table.values_mut() {
        slugs.sort();
    }
    table
}

/// Whether the loaded citare data names editions' slugs. A bundle older than
/// citare v0.6.0 has none, and then citations are looked up by `harvard_slug`.
fn data_has_slugs() -> bool {
    citare_core::data::get()
        .editions
        .iter()
        .any(|e| e.slug.is_some())
}

/// Filter to only citations that have a slug (resolvable via our index).
pub fn resolvable_citations(citations: &[DetectedCitation]) -> Vec<&DetectedCitation> {
    citations
        .iter()
        .filter(|c| c.slug.is_some() && c.volume.is_some() && c.page.is_some())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one citation `text` resolves through, as `(slug, volume, page)`.
    fn resolved(text: &str) -> (String, String, String) {
        let cites = detect_citations(text);
        let r = resolvable_citations(&cites);
        assert_eq!(r.len(), 1, "{text}: {cites:?}");
        let c = r[0];
        (
            c.slug.clone().unwrap(),
            c.volume.clone().unwrap(),
            c.page.clone().unwrap(),
        )
    }

    #[test]
    fn citations_resolve_by_citare_slug() {
        // citare#71's table: CAP's slug where CAP has the reporter, else derived.
        for (text, slug, volume, page) in [
            ("2021 NY Slip Op 01234", "ny-slip-op", "2021", "01234"),
            ("10 F.4th 100", "f-4th", "10", "100"),
            ("100 N.Y.S.3d 200", "n-y-s-3d", "100", "200"),
            ("150 A.D.3d 100", "ad3d", "150", "100"),
            ("400 P.3d 100", "p3d", "400", "100"),
        ] {
            assert_eq!(
                resolved(text),
                (slug.into(), volume.into(), page.into()),
                "{text}"
            );
        }
    }

    #[test]
    fn neutral_citations_share_the_cap_slug_by_volume() {
        // The Ohio neutral citation and CAP's Ohio Reports are both `ohio`,
        // at volumes that can't overlap; likewise `2021 ND 123` and N.D.
        assert_eq!(
            resolved("2019-Ohio-1234"),
            ("ohio".into(), "2019".into(), "1234".into())
        );
        assert_eq!(
            resolved("20 Ohio 1"),
            ("ohio".into(), "20".into(), "1".into())
        );
        assert_eq!(
            resolved("2021 ND 123"),
            ("nd".into(), "2021".into(), "123".into())
        );
        assert_eq!(
            resolved("50 N.D. 1"),
            ("nd".into(), "50".into(), "1".into())
        );
        let nd = detect_citations("2021 ND 123");
        assert_eq!(nd[0].harvard_slug, None);
    }

    #[test]
    fn a_law_has_no_slug_whatever_its_harvard_slug() {
        let cites = detect_citations("N.Y. Penal Law § 125.25");
        let c = cites
            .iter()
            .find(|c| c.citation_type == "FullLawCitation")
            .expect("a law citation");
        assert_eq!(c.slug, None);
        assert!(resolvable_citations(&cites).is_empty());
    }

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
                "See Mich. Comp. Laws § 600.2912a.",
                "https://www.legislature.mi.gov/Laws/MCL?objectName=mcl-600-2912a",
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

    /// The state codes added from the 38-opinion sample and the states
    /// with the most opinions, each URL fetched and showing the section
    /// when the row was added (October 2026).
    #[test]
    fn state_code_patterns() {
        let cases = [
            (
                "See D.C. Code § 48-904.01.",
                "https://code.dccouncil.gov/us/dc/council/code/sections/48-904.01",
            ),
            (
                "See Fla. Stat. § 782.04.",
                "https://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0700-0799/0782/Sections/0782.04.html",
            ),
            (
                "See Fla. Stat. § 39.01.",
                "https://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0000-0099/0039/Sections/0039.01.html",
            ),
            (
                "See Mo. Rev. Stat. § 537.080.",
                "https://revisor.mo.gov/main/OneSection.aspx?section=537.080",
            ),
            (
                "See Mo. Ann. Stat. § 537.080.",
                "https://revisor.mo.gov/main/OneSection.aspx?section=537.080",
            ),
            (
                "See N.C. Gen. Stat. § 50-13.4.",
                "https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/BySection/Chapter_50/GS_50-13.4.html",
            ),
            (
                "See N.C. Gen. Stat. § 15A-1340.14.",
                "https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/BySection/Chapter_15A/GS_15A-1340.14.html",
            ),
            (
                "See Neb. Rev. Stat. § 84-917.",
                "https://nebraskalegislature.gov/laws/statutes.php?statute=84-917",
            ),
            (
                "See N.Y. Penal Law § 125.25.",
                "https://www.nysenate.gov/legislation/laws/PEN/125.25",
            ),
            (
                "See N.Y. Fam. Ct. Act § 413.",
                "https://www.nysenate.gov/legislation/laws/FCT/413",
            ),
            (
                "See N.Y. Educ. Law § 3020-a.",
                "https://www.nysenate.gov/legislation/laws/EDN/3020-A",
            ),
            (
                "See 42 Pa. Cons. Stat. § 5524.",
                "https://www.palegis.us/statutes/consolidated/view-statute?txtType=HTM&ttl=42&div=0&chapter=55&section=24&subsctn=0",
            ),
            (
                "See 18 Pa. Cons. Stat. § 2702.1.",
                "https://www.palegis.us/statutes/consolidated/view-statute?txtType=HTM&ttl=18&div=0&chapter=27&section=02&subsctn=1",
            ),
            (
                "See Tex. Penal Code Ann. § 19.02.",
                "https://tcss.legis.texas.gov/resources/PE/htm/PE.19.htm#19.02",
            ),
            (
                "See Tex. Gov't Code Ann. § 411.081.",
                "https://tcss.legis.texas.gov/resources/GV/htm/GV.411.htm#411.081",
            ),
            (
                "See Wis. Stat. § 752.31.",
                "https://docs.legis.wisconsin.gov/document/statutes/752.31",
            ),
            (
                "See W. Va. Code § 61-11-18.",
                "https://code.wvlegislature.gov/61-11-18/",
            ),
            (
                "See W. Va. Code § 61-2-14a.",
                "https://code.wvlegislature.gov/61-2-14a/",
            ),
            // State courts' own forms, which citare recognizes since
            // v0.5.3 (citare#69) and normalizes to the codes above.
            (
                "See 42 Pa.C.S. § 5322.",
                "https://www.palegis.us/statutes/consolidated/view-statute?txtType=HTM&ttl=42&div=0&chapter=53&section=22&subsctn=0",
            ),
            (
                "See Penal Law § 160.05.",
                "https://www.nysenate.gov/legislation/laws/PEN/160.05",
            ),
            (
                "See Judiciary Law § 487.",
                "https://www.nysenate.gov/legislation/laws/JUD/487",
            ),
            (
                "See Family Ct Act § 413.",
                "https://www.nysenate.gov/legislation/laws/FCT/413",
            ),
            (
                "See N.C.G.S. § 50-13.4.",
                "https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/BySection/Chapter_50/GS_50-13.4.html",
            ),
            (
                "See TEX. PENAL CODE ANN. § 19.02.",
                "https://tcss.legis.texas.gov/resources/PE/htm/PE.19.htm#19.02",
            ),
            (
                "See West Virginia Code § 61-11-18.",
                "https://code.wvlegislature.gov/61-11-18/",
            ),
            (
                "See 19-A M.R.S. § 1653.",
                "https://legislature.maine.gov/statutes/19-A/title19-Asec1653.html",
            ),
            (
                "See 1 M.R.S. § 408-A.",
                "https://legislature.maine.gov/statutes/1/title1sec408-A.html",
            ),
            (
                "See A.R.S. § 13-1105.",
                "https://www.azleg.gov/viewdocument/?docName=https://www.azleg.gov/ars/13/01105.htm",
            ),
        ];
        for (text, url) in cases {
            assert_eq!(sole_external_url(text).as_deref(), Some(url), "{text}");
        }
    }

    /// Every law citation carries its parts, with the jurisdiction when
    /// the code is known, linked or not; nothing else does.
    #[test]
    fn law_citations_carry_their_parts() {
        let law = |text: &str| {
            let cites = detect_citations(text);
            assert_eq!(cites.len(), 1, "{text}");
            cites[0].law.clone()
        };
        assert_eq!(
            law("See 42 Pa. Cons. Stat. § 5524."),
            Some(LawRef {
                jurisdiction: Some("Pennsylvania".into()),
                code: "Pa. Cons. Stat.".into(),
                subject: None,
                title: Some("42".into()),
                chapter: None,
                section: Some("5524".into()),
            })
        );
        let ct = law("See Conn. Gen. Stat. § 52-584.").unwrap();
        assert_eq!(ct.jurisdiction.as_deref(), Some("Connecticut"));
        assert_eq!(ct.section.as_deref(), Some("52-584"));
        assert_eq!(
            law("See 42 U.S.C. § 1983.")
                .unwrap()
                .jurisdiction
                .as_deref(),
            Some("United States")
        );
        // A code with no row in STATE_CODES still has citare's jurisdiction.
        let georgia = law("See Ga. Code Ann. § 16-5-1.").unwrap();
        assert_eq!(georgia.jurisdiction.as_deref(), Some("Georgia"));
        assert_eq!(georgia.code, "Ga. Code Ann.");
        // Forms citare v0.5.3 recognizes (citare#69), with its normalized
        // code: Connecticut's own form, and a New York law by name.
        let ct = law("Under General Statutes § 52-584, the action is barred.").unwrap();
        assert_eq!(
            (
                ct.jurisdiction.as_deref(),
                ct.code.as_str(),
                ct.section.as_deref()
            ),
            (Some("Connecticut"), "Conn. Gen. Stat.", Some("52-584"))
        );
        let ny = law("See N.Y. Gen. Bus. Law § 349.").unwrap();
        assert_eq!(
            (
                ny.jurisdiction.as_deref(),
                ny.code.as_str(),
                ny.subject.as_deref()
            ),
            (Some("New York"), "N.Y. Gen. Bus. Law", Some("Gen. Bus."))
        );
        assert_eq!(law("See 31 A.2d 647."), None);
        let json = serde_json::to_value(&detect_citations("See Wis. Stat. § 752.31.")[0]).unwrap();
        assert_eq!(json["law"]["jurisdiction"], "Wisconsin");
        assert_eq!(json["law"]["section"], "752.31");
    }

    /// The `law` object citare#69 adds, for forms stare's citare doesn't
    /// recognize yet: the jurisdiction from reporters-db and the normalized
    /// code, whatever the citation's spelling. Each links (or doesn't) by
    /// that jurisdiction and code, so these light up with the citare bump.
    #[test]
    fn state_code_urls_from_citares_law_object() {
        let law = |jurisdiction: &str,
                   code: &str,
                   subject: Option<&str>,
                   title: Option<&str>,
                   section: &str| LawRef {
            jurisdiction: Some(jurisdiction.into()),
            code: code.into(),
            subject: subject.map(Into::into),
            title: title.map(Into::into),
            chapter: None,
            section: Some(section.into()),
        };
        let cases = [
            // `42 Pa.C.S. § 5322`
            (
                law("Pennsylvania", "Pa. Cons. Stat.", None, Some("42"), "5322"),
                Some("https://www.palegis.us/statutes/consolidated/view-statute?txtType=HTM&ttl=42&div=0&chapter=53&section=22&subsctn=0"),
            ),
            // `Penal Law § 160.05`, with the subject and without one
            (
                law("New York", "N.Y. Penal Law", Some("Penal"), None, "160.05"),
                Some("https://www.nysenate.gov/legislation/laws/PEN/160.05"),
            ),
            (
                law("New York", "N.Y. Penal Law", None, None, "160.05"),
                Some("https://www.nysenate.gov/legislation/laws/PEN/160.05"),
            ),
            (
                law("New York", "N.Y. Gen. Bus. Law", Some("Gen. Bus."), None, "349"),
                Some("https://www.nysenate.gov/legislation/laws/GBS/349"),
            ),
            // `Family Ct Act § 413`
            (
                law("New York", "N.Y. Family Ct Act", Some("Family Ct Act"), None, "413"),
                Some("https://www.nysenate.gov/legislation/laws/FCT/413"),
            ),
            // `Judiciary Law § 487`, `Vehicle and Traffic Law § 1192`
            (
                law("New York", "N.Y. Judiciary Law", Some("Judiciary"), None, "487"),
                Some("https://www.nysenate.gov/legislation/laws/JUD/487"),
            ),
            (
                law("New York", "N.Y. Vehicle and Traffic Law", Some("Vehicle and Traffic"), None, "1192"),
                Some("https://www.nysenate.gov/legislation/laws/VAT/1192"),
            ),
            // `TEX. PENAL CODE ANN. § 19.02`, `Tex. Fam.Code Ann. § 153.002`
            (
                law("Texas", "Tex. Penal Code Ann.", None, None, "19.02"),
                Some("https://tcss.legis.texas.gov/resources/PE/htm/PE.19.htm#19.02"),
            ),
            (
                law("Texas", "Tex. Fam. Code Ann.", Some("Fam."), None, "153.002"),
                Some("https://tcss.legis.texas.gov/resources/FA/htm/FA.153.htm#153.002"),
            ),
            // `N.C.G.S. § 50-13.4`, `G.S. § 15A-1340.14`
            (
                law("North Carolina", "N.C. Gen. Stat.", None, None, "15A-1340.14"),
                Some("https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/BySection/Chapter_15A/GS_15A-1340.14.html"),
            ),
            // `WIS. STAT. § 752.31`, `West Virginia Code § 61-11-18`, `MCL § 750.316`
            (
                law("Wisconsin", "Wis. Stat.", None, None, "752.31"),
                Some("https://docs.legis.wisconsin.gov/document/statutes/752.31"),
            ),
            (
                law("West Virginia", "W. Va. Code", None, None, "61-11-18"),
                Some("https://code.wvlegislature.gov/61-11-18/"),
            ),
            (
                law("Michigan", "Mich. Comp. Laws", None, None, "750.316"),
                Some("https://www.legislature.mi.gov/Laws/MCL?objectName=mcl-750-316"),
            ),
            // `A.R.S. § 13-1105`
            (
                law("Arizona", "Ariz. Rev. Stat. Ann.", None, None, "13-1105"),
                Some("https://www.azleg.gov/viewdocument/?docName=https://www.azleg.gov/ars/13/01105.htm"),
            ),
            // Recognized, not linked: `General Statutes § 52-557n`,
            // `(Pen. Code, § 211)`, `OCGA § 16-9-93`, `40 P.S. § 1301.101`,
            // `Conn. Practice Book § 60-5`.
            (law("Connecticut", "Conn. Gen. Stat.", None, None, "52-557n"), None),
            (law("California", "Cal. Penal Code", None, None, "211"), None),
            (law("Georgia", "Ga. Code Ann.", None, None, "16-9-93"), None),
            (law("Pennsylvania", "Pa. Stat. Ann.", None, Some("40"), "1301.101"), None),
            (law("Connecticut", "Conn. Practice Book", None, None, "60-5"), None),
            // A code is linked only under its own jurisdiction.
            (law("Virginia", "W. Va. Code", None, None, "61-11-18"), None),
        ];
        for (law, url) in cases {
            assert_eq!(state_code_url(&law).as_deref(), url, "{law:?}");
        }
    }

    /// citare stops some sections short, at an en dash or a comma. The
    /// section it gives isn't the one cited, so there is no link to it.
    #[test]
    fn a_section_cut_short_is_not_linked() {
        for text in [
            "See D.C. Code § 22–2101.",
            "See Neb. Rev. Stat. § 60-6,196.",
        ] {
            let cites = detect_citations(text);
            let c = cites
                .iter()
                .find(|c| c.citation_type == "FullLawCitation")
                .unwrap_or_else(|| panic!("no law citation in {text}"));
            assert_eq!(c.external_url, None, "{text}");
            assert!(c.law.as_ref().unwrap().jurisdiction.is_some(), "{text}");
            assert_eq!(c.law.as_ref().unwrap().section, None, "{text}");
        }
    }

    /// Law citations with no deterministic per-section URL stay unlinked:
    /// public laws before the 104th Congress (govinfo's link service has
    /// none) and state codes not in the list.
    #[test]
    fn external_url_none_without_a_pattern() {
        for text in [
            "See Pub. L. No. 93-205.",
            "See Ga. Code Ann. § 16-5-1.",
            "See Colo. Rev. Stat. § 18-3-102.",
            "Under General Statutes § 52-584, it is barred.",
            "See OCGA § 16-9-93.",
            "See 40 P.S. § 1301.101.",
            "See Conn. Gen. Stat. § 52-584.",
            "See Cal. Penal Code § 187.",
            "See Ohio Rev. Code Ann. § 2903.01.",
            "See Wyo. Stat. Ann. § 16-3-114.",
            "See 34 Pa. Code § 121.7.",
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

    /// #159: a full case citation carries the case name the citing text gives
    /// it, and a parallel citation names the first citation of its run.
    #[test]
    fn full_case_citations_carry_case_names_and_parallels() {
        let cites = detect_citations(
            "See People v. Smith, 123 Ill. 2d 45, 524 N.E.2d 1 (1988). See also Roe v. Wade, 410 U.S. 113 (1973). Id. at 120.",
        );
        let first = find(&cites, "FullCaseCitation", "123 Ill. 2d 45");
        let second = find(&cites, "FullCaseCitation", "524 N.E.2d 1");
        let roe = find(&cites, "FullCaseCitation", "410 U.S. 113");
        assert_eq!(first.case_name.as_deref(), Some("People v. Smith"));
        assert_eq!(second.case_name.as_deref(), Some("People v. Smith"));
        assert_eq!(roe.case_name.as_deref(), Some("Roe v. Wade"));
        let at = |c: &DetectedCitation| cites.iter().position(|x| std::ptr::eq(x, c)).unwrap();
        assert_eq!(first.parallel_of, None);
        assert_eq!(second.parallel_of, Some(at(first)));
        assert_eq!(roe.parallel_of, None, "a different case is not a parallel");
        let id = find(&cites, "IdCitation", "Id.");
        assert_eq!(id.case_name, None);
        assert_eq!(id.parallel_of, None);
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

    /// citare v0.7.0 (citare#76) keeps a parallel group to one decision, so
    /// a supra naming a case decided twice under one name (the district
    /// court and the reversal) has no antecedent. v0.6.0 tied it to the
    /// district court's citation through a group that spanned both.
    #[test]
    fn supra_of_two_decisions_with_one_name_has_no_antecedent() {
        let cites = detect_citations(
            "Brown v. Liberty Loan Corp. of Duval, 392 F.Supp. 1023 (M.D.Fla.1975), \
             rev'd, Brown v. Liberty Loan Corp. of Duval, 539 F.2d 1355 (5th Cir. 1976). \
             The court held. Brown v. Liberty Loan Corp. of Duval, supra, at 1360.",
        );
        let supra = find(&cites, "SupraCitation", "supra,");
        assert!(supra.antecedent.is_none(), "{cites:#?}");
        assert_eq!(supra.page, None);
        assert!(resolvable_citations(&cites)
            .iter()
            .all(|c| c.citation_type == "FullCaseCitation"));
    }

    /// citare#84: `Id., (1990), 52 Ohio St.3d 155` names Murray by an id.
    /// citation. The Id. refers to the citation after it, and that
    /// citation has no case name of its own.
    #[test]
    fn id_used_as_a_case_name() {
        let text = "In re Murray (1990), 52 Ohio St.3d 155, 157; Stanley v. Illinois (1972), \
                    405 U.S. 645, 651. Id., (1990), 52 Ohio St.3d 155, 157.";
        let cites = detect_citations(text);
        let id = find(&cites, "IdCitation", "Id.,");
        let a = id.antecedent.as_ref().expect("antecedent");
        // Murray, not Stanley v. Illinois before it. citare keys both of
        // Murray's citations as one resource, so the antecedent is the
        // first.
        assert_eq!(a.matched_text, "52 Ohio St.3d 155", "{cites:#?}");
        // citare v0.7.1 (citare#89) reads the year before each volume as
        // the citation's own, so it no longer ends the case name.
        let named: Vec<(Option<&str>, Option<i32>)> = cites
            .iter()
            .filter(|c| c.citation_type == "FullCaseCitation")
            .map(|c| (c.case_name.as_deref(), c.year))
            .collect();
        assert_eq!(
            named,
            [
                (Some("Murray"), Some(1990)),
                (Some("Stanley v. Illinois"), Some(1972)),
                (None, Some(1990)),
            ]
        );
    }

    /// citare#89: a year in parentheses right before the volume, Ohio's
    /// style (`Troop A Riding Academy v. Miller (1934), 127 Ohio 545`), is
    /// the citation's year and stays out of the case name. v0.7.0 named the
    /// case `Troop A Riding Academy v. Miller (1934)` and gave it no year.
    #[test]
    fn year_before_the_volume_is_the_citations_year() {
        let cites = detect_citations("Troop A Riding Academy v. Miller (1934), 127 Ohio 545.");
        let c = find(&cites, "FullCaseCitation", "127 Ohio 545");
        assert_eq!(
            c.case_name.as_deref(),
            Some("Troop A Riding Academy v. Miller")
        );
        assert_eq!(c.year, Some(1934));
        assert_eq!(c.slug.as_deref(), Some("ohio-st"));
        assert_eq!(c.corrected_reporter.as_deref(), Some("Ohio St."));
        // Without a comma, and through a parallel run: both printings carry
        // the year and the name, and the second is the first's parallel.
        let cites = detect_citations("See Stanley v. Illinois (1972) 405 U.S. 645, 92 S.Ct. 1208.");
        let us = find(&cites, "FullCaseCitation", "405 U.S. 645");
        let sct = find(&cites, "FullCaseCitation", "92 S.Ct. 1208");
        for c in [us, sct] {
            assert_eq!(c.case_name.as_deref(), Some("Stanley v. Illinois"));
            assert_eq!(c.year, Some(1972));
        }
        assert_eq!(sct.parallel_of, Some(0));
    }

    /// citare#84: the parallel citations of a certiorari denial, which have
    /// no case name, are one run of their own, apart from the decision
    /// before them (citare#76).
    #[test]
    fn nameless_parallel_run_in_subsequent_history() {
        let cites = detect_citations(
            "Flaksa v. Little River Marine Construction Co., 389 F.2d 885 (5th Cir.), \
             cert. den., 392 U.S. 928, 88 S.Ct. 2287, 20 L.Ed.2d 1387 (1968).",
        );
        let parallels: Vec<(&str, Option<usize>, Option<&str>)> = cites
            .iter()
            .map(|c| {
                (
                    c.matched_text.as_str(),
                    c.parallel_of,
                    c.case_name.as_deref(),
                )
            })
            .collect();
        let flaksa = Some("Flaksa v. Little River Marine Construction Co.");
        assert_eq!(
            parallels,
            [
                ("389 F.2d 885", None, flaksa),
                ("392 U.S. 928", None, None),
                ("88 S.Ct. 2287", Some(1), None),
                ("20 L.Ed.2d 1387", Some(1), None),
            ]
        );
    }

    /// #212: a nameless citation in another's subsequent history takes its name.
    #[test]
    fn subsequent_history_takes_the_name_it_follows() {
        let names = |text: &str| -> Vec<(String, Option<String>, Option<String>)> {
            detect_citations(text)
                .into_iter()
                .filter(|c| c.citation_type == "FullCaseCitation")
                .map(|c| (c.matched_text, c.case_name, c.history_name))
                .collect()
        };
        let segreto = || Some("Segreto v. Bristol".to_string());
        let found = names(
            "Segreto v. Bristol, 71 Conn.App. 844, 848, 804 A.2d 928, cert. denied, 261 Conn. 941, 808 A.2d 1132 (2002).",
        );
        assert_eq!(found[2], ("261 Conn. 941".into(), None, segreto()));
        assert_eq!(found[3], ("808 A.2d 1132".into(), None, segreto()));
        let flaksa = names(
            "Flaksa v. Little River Marine Construction Co., 389 F.2d 885 (5th Cir.), \
             cert. den., 392 U.S. 928, 88 S.Ct. 2287, 20 L.Ed.2d 1387 (1968).",
        );
        let name = Some("Flaksa v. Little River Marine Construction Co.".to_string());
        assert!(flaksa[1..]
            .iter()
            .all(|(_, own, history)| own.is_none() && *history == name));
        // Other spellings of history: N.J.'s `certif. denied`, `reh. denied`, a bracketed
        // note, and a second history after a semicolon.
        for (text, at) in [
            ("Hantman v. Township of Randolph, 58 N.J.Super. 127, 155 A.2d 554 (App.Div.1959), certif. denied, 31 N.J. 550.", 2),
            ("United States v. Mendenhall, 446 U.S. 544, 553-54, 100 S. Ct. 1870, 64 L. Ed. 2d 497, reh. denied, 448 U.S. 908.", 3),
            ("United States v. Rosenwasser, 550 F.2d 806, 814 (2d Cir.) [Gurfein, J., dissenting], cert. denied, 434 U.S. 825.", 1),
            ("Exxon Corp. v. FTC, 589 F.2d 582, 587 (D.C.Cir.1978), cert, denied, 441 U.S. 943.", 1),
        ] {
            let found = names(text);
            assert!(found[at].1.is_none() && found[at].2.as_deref() == found[0].1.as_deref(), "{text}: {found:?}");
        }
        // A citation after a new sentence, or history under another name, takes none.
        for text in [
            "Roe v. Wade, 410 U.S. 113 (1973). See 261 Conn. 941.",
            "Roe v. Wade, 410 U.S. 113 (1973), aff'd sub nom. Doe v. Bolton, 261 Conn. 941.",
        ] {
            assert!(
                names(text).iter().all(|(_, _, history)| history.is_none()),
                "{text}"
            );
        }
    }

    /// citare#86: `127 Ohio 545` is the Ohio State Reports, CAP's
    /// `ohio-st`, read as a variation; the Ohio Reports end at volume 20.
    /// It keeps the reporter it was cited with, and links out under the
    /// one it was read as.
    #[test]
    fn a_variation_is_read_as_its_edition() {
        let cites = detect_citations("Troop A Riding Academy v. Miller, 127 Ohio 545 (1934).");
        let c = find(&cites, "FullCaseCitation", "127 Ohio 545");
        assert_eq!(c.slug.as_deref(), Some("ohio-st"));
        assert_eq!(c.harvard_slug.as_deref(), Some("ohio-st"));
        assert_eq!(c.reporter.as_deref(), Some("Ohio"));
        assert_eq!(c.corrected_reporter.as_deref(), Some("Ohio St."));
        assert_eq!(
            c.case_links[0].url,
            "https://www.courtlistener.com/c/Ohio%20St./127/545/"
        );
        assert!(c.case_links[1].url.ends_with("q=%22127+Ohio+St.+545%22"));
        // The Ohio Reports' own volumes, and an edition's own name or a
        // spacing of it, aren't variations.
        for text in ["20 Ohio 1", "410 U. S. 113", "3 F. 2d 4", "100 Ohio St. 1"] {
            let cites = detect_citations(text);
            assert_eq!(cites.len(), 1, "{text}");
            assert_eq!(cites[0].corrected_reporter, None, "{text}");
        }
        assert!(detect_citations("300 Ohio 5").is_empty());
        // A short form's antecedent carries it.
        let cites =
            detect_citations("Troop A Riding Academy v. Miller, 127 Ohio 545 (1934). Id. at 547.");
        let id = find(&cites, "IdCitation", "Id.");
        assert_eq!(
            id.antecedent
                .as_ref()
                .unwrap()
                .corrected_reporter
                .as_deref(),
            Some("Ohio St.")
        );
    }

    /// A state's official reporter and the U.S. Reports are official; a
    /// regional reprint, the Supreme Court Reporter and a federal reporter
    /// aren't (#160).
    #[test]
    fn official_reporters() {
        let cites = detect_citations(
            "Pettegrew v. Pettegrew, 128 Neb. 783, 260 N.W. 287 (1935). \
             Roe v. Wade, 410 U.S. 113, 93 S. Ct. 705 (1973). \
             Smith v. Jones, 31 A.2d 650, 150 Pa. Super. 1 (1943). 10 F.4th 100.",
        );
        let official: Vec<(&str, bool)> = cites
            .iter()
            .map(|c| (c.matched_text.as_str(), c.official))
            .collect();
        assert_eq!(
            official,
            [
                ("128 Neb. 783", true),
                ("260 N.W. 287", false),
                ("410 U.S. 113", true),
                ("93 S. Ct. 705", false),
                ("31 A.2d 650", false),
                ("150 Pa. Super. 1", true),
                ("10 F.4th 100", false),
            ]
        );
    }

    /// citare#79: a citation citare can't narrow to one edition takes the
    /// CAP reporter, not an edition split off its name: `172 Wash. 688` is
    /// Washington's, not Virginia's `wash-va`.
    #[test]
    fn an_ambiguous_name_takes_the_cap_reporter() {
        for (text, slug) in [
            ("172 Wash. 688", "wash"),
            ("1995 Mass. App. Div. 12", "mass-app-div-annual"),
            ("10 Mass. App. Div. 12", "mass-app-div"),
            ("171 Ct.Cl. 497", "us-ct-cl"),
        ] {
            assert_eq!(resolved(text).0, slug, "{text}");
        }
        assert_eq!(
            detect_citations("2012-Ohio-3150")[0].harvard_slug,
            None,
            "a year volume CAP's ohio doesn't file"
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
