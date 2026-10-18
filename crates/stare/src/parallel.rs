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
//!   resolved through them; the data overrides citare's grouping (R2).
//! - The preferred printing is the official reporter's when stare.pub holds it, else the
//!   first member that resolves (R3).
//!
//! The site applies the same rules in `web/public/js/parallel.js`; both are tested on the
//! vectors in `tests/fixtures/parallel-reconcile.json`.

use serde::{Deserialize, Serialize};

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
    /// It opens `case`, a string two citations of one case file share
    /// (`neb/128/783`, whether reached directly or through an alias).
    Found { case: String },
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
}

/// The verdict for each of `printings`, in order.
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
        let found: Vec<(usize, &str)> = members
            .iter()
            .filter_map(|&i| match &printings[i].lookup {
                Lookup::Found { case } => Some((i, case.as_str())),
                _ => None,
            })
            .collect();
        let Some(&(first, case)) = found.first() else {
            continue;
        };
        if found.iter().any(|(_, c)| *c != case) {
            for &(i, mine) in &found {
                verdicts[i].conflicts = found
                    .iter()
                    .filter(|(_, other)| *other != mine)
                    .map(|&(j, _)| j)
                    .collect();
            }
            continue;
        }
        let preferred = found
            .iter()
            .map(|&(i, _)| i)
            .find(|&i| printings[i].official)
            .unwrap_or(first);
        verdicts[preferred].preferred = true;
        for &i in members {
            if matches!(printings[i].lookup, Lookup::HeldMiss | Lookup::NotHeld) {
                verdicts[i].partner = Some(preferred);
            }
        }
    }
    verdicts
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
