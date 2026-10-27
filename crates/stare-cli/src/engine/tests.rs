//! The engine's tests, moved with it from `main.rs`: a versioned build with the unified
//! index, and what `stare resolve` and `stare check` make of it.

use super::check::*;
use super::resolve::*;
use super::{Sources, CACHE_ENV};
use stare::config;

fn sources(index: &std::path::Path) -> Sources {
    Sources::new(index.to_string_lossy(), "")
}

const H1: &str = "0f3a9c2e7b1d4a65";

/// A versioned build with the unified index and the old files beside it (the
/// transition release), a CourtListener record beside the data source's `cap/`,
/// and CAP zips for a2d 31:
///
/// - a2d 31 page 647 has a CAP case and a CourtListener alias line;
/// - a3d 250 is a volume only CourtListener has (two records at page 100);
/// - a2d 31 is split, with pages from 700 in part 1.
fn idx_fixture(with_idx: bool) -> (tempfile::TempDir, tempfile::TempDir, Sources) {
    use std::io::Write;
    let idx = tempfile::tempdir().unwrap();
    let idx_field = if with_idx { r#""idx": 1,"# } else { "" };
    std::fs::write(
        idx.path().join("manifest.json"),
        format!(
            r#"{{"format": 2, {idx_field} "base": "v/v1/",
                "reporters": {{"a2d": ["31"], "a3d": ["250"]}}}}"#
        ),
    )
    .unwrap();
    let v = idx.path().join("v/v1");
    std::fs::create_dir_all(v.join("a2d")).unwrap();
    std::fs::create_dir_all(v.join("a3d")).unwrap();

    let zip = std::fs::read("../stare/tests/fixtures/a2d-31.zip").unwrap();
    let names = stare::case::list_cases_in_zip(&zip).unwrap();
    let keyed: Vec<(&str, usize)> = names
        .iter()
        .map(|n| (n.as_str(), n[..4].parse().unwrap()))
        .collect();
    let built = stare::index::build(&keyed);
    std::fs::write(v.join("a2d/31.bin"), &built.bin).unwrap();

    let mut entries =
        stare::idx::entries_from_bin(&built.bin, built.multi_file().as_deref(), None).unwrap();
    entries.push(stare::idx::Entry::cl(stare::index::PageKey::Number(647), 1, H1).unwrap());
    // Split before page 700, the way a big volume would be.
    let mut head = String::from("#parts,700\n");
    let mut tail = String::new();
    stare::idx::sort_entries(&mut entries);
    for e in &entries {
        let out = match e.page {
            stare::index::PageKey::Number(n) if n >= 700 => &mut tail,
            _ => &mut head,
        };
        out.push_str(&e.line());
        out.push('\n');
    }
    std::fs::write(v.join("a2d/31.idx.gz"), stare::idx::gzip(&head)).unwrap();
    std::fs::write(v.join("a2d/31.1.idx.gz"), stare::idx::gzip(&tail)).unwrap();
    std::fs::write(
        v.join("a3d/250.idx.gz"),
        stare::idx::gzip(&format!(
            "100,cl,9876543/{H1}\n100,cl,9876544/a1b2c3d4e5f60718\nbad line\n"
        )),
    )
    .unwrap();

    let data = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(data.path().join("cap/a2d")).unwrap();
    std::fs::write(data.path().join("cap/a2d/31.zip"), &zip).unwrap();
    let dir = data.path().join("cl/c/9876543");
    std::fs::create_dir_all(&dir).unwrap();
    let json = std::fs::read("../stare/tests/fixtures/cl-record.json").unwrap();
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(&json).unwrap();
    std::fs::write(dir.join(format!("{H1}.json.gz")), gz.finish().unwrap()).unwrap();

    let src = Sources::new(
        idx.path().to_string_lossy(),
        data.path().join("cap").to_string_lossy(),
    );
    (idx, data, src)
}

#[test]
fn the_unified_index_resolves_every_source() {
    let _env = CACHE_ENV.lock().unwrap_or_else(|e| e.into_inner());
    let cache = tempfile::tempdir().unwrap();
    std::env::set_var("XDG_CACHE_HOME", cache.path());
    let (_idx, _data, src) = idx_fixture(true);

    // A CAP page with a CourtListener alias line shows CAP's case.
    let result = resolve_case(&src, "a2d", "31", 647).unwrap();
    assert_eq!(result.case_file, "0647-01");
    assert_eq!(result.case.name_abbreviation, "D'Elia & Marks Co. v. Lyon");

    // A page past the split comes from the later part.
    let tail =
        stare::idx::parse_bytes(&std::fs::read(_idx.path().join("v/v1/a2d/31.1.idx.gz")).unwrap())
            .unwrap();
    let first = &tail.entries[0];
    let stare::index::PageKey::Number(page) = first.page else {
        unreachable!()
    };
    let r = resolve_case(&src, "a2d", "31", page as u32).unwrap();
    assert_eq!(r.case_file, first.reference);
    assert!(config::cache_get("bins", "v/v1/a2d/31.1.idx.gz").is_some());

    // A volume only CourtListener has: the first record at the page.
    let result = resolve_case(&src, "a3d", "250", 100).unwrap();
    assert_eq!(result.case_file, "cl/9876543");
    assert_eq!(result.case.source_name(), "courtlistener");
    assert_eq!(
        source_line(&result.case).as_deref(),
        Some("Source: CourtListener (export 2026-09-30)")
    );

    // A miss in a held volume is a miss, never another volume's case.
    let err = resolve_case(&src, "a3d", "250", 101).err().unwrap();
    assert!(
        format!("{err:#}").contains("no case at page 101"),
        "{err:#}"
    );

    // `stare check` counts both as held, and only the hit as found.
    assert_eq!(check_page(&src, "a3d", 250, 100), (true, true, None));
    assert_eq!(check_page(&src, "a3d", 250, 101), (true, false, None));
    assert_eq!(check_page(&src, "a2d", 31, 647), (true, true, None));
    assert_eq!(check_page(&src, "a2d", 99, 1), (false, false, None));
}

#[test]
fn an_alias_resolves_to_its_case_in_another_volume() {
    let _env = CACHE_ENV.lock().unwrap_or_else(|e| e.into_inner());
    let cache = tempfile::tempdir().unwrap();
    std::env::set_var("XDG_CACHE_HOME", cache.path());
    let (idx, _data, src) = idx_fixture(true);
    // nw 260 has only aliases: page 287 is a2d/31's 0647-01 by CourtListener's
    // citations. a3d 250 page 100 has CourtListener's record and an alias: the
    // alias, a CAP case, comes first. a2d 31 page 647 has CAP's own case and an
    // alias to another: CAP's own comes first.
    std::fs::write(
        idx.path().join("manifest.json"),
        r#"{"format": 2, "idx": 1, "base": "v/v1/",
            "reporters": {"a2d": ["31"], "a3d": ["250"]}, "aliases": {"nw": ["260"]}}"#,
    )
    .unwrap();
    let v = idx.path().join("v/v1");
    std::fs::create_dir_all(v.join("nw")).unwrap();
    std::fs::write(
        v.join("nw/260.idx.gz"),
        stare::idx::gzip("287,cap,a2d/31/0647-01,via=cl:8077312\n"),
    )
    .unwrap();
    std::fs::write(
        v.join("a3d/250.idx.gz"),
        stare::idx::gzip(&format!(
            "100,cl,9876543/{H1}\n100,cap,a2d/31/0647-01,via=cl:9876543\n"
        )),
    )
    .unwrap();
    let src = Sources::new(src.index.clone(), src.data.clone());

    let r = resolve_case(&src, "nw", "260", 287).unwrap();
    assert_eq!(r.case.name_abbreviation, "D'Elia & Marks Co. v. Lyon");
    assert_eq!(r.case_file, "a2d/31/0647-01");
    assert_eq!(r.via.as_deref(), Some("cl:8077312"));
    let r = resolve_case(&src, "a3d", "250", 100).unwrap();
    assert_eq!(r.case_file, "a2d/31/0647-01");
    assert_eq!(r.via.as_deref(), Some("cl:9876543"));
    let r = resolve_case(&src, "a2d", "31", 647).unwrap();
    assert_eq!(r.case_file, "0647-01");
    assert_eq!(r.via, None);

    // `stare check`: the alias resolves, with its source; a miss in a volume of
    // aliases only is a volume stare.pub doesn't hold.
    assert_eq!(
        check_page(&src, "nw", 260, 287),
        (true, true, Some("cl:8077312".to_string()))
    );
    assert_eq!(check_page(&src, "nw", 260, 288), (false, false, None));
    assert_eq!(check_page(&src, "a2d", 31, 647), (true, true, None));
}

#[test]
fn a_folded_folder_named_directly_reads_its_volumes_file() {
    let _env = CACHE_ENV.lock().unwrap_or_else(|e| e.into_inner());
    let cache = tempfile::tempdir().unwrap();
    std::env::set_var("XDG_CACHE_HOME", cache.path());
    let (idx, data, src) = idx_fixture(true);
    // Say a2d 31 is split over 31 and 31-2, and 31-2 holds a copy of page 647.
    std::fs::write(
        idx.path().join("manifest.json"),
        r#"{"format": 2, "idx": 1, "base": "v/v1/", "reporters": {"a2d": ["31", "31-2"]},
            "parts": {"a2d": {"31": [{"volume": "31", "first_page": 1, "last_page": 900},
                                     {"volume": "31-2", "first_page": 1, "last_page": 900}]}}}"#,
    )
    .unwrap();
    std::fs::write(
        idx.path().join("v/v1/a2d/31.idx.gz"),
        stare::idx::gzip("1,cap,0001-01\n647,cap,31-2/0647-01\n"),
    )
    .unwrap();
    std::fs::copy(
        data.path().join("cap/a2d/31.zip"),
        data.path().join("cap/a2d/31-2.zip"),
    )
    .unwrap();
    let src = Sources::new(src.index.clone(), src.data.clone());
    let result = resolve_case(&src, "a2d", "31-2", 647).unwrap();
    assert_eq!(result.case_file, "0647-01");
    // 31-2 has no case at page 1; 31 does.
    assert!(resolve_case(&src, "a2d", "31-2", 1).is_err());
    assert!(config::cache_get("bins", "v/v1/a2d/31-2.idx.gz").is_none());
}

#[test]
fn a_manifest_without_idx_reads_the_bin() {
    let _env = CACHE_ENV.lock().unwrap_or_else(|e| e.into_inner());
    let cache = tempfile::tempdir().unwrap();
    std::env::set_var("XDG_CACHE_HOME", cache.path());
    let (_idx, _data, src) = idx_fixture(false);

    let result = resolve_case(&src, "a2d", "31", 647).unwrap();
    assert_eq!(result.case_file, "0647-01");
    // Nothing reads the .idx.gz files the old manifest doesn't announce.
    assert!(config::cache_get("bins", "v/v1/a2d/31.idx.gz").is_none());
    // CourtListener cases need the unified index.
    assert!(resolve_case(&src, "a3d", "250", 100).is_err());
}

/// #154: a labelled page (`xxix`, `Supp. 1`) resolves and checks from the unified
/// index, and from the `.multi` without it, typed in slug form or cited.
#[test]
fn labelled_pages_resolve_and_check() {
    let _env = CACHE_ENV.lock().unwrap_or_else(|e| e.into_inner());
    for with_idx in [true, false] {
        let cache = tempfile::tempdir().unwrap();
        std::env::set_var("XDG_CACHE_HOME", cache.path());
        let (idx, _data, src) = idx_fixture(with_idx);
        // Say 0647-01 starts on page xxix, and 0649-01 on Supp. 1. Labels sort
        // after numbers, so their lines go in the split volume's last part.
        let v = idx.path().join("v/v1/a2d");
        let tail = stare::idx::decode(&std::fs::read(v.join("31.1.idx.gz")).unwrap()).unwrap();
        std::fs::write(
            v.join("31.1.idx.gz"),
            stare::idx::gzip(&format!("{tail}supp. 1,cap,0649-01\nxxix,cap,0647-01\n")),
        )
        .unwrap();
        std::fs::write(v.join("31.multi"), "xxix,0647-01\nsupp. 1,0649-01\n").unwrap();

        for (input, label, case_file) in [
            ("a2d 31 xxix", "xxix", "0647-01"),
            ("a2d 31 XXIX", "XXIX", "0647-01"),
            ("a2d 31 Supp. 1", "Supp. 1", "0649-01"),
        ] {
            let (reporter, volume, got) = parse_labeled_input(input).unwrap();
            assert_eq!(
                (reporter.as_str(), volume.as_str(), got.as_str()),
                ("a2d", "31", label)
            );
            let result = resolve_label(&src, &reporter, &volume, &got).unwrap();
            assert_eq!(result.case_file, case_file, "{input} (idx: {with_idx})");
        }
        assert!(resolve_label(&src, "a2d", "31", "xxx").is_err());

        // citare reads "31 A.2d xxix" with the label as its page.
        assert_eq!(
            cited_label("31 A.2d xxix"),
            Some(("a2d".into(), "31".into(), "xxix".into()))
        );
        assert_eq!(cited_label("31 A.2d 647"), None);

        let label = |l: &str| stare::index::PageKey::Label(l.into());
        assert_eq!(
            check_page_key(&src, "a2d", 31, &label("xxix")),
            (true, true, None)
        );
        assert_eq!(
            check_page_key(&src, "a2d", 31, &label("supp. 1")),
            (true, true, None)
        );
        assert_eq!(
            check_page_key(&src, "a2d", 31, &label("xxx")),
            (true, false, None)
        );
        let cites = stare::cite::detect_citations("See 31 A.2d xxix.");
        assert_eq!(check_status(&src, &cites[0]), CheckStatus::Found);
    }
}

/// #160 in `stare check`: a parallel citation stare.pub doesn't hold is found
/// through its partner, and parallel citations that open different cases are
/// #212: at 31 A.2d 657, where Brooks v. District of Columbia and Waterman v. Railway
/// Express Agency both start, the citing text's case name picks the case.
#[test]
fn a_shared_page_opens_the_case_the_citing_text_names() {
    let _env = CACHE_ENV.lock().unwrap_or_else(|e| e.into_inner());
    let cache = tempfile::tempdir().unwrap();
    std::env::set_var("XDG_CACHE_HOME", cache.path());
    let (_idx, _data, src) = idx_fixture(true);
    let pick = |text: &str| {
        let detected = stare::cite::detect_citations(text);
        let parallels = reconcile_parallels(
            &detected,
            |c| check_status(&src, c),
            |c| check_cases(&src, c),
        );
        names_pick(&src, &detected, &parallels)
            .remove("31 A.2d 657")
            .map(|b| (b.case.clone(), b.among, b.shared, b.note()))
    };
    assert_eq!(
        pick("Waterman v. Railway Express Agency, 31 A.2d 657 (1943)."),
        Some((
            "a2d/31/657-2".into(),
            2,
            false,
            "matched by case name among the 2 cases on this page".into()
        ))
    );
    assert_eq!(
        pick("Brooks v. District of Columbia, 31 A.2d 657 (1943).").map(|p| p.0),
        Some("a2d/31/657".into())
    );
    // Another year, a name neither has, or no name: the page's first, as before.
    assert_eq!(
        pick("Waterman v. Railway Express Agency, 31 A.2d 657 (1950)."),
        None
    );
    assert_eq!(pick("Doe v. Roe, 31 A.2d 657 (1943)."), None);
    assert_eq!(pick("See 31 A.2d 657."), None);
    // A page with one case has nothing to pick among.
    let detected = stare::cite::detect_citations("D'Elia & Marks Co. v. Lyon, 31 A.2d 647.");
    assert!(names_pick(&src, &detected, &Default::default()).is_empty());
}

/// D90: when a run's printings share several cases and none fits the citing text's
/// name, the one case on the official printing's whole page that fits opens, in
/// every printing of the run.
#[test]
fn the_official_page_decides_when_the_shared_cases_miss_the_name() {
    let _env = CACHE_ENV.lock().unwrap_or_else(|e| e.into_inner());
    let cache = tempfile::tempdir().unwrap();
    std::env::set_var("XDG_CACHE_HOME", cache.path());
    let (idx, _data, src) = idx_fixture(true);
    // An alias at 31 A.2d 657 to Raaen v. Southern Hotel Supply Co. (31 A.2d 659), so
    // the page has three cases: Brooks v. District of Columbia, Waterman v. Railway
    // Express Agency and Raaen.
    let path = idx.path().join("v/v1/a2d/31.idx.gz");
    let text = stare::idx::decode(&std::fs::read(&path).unwrap()).unwrap();
    let alias = stare::idx::Entry::alias(
        stare::index::PageKey::Number(657),
        "a2d",
        "31",
        "0659-01",
        1,
    )
    .unwrap()
    .line();
    let mut lines: Vec<&str> = text.lines().collect();
    let at = lines.iter().rposition(|l| l.starts_with("657,")).unwrap() + 1;
    lines.insert(at, &alias);
    std::fs::write(&path, stare::idx::gzip(&(lines.join("\n") + "\n"))).unwrap();

    let detected = |name: &str| {
        stare::cite::detect_citations(&format!("{name}, 31 A.2d 657 (1943), 1 U.S. 1."))
    };
    // The run's printings share Brooks and Raaen, as reconciliation would say of a
    // partner whose data leaves out Waterman.
    let shared = vec!["a2d/31/657".to_string(), "a2d/31/659".to_string()];
    let run = |official: bool| {
        let verdict = || ParallelVerdict {
            case: Some("a2d/31/657".into()),
            tied: shared.clone(),
            official: official.then(|| "31 A.2d 657".to_string()),
            ..Default::default()
        };
        std::collections::HashMap::from([
            (
                "31 A.2d 657".to_string(),
                ParallelVerdict {
                    preferred: true,
                    ..verdict()
                },
            ),
            ("1 U.S. 1".to_string(), verdict()),
        ])
    };
    let picks = names_pick(
        &src,
        &detected("Waterman v. Railway Express Agency"),
        &run(true),
    );
    let note = "matched by case name among the 3 cases on the official page, 31 A.2d 657; \
                the cases its parallel citations share don't include it";
    for raw in ["31 A.2d 657", "1 U.S. 1"] {
        let b = &picks[raw];
        assert_eq!(
            (b.case.as_str(), b.among, b.note()),
            ("a2d/31/657-2", 3, note.into())
        );
    }
    // A shared case that fits is picked among the shared cases, as before.
    let picks = names_pick(
        &src,
        &detected("Brooks v. District of Columbia"),
        &run(true),
    );
    assert_eq!(picks["31 A.2d 657"].case, "a2d/31/657");
    assert!(picks["31 A.2d 657"].official.is_none());
    // No official printing shown by default, or a name nothing on the page fits:
    // the run's narrowing stands.
    assert!(names_pick(
        &src,
        &detected("Waterman v. Railway Express Agency"),
        &run(false)
    )
    .is_empty());
    assert!(names_pick(&src, &detected("Doe v. Roe"), &run(true)).is_empty());

    // D98 (1): a run whose printings share one case, Raaen, as reconciliation would
    // say of a partner whose data names only Raaen.
    let run_one = |official: bool| {
        let verdict = || ParallelVerdict {
            case: Some("a2d/31/659".into()),
            official: official.then(|| "31 A.2d 657".to_string()),
            ..Default::default()
        };
        std::collections::HashMap::from([
            (
                "31 A.2d 657".to_string(),
                ParallelVerdict {
                    preferred: true,
                    ..verdict()
                },
            ),
            ("1 U.S. 1".to_string(), verdict()),
        ])
    };
    let picks = names_pick(
        &src,
        &detected("Waterman v. Railway Express Agency"),
        &run_one(true),
    );
    let note = "matched by case name among the 3 cases on the official page, 31 A.2d 657; \
                the case its parallel citations share doesn't fit the name";
    for raw in ["31 A.2d 657", "1 U.S. 1"] {
        let b = &picks[raw];
        assert_eq!(
            (b.case.as_str(), b.among, b.note()),
            ("a2d/31/657-2", 3, note.into())
        );
    }
    // A name the shared case fits even partly, one with no telling words, one
    // nothing on the page fits, or no official printing shown by default: Raaen
    // stands.
    for name in ["Raaen v. Waterman", "State v.", "Doe v. Roe"] {
        assert!(
            names_pick(&src, &detected(name), &run_one(true)).is_empty(),
            "{name}"
        );
    }
    assert!(names_pick(
        &src,
        &detected("Waterman v. Railway Express Agency"),
        &run_one(false)
    )
    .is_empty());
}

/// flagged with each other.
#[test]
fn check_reconciles_parallel_citations() {
    let detected = stare::cite::detect_citations(
        "Pettegrew v. Pettegrew, 128 Neb. 783, 260 N.W. 287 (1935). \
         Smith v. Jones, 345 Pa. 1, 31 A.2d 650 (1943). See 99 N.W. 1.",
    );
    let found = |c: &stare::cite::DetectedCitation| match c.matched_text.as_str() {
        "128 Neb. 783" | "345 Pa. 1" | "31 A.2d 650" => CheckStatus::Found,
        _ => CheckStatus::NotHeld,
    };
    let case = |c: &stare::cite::DetectedCitation| vec![c.matched_text.clone()];
    let v = reconcile_parallels(&detected, found, case);
    assert_eq!(v["260 N.W. 287"].partner.as_deref(), Some("128 Neb. 783"));
    assert!(v["128 Neb. 783"].partner.is_none());
    assert_eq!(v["345 Pa. 1"].conflicts, ["31 A.2d 650"]);
    assert_eq!(v["31 A.2d 650"].conflicts, ["345 Pa. 1"]);
    assert_eq!(v["31 A.2d 650"].run.as_deref(), Some("345 Pa. 1"));
    assert!(v.get("99 N.W. 1").is_none_or(|v| v.partner.is_none()));
    assert_eq!(v["260 N.W. 287"].case.as_deref(), Some("128 Neb. 783"));
    assert!(v["128 Neb. 783"].preferred);

    // #204: the reprint's page holds two decisions, and the second is the one its
    // partner opens. The two agree on it.
    let found = |c: &stare::cite::DetectedCitation| match c.matched_text.as_str() {
        "128 Neb. 783" | "260 N.W. 287" => CheckStatus::Found,
        _ => CheckStatus::NotHeld,
    };
    let cases = |c: &stare::cite::DetectedCitation| match c.matched_text.as_str() {
        "260 N.W. 287" => vec!["iowa/219/500".to_string(), "neb/128/783".to_string()],
        _ => vec!["neb/128/783".to_string()],
    };
    let v = reconcile_parallels(&detected, found, cases);
    assert!(v["260 N.W. 287"].conflicts.is_empty());
    assert_eq!(v["260 N.W. 287"].case.as_deref(), Some("neb/128/783"));
    // Without a parallel run there is nothing to look up.
    let alone = stare::cite::detect_citations("See 128 Neb. 783. See 260 N.W. 287.");
    let v = reconcile_parallels(&alone, |_| unreachable!(), |_| unreachable!());
    assert!(v.is_empty());
}

/// #198 in `stare check`: one entry per cited case, its printings, its short forms and
/// spellings of an unresolved citation together, counted by the places that cite it.
#[test]
fn check_groups_citations_by_case() {
    let detected = stare::cite::detect_citations(
        "Pettegrew v. Pettegrew, 128 Neb. 783, 260 N.W. 287 (1935). \
         See Barney v. Oelrichs, 138 U.S. 529 (1891). Id. at 533. \
         See 31 A.2d 950; 31 A. 2d 950.",
    );
    let mut seen = std::collections::HashSet::new();
    let entries: Vec<stare::cited::Cited> = detected
        .iter()
        .filter(|c| seen.insert(cited_key(c)))
        .map(|c| match c.matched_text.as_str() {
            "128 Neb. 783" => cited_entry(c, CheckStatus::Found, Some("neb/128/783".into()), false),
            "260 N.W. 287" => cited_entry(
                c,
                CheckStatus::FoundPartner,
                Some("neb/128/783".into()),
                false,
            ),
            "138 U.S. 529" => cited_entry(c, CheckStatus::Found, Some("us/138/529".into()), false),
            "Id." => cited_entry(c, CheckStatus::Found, None, false),
            _ => cited_entry(c, CheckStatus::HeldMiss, None, false),
        })
        .collect();
    let places: Vec<stare::cited::Place> = detected
        .iter()
        .map(|c| stare::cited::Place {
            key: cited_key(c),
            parallel_of: c.parallel_of,
        })
        .collect();
    let g = stare::cited::group(&entries, &places);
    let listed: Vec<(Vec<&str>, usize)> = g
        .groups
        .iter()
        .map(|g| {
            let keys = g.members.iter().map(|&i| entries[i].key.as_str());
            (keys.collect(), g.count)
        })
        .collect();
    assert_eq!(
        listed,
        [
            (vec!["128 Neb. 783", "260 N.W. 287"], 1),
            (vec!["138 U.S. 529", "Id.\u{2192}138 U.S. 529"], 2),
            (vec!["31 A.2d 950", "31 A. 2d 950"], 2),
        ]
    );
    assert_eq!(entries[4].citation.as_deref(), Some("a2d/31/950"));
    // Each form's own places: the run once for each printing.
    assert_eq!(g.entry_counts, [1, 1, 1, 1, 1, 1]);
}

#[test]
fn cited_pages_are_numbers_or_labels() {
    use stare::index::PageKey::{Label, Number};
    assert_eq!(cited_page("647"), Some(Number(647)));
    assert_eq!(cited_page("xxix"), Some(Label("xxix".into())));
    assert_eq!(cited_page("Supp. 1"), Some(Label("supp. 1".into())));
    assert_eq!(cited_page("647a"), None);
    assert_eq!(cited_page("37,448"), None);
}

/// A statute with no link is a statute, not an unchecked case; one
/// with a link is external, and an `Id.` to another of its sections a
/// statute too. None of them touches the index.
#[test]
fn check_tells_statutes_from_cases() {
    let _env = CACHE_ENV.lock().unwrap_or_else(|e| e.into_inner());
    let cache = tempfile::tempdir().unwrap();
    std::env::set_var("XDG_CACHE_HOME", cache.path());
    let src = sources(tempfile::tempdir().unwrap().path());
    let detected = stare::cite::detect_citations(
        "See Conn. Gen. Stat. § 52-584; Minn. Stat. § 609.185. Id. § 609.19.",
    );
    let statuses: Vec<_> = detected
        .iter()
        .map(|c| (c.matched_text.as_str(), check_status(&src, c)))
        .collect();
    assert_eq!(
        statuses,
        [
            ("Conn. Gen. Stat. § 52-584", CheckStatus::Statute),
            ("Minn. Stat. § 609.185", CheckStatus::External),
            ("Id.", CheckStatus::Statute),
        ]
    );
}

/// #120 in `stare check`: a short form is looked up through its
/// antecedent, never at its pin page, and one with no antecedent isn't
/// looked up at all.
#[test]
fn check_looks_short_forms_up_through_their_antecedent() {
    let _env = CACHE_ENV.lock().unwrap_or_else(|e| e.into_inner());
    let cache = tempfile::tempdir().unwrap();
    std::env::set_var("XDG_CACHE_HOME", cache.path());

    // Roe starts at 1021 and Burnett v. State at 1023, Roe's pin page.
    let idx = tempfile::tempdir().unwrap();
    std::fs::write(
        idx.path().join("manifest.json"),
        r#"{"format": 2, "reporters": {"p2d": ["997"]}}"#,
    )
    .unwrap();
    std::fs::create_dir_all(idx.path().join("p2d")).unwrap();
    let built = stare::index::build(&[("1021-01", 1021usize), ("1023-01", 1023)]);
    std::fs::write(idx.path().join("p2d/997.bin"), &built.bin).unwrap();
    let src = sources(idx.path());

    let text = "Id. at 5. Roe v. Board of County Commissioners, 997 P.2d 1021 (Wyo. 2000). \
                Roe, 997 P.2d at 1023. Id. at 1024. \
                Axon Enterprise, Inc. v. FTC, 598 U.S. 175 (2023). Axon, 598 U.S. at 180.";
    let detected = stare::cite::detect_citations(text);
    let status = |raw: &str, ty: &str| {
        let c = detected
            .iter()
            .find(|c| c.matched_text == raw && c.citation_type == ty)
            .unwrap_or_else(|| panic!("no {ty} {raw}"));
        (check_status(&src, c), check_target(c).and_then(|t| t.page))
    };
    assert_eq!(
        status("997 P.2d at 1023", "ShortCaseCitation"),
        (CheckStatus::Found, Some("1021"))
    );
    let ids: Vec<_> = detected
        .iter()
        .filter(|c| c.citation_type == "IdCitation")
        .map(|c| (check_status(&src, c), c.pin.as_deref()))
        .collect();
    assert_eq!(
        ids,
        [
            (CheckStatus::NoAntecedent, Some("5")),
            (CheckStatus::Found, Some("1024")),
        ]
    );
    // The antecedent is a volume stare.pub doesn't hold: the short cite
    // links out with it.
    assert_eq!(
        status("598 U.S. at 180", "ShortCaseCitation"),
        (CheckStatus::NotHeld, Some("175"))
    );
}

/// A case's JSON comes from a whole zip in the cache when there is one, with no
/// request to the data source; otherwise from the source, and then from the cache.
#[test]
fn a_cached_zip_is_read_in_place_of_the_source() {
    use super::case_text::{read_case, read_entry};
    let _env = CACHE_ENV.lock().unwrap_or_else(|e| e.into_inner());
    let cache = tempfile::tempdir().unwrap();
    std::env::set_var("XDG_CACHE_HOME", cache.path());
    let zip = std::fs::read("../stare/tests/fixtures/a2d-31.zip").unwrap();

    // Nothing listens at port 1, so any request fails.
    let offline = Sources::new("http://127.0.0.1:1", "http://127.0.0.1:1/cap");
    assert!(read_case(&offline, "a2d", "31", "0647-01").is_err());
    config::cache_set("zips", "a2d/31.zip", &zip).unwrap();
    let case = read_case(&offline, "a2d", "31", "0647-01").unwrap();
    assert_eq!(case.name_abbreviation, "D'Elia & Marks Co. v. Lyon");

    // A directory source reads the entry from the zip on disk and caches nothing.
    let fresh = tempfile::tempdir().unwrap();
    std::env::set_var("XDG_CACHE_HOME", fresh.path());
    let (_idx, data, src) = idx_fixture(true);
    let html = read_entry(&src, "a2d", "31", "html/0647-01.html").unwrap();
    assert!(String::from_utf8(html).unwrap().contains("page-label"));
    assert!(config::cache_get("zips", "a2d/31/html/0647-01.html").is_none());
    assert!(config::cache_get("zips", "a2d/31.zip").is_none());
    assert!(data.path().join("cap/a2d/31.zip").exists());

    // Paths out of the cache or the zip are refused.
    assert!(read_entry(&src, "a2d", "../31", "json/0647-01.json").is_err());
    assert!(read_entry(&src, "a2d", "31", "../json/0647-01.json").is_err());
    assert!(read_entry(&src, "A2D", "31", "json/0647-01.json").is_err());
}
