//! Cited cases (#198): the citations in a text gathered by the case they resolve to, and
//! counted by the places in the text that cite it.
//!
//! An entry is one distinct citation as the readers list it: a full citation by its
//! string, a short form (`Id.`, `supra`, `389 F.2d at 887`) with the citation it refers
//! to. [`group`] puts in one group every entry that resolves to one case (its parallel
//! printings, a reprint resolved through its partner, an alias, and the short forms that
//! refer to any of them); an entry that resolves to nothing groups by its normalized
//! citation (reporter slug, volume, page), so spellings of one unresolved citation
//! collapse. Members of a parallel run go together, unless reconciliation flagged them
//! for review (#184), since merging them would assert a resolution stare didn't make, or
//! they resolve to different cases: a string cited in two runs (`70 App.D.C. 262,
//! 105 F.2d 785` and later `[70 App.D.C. 262, 105 F.2d 788.]`, a pin cite citare reads
//! as a run) is one entry, and doesn't join the second run's other case to the first.
//!
//! A group's count is the places in the text that cite it: a parallel run is one place,
//! and each short form one more.
//!
//! This is the only implementation: `stare check` calls [`group`] directly, and the site
//! through the WASM export `group_citations` (`crates/stare-wasm`).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// One distinct citation, as resolved.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cited {
    /// The entry's key: a full citation's string, or a short form's with the citation it
    /// refers to. Places name their entry by it.
    pub key: String,
    /// The case it resolves to, as [`crate::parallel`] names cases (`neb/128/783`), when
    /// it resolves.
    #[serde(default)]
    pub case: Option<String>,
    /// For one that doesn't resolve, the citation normalized: `slug/volume/page`.
    #[serde(default)]
    pub citation: Option<String>,
    /// For a short form, the key of the full citation it refers to; None for one with
    /// no antecedent, or whose status is its own (`Id. § 1985` after a statute).
    #[serde(default)]
    pub antecedent: Option<String>,
    /// Whether reconciliation flagged it: its parallel citations open a different case.
    #[serde(default)]
    pub review: bool,
}

/// One citation in the text, in text order.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Place {
    /// The key of its entry ([`Cited::key`]).
    pub key: String,
    /// For a parallel citation, the index among the places of the citation before it
    /// in its run (`DetectedCitation::parallel_of`).
    #[serde(default)]
    pub parallel_of: Option<usize>,
}

/// One cited case.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Group {
    /// Its entries, as indexes into the entries given to [`group`], in order.
    pub members: Vec<usize>,
    /// The places in the text that cite it: one per parallel run, one per citation
    /// outside a run.
    pub count: usize,
}

/// What [`group`] returns.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grouping {
    /// The cited cases, in order of their first entry.
    pub groups: Vec<Group>,
    /// Each entry's group, as an index into `groups`.
    pub entries: Vec<usize>,
    /// For each place, the citing place it is part of, named by the index of its run's
    /// first citation (its own index outside a run); None for a place whose key is no
    /// entry's.
    pub places: Vec<Option<usize>>,
}

/// The WASM export's input: `{ entries, places }`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Input {
    pub entries: Vec<Cited>,
    #[serde(default)]
    pub places: Vec<Place>,
}

struct Sets(Vec<usize>);

impl Sets {
    fn find(&mut self, mut x: usize) -> usize {
        while self.0[x] != x {
            self.0[x] = self.0[self.0[x]];
            x = self.0[x];
        }
        x
    }

    fn union(&mut self, a: usize, b: usize) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra != rb {
            // The earlier root stays, so a group's order is its first entry's.
            let (keep, other) = if ra < rb { (ra, rb) } else { (rb, ra) };
            self.0[other] = keep;
        }
    }
}

/// The cited cases among `entries`, counted over `places`.
pub fn group(entries: &[Cited], places: &[Place]) -> Grouping {
    let n = entries.len();
    let mut index: HashMap<&str, usize> = HashMap::new();
    for (i, e) in entries.iter().enumerate() {
        index.entry(e.key.as_str()).or_insert(i);
    }
    // Entries are 0..n; a case or a citation they share is a node after them.
    let mut sets = Sets((0..n).collect());
    let mut labels: HashMap<String, usize> = HashMap::new();
    let mut label = |sets: &mut Sets, l: String| {
        *labels.entry(l).or_insert_with(|| {
            sets.0.push(sets.0.len());
            sets.0.len() - 1
        })
    };
    for (i, e) in entries.iter().enumerate() {
        let shared = match (&e.case, &e.citation) {
            (Some(case), _) => Some(format!("case:{case}")),
            (None, Some(citation)) => Some(format!("cite:{citation}")),
            _ => None,
        };
        if let Some(l) = shared {
            let node = label(&mut sets, l);
            sets.union(i, node);
        }
        if let Some(&a) = e.antecedent.as_deref().and_then(|a| index.get(a)) {
            sets.union(a, i);
        }
    }
    let entry_of = |p: &Place| index.get(p.key.as_str()).copied();
    for (p, place) in places.iter().enumerate() {
        let Some(q) = place.parallel_of.filter(|&q| q < p) else {
            continue;
        };
        if let (Some(a), Some(b)) = (entry_of(&places[q]), entry_of(place)) {
            let (ea, eb) = (&entries[a], &entries[b]);
            let apart = matches!((&ea.case, &eb.case), (Some(x), Some(y)) if x != y);
            if !ea.review && !eb.review && !apart {
                sets.union(a, b);
            }
        }
    }

    let mut groups: Vec<Group> = Vec::new();
    let mut of_root: HashMap<usize, usize> = HashMap::new();
    let mut entry_group = Vec::with_capacity(n);
    for i in 0..n {
        let root = sets.find(i);
        let g = *of_root.entry(root).or_insert_with(|| {
            groups.push(Group::default());
            groups.len() - 1
        });
        groups[g].members.push(i);
        entry_group.push(g);
    }

    let mut heads: Vec<usize> = Vec::with_capacity(places.len());
    let mut out = Vec::with_capacity(places.len());
    let mut counted: Vec<(usize, usize)> = Vec::new();
    for (p, place) in places.iter().enumerate() {
        let head = match place.parallel_of.filter(|&q| q < p) {
            Some(q) if entry_of(&places[q]).is_some() => heads[q],
            _ => p,
        };
        heads.push(head);
        let Some(e) = entry_of(place) else {
            out.push(None);
            continue;
        };
        out.push(Some(head));
        let g = entry_group[e];
        if !counted.contains(&(g, head)) {
            counted.push((g, head));
            groups[g].count += 1;
        }
    }

    Grouping {
        groups,
        entries: entry_group,
        places: out,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full(key: &str, case: Option<&str>) -> Cited {
        Cited {
            key: key.into(),
            case: case.map(Into::into),
            ..Default::default()
        }
    }

    fn short(key: &str, antecedent: &str) -> Cited {
        Cited {
            key: key.into(),
            antecedent: Some(antecedent.into()),
            ..Default::default()
        }
    }

    fn place(key: &str, parallel_of: Option<usize>) -> Place {
        Place {
            key: key.into(),
            parallel_of,
        }
    }

    fn members(g: &Grouping) -> Vec<Vec<usize>> {
        g.groups.iter().map(|g| g.members.clone()).collect()
    }

    fn counts(g: &Grouping) -> Vec<usize> {
        g.groups.iter().map(|g| g.count).collect()
    }

    /// The issue's example: one decision cited once in three printings, then by `Id.`
    /// and a short cite. One case, three places.
    #[test]
    fn printings_and_short_forms_of_one_case() {
        let entries = [
            full("389 F.2d 885", Some("f2d/389/885")),
            full("88 S.Ct. 1234", Some("f2d/389/885")),
            full("20 L.Ed.2d 123", Some("f2d/389/885")),
            short("Id.→389 F.2d 885", "389 F.2d 885"),
            short("389 F.2d at 887→389 F.2d 885", "389 F.2d 885"),
        ];
        let places = [
            place("389 F.2d 885", None),
            place("88 S.Ct. 1234", Some(0)),
            place("20 L.Ed.2d 123", Some(1)),
            place("Id.→389 F.2d 885", None),
            place("389 F.2d at 887→389 F.2d 885", None),
        ];
        let g = group(&entries, &places);
        assert_eq!(members(&g), [vec![0, 1, 2, 3, 4]]);
        assert_eq!(counts(&g), [3]);
        assert_eq!(g.places, [Some(0), Some(0), Some(0), Some(3), Some(4)]);
    }

    /// `cert. denied, 261 Conn. 941, 808 A.2d 1132` (Brooks v. Powers): two printings,
    /// one cited once, so one place; the reprint is in a volume stare.pub doesn't hold
    /// and resolves through its partner.
    #[test]
    fn a_decision_cited_once_in_two_reporters() {
        let entries = [
            full("261 Conn. 941", Some("conn/261/941")),
            full("808 A.2d 1132", Some("conn/261/941")),
        ];
        let places = [
            place("261 Conn. 941", None),
            place("808 A.2d 1132", Some(0)),
        ];
        let g = group(&entries, &places);
        assert_eq!(members(&g), [vec![0, 1]]);
        assert_eq!(counts(&g), [1]);
    }

    /// A run where nothing resolves is still one decision as citare reads it.
    #[test]
    fn an_unresolved_run_is_one_place() {
        let entries = [
            Cited {
                key: "163 Md. 481".into(),
                citation: Some("md/163/481".into()),
                ..Default::default()
            },
            Cited {
                key: "163 A. 183".into(),
                citation: Some("a/163/183".into()),
                ..Default::default()
            },
        ];
        let places = [place("163 Md. 481", None), place("163 A. 183", Some(0))];
        let g = group(&entries, &places);
        assert_eq!(members(&g), [vec![0, 1]]);
        assert_eq!(counts(&g), [1]);
    }

    /// Spellings of one unresolved citation collapse; another citation doesn't join.
    #[test]
    fn unresolved_citations_group_by_their_normalized_form() {
        let miss = |key: &str, citation: &str| Cited {
            key: key.into(),
            citation: Some(citation.into()),
            ..Default::default()
        };
        let entries = [
            miss("31 A.2d 950", "a2d/31/950"),
            miss("31 A. 2d 950", "a2d/31/950"),
            miss("31 A.2d 951", "a2d/31/951"),
        ];
        let places = [
            place("31 A.2d 950", None),
            place("31 A. 2d 950", None),
            place("31 A.2d 951", None),
        ];
        let g = group(&entries, &places);
        assert_eq!(members(&g), [vec![0, 1], vec![2]]);
        assert_eq!(counts(&g), [2, 1]);
    }

    /// Printings flagged for review stay apart, each counting the run once; a later
    /// citation of one of them by itself joins it.
    #[test]
    fn printings_flagged_for_review_stay_apart() {
        let flagged = |key: &str, case: &str| Cited {
            review: true,
            ..full(key, Some(case))
        };
        let entries = [
            flagged("128 Neb. 783", "neb/128/783"),
            flagged("31 A.2d 647", "a2d/31/647"),
            full("128 Neb. 783, 785", Some("neb/128/783")),
        ];
        let places = [
            place("128 Neb. 783", None),
            place("31 A.2d 647", Some(0)),
            place("128 Neb. 783, 785", None),
        ];
        let g = group(&entries, &places);
        assert_eq!(members(&g), [vec![0, 2], vec![1]]);
        assert_eq!(counts(&g), [2, 1]);
        assert_eq!(g.entries, [0, 1, 0]);
    }

    /// A statute and the `Id.` to another of its sections stay apart; a place whose key
    /// is no entry's (a bare section reference) is in no group.
    #[test]
    fn short_forms_with_a_status_of_their_own() {
        let entries = [
            full("42 U.S.C. § 1983", None),
            full("Id. § 1985→42 U.S.C. § 1983", None),
        ];
        let places = [
            place("42 U.S.C. § 1983", None),
            place("Id. § 1985→42 U.S.C. § 1983", None),
            place("§ 3(a)", None),
        ];
        let g = group(&entries, &places);
        assert_eq!(members(&g), [vec![0], vec![1]]);
        assert_eq!(counts(&g), [1, 1]);
        assert_eq!(g.places, [Some(0), Some(1), None]);
    }

    /// Ray v. Bruce, 31 A.2d 693: `70 App.D.C. 262, 105 F.2d 785`, then
    /// `[70 App.D.C. 262, 105 F.2d 788.]`, where another case starts at 788. The second
    /// run doesn't merge that case into the first's.
    #[test]
    fn a_string_in_two_runs_joins_no_other_case() {
        let entries = [
            full("70 App.D.C. 262", Some("f2d/105/785")),
            full("105 F.2d 785", Some("f2d/105/785")),
            full("105 F.2d 788", Some("f2d/105/788")),
        ];
        let places = [
            place("70 App.D.C. 262", None),
            place("105 F.2d 785", Some(0)),
            place("70 App.D.C. 262", None),
            place("105 F.2d 788", Some(2)),
        ];
        let g = group(&entries, &places);
        assert_eq!(members(&g), [vec![0, 1], vec![2]]);
        assert_eq!(counts(&g), [2, 1]);
    }

    #[test]
    fn nothing_to_group() {
        assert_eq!(group(&[], &[]), Grouping::default());
        let g = group(&[full("1 A.2d 1", None)], &[]);
        assert_eq!(counts(&g), [0]);
    }
}
