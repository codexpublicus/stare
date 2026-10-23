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

/// Of `cases`, the one the citing text's `name` (and `year`, when it gives one) means:
/// decided that year where its date is known, with at least half the shorter name's
/// telling words in common, and closer to the name than every other case that fits.
/// None when no case fits, when two fit equally, or when the name has no telling
/// words (`State v.`); the reader then opens the page's first case, as before.
pub fn pick<'a>(cases: &'a [Candidate], name: &str, year: Option<i32>) -> Option<&'a str> {
    let words = name_words(name);
    if words.is_empty() {
        return None;
    }
    let year = year.map(|y| format!("{y:04}"));
    let fits: Vec<(&str, (f64, f64))> = cases
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
        .collect();
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
