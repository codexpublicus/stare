//! Resolving one citation to the case it names: reading what `stare resolve` is given,
//! looking the page up in the index, and reading the case from its source.

use super::fetch::{fetch_bin, fetch_idx, fetch_multi, fetch_record, fetch_zip};
use super::Sources;
use anyhow::{bail, Context, Result};

/// Parse citation input — tries slug format first, then citare.
///
/// Accepts:
///   "a2d 31 647"       → slug format
///   "a3d 138-2 1012"   → slug format naming a CAP volume folder
///   "31 A.2d 647"      → natural citation (via citare)
///   "410 U.S. 113"     → natural citation
///
/// The volume is a string: a cited volume number, or a CAP folder name in slug format.
pub fn parse_citation_input(input: &str) -> Result<(String, String, u32)> {
    // Try slug format: "a2d 31 647"
    let parts: Vec<&str> = input.split_whitespace().collect();
    if parts.len() == 3 && stare::manifest::is_volume_key(parts[1]) {
        if let Ok(page) = parts[2].parse::<u32>() {
            return Ok((parts[0].to_lowercase(), parts[1].to_string(), page));
        }
    }

    // Try citare
    let detected = stare::cite::detect_citations(input);
    for c in &detected {
        if let (Some(slug), Some(vol_str), Some(page_str)) = (&c.slug, &c.volume, &c.page) {
            if let (Ok(vol), Ok(page)) = (vol_str.parse::<u32>(), page_str.parse::<u32>()) {
                return Ok((slug.clone(), vol.to_string(), page));
            }
        }
    }

    bail!(
        "Could not parse citation: \"{}\"\nTry: \"31 A.2d 647\" or \"a2d 31 647\"",
        input
    )
}

/// Slug format with a page that isn't a number: "cai-cas 1 xxix", "cal-app-4th 15
/// Supp. 1". Those pages are front matter or supplements, indexed by label.
pub fn parse_labeled_input(input: &str) -> Option<(String, String, String)> {
    // A natural citation ("31 A.2d 647") fails here on its volume, "A.2d".
    let mut parts = input.split_whitespace();
    let reporter = parts.next()?;
    let volume = parts.next()?;
    let label = parts.collect::<Vec<_>>().join(" ");
    let slug = reporter
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !slug
        || !stare::manifest::is_volume_key(volume)
        || label.is_empty()
        || label.starts_with(|c: char| c.is_ascii_digit())
    {
        return None;
    }
    Some((reporter.to_lowercase(), volume.to_string(), label))
}

/// A natural citation to a labelled page, as citare reads it: "1 Cai. Cas. xxix" is
/// `("cai-cas", "1", "xxix")`. None when the first citation citare finds has a page
/// that starts with a digit, or nothing to look up.
pub fn cited_label(input: &str) -> Option<(String, String, String)> {
    let detected = stare::cite::detect_citations(input);
    let c = detected
        .iter()
        .find(|c| c.slug.is_some() && c.volume.is_some() && c.page.is_some())?;
    let page = c.page.as_deref()?;
    let volume = c.volume.as_deref()?.parse::<u32>().ok()?;
    match cited_page(page)? {
        stare::index::PageKey::Label(_) => {
            Some((c.slug.clone()?, volume.to_string(), page.to_string()))
        }
        stare::index::PageKey::Number(_) => None,
    }
}

/// The page a citation names, as the index keys it: a number when it's all digits, a
/// label when it doesn't start with one (`xxix`, `Supp. 1`, lowercased). None for
/// anything else (`647a`, a CCH paragraph `37,448`).
pub fn cited_page(page: &str) -> Option<stare::index::PageKey> {
    let page = page.trim();
    if page.starts_with(|c: char| c.is_ascii_digit()) {
        return page
            .parse::<u32>()
            .ok()
            .map(|n| stare::index::PageKey::Number(n as usize));
    }
    stare::idx::parse_page(page)
}

/// Resolve what `stare resolve` is given: a labelled page in slug form or as cited,
/// else a citation or its slug form.
pub fn resolve_input(src: &Sources, input: &str) -> Result<stare::resolve::CaseResult> {
    let labeled = parse_labeled_input(input).or_else(|| cited_label(input));
    match labeled {
        Some((reporter, volume, label)) => resolve_label(src, &reporter, &volume, &label),
        None => {
            let (reporter, volume, page) = parse_citation_input(input)?;
            resolve_case(src, &reporter, &volume, page)
        }
    }
}

/// Resolve a citation to `volume` (a cited number or a CAP folder name).
///
/// When the manifest says the build has the unified index (`idx`), the volume's
/// `.idx.gz` answers for every source in one read (plus a later part for a split
/// volume); a split volume's other folder named directly (`a3d 138-2`) reads its
/// number's file. Otherwise, or when the volume has no `.idx.gz`, the `.bin`/`.multi`
/// files do: the volume's own folder first,
/// then the manifest's other parts of a volume CAP split over several folders.
pub fn resolve_case(
    src: &Sources,
    reporter: &str,
    volume: &str,
    page: u32,
) -> Result<stare::resolve::CaseResult> {
    let key = stare::index::PageKey::Number(page as usize);
    if let Some(entries) = idx_entries(src, reporter, volume, &key)? {
        return resolve_entries(
            src,
            reporter,
            volume,
            &stare::idx::page_text(&key),
            &entries,
        );
    }
    let located = locate_cap(src, reporter, volume, page)?;
    let mut case_file = located.case_file;
    if case_file == stare::index::LONG_NAME {
        // The page's cases have names too long for the .bin; they're all in the .multi.
        let multi = fetch_multi(src, reporter, &located.volume)?
            .with_context(|| format!("{}/{}.multi is missing", reporter, located.volume))?;
        let multi = stare::index::parse_multi(&multi);
        let bin = fetch_bin(src, reporter, &located.volume)?;
        case_file = stare::index::lookup_all(&bin, &multi, page as usize)
            .first()
            .with_context(|| format!("no case at page {} in {}", page, located.volume))?
            .to_string();
    }
    let zip_data = fetch_zip(src, reporter, &located.volume)?;
    let case = stare::case::extract_from_zip(&zip_data, &case_file)?;
    Ok(stare::resolve::CaseResult {
        case_file,
        case,
        via: None,
    })
}

/// The unified index's entries at `page` of `volume`, CAP's first: following part 0's
/// `#parts` header to the part the page is in. None when the manifest doesn't announce
/// the unified index or the volume has no `.idx.gz`, so the caller falls back to the
/// `.bin`/`.multi` files.
pub fn idx_entries(
    src: &Sources,
    reporter: &str,
    volume: &str,
    page: &stare::index::PageKey,
) -> Result<Option<Vec<stare::idx::Entry>>> {
    let Some(manifest) = src.manifest().filter(|m| m.has_idx()) else {
        return Ok(None);
    };
    // A split volume's other folder named directly (`a3d 138-2`) is in its number's
    // file, as the lines that name the folder.
    if let Some(number) = manifest.folded_into(reporter, volume) {
        let number = number.to_string();
        return Ok(idx_entries(src, reporter, &number, page)?.map(|entries| {
            entries
                .into_iter()
                .filter(|e| e.cap_case().is_some_and(|(f, _)| f == Some(volume)))
                .collect()
        }));
    }
    let Some(head) = fetch_idx(src, reporter, volume, 0)? else {
        return Ok(None);
    };
    let part = head.part_for(page);
    let index = if part == 0 {
        head
    } else {
        fetch_idx(src, reporter, volume, part)?.with_context(|| {
            format!(
                "{} is missing",
                stare::idx::path(reporter, volume, part).unwrap_or_default()
            )
        })?
    };
    Ok(Some(index.lookup(page).into_iter().cloned().collect()))
}

/// The first of a page's entries, read from its source: a CAP case from its folder's
/// zip, an alias's case from its own reporter and folder's zip (with the alias's `via`
/// on the result), or a CourtListener record from the data bucket's `cl/`.
pub fn resolve_entries(
    src: &Sources,
    reporter: &str,
    volume: &str,
    page: &str,
    entries: &[stare::idx::Entry],
) -> Result<stare::resolve::CaseResult> {
    let entry = entries
        .first()
        .with_context(|| format!("no case at page {} in {} vol. {}", page, reporter, volume))?;
    if let Some((folder, case_file)) = entry.cap_case() {
        let zip_data = fetch_zip(src, reporter, folder.unwrap_or(volume))?;
        let case = stare::case::extract_from_zip(&zip_data, case_file)?;
        return Ok(stare::resolve::CaseResult {
            case_file: case_file.to_string(),
            case,
            via: entry.via.clone(),
        });
    }
    if let Some((target, folder, case_file)) = entry.alias_target() {
        let zip_data = fetch_zip(src, target, folder)?;
        let case = stare::case::extract_from_zip(&zip_data, case_file)
            .with_context(|| format!("alias {}", entry.line()))?;
        return Ok(stare::resolve::CaseResult {
            case_file: format!("{}/{}/{}", target, folder, case_file),
            case,
            via: entry.via.clone(),
        });
    }
    let (cluster_id, hash) = entry
        .cl_record()
        .with_context(|| format!("unreadable index line {}", entry.line()))?;
    let bytes = fetch_record(src, cluster_id, hash)?;
    let case = stare::cl::decode_record(&bytes).with_context(|| {
        format!(
            "CourtListener record {}",
            stare::cl::record_path(cluster_id, hash).unwrap_or_default()
        )
    })?;
    Ok(stare::resolve::CaseResult {
        case_file: format!("cl/{}", cluster_id),
        case,
        via: entry.via.clone(),
    })
}

/// The CAP folder with a case at `page` for a citation to `volume`; an error is a miss.
pub fn locate_cap(
    src: &Sources,
    reporter: &str,
    volume: &str,
    page: u32,
) -> Result<stare::manifest::Located> {
    let read = |v: &str| fetch_bin(src, reporter, v);
    match stare::manifest::locate(&[volume.to_string()], page, read) {
        Ok(found) => Ok(found),
        Err(direct) => {
            let Some(manifest) = src.manifest() else {
                return Err(direct.context(format!("{}/{}", reporter, volume)));
            };
            let others: Vec<String> = manifest
                .candidates(reporter, volume, page)
                .into_iter()
                .filter(|v| v != volume)
                .collect();
            if others.is_empty() {
                return Err(direct.context(format!("{}/{}", reporter, volume)));
            }
            stare::manifest::locate(&others, page, read).with_context(|| {
                format!("no case at page {} in {} vol. {}", page, reporter, volume)
            })
        }
    }
}

/// Resolve a case on an unnumbered page (`xxix`, `Supp. 1`) of a volume.
pub fn resolve_label(
    src: &Sources,
    reporter: &str,
    volume: &str,
    label: &str,
) -> Result<stare::resolve::CaseResult> {
    let key = stare::idx::parse_page(label).with_context(|| format!("not a page: {:?}", label))?;
    if let Some(entries) = idx_entries(src, reporter, volume, &key)? {
        return resolve_entries(src, reporter, volume, label, &entries);
    }
    let multi = fetch_multi(src, reporter, volume)?.unwrap_or_default();
    let labeled = stare::index::parse_labeled(&multi);
    let case_file = stare::index::lookup_label(&labeled, label)
        .first()
        .with_context(|| format!("no case at page {} in {}/{}", label, reporter, volume))?
        .to_string();
    let zip_data = fetch_zip(src, reporter, volume)?;
    let case = stare::case::extract_from_zip(&zip_data, &case_file)?;
    Ok(stare::resolve::CaseResult {
        case_file,
        case,
        via: None,
    })
}

/// "Source: CourtListener (export 2026-09-30)" for a CourtListener record; None for
/// CAP's, which is the default source.
pub fn source_line(case: &stare::case::CaseJson) -> Option<String> {
    let source = case.source.as_ref().filter(|s| s.name == "courtlistener")?;
    Some(match &source.export {
        Some(export) => format!("Source: CourtListener (export {})", export),
        None => "Source: CourtListener".to_string(),
    })
}
