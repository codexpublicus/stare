//! Picking the case a citation means on a page several cases start on, by the case
//! name the citing text gives (#212; the owner's ruling D72 (2)).
//!
//! A page lookup lists every case at the page ([`crate::parallel::page_cases`]), and a
//! reader opens the first. When nothing else settles which one a citation means (no
//! alias names one, and a parallel run's printings don't narrow it to one), the
//! citing text's name for the case (`DetectedCitation::case_name`, `Segreto v.
//! Bristol`) is compared with each case's own, the way stare-builder matches a
//! CourtListener cluster to a case on a shared page (stare-builder#37, `alias::by_name`):
//! the names' telling words, and the citation's year against the decision date when
//! both are there. A case is taken only when it is the one clear match; otherwise the
//! reader keeps opening the page's first.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Words that say nothing about which case a name is (stare-builder's
/// `NAME_STOPWORDS`).
const NAME_STOPWORDS: [&str; 39] = [
    "v",
    "vs",
    "the",
    "of",
    "and",
    "in",
    "re",
    "a",
    "an",
    "inc",
    "co",
    "corp",
    "company",
    "corporation",
    "llc",
    "ltd",
    "et",
    "al",
    "ex",
    "rel",
    "matter",
    "people",
    "state",
    "commonwealth",
    "united",
    "states",
    "america",
    "city",
    "county",
    "town",
    "village",
    "estate",
    "petitioner",
    "respondent",
    "appellant",
    "appellee",
    "plaintiff",
    "defendant",
    "board",
];

/// One case at a page, as a reader names it (`conn/261/941-2`), with its own names
/// (CAP's `name_abbreviation` and `name`, a CourtListener record's the same) and its
/// decision date (`2002-09-10`), where the reader could read them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Candidate {
    pub id: String,
    #[serde(default)]
    pub names: Vec<String>,
    #[serde(default)]
    pub date: Option<String>,
}

/// The fields of a case JSON (CAP's, or a CourtListener record) a match reads.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct CaseNames {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub name_abbreviation: Option<String>,
    #[serde(default)]
    pub decision_date: Option<String>,
}

impl CaseNames {
    /// Read from a case JSON's bytes.
    pub fn parse(bytes: &[u8]) -> anyhow::Result<Self> {
        Ok(serde_json::from_slice(bytes)?)
    }

    /// The case `id` with these names.
    pub fn candidate(self, id: &str) -> Candidate {
        Candidate {
            id: id.to_string(),
            names: [self.name_abbreviation, self.name]
                .into_iter()
                .flatten()
                .filter(|n| !n.trim().is_empty())
                .collect(),
            date: self.decision_date.filter(|d| !d.is_empty()),
        }
    }
}

/// A case name's telling words: lowercase letters and digits, two characters or more,
/// without [`NAME_STOPWORDS`].
fn name_words(name: &str) -> BTreeSet<String> {
    name.to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| w.len() > 1 && !NAME_STOPWORDS.contains(w))
        .map(str::to_string)
        .collect()
}

/// How alike two names are: the share of the shorter name's words the other has, then
/// the share of all their words they have in common, each from 0 to 1.
fn name_overlap(a: &BTreeSet<String>, b: &BTreeSet<String>) -> (f64, f64) {
    let least = a.len().min(b.len());
    if least == 0 {
        return (0.0, 0.0);
    }
    let common = a.intersection(b).count() as f64;
    (common / least as f64, common / a.union(b).count() as f64)
}

/// The cases of `cases` the citing text's `name` (and `year`, when it gives one) fits,
/// each with how alike the names are: decided that year where its date is known, with
/// at least half the shorter name's telling words in common. None when the name has no
/// telling words (`State v.`).
fn fits<'a>(cases: &'a [Candidate], name: &str, year: Option<i32>) -> Vec<(&'a str, (f64, f64))> {
    let words = name_words(name);
    if words.is_empty() {
        return Vec::new();
    }
    let year = year.map(|y| format!("{y:04}"));
    cases
        .iter()
        .filter(
            |c| match (&year, c.date.as_deref().and_then(|d| d.get(..4))) {
                (Some(y), Some(d)) => y == d,
                _ => true,
            },
        )
        .filter_map(|c| {
            let best = c
                .names
                .iter()
                .map(|n| name_overlap(&words, &name_words(n)))
                .fold((0.0, 0.0), |a, b| if b > a { b } else { a });
            (best.0 >= 0.5).then_some((c.id.as_str(), best))
        })
        .collect()
}

/// Of `cases`, the one the citing text's `name` (and `year`, when it gives one) means:
/// decided that year where its date is known, with at least half the shorter name's
/// telling words in common, and closer to the name than every other case that fits.
/// None when no case fits, when two fit equally, or when the name has no telling
/// words (`State v.`); the reader then opens the page's first case, as before.
pub fn pick<'a>(cases: &'a [Candidate], name: &str, year: Option<i32>) -> Option<&'a str> {
    let fits = fits(cases, name, year);
    let best = fits
        .iter()
        .map(|f| f.1)
        .fold((0.0, 0.0), |a, b| if b > a { b } else { a });
    match fits
        .iter()
        .filter(|f| f.1 == best)
        .collect::<Vec<_>>()
        .as_slice()
    {
        [one] => Some(one.0),
        _ => None,
    }
}

/// Whether `case` clearly isn't the case the citing text's `name` names: it has telling
/// words, and none of them is one of the name's. False when either has none to compare.
fn clearly_not(case: &Candidate, name: &str) -> bool {
    let words = name_words(name);
    let theirs: Vec<BTreeSet<String>> = case
        .names
        .iter()
        .map(|n| name_words(n))
        .filter(|w| !w.is_empty())
        .collect();
    !words.is_empty() && !theirs.is_empty() && theirs.iter().all(|w| w.is_disjoint(&words))
}

/// The case on the official printing's whole page (`page`, every case at it) the citing
/// text's `name` means, for a parallel run whose printings' data narrowed it to
/// `shared`, when that narrowing missed the name and exactly one case on the page fits
/// it. The other printings' data (CourtListener's aliases at an orders list, `71 L. Ed.
/// 2d 848`) gives a shared page's citation to only some of the cases printed there, so
/// the cases a run shares can leave out the one the text names.
///
/// - Several shared cases (the owner's ruling D90): none of them fits the name.
/// - One shared case (D98 (1); `143 L. Ed. 2d 111`'s one alias, to Compagnie Euralair,
///   for `State v. Shabazz, ..., 525 U.S. 1179`): it clearly doesn't fit, having telling
///   words and none of the name's. A shared case that fits partly, or one whose names
///   couldn't be read, stands.
///
/// None otherwise, and the run's narrowing stands ([`pick`] among `shared`).
pub fn pick_on_official_page<'a>(
    page: &'a [Candidate],
    shared: &[String],
    name: &str,
    year: Option<i32>,
) -> Option<&'a str> {
    let fits = fits(page, name, year);
    match shared {
        [] => return None,
        [one] => {
            let case = page.iter().find(|c| c.id == *one)?;
            if !clearly_not(case, name) {
                return None;
            }
        }
        _ => {
            if fits.iter().any(|(id, _)| shared.iter().any(|s| s == id)) {
                return None;
            }
        }
    }
    match fits.as_slice() {
        [(one, _)] => Some(one),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn case(id: &str, name: &str, date: &str) -> Candidate {
        Candidate {
            id: id.into(),
            names: vec![name.into()],
            date: Some(date.into()),
        }
    }

    #[test]
    fn the_name_in_the_citing_text_picks_the_case() {
        // 261 Conn. 941, as Brooks v. Powers cites it.
        let cases = [
            case("conn/261/941", "Marshall v. Marshall", "2002-09-12"),
            case("conn/261/941-2", "Segreto v. City of Bristol", "2002-09-12"),
            case("conn/261/941-3", "State v. Nicholson", "2002-09-12"),
        ];
        assert_eq!(
            pick(&cases, "Segreto v. Bristol", Some(2002)),
            Some("conn/261/941-2")
        );
        assert_eq!(
            pick(&cases, "Marshall v. Marshall", None),
            Some("conn/261/941")
        );
        assert_eq!(
            pick(&cases, "State v. Nicholson", Some(2002)),
            Some("conn/261/941-3")
        );
        // Another year, a name none of them has, and a name with no telling words.
        assert_eq!(pick(&cases, "Segreto v. Bristol", Some(1999)), None);
        assert_eq!(pick(&cases, "Doe v. Roe", Some(2002)), None);
        assert_eq!(pick(&cases, "State v. State", Some(2002)), None);
    }

    #[test]
    fn the_official_page_decides_when_no_shared_case_fits_the_name() {
        // 455 U.S. 989, as `State v. Gordon, ..., cert. denied, 455 U.S. 989, 102 S. Ct.
        // 1612, 71 L. Ed. 2d 848 (1982)` cites it: the three printings share three cases,
        // none of them Connecticut v. Gordon.
        let page = [
            case("us/455/989", "Gomez v. United States", "1982-03-22"),
            case("us/455/989-2", "Hall v. Florida", "1982-03-22"),
            case("us/455/989-3", "Connecticut v. Gordon", "1982-03-22"),
            case("us/455/989-4", "Jones v. Illinois", "1982-03-22"),
            case("us/455/989-5", "Smith v. Ohio", "1982-03-22"),
        ];
        let shared: Vec<String> = ["us/455/989", "us/455/989-2", "us/455/989-4"]
            .map(String::from)
            .to_vec();
        assert_eq!(
            pick_on_official_page(&page, &shared, "State v. Gordon", Some(1982)),
            Some("us/455/989-3")
        );
        // A shared case that fits keeps the run's narrowing, even beside one that
        // doesn't share.
        assert_eq!(
            pick_on_official_page(&page, &shared, "Hall v. Florida", Some(1982)),
            None
        );
        // Two cases on the page fitting, none, another year, no telling words, or a run
        // that shares no case: today's case stands.
        let twice = [
            page.as_slice(),
            &[case("us/455/989-6", "Gordon v. Ohio", "1982-03-22")],
        ]
        .concat();
        assert_eq!(
            pick_on_official_page(&twice, &shared, "State v. Gordon", Some(1982)),
            None
        );
        assert_eq!(
            pick_on_official_page(&page, &shared, "Doe v. Roe", Some(1982)),
            None
        );
        assert_eq!(
            pick_on_official_page(&page, &shared, "State v. Gordon", Some(1979)),
            None
        );
        assert_eq!(
            pick_on_official_page(&page, &shared, "State v.", None),
            None
        );
        assert_eq!(
            pick_on_official_page(&page, &[], "State v. Gordon", Some(1982)),
            None
        );
    }

    #[test]
    fn the_official_page_decides_when_the_one_shared_case_is_clearly_another() {
        // 525 U.S. 1179, as `State v. Shabazz, ..., cert. denied, 525 U.S. 1179, 119 S. Ct.
        // 1116, 143 L. Ed. 2d 111` cites it: 143 L. Ed. 2d 111's one alias is to Compagnie
        // Euralair, so the run's printings share only that case (D98 (1)).
        let page = [
            case("us/525/1179", "Allen v. United States", "1999-02-22"),
            case("us/525/1179-3", "Shabazz v. Connecticut", "1999-02-22"),
            case(
                "us/525/1179-4",
                "Compagnie Euralair, S. A. v. General Electric Co.",
                "1999-02-22",
            ),
            case("us/525/1179-5", "Mendez v. Texas", "1999-02-22"),
        ];
        let euralair = ["us/525/1179-4".to_string()];
        assert_eq!(
            pick_on_official_page(&page, &euralair, "State v. Shabazz", Some(1999)),
            Some("us/525/1179-3")
        );
        // A name the shared case fits, even partly, keeps it.
        assert_eq!(
            pick_on_official_page(&page, &euralair, "Euralair v. Shabazz", Some(1999)),
            None
        );
        assert_eq!(
            pick_on_official_page(
                &page,
                &euralair,
                "General Electric Co. v. Shabazz Holdings",
                Some(1999)
            ),
            None
        );
        // A name with no telling words, one nothing on the page fits, another year, or
        // two cases on the page fitting: today's case stands.
        assert_eq!(
            pick_on_official_page(&page, &euralair, "State v.", Some(1999)),
            None
        );
        assert_eq!(
            pick_on_official_page(&page, &euralair, "Doe v. Roe", Some(1999)),
            None
        );
        assert_eq!(
            pick_on_official_page(&page, &euralair, "State v. Shabazz", Some(1997)),
            None
        );
        let twice = [
            page.as_slice(),
            &[case("us/525/1179-6", "Shabazz v. Ohio", "1999-02-22")],
        ]
        .concat();
        assert_eq!(
            pick_on_official_page(&twice, &euralair, "State v. Shabazz", Some(1999)),
            None
        );
        // A shared case whose names couldn't be read, or that isn't on the page, says
        // nothing about the name.
        let unread = [
            page.as_slice(),
            &[Candidate {
                id: "us/525/1179-7".into(),
                ..Default::default()
            }],
        ]
        .concat();
        assert_eq!(
            pick_on_official_page(
                &unread,
                &["us/525/1179-7".to_string()],
                "State v. Shabazz",
                Some(1999)
            ),
            None
        );
        assert_eq!(
            pick_on_official_page(
                &page,
                &["us/525/1179-9".to_string()],
                "State v. Shabazz",
                Some(1999)
            ),
            None
        );
    }

    #[test]
    fn a_name_two_cases_fit_equally_picks_none() {
        let twins = [
            case("a/1/1", "State v. Gerald", "1984-12-19"),
            case("a/1/1-2", "State v. Gerald", "1984-12-19"),
        ];
        assert_eq!(pick(&twins, "State v. Gerald", Some(1984)), None);
        // The closer name wins where both fit.
        let smiths = [
            case("a/1/1", "State v. Smith", "1984-12-19"),
            case("a/1/1-2", "Smith v. Jones Construction Co.", "1984-12-19"),
        ];
        assert_eq!(
            pick(&smiths, "Smith v. Jones Construction", None),
            Some("a/1/1-2")
        );
    }

    #[test]
    fn either_of_a_cases_names_and_a_missing_date_count() {
        let cases = [
            Candidate {
                id: "a/1/1".into(),
                names: vec![
                    "Hoffman v. Midlantic".into(),
                    "Louis Hoffman & Sons Metal Co. v. Midlantic Banks, Inc.".into(),
                ],
                date: None,
            },
            case("a/1/1-2", "State v. Gerald", "1984-12-19"),
        ];
        assert_eq!(
            pick(
                &cases,
                "Louis Hoffman & Sons v. Midlantic Banks",
                Some(1984)
            ),
            Some("a/1/1")
        );
        assert_eq!(
            CaseNames::parse(br#"{"name": "Segreto v. City of Bristol", "name_abbreviation": "Segreto v. Bristol", "decision_date": "2002-09-12", "casebody": {}}"#)
                .unwrap()
                .candidate("conn/261/941-2"),
            Candidate {
                id: "conn/261/941-2".into(),
                names: vec!["Segreto v. Bristol".into(), "Segreto v. City of Bristol".into()],
                date: Some("2002-09-12".into()),
            }
        );
    }
}
