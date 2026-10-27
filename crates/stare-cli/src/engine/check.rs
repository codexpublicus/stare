//! Checking a text's citations, as `stare check` and the site's brief checker do: every
//! citation citare finds, looked up, its parallel runs reconciled (#160), a page several
//! cases start on settled by the citing text's case name (#212), and the citations
//! grouped by the case they cite (#198).

use super::fetch::{fetch_record, fetch_zip, zip_directory};
use super::resolve::{cited_page, idx_entries};
use super::Sources;
use anyhow::Result;
use serde::Serialize;
use stare::config;

/// How a citation in `stare check` resolves, as the site shows it
/// (`web/public/js/citations.js`, `checkCitation`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    /// A case starts at the page: stare.pub has it.
    Found,
    /// The page is a parallel citation of a case stare.pub has, through an alias from
    /// CourtListener's citation metadata (#151): found, labelled with its source.
    FoundAlias,
    /// Not found on its own, but citare reads it as a parallel citation of one that is
    /// (#160): found through that partner, labelled as inferred from the citing text.
    FoundPartner,
    /// A statute or regulation, linked to its text.
    External,
    /// A statute or regulation with no link to its text yet.
    Statute,
    /// stare.pub holds the volume, but no case starts at the page.
    HeldMiss,
    /// stare.pub doesn't hold the volume; the case links may have it.
    NotHeld,
    /// A short form citare couldn't tie to an earlier citation.
    NoAntecedent,
    /// Nothing to look up: no reporter, volume or page.
    Unchecked,
}

impl CheckStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            CheckStatus::Found => "found",
            CheckStatus::FoundAlias => "found_alias",
            CheckStatus::FoundPartner => "found_partner",
            CheckStatus::External => "external",
            CheckStatus::Statute => "statute",
            CheckStatus::HeldMiss => "held_miss",
            CheckStatus::NotHeld => "not_held",
            CheckStatus::NoAntecedent => "no_antecedent",
            CheckStatus::Unchecked => "unchecked",
        }
    }

    /// Whether a citation with this status opens a case.
    pub fn resolvable(self) -> bool {
        matches!(
            self,
            CheckStatus::Found | CheckStatus::FoundAlias | CheckStatus::FoundPartner
        )
    }
}

/// What one citation is looked up as: the citation itself, or a short
/// form's antecedent. A short form is never looked up at its pin page.
pub struct CheckTarget<'a> {
    pub slug: Option<String>,
    /// The edition a variation was read as (`Ohio St.` for `127 Ohio 545`),
    /// else the reporter as cited.
    pub reporter: Option<&'a str>,
    pub volume: Option<u32>,
    pub page: Option<&'a str>,
    pub external_url: Option<&'a str>,
    /// A statute or regulation (it has a `LawRef`).
    pub law: bool,
    pub case_links: &'a [stare::cite::CaseLink],
}

pub fn check_target(c: &stare::cite::DetectedCitation) -> Option<CheckTarget<'_>> {
    let slug_for = |slug: &Option<String>, reporter: &Option<String>| {
        slug.clone().or_else(|| {
            reporter
                .as_deref()
                .map(|r| r.to_lowercase().replace(['.', ' '], ""))
                .filter(|s| !s.is_empty())
        })
    };
    if c.is_short_form() {
        let a = c.antecedent.as_ref()?;
        return Some(CheckTarget {
            slug: slug_for(&a.slug, &a.reporter),
            reporter: a.corrected_reporter.as_deref().or(a.reporter.as_deref()),
            volume: a.volume.as_deref().and_then(|v| v.parse().ok()),
            page: a.page.as_deref(),
            external_url: a.external_url.as_deref(),
            law: a.law.is_some(),
            case_links: &a.case_links,
        });
    }
    Some(CheckTarget {
        slug: slug_for(&c.slug, &c.reporter),
        reporter: c.corrected_reporter.as_deref().or(c.reporter.as_deref()),
        volume: c.volume.as_deref().and_then(|v| v.parse().ok()),
        page: c.page.as_deref(),
        external_url: c.external_url.as_deref(),
        law: c.law.is_some() || c.citation_type == "FullLawCitation",
        case_links: &c.case_links,
    })
}

/// Whether stare.pub holds `volume` of `slug`, whether a case starts at `page` in it,
/// and the `via` of the alias it resolved through, if it did: from the unified index
/// when the build has one, else from the `.bin` files (and the other parts of a volume
/// CAP split). A volume whose index has only aliases (the manifest's `aliases`) isn't
/// held: a hit there resolves, and a miss is like any volume stare.pub doesn't hold.
#[cfg(test)]
pub fn check_page(
    src: &Sources,
    slug: &str,
    volume: u32,
    page: u32,
) -> (bool, bool, Option<String>) {
    check_page_key(
        src,
        slug,
        volume,
        &stare::index::PageKey::Number(page as usize),
    )
}

/// `check_page` for a page as the index keys it: a number, or a label (`xxix`), which
/// the `.bin` files keep in the folder's `.multi`.
pub fn check_page_key(
    src: &Sources,
    slug: &str,
    volume: u32,
    key: &stare::index::PageKey,
) -> (bool, bool, Option<String>) {
    use super::fetch::{fetch_bin, fetch_multi};
    let cited = volume.to_string();
    let held_by_manifest = src.manifest().is_some_and(|m| m.holds_volume(slug, &cited));
    if let Ok(Some(entries)) = idx_entries(src, slug, &cited, key) {
        let alias_only = src
            .manifest()
            .is_some_and(|m| m.has_alias_volume(slug, &cited));
        let found = !entries.is_empty();
        let via = entries.first().and_then(|e| e.via.clone());
        return ((held_by_manifest || !alias_only) || found, found, via);
    }
    let page = match key {
        stare::index::PageKey::Number(n) => *n as u32,
        stare::index::PageKey::Label(label) => {
            let multi = fetch_multi(src, slug, &cited).ok().flatten();
            let labeled = stare::index::parse_labeled(multi.as_deref().unwrap_or(""));
            let found = !stare::index::lookup_label(&labeled, label).is_empty();
            let held = found || held_by_manifest || fetch_bin(src, slug, &cited).is_ok();
            return (held, found, None);
        }
    };
    let mut candidates = vec![cited.clone()];
    if let Some(m) = src.manifest() {
        for v in m.candidates(slug, &cited, page) {
            if !candidates.contains(&v) {
                candidates.push(v);
            }
        }
    }
    let found = stare::manifest::locate(&candidates, page, |v| fetch_bin(src, slug, v)).is_ok();
    let held = found || held_by_manifest || fetch_bin(src, slug, &cited).is_ok();
    (held, found, None)
}

pub fn check_status(src: &Sources, c: &stare::cite::DetectedCitation) -> CheckStatus {
    let Some(t) = check_target(c) else {
        return CheckStatus::NoAntecedent;
    };
    if t.external_url.is_some() {
        // A statute's text is the place for a plain `Id.`; with a pin
        // (`Id. § 1985`) it is a different section, which nothing here
        // can link to.
        return if c.is_short_form() && c.pin.is_some() {
            CheckStatus::Statute
        } else {
            CheckStatus::External
        };
    }
    if t.law {
        return CheckStatus::Statute;
    }
    let (Some(slug), Some(volume), Some(page)) =
        (t.slug.as_deref(), t.volume, t.page.and_then(cited_page))
    else {
        return CheckStatus::Unchecked;
    };
    match check_page_key(src, slug, volume, &page) {
        (_, true, Some(_)) => CheckStatus::FoundAlias,
        (_, true, None) => CheckStatus::Found,
        (true, false, _) => CheckStatus::HeldMiss,
        (false, false, _) if !t.case_links.is_empty() => CheckStatus::NotHeld,
        _ => CheckStatus::Unchecked,
    }
}

/// Every case at the page of a citation that is found, the one a reader opens first, as
/// [`stare::parallel::page_cases`] names them (#204), so a parallel citation through an
/// alias and the citation it is an alias of meet, even at a page several cases start
/// on. Without the unified index, the page's first case alone. The index files it
/// reads are cached by then.
pub fn check_cases(src: &Sources, c: &stare::cite::DetectedCitation) -> Vec<String> {
    let Some(t) = check_target(c) else {
        return Vec::new();
    };
    let (Some(page), Some(slug), Some(volume)) = (
        t.page.and_then(cited_page),
        t.slug,
        t.volume.map(|v| v.to_string()),
    ) else {
        return Vec::new();
    };
    if let Ok(Some(entries)) = idx_entries(src, &slug, &volume, &page) {
        let entries: Vec<&stare::idx::Entry> = entries.iter().collect();
        let cases = stare::parallel::page_cases(&slug, &volume, &page, &entries);
        if !cases.is_empty() {
            return cases;
        }
    }
    vec![stare::parallel::case_at(&slug, &volume, &page)]
}

/// [`check_cases`] with where each case is read from, for its name (#212); empty
/// without the unified index.
pub fn check_case_refs(
    src: &Sources,
    c: &stare::cite::DetectedCitation,
) -> Vec<(String, stare::parallel::CaseRef)> {
    let Some(t) = check_target(c) else {
        return Vec::new();
    };
    let (Some(page), Some(slug), Some(volume)) = (
        t.page.and_then(cited_page),
        t.slug,
        t.volume.map(|v| v.to_string()),
    ) else {
        return Vec::new();
    };
    match idx_entries(src, &slug, &volume, &page) {
        Ok(Some(entries)) => {
            let entries: Vec<&stare::idx::Entry> = entries.iter().collect();
            stare::parallel::page_case_refs(&slug, &volume, &page, &entries)
        }
        _ => Vec::new(),
    }
}

/// The `via` of the alias at a citation's page that names `case`, if one does.
pub fn check_case_via(
    src: &Sources,
    c: &stare::cite::DetectedCitation,
    case: &str,
) -> Option<String> {
    let t = check_target(c)?;
    let entries = idx_entries(
        src,
        t.slug.as_deref()?,
        &t.volume?.to_string(),
        &cited_page(t.page?)?,
    )
    .ok()
    .flatten()?;
    entries.into_iter().find_map(|e| {
        let (reporter, folder, file) = e.alias_target()?;
        (stare::parallel::alias_case(reporter, folder, file) == case)
            .then_some(e.via)
            .flatten()
    })
}

/// How a citation's case was picked by the citing text's case name (#212).
#[derive(Debug, Clone)]
pub struct ByName {
    /// The case it opens.
    pub case: String,
    /// How many cases it was picked among.
    pub among: usize,
    /// Whether those were the cases its parallel citations share, not every case at
    /// its page.
    pub shared: bool,
    /// When none of the cases its run's printings share fits the name and one case on
    /// the official printing's page does (D90), that printing (`455 U.S. 989`), and
    /// `among` counts the cases at its page.
    pub official: Option<String>,
    /// Whether the run's printings shared one case, which clearly isn't the one the
    /// name names (D98 (1)), rather than several.
    pub shares_one: bool,
}

impl ByName {
    /// "matched by case name among the 3 cases on this page", as the site says it.
    pub fn note(&self) -> String {
        if let Some(official) = &self.official {
            let missed = if self.shares_one {
                "the case its parallel citations share doesn't fit the name"
            } else {
                "the cases its parallel citations share don't include it"
            };
            format!(
                "matched by case name among the {} cases on the official page, {}; {}",
                self.among, official, missed
            )
        } else if self.shared {
            format!(
                "matched by case name among the {} cases its parallel citations share",
                self.among
            )
        } else {
            format!(
                "matched by case name among the {} cases on this page",
                self.among
            )
        }
    }
}

/// For each full case citation found at a page several cases start on, with nothing
/// else to say which it means (no alias names one, and its parallel citations, if any,
/// share more than one), the case its name in the citing text picks
/// ([`stare::byname::pick`]), by raw string. A citation no one case matches clearly
/// isn't in it, and opens the page's first case as before.
///
/// When a run's printings share several cases, none of them fits the name, and exactly
/// one case on the official printing's whole page does, every printing in the run
/// opens that case (D90, [`stare::byname::pick_on_official_page`]); likewise when they
/// share one case that clearly isn't the one the name names (D98 (1)).
pub fn names_pick(
    src: &Sources,
    detected: &[stare::cite::DetectedCitation],
    parallels: &std::collections::HashMap<String, ParallelVerdict>,
) -> std::collections::HashMap<String, ByName> {
    let mut out = std::collections::HashMap::new();
    let mut reader = NameReader::default();
    // The official printings picked on their whole page (D90), by raw string.
    let mut official_picks: std::collections::HashMap<String, ByName> = Default::default();
    for c in detected {
        if c.citation_type != "FullCaseCitation" || out.contains_key(&c.matched_text) {
            continue;
        }
        let Some(name) = c.case_name.as_deref().or(c.history_name.as_deref()) else {
            continue;
        };
        if !matches!(
            check_status(src, c),
            CheckStatus::Found | CheckStatus::FoundAlias
        ) {
            continue;
        }
        let refs = check_case_refs(src, c);
        let verdict = parallels.get(&c.matched_text);
        let open: Vec<String> = match verdict {
            Some(v) if !v.conflicts.is_empty() => continue,
            Some(v) if v.case.is_some() => v.tied.clone(),
            _ => refs.iter().map(|(id, _)| id.clone()).collect(),
        };
        // Its parallel citations narrowed the page's cases to these.
        let shared = open.len() < refs.len();
        let mut candidate = |id: &String, r: &stare::parallel::CaseRef| match reader.names(src, r) {
            Some(names) => names.candidate(id),
            None => stare::byname::Candidate {
                id: id.clone(),
                ..Default::default()
            },
        };
        let official = verdict.and_then(|v| v.official.as_ref()) == Some(&c.matched_text);
        if open.len() < 2 {
            // A run whose printings share one case, at an official page with several
            // (D98 (1)).
            let one = verdict
                .filter(|v| v.tied.is_empty())
                .and_then(|v| v.case.clone());
            if let (true, Some(one)) = (official && refs.len() > 1, one) {
                let page: Vec<stare::byname::Candidate> =
                    refs.iter().map(|(id, r)| candidate(id, r)).collect();
                if let Some(case) = stare::byname::pick_on_official_page(
                    &page,
                    std::slice::from_ref(&one),
                    name,
                    c.year,
                ) {
                    official_picks.insert(
                        c.matched_text.clone(),
                        ByName {
                            case: case.to_string(),
                            among: refs.len(),
                            shared: false,
                            official: Some(c.matched_text.clone()),
                            shares_one: true,
                        },
                    );
                }
            }
            continue;
        }
        let candidates: Vec<stare::byname::Candidate> = refs
            .iter()
            .filter(|(id, _)| open.contains(id))
            .map(|(id, r)| candidate(id, r))
            .collect();
        if let Some(case) = stare::byname::pick(&candidates, name, c.year) {
            out.insert(
                c.matched_text.clone(),
                ByName {
                    case: case.to_string(),
                    among: open.len(),
                    shared,
                    official: None,
                    shares_one: false,
                },
            );
        } else if shared && official {
            let page: Vec<stare::byname::Candidate> =
                refs.iter().map(|(id, r)| candidate(id, r)).collect();
            if let Some(case) = stare::byname::pick_on_official_page(&page, &open, name, c.year) {
                official_picks.insert(
                    c.matched_text.clone(),
                    ByName {
                        case: case.to_string(),
                        among: refs.len(),
                        shared: false,
                        official: Some(c.matched_text.clone()),
                        shares_one: false,
                    },
                );
            }
        }
    }
    // Every printing in such a run opens the case its official printing's page names;
    // one found through its partner follows that partner, as before.
    for (raw, v) in parallels.iter().filter(|(_, v)| v.partner.is_none()) {
        if let Some(pick) = v.official.as_ref().and_then(|o| official_picks.get(o)) {
            out.insert(raw.clone(), pick.clone());
        }
    }
    out
}

/// Reads the names of cases at a page: a CAP case's JSON from its volume's zip (the
/// zip when it is cached or the data source is a directory, else by range requests,
/// [`stare::ziprange`]), or a CourtListener record. Each zip's directory is read once.
#[derive(Default)]
pub struct NameReader {
    directories: std::collections::HashMap<String, Option<Vec<stare::ziprange::Entry>>>,
}

impl NameReader {
    pub fn names(
        &mut self,
        src: &Sources,
        r: &stare::parallel::CaseRef,
    ) -> Option<stare::byname::CaseNames> {
        use stare::parallel::CaseRef;
        match r {
            CaseRef::Cl { cluster_id, hash } => {
                let bytes = fetch_record(src, *cluster_id, hash).ok()?;
                let case = stare::cl::decode_record(&bytes).ok()?;
                Some(stare::byname::CaseNames {
                    name: Some(case.name),
                    name_abbreviation: Some(case.name_abbreviation),
                    decision_date: Some(case.decision_date),
                })
            }
            CaseRef::Cap {
                reporter,
                folder,
                case_file,
            } => {
                let file = format!("json/{case_file}.json");
                let key = format!("{reporter}/{folder}/{file}");
                if let Some(bytes) = config::cache_get("zips", &key) {
                    return stare::byname::CaseNames::parse(&bytes).ok();
                }
                let zip_key = format!("{reporter}/{folder}.zip");
                let bytes = if config::cache_get("zips", &zip_key).is_some()
                    || !Sources::is_url(&src.data)
                {
                    let zip = fetch_zip(src, reporter, folder).ok()?;
                    stare::case::extract_file_from_zip(&zip, &file)
                        .ok()?
                        .into_bytes()
                } else {
                    let url = format!("{}/{}", src.data, zip_key);
                    let entries = self
                        .directories
                        .entry(zip_key)
                        .or_insert_with(|| zip_directory(&url).ok())
                        .as_ref()?;
                    let entry = entries.iter().find(|e| e.name == file)?;
                    let range = format!("bytes={}-{}", entry.start, entry.end.saturating_sub(1));
                    let (bytes, start) = super::fetch::fetch_range(&url, &range).ok()?;
                    stare::ziprange::entry(&bytes, start, entry).ok()?
                };
                let _ = config::cache_set("zips", &key, &bytes);
                stare::byname::CaseNames::parse(&bytes).ok()
            }
        }
    }
}

/// What reconciling the text's parallel runs (#160) says of a citation, by its raw string.
#[derive(Default)]
pub struct ParallelVerdict {
    /// The raw string of the citation it is found through.
    pub partner: Option<String>,
    /// The raw strings of its parallel citations that open a different case.
    pub conflicts: Vec<String>,
    /// The raw string of the first citation of its run, when it has conflicts.
    pub run: Option<String>,
    /// The case its run agrees on, which it opens (#204).
    pub case: Option<String>,
    /// When its run's printings share more than one case, all of them (#212).
    pub tied: Vec<String>,
    /// Whether it is the printing its run shows by default (R3).
    pub preferred: bool,
    /// The raw string of its run's official printing (`DetectedCitation::official`),
    /// when the run agrees and that printing is the one it shows by default (D90).
    pub official: Option<String>,
}

/// [`stare::parallel::reconcile`] over the full case citations in `detected`, with
/// `status` and `cases` looking each up (every case at its page), gathered by raw string.
pub fn reconcile_parallels(
    detected: &[stare::cite::DetectedCitation],
    mut status: impl FnMut(&stare::cite::DetectedCitation) -> CheckStatus,
    mut cases: impl FnMut(&stare::cite::DetectedCitation) -> Vec<String>,
) -> std::collections::HashMap<String, ParallelVerdict> {
    use stare::parallel::{Lookup, Printing};
    let mut out: std::collections::HashMap<String, ParallelVerdict> = Default::default();
    // Index in `detected` → index among the printings.
    let mut printing_of: std::collections::HashMap<usize, usize> = Default::default();
    let mut members = Vec::new();
    let mut printings: Vec<Printing> = Vec::new();
    for (i, c) in detected.iter().enumerate() {
        if c.citation_type != "FullCaseCitation" {
            continue;
        }
        let at = printings.len();
        let run = c
            .parallel_of
            .and_then(|r| printing_of.get(&r).copied())
            .map(|r| printings[r].run)
            .unwrap_or(at);
        printing_of.insert(i, at);
        members.push(c);
        printings.push(Printing {
            run,
            official: c.official,
            lookup: Lookup::Unknown,
        });
    }
    if printings.iter().enumerate().all(|(i, p)| p.run == i) {
        return out;
    }
    for (p, c) in printings.iter_mut().zip(&members) {
        p.lookup = match status(c) {
            CheckStatus::Found | CheckStatus::FoundAlias => match cases(c) {
                cases if cases.is_empty() => Lookup::Unknown,
                cases => Lookup::Found { cases },
            },
            CheckStatus::HeldMiss => Lookup::HeldMiss,
            CheckStatus::NotHeld => Lookup::NotHeld,
            _ => Lookup::Unknown,
        };
    }
    let verdicts = stare::parallel::reconcile(&printings);
    for (i, v) in verdicts.iter().enumerate() {
        let raw = &members[i].matched_text;
        let entry = out.entry(raw.clone()).or_default();
        if let Some(p) = v.partner {
            entry
                .partner
                .get_or_insert_with(|| members[p].matched_text.clone());
        }
        for &j in &v.conflicts {
            let other = &members[j].matched_text;
            if other != raw && !entry.conflicts.contains(other) {
                entry.conflicts.push(other.clone());
            }
        }
        if !v.conflicts.is_empty() {
            entry.run = Some(members[printings[i].run].matched_text.clone());
        }
        if entry.case.is_none() {
            entry.case = v.case.clone();
            entry.tied = v.tied.clone();
        }
        entry.preferred |= v.preferred;
        if v.case.is_some() && entry.official.is_none() {
            entry.official = (0..printings.len())
                .find(|&j| {
                    printings[j].run == printings[i].run
                        && printings[j].official
                        && verdicts[j].preferred
                })
                .map(|j| members[j].matched_text.clone());
        }
    }
    out
}

/// The `via` of the alias a citation resolved through (`cl:8077312`), for a citation
/// whose status is [`CheckStatus::FoundAlias`]. The index files it reads are cached by
/// then.
pub fn check_via(src: &Sources, c: &stare::cite::DetectedCitation) -> Option<String> {
    let t = check_target(c)?;
    let page = cited_page(t.page?)?;
    check_page_key(src, t.slug.as_deref()?, t.volume?, &page).2
}

/// How a citation's case was picked by name, as `stare check --json` gives it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ByNameNote {
    pub among: usize,
    pub note: String,
    pub official: Option<String>,
    pub shared: bool,
}

/// One listed citation of a checked text: one per citation and antecedent, in text
/// order. Its JSON is `stare check --json`'s, field for field; the fields are declared
/// in the order the JSON lists them.
#[derive(Debug, Clone, Serialize)]
pub struct CheckedCitation {
    /// The full citation a short form refers to.
    pub antecedent: Option<String>,
    pub by_name: Option<ByNameNote>,
    /// The case it resolves to, as [`stare::parallel`] names cases (`a2d/31/657-2`).
    pub case: Option<String>,
    pub case_links: Vec<stare::cite::CaseLink>,
    /// Its parallel citations that open a different case.
    pub conflicts: Vec<String>,
    /// The places in the text that cite its case in this form.
    pub count: usize,
    pub external_url: Option<String>,
    /// Its cited case, as an index into [`CheckReport::grouping`]'s groups.
    pub group: usize,
    pub needs_review: bool,
    pub page: Option<String>,
    /// The citation it is found through.
    pub partner: Option<String>,
    pub pin: Option<String>,
    pub raw: String,
    pub reporter: Option<String>,
    pub resolvable: bool,
    pub slug: Option<String>,
    pub status: CheckStatus,
    #[serde(rename = "type")]
    pub citation_type: String,
    /// The alias it resolved through (`cl:8077312`).
    pub via: Option<String>,
    pub volume: Option<u32>,
}

/// What checking a text found.
#[derive(Debug, Clone)]
pub struct CheckReport {
    pub citations: Vec<CheckedCitation>,
    /// The cited cases: [`stare::cited::group`] over the citations.
    pub grouping: stare::cited::Grouping,
    /// For each cited case, the citation it is listed by.
    pub primaries: Vec<usize>,
    /// How many cited cases are statutes or regulations.
    pub statutes: usize,
    /// How many cited cases that aren't statutes resolve.
    pub resolvable: usize,
    /// How many parallel runs open different cases.
    pub needs_review: usize,
}

impl CheckReport {
    /// How many cited cases aren't statutes.
    pub fn cited_cases(&self) -> usize {
        self.primaries.len() - self.statutes
    }

    /// `stare check --json`: the citations, keys sorted as the JSON has always had
    /// them.
    pub fn to_json(&self) -> Result<String> {
        Ok(serde_json::to_string_pretty(&serde_json::to_value(
            &self.citations,
        )?)?)
    }
}

/// Check every citation in `text`.
pub fn check_text(src: &Sources, text: &str) -> CheckReport {
    let detected = stare::cite::detect_citations(text);
    let mut statuses = std::collections::HashMap::new();
    let parallels = reconcile_parallels(
        &detected,
        |c| {
            *statuses
                .entry(c.matched_text.clone())
                .or_insert_with(|| check_status(src, c))
        },
        |c| check_cases(src, c),
    );
    // The case the citing text's name picks at a shared page (#212).
    let picked = names_pick(src, &detected, &parallels);

    // One entry per citation and antecedent: every `Id.` that refers to
    // the same case shares one, and `Id.`s that refer to different cases
    // don't.
    let mut seen = std::collections::HashSet::new();
    let mut citations = Vec::new();
    let mut cited = Vec::new();
    let mut primary_rank = Vec::new();
    for c in &detected {
        // A bare `§` citare can't tie to a code names nothing to look up,
        // and the site neither lists nor counts it.
        if c.citation_type == "UnknownCitation" {
            continue;
        }
        let antecedent = c.antecedent.as_ref().map(|a| a.matched_text.clone());
        if !seen.insert((c.matched_text.clone(), antecedent.clone())) {
            continue;
        }
        let mut status = check_status(src, c);
        let mut via = (status == CheckStatus::FoundAlias)
            .then(|| check_via(src, c))
            .flatten();
        // A full citation's own verdict, or a short form's antecedent's partner.
        let own = parallels
            .get(&c.matched_text)
            .filter(|_| !c.is_short_form());
        let partner = parallels
            .get(antecedent.as_ref().unwrap_or(&c.matched_text))
            .and_then(|v| v.partner.clone());
        if partner.is_some() && matches!(status, CheckStatus::HeldMiss | CheckStatus::NotHeld) {
            status = CheckStatus::FoundPartner;
        }
        let partner = partner.filter(|_| status == CheckStatus::FoundPartner);
        let conflicts = own.map(|v| v.conflicts.clone()).unwrap_or_default();
        let target = check_target(c);
        let resolvable = status.resolvable();
        // The case it resolves to (#198): the one its name picks at a shared page (#212),
        // or its partner's name does, else the one its parallel run agrees on (#204), else
        // the page's first.
        let by_name = (!c.is_short_form())
            .then(|| picked.get(&c.matched_text))
            .flatten();
        let case = (resolvable && !c.is_short_form())
            .then(|| {
                by_name
                    .or_else(|| partner.as_ref().and_then(|p| picked.get(p)))
                    .map(|b| b.case.clone())
                    .or_else(|| own.and_then(|v| v.case.clone()))
                    .or_else(|| check_cases(src, c).into_iter().next())
            })
            .flatten();
        // At a page with several aliases, the alias that names the case it opens. A
        // printing that opens the case its official printing's page names (D90) has
        // none when no alias at its own page names that case.
        if let (Some(_), Some(case)) = (&via, &case) {
            let fallback = via
                .take()
                .filter(|_| !by_name.is_some_and(|b| b.official.is_some()));
            via = check_case_via(src, c, case).or(fallback);
        }
        let needs_review = !conflicts.is_empty();
        cited.push(cited_entry(c, status, case.clone(), needs_review));
        citations.push(CheckedCitation {
            antecedent,
            by_name: by_name.filter(|_| resolvable).map(|b| ByNameNote {
                among: b.among,
                note: b.note(),
                official: b.official.clone(),
                shared: b.shared,
            }),
            case,
            case_links: target
                .as_ref()
                .map(|t| t.case_links.to_vec())
                .unwrap_or_default(),
            conflicts,
            count: 0,
            external_url: target
                .as_ref()
                .and_then(|t| t.external_url)
                .filter(|_| status == CheckStatus::External)
                .map(str::to_string),
            group: 0,
            needs_review,
            page: target.as_ref().and_then(|t| t.page).map(str::to_string),
            partner,
            pin: c.pin.clone(),
            raw: c.matched_text.clone(),
            reporter: target.as_ref().and_then(|t| t.reporter).map(str::to_string),
            resolvable,
            slug: target.as_ref().and_then(|t| t.slug.clone()),
            status,
            citation_type: c.citation_type.clone(),
            via,
            volume: target.as_ref().and_then(|t| t.volume),
        });
        // The entry a cited case is listed by: a run's preferred printing, an official
        // reporter's printing found on its own, one found on its own, one found
        // through its partner, any full citation, in that order.
        primary_rank.push(match status {
            _ if c.is_short_form() => 5,
            _ if own.is_some_and(|v| v.preferred) => 0,
            CheckStatus::Found | CheckStatus::FoundAlias if c.official => 1,
            CheckStatus::Found | CheckStatus::FoundAlias => 2,
            CheckStatus::FoundPartner => 3,
            _ => 4,
        });
    }
    // Every entry belongs to the full citation it refers to, when that is listed.
    let full: std::collections::HashSet<String> = cited
        .iter()
        .zip(&primary_rank)
        .filter(|(_, &rank)| rank < 5)
        .map(|(e, _)| e.key.clone())
        .collect();
    for e in &mut cited {
        if e.antecedent.as_ref().is_some_and(|a| !full.contains(a)) {
            e.antecedent = None;
        }
    }
    let places: Vec<stare::cited::Place> = detected
        .iter()
        .map(|c| stare::cited::Place {
            key: cited_key(c),
            parallel_of: c.parallel_of,
        })
        .collect();
    let grouping = stare::cited::group(&cited, &places);
    for ((c, g), n) in citations
        .iter_mut()
        .zip(&grouping.entries)
        .zip(&grouping.entry_counts)
    {
        c.group = *g;
        c.count = *n;
    }
    let primaries: Vec<usize> = grouping
        .groups
        .iter()
        .map(|g| {
            *g.members
                .iter()
                .min_by_key(|&&i| primary_rank[i])
                .unwrap_or(&g.members[0])
        })
        .collect();
    let is_statute =
        |c: &CheckedCitation| matches!(c.status, CheckStatus::Statute | CheckStatus::External);
    let statutes = primaries
        .iter()
        .filter(|&&i| is_statute(&citations[i]))
        .count();
    let resolvable = primaries
        .iter()
        .filter(|&&i| !is_statute(&citations[i]) && citations[i].resolvable)
        .count();
    // Each parallel run whose citations open different cases, once.
    let needs_review = parallels
        .values()
        .filter_map(|v| v.run.as_deref())
        .collect::<std::collections::HashSet<_>>()
        .len();
    CheckReport {
        citations,
        grouping,
        primaries,
        statutes,
        resolvable,
        needs_review,
    }
}

// The key `stare check` lists a citation under: its string, and a short form's
// antecedent's.
pub fn cited_key(c: &stare::cite::DetectedCitation) -> String {
    match &c.antecedent {
        Some(a) => format!("{}\u{2192}{}", c.matched_text, a.matched_text),
        None => c.matched_text.clone(),
    }
}

/// What [`stare::cited::group`] reads of a listed citation: the case it resolves to, else
/// its normalized citation, the full citation a short form refers to, and whether it
/// needs review.
pub fn cited_entry(
    c: &stare::cite::DetectedCitation,
    status: CheckStatus,
    case: Option<String>,
    review: bool,
) -> stare::cited::Cited {
    let key = cited_key(c);
    if c.is_short_form() {
        // A pinned `Id.` to a statute is another section, with a status of its own.
        let own = status == CheckStatus::Statute && c.pin.is_some();
        let antecedent = c
            .antecedent
            .as_ref()
            .filter(|_| !own)
            .map(|a| a.matched_text.clone());
        return stare::cited::Cited {
            key,
            antecedent,
            ..Default::default()
        };
    }
    let citation = case.is_none().then(|| {
        let t = check_target(c)?;
        if t.law || t.external_url.is_some() {
            return None;
        }
        let page = stare::idx::page_text(&cited_page(t.page?)?);
        Some(format!("{}/{}/{}", t.slug?, t.volume?, page))
    });
    stare::cited::Cited {
        key,
        case,
        citation: citation.flatten(),
        antecedent: None,
        review,
    }
}
