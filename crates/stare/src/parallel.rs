//! Parallel-citation reconciliation (#160): what a run of parallel citations of one
//! decision (`Pettegrew v. Pettegrew, 128 Neb. 783, 260 N.W. 287`) says once each
//! member has been looked up.
//!
//! citare decides which citations in a text are one run (`DetectedCitation::parallel_of`);
//! it knows nothing of what stare.pub holds. The index decides what each member opens.
//! The rules, which the owner settled as D35 on #160:
//!
//! - When the members that resolve all open one case, a member that doesn't (a volume
//!   stare.pub doesn't hold, or a page CAP redacted in one it does) resolves through the
//!   run's preferred printing. That link is inferred from the citing text, never from
//!   data, and is labelled so (R1, R4).
//! - When members open different cases, each is flagged with the others and nothing is
//!   resolved through them; the data overrides citare's grouping (R2). Where several
//!   cases start at a member's page, it is compared against every one of them (#204):
//!   members that share a case open that one.
//! - The preferred printing is the official reporter's when stare.pub holds it, else the
//!   first member that resolves (R3).
//!
//! This is the only implementation: `stare check` calls [`reconcile`] directly, and the
//! site through the WASM export `reconcile_parallels` (`crates/stare-wasm`). It is tested
//! on the vectors in `tests/fixtures/parallel-reconcile.json`.

use serde::{Deserialize, Serialize};

use crate::idx::Entry;
use crate::index::{page_key, PageKey};

/// One member of a run, as looked up.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Printing {
    /// The index, in the list given to [`reconcile`], of the run's first citation: the
    /// printing's own index when it starts a run or is in none.
    pub run: usize,
    /// Whether the citation is to an official reporter (`DetectedCitation::official`).
    #[serde(default)]
    pub official: bool,
    pub lookup: Lookup,
}

/// What the index says of a citation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Lookup {
    /// It opens a case: every case that starts at its page (#204), the one a reader
    /// opens first first, each a string two citations of one case file share
    /// (`neb/128/783`, whether reached directly or through an alias; [`page_cases`]).
    Found { cases: Vec<String> },
    /// stare.pub holds the volume, and no case starts at the page.
    HeldMiss,
    /// stare.pub doesn't hold the volume.
    NotHeld,
    /// Nothing is known: the index couldn't be read, or there is nothing to look up.
    Unknown,
}

/// What reconciliation says of one printing. The default is "stands on its own lookup".
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Verdict {
    /// For a printing that doesn't resolve on its own, the index of the member whose case
    /// it resolves through, inferred from the citing text.
    pub partner: Option<usize>,
    /// The indexes of the run's members that open a different case than this one does.
    pub conflicts: Vec<usize>,
    /// Whether this is the printing a run that opens one case shows by default.
    pub preferred: bool,
    /// For a member of a run whose printings agree on one case, that case: the one its
    /// members share, which for a member at a page several cases start on (#204) can be
    /// other than the page's first. None for a printing in no run, or in one that
    /// doesn't agree.
    #[serde(default)]
    pub case: Option<String>,
}

/// The verdict for each of `printings`, in order.
///
/// A member that resolves is consistent with the others when they share a case: one
/// case starts at every resolving member's page (#204), so a parallel citation whose
/// partner is the second decision at a shared page resolves to it. A run whose
/// resolving members share no case is flagged; each member's `conflicts` are the
/// members it shares no case with, or, when it shares one with each of them but no
/// case is common to all, every other resolving member.
pub fn reconcile(printings: &[Printing]) -> Vec<Verdict> {
    let mut verdicts = vec![Verdict::default(); printings.len()];
    let mut runs: Vec<(usize, Vec<usize>)> = Vec::new();
    for (i, p) in printings.iter().enumerate() {
        match runs.iter_mut().find(|(run, _)| *run == p.run) {
            Some((_, members)) => members.push(i),
            None => runs.push((p.run, vec![i])),
        }
    }
    for (_, members) in runs.iter().filter(|(_, m)| m.len() > 1) {
        let found: Vec<(usize, &[String])> = members
            .iter()
            .filter_map(|&i| match &printings[i].lookup {
                Lookup::Found { cases } if !cases.is_empty() => Some((i, cases.as_slice())),
                _ => None,
            })
            .collect();
        let Some(&(first, _)) = found.first() else {
            continue;
        };
        let shared = |c: &String| found.iter().all(|(_, cases)| cases.contains(c));
        if !found.iter().any(|(_, cases)| cases.iter().any(shared)) {
            for &(i, mine) in &found {
                let others = || found.iter().filter(|&&(j, _)| j != i);
                let disjoint: Vec<usize> = others()
                    .filter(|(_, theirs)| !theirs.iter().any(|c| mine.contains(c)))
                    .map(|&(j, _)| j)
                    .collect();
                verdicts[i].conflicts = if disjoint.is_empty() {
                    others().map(|&(j, _)| j).collect()
                } else {
                    disjoint
                };
            }
            continue;
        }
        let preferred = found
            .iter()
            .map(|&(i, _)| i)
            .find(|&i| printings[i].official)
            .unwrap_or(first);
        // The preferred printing's first case that every resolving member shares.
        let case = found
            .iter()
            .find(|&&(i, _)| i == preferred)
            .and_then(|(_, cases)| cases.iter().find(|c| shared(c)))
            .cloned();
        verdicts[preferred].preferred = true;
        for &i in members {
            match printings[i].lookup {
                Lookup::HeldMiss | Lookup::NotHeld => verdicts[i].partner = Some(preferred),
                Lookup::Found { .. } => {}
                Lookup::Unknown => continue,
            }
            verdicts[i].case = case.clone();
        }
    }
    verdicts
}

/// Every case that starts at `page` of `volume` (as cited) of `slug`, from the page's
/// index entries in index order (#204), as [`case_at`] and [`alias_case`] name them:
/// the volume's own CAP cases (`a2d/31/647`, then `a2d/31/647-2` for the case filed
/// `0647-02`), then the cases aliases name, then, on a page with neither, each
/// CourtListener record (`-2` for the second). On a page CAP has a case on, a
/// CourtListener line is an alias for it and adds none. The first is the case a
/// reader opens at the page.
pub fn page_cases(slug: &str, volume: &str, page: &PageKey, entries: &[&Entry]) -> Vec<String> {
    let at = case_at(slug, volume, page);
    let numbered = |seq: u32| {
        if seq > 1 {
            format!("{at}-{seq}")
        } else {
            at.clone()
        }
    };
    let mut cases: Vec<String> = Vec::new();
    let mut push = |c: String| {
        if !cases.contains(&c) {
            cases.push(c);
        }
    };
    let mut cap = false;
    for e in entries {
        if let Some((reporter, folder, file)) = e.alias_target() {
            cap = true;
            push(alias_case(reporter, folder, file));
        } else if let Some((_, file)) = e.cap_case() {
            cap = true;
            push(numbered(file_seq(file)));
        }
    }
    if !cap {
        let records = entries.iter().filter(|e| e.cl_record().is_some()).count();
        for n in 1..=records {
            push(numbered(n as u32));
        }
    }
    cases
}

// The sequence a case file ends with (`0647-02` is 2), else 1.
fn file_seq(case_file: &str) -> u32 {
    match case_file.rsplit_once('-') {
        Some((_, n)) if !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) => {
            n.parse().unwrap_or(1).max(1)
        }
        _ => 1,
    }
}

/// The case a citation found at its own page opens, as the site's `caseIdentity` names
/// it: `slug/volume/page` (`neb/128/783`, `cai-cas/1/xxix`).
pub fn case_at(slug: &str, volume: &str, page: &PageKey) -> String {
    format!("{slug}/{volume}/{}", page_str(page))
}

/// The case an alias names (`neb/128/0783-01`), as [`case_at`] names it when cited
/// directly, with `-<seq>` for a case after the first on its page: a parallel citation
/// that resolves through an alias and the citation it is an alias of meet here. A folder
/// CAP split off a volume (`138-2`) counts as the volume.
pub fn alias_case(reporter: &str, folder: &str, case_file: &str) -> String {
    let volume = match folder.rsplit_once('-') {
        Some((v, n)) if !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) => v,
        _ => folder,
    };
    let (name, seq) = match case_file.rsplit_once('-') {
        Some((name, n)) if !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) => {
            (name, n.parse::<u32>().unwrap_or(1))
        }
        _ => (case_file, 1),
    };
    let page = page_str(&page_key(name.trim_start_matches('0')));
    let page = if page.is_empty() {
        "0".to_string()
    } else {
        page
    };
    if seq > 1 {
        format!("{reporter}/{volume}/{page}-{seq}")
    } else {
        format!("{reporter}/{volume}/{page}")
    }
}

fn page_str(page: &PageKey) -> String {
    match page {
        PageKey::Number(n) => n.to_string(),
        PageKey::Label(l) => l.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn case_names() {
        assert_eq!(case_at("neb", "128", &PageKey::Number(783)), "neb/128/783");
        assert_eq!(
            case_at("cai-cas", "1", &PageKey::Label("xxix".into())),
            "cai-cas/1/xxix"
        );
        assert_eq!(alias_case("neb", "128", "0783-01"), "neb/128/783");
        assert_eq!(alias_case("a3d", "138-2", "1012-02"), "a3d/138/1012-2");
        assert_eq!(alias_case("cai-cas", "1", "xxix-01"), "cai-cas/1/xxix");
    }

    #[test]
    fn every_case_at_a_page() {
        use crate::idx::Entry;
        let page = PageKey::Number(647);
        let own = |f: &str| Entry::cap(page.clone(), None, f).unwrap();
        let cl = |n: u64| Entry::cl(page.clone(), n, "0123456789abcdef").unwrap();
        let alias = Entry::alias(page.clone(), "neb", "128", "0783-01", 8077312).unwrap();
        let (a, b) = (own("0647-01"), own("0647-02"));
        assert_eq!(
            page_cases("a2d", "31", &page, &[&a, &b, &alias, &cl(1)]),
            ["a2d/31/647", "a2d/31/647-2", "neb/128/783"]
        );
        // A page with only aliases: the cases they name, in order.
        assert_eq!(page_cases("n-w", "260", &page, &[&alias]), ["neb/128/783"]);
        // CourtListener's records, on a page CAP has no case on.
        assert_eq!(
            page_cases("a2d", "31", &page, &[&cl(1), &cl(2)]),
            ["a2d/31/647", "a2d/31/647-2"]
        );
        assert!(page_cases("a2d", "31", &page, &[]).is_empty());
    }

    #[derive(Deserialize)]
    struct Vector {
        name: String,
        printings: Vec<Printing>,
        verdicts: Vec<Verdict>,
    }

    #[derive(Deserialize)]
    struct Fixture {
        vectors: Vec<Vector>,
    }

    #[test]
    fn the_shared_vectors() {
        let fixture: Fixture =
            serde_json::from_str(include_str!("../tests/fixtures/parallel-reconcile.json"))
                .unwrap();
        assert!(fixture.vectors.len() >= 10);
        for v in fixture.vectors {
            assert_eq!(reconcile(&v.printings), v.verdicts, "{}", v.name);
        }
    }

    #[test]
    fn nothing_to_reconcile() {
        assert!(reconcile(&[]).is_empty());
    }
}
