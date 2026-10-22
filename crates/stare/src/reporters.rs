//! The reporter map, `reporters.json` (#161): every reporter slug the index can file a
//! volume under, the abbreviations citare reads as it, the volumes the index holds, and
//! the URL templates that turn a slug, volume and page into index and case-file URLs.
//! An agent maps "N.W.2d" to `nw2d` with it instead of running citare.
//!
//! It is generated, never hand-written: the names and variations come from the citare
//! data bundle stare is built with (the edition table and the variation names in its
//! reporter map), and the volumes from an index manifest. `stare-site export-reporters`
//! writes it for the site build, which serves it at `https://stare.pub/reporters.json`.
//! `schemas/reporters.v1.schema.json` ([`crate::schemas::REPORTERS_V1`]) is its spec.
//!
//! The volumes are the manifest's as of the site build. Index builds publish on their
//! own schedule, so the live manifest's `reporters` stays the authority on what is held;
//! `index_build` names the build the volumes came from.

use crate::license::{License, Source};
use crate::manifest::Manifest;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

/// The format of `reporters.json`; `schemas/reporters.v1.schema.json` describes it.
pub const FORMAT: u32 = 1;

/// Where `reporters.json` is published.
pub const URL: &str = "https://stare.pub/reporters.json";

/// The URL templates in `reporters.json`. `{base}` is the live manifest's `base`.
pub const INDEX_URL: &str = "https://idx.stare.pub/{base}{slug}/{volume}.idx.gz";
pub const INDEX_PART_URL: &str = "https://idx.stare.pub/{base}{slug}/{volume}.{part}.idx.gz";
pub const MANIFEST_URL: &str = "https://idx.stare.pub/manifest.json";
pub const CAP_ZIP_URL: &str = "https://data.stare.pub/cap/{slug}/{folder}.zip";
pub const CAP_CASE_PATH: &str = "json/{ref}.json";
pub const CL_RECORD_URL: &str = "https://data.stare.pub/cl/c/{cluster_id}/{hash}.json.gz";
pub const VIEWER_URL: &str = "https://stare.pub/#{slug}/{volume}/{page}";

/// The fields of the map taken from reporters-db, by way of citare's data bundle: the
/// names and variations (`abbreviations`' keys, each reporter's `names` and
/// `variations`) and the editions (name, the reporter's full name, start and end
/// years). The slugs, `cap`, `volumes` and `urls` are the project's, from CAP's
/// reporter list, citare and the index manifest.
pub const REPORTERS_DB_FIELDS: &[&str] = &[
    "abbreviations (keys)",
    "reporters.*.names",
    "reporters.*.variations",
    "reporters.*.editions",
];

/// What reporters-db contributes to the map (D67).
pub const REPORTERS_DB_CONTRIBUTES: &str =
    "Most reporter names, variations and editions, from reporters-db's reporters.json by way of citare's data bundle.";

/// The fields of the map citare's own supplement to reporters-db contributes to: the
/// reporters, editions and variations its `data/reporters-local.json` adds.
pub const CITARE_FIELDS: &[&str] = REPORTERS_DB_FIELDS;

/// What citare's supplement contributes to the map (D67).
pub const CITARE_CONTRIBUTES: &str =
    "The reporters, editions and variations reporters-db doesn't have, from citare's own supplement to it, data/reporters-local.json.";

/// Slugs citare no longer assigns, each with the slug that took its editions. The map
/// keeps an entry for each, with `replaced_by` and no names, for one site release
/// after the citare release that dropped it, so an agent holding the old slug finds
/// the new one; the next release removes it. citare v0.7.2 (citare#105, ruling D78)
/// folded `P.R.R.` into CAP's `pr` and `Cai. R.` into CAP's `cai`.
pub const REPLACED: &[(&str, &str)] = &[("cai-r", "cai"), ("p-r-r", "pr")];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReporterMap {
    #[serde(rename = "$schema")]
    pub schema: String,
    pub format: u32,
    /// The map's licence, CC BY-NC-ND 4.0 ([`crate::license`]), for everything in it
    /// that [`ReporterMap::sources`] doesn't name.
    pub license: License,
    /// Every source of the map's fields that aren't the project's alone, one entry
    /// each, with its licence and what it contributes (D65, D67): reporters-db, with
    /// its licence and copyright notice, and citare's own supplement to it, under the
    /// project's terms. Both contribute to [`REPORTERS_DB_FIELDS`].
    pub sources: Vec<Source>,
    pub generated_from: GeneratedFrom,
    pub urls: Urls,
    /// Every name and variation → the slugs it can be filed under, sorted. Most have
    /// one; a name several reporters share (`Hill`) has several, and citare picks one
    /// by the volume and the citing text.
    pub abbreviations: BTreeMap<String, Vec<String>>,
    /// Slug → what it holds and how it is cited.
    pub reporters: BTreeMap<String, Reporter>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GeneratedFrom {
    /// The citare data bundle's published name (`citare-data-<hash>.bin`).
    pub citare_data: String,
    /// reporters-db's commit, from the bundle's provenance.
    pub reporters_db_commit: Option<String>,
    /// The index build the volumes came from.
    pub index_build: Option<IndexBuild>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IndexBuild {
    pub version: Option<String>,
    pub base: Option<String>,
    pub generated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Urls {
    pub manifest: &'static str,
    pub index: &'static str,
    pub index_part: &'static str,
    pub cap_zip: &'static str,
    pub cap_case_in_zip: &'static str,
    pub cl_record: &'static str,
    pub viewer: &'static str,
}

impl Default for Urls {
    fn default() -> Self {
        Urls {
            manifest: MANIFEST_URL,
            index: INDEX_URL,
            index_part: INDEX_PART_URL,
            cap_zip: CAP_ZIP_URL,
            cap_case_in_zip: CAP_CASE_PATH,
            cl_record: CL_RECORD_URL,
            viewer: VIEWER_URL,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Reporter {
    /// The editions' canonical abbreviations (`A.2d`).
    pub names: Vec<String>,
    /// Other spellings citare reads as one of `names` (`A. 2d`), sorted.
    pub variations: Vec<String>,
    /// The reporters-db editions filed under this slug.
    pub editions: Vec<Edition>,
    /// Whether this is a Caselaw Access Project slug, the folder CAP files the
    /// reporter's volumes under.
    pub cap: bool,
    /// The volume folders the index holds, or `None` when it holds none: a citation
    /// into the reporter then links out.
    pub volumes: Option<Volumes>,
    /// The slug that replaced this one, for a slug citare no longer assigns
    /// ([`REPLACED`]); absent otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replaced_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Edition {
    pub name: String,
    pub reporter: String,
    pub start_year: Option<u32>,
    pub end_year: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Volumes {
    /// How many volume folders the index holds.
    pub count: usize,
    /// The first and last folder, in the manifest's order (`31`, `999`).
    pub first: String,
    pub last: String,
    /// Volume numbers whose cases are split over several folders (`138` is `138`
    /// and `138-2`); the manifest's `parts` says which pages are in which.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub split: Vec<String>,
}

/// One edition as the map needs it, so [`build`] can be tested without the bundle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditionInput {
    pub name: String,
    pub reporter: String,
    pub start: Option<String>,
    pub end: Option<String>,
    pub slug: Option<String>,
    pub harvard_slug: Option<String>,
}

/// A variation name and the editions it names, by index into the edition list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VariationInput {
    pub name: String,
    pub editions: Vec<usize>,
}

/// The map from the citare data stare was built with (or loaded at runtime) and an
/// index manifest.
pub fn from_citare(manifest: Option<&Manifest>, citare_data: &str) -> ReporterMap {
    let data = citare_core::data::get();
    let bundle = &data.bundle;
    let editions: Vec<EditionInput> = bundle
        .editions
        .iter()
        .map(|e| EditionInput {
            name: e.short_name.to_string(),
            reporter: e.reporter_name.to_string(),
            start: e.start.as_deref().map(str::to_string),
            end: e.end.as_deref().map(str::to_string),
            slug: e.slug.as_deref().map(str::to_string),
            harvard_slug: e.harvard_slug.as_deref().map(str::to_string),
        })
        .collect();
    // The reporter map has one extractor per spelling; a variation's names the
    // literal spelling, and its variation editions the editions it stands for.
    let variations: Vec<VariationInput> = bundle
        .reporter_map
        .iter()
        .filter(|m| !m.short && !m.variation_indices.is_empty())
        .flat_map(|m| {
            m.strings.iter().map(|s| VariationInput {
                name: s.to_string(),
                editions: m.variation_indices.iter().map(|&i| i as usize).collect(),
            })
        })
        .collect();
    let mut map = build(&editions, &variations, manifest);
    replace(&mut map, REPLACED);
    map.generated_from.citare_data = citare_data.to_string();
    map.generated_from.reporters_db_commit = data.meta("reporters_db_commit").map(str::to_string);
    map.sources = sources(map.generated_from.reporters_db_commit.as_deref());
    map
}

/// The map's `sources` (D65, D67): reporters-db at `reporters_db_commit`, then
/// citare's own supplement to it.
pub fn sources(reporters_db_commit: Option<&str>) -> Vec<Source> {
    vec![
        crate::license::REPORTERS_DB.source(
            reporters_db_commit,
            REPORTERS_DB_CONTRIBUTES,
            REPORTERS_DB_FIELDS,
        ),
        crate::license::citare(CITARE_CONTRIBUTES, CITARE_FIELDS),
    ]
}

/// The map from an edition table, its variations and an index manifest.
pub fn build(
    editions: &[EditionInput],
    variations: &[VariationInput],
    manifest: Option<&Manifest>,
) -> ReporterMap {
    let mut reporters: BTreeMap<String, Reporter> = BTreeMap::new();
    let mut abbreviations: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut variation_names: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();

    for e in editions {
        let Some(slug) = &e.slug else { continue };
        let r = reporters.entry(slug.clone()).or_default();
        if !r.names.contains(&e.name) {
            r.names.push(e.name.clone());
        }
        let edition = Edition {
            name: e.name.clone(),
            reporter: e.reporter.clone(),
            start_year: year(e.start.as_deref()),
            end_year: year(e.end.as_deref()),
        };
        if !r.editions.contains(&edition) {
            r.editions.push(edition);
        }
        r.cap |= e.harvard_slug.as_deref() == Some(slug.as_str());
        abbreviations
            .entry(e.name.clone())
            .or_default()
            .insert(slug.clone());
    }
    for v in variations {
        for &i in &v.editions {
            let Some(slug) = editions.get(i).and_then(|e| e.slug.as_ref()) else {
                continue;
            };
            abbreviations
                .entry(v.name.clone())
                .or_default()
                .insert(slug.clone());
            variation_names
                .entry(slug.clone())
                .or_default()
                .insert(v.name.clone());
        }
    }
    for (slug, names) in variation_names {
        if let Some(r) = reporters.get_mut(&slug) {
            r.variations = names.into_iter().filter(|n| !r.names.contains(n)).collect();
        }
    }

    if let Some(m) = manifest {
        // A slug the index holds that citare has no edition for still gets an
        // entry, so the map lists every slug there is.
        for (slug, folders) in &m.reporters {
            let (Some(first), Some(last)) = (folders.first(), folders.last()) else {
                continue;
            };
            let split = m
                .parts
                .get(slug)
                .map(|p| p.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            let mut split = split;
            split.sort_by(|a, b| crate::manifest::compare_volumes(a, b));
            reporters.entry(slug.clone()).or_default().volumes = Some(Volumes {
                count: folders.len(),
                first: first.clone(),
                last: last.clone(),
                split,
            });
        }
    }

    ReporterMap {
        schema: crate::schemas::REPORTERS_V1_ID.to_string(),
        format: FORMAT,
        license: crate::license::CC_BY_NC_ND,
        sources: sources(None),
        generated_from: GeneratedFrom {
            citare_data: String::new(),
            reporters_db_commit: None,
            index_build: manifest.map(|m| IndexBuild {
                version: m.version.clone(),
                base: m.base.clone(),
                generated_at: m.generated_at.clone(),
            }),
        },
        urls: Urls::default(),
        abbreviations: abbreviations
            .into_iter()
            .map(|(k, v)| (k, v.into_iter().collect()))
            .collect(),
        reporters,
    }
}

/// Adds an entry for each replaced slug, `(old, new)`, saying it was replaced by `new`.
/// A slug citare still assigns (one with names) keeps its entry as it is, and so does
/// one whose replacement isn't in the map, since neither was replaced.
pub fn replace(map: &mut ReporterMap, replaced: &[(&str, &str)]) {
    for &(old, new) in replaced {
        if !map.reporters.contains_key(new) {
            continue;
        }
        let r = map.reporters.entry(old.to_string()).or_default();
        if r.names.is_empty() {
            r.replaced_by = Some(new.to_string());
        }
    }
}

/// The year of an ISO-8601 date (`1938-01-01T00:00:00` → 1938).
fn year(date: Option<&str>) -> Option<u32> {
    date?.get(..4)?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edition(name: &str, reporter: &str, slug: Option<&str>, cap: bool) -> EditionInput {
        EditionInput {
            name: name.into(),
            reporter: reporter.into(),
            start: Some("1938-01-01T00:00:00".into()),
            end: None,
            slug: slug.map(str::to_string),
            harvard_slug: if cap { slug.map(str::to_string) } else { None },
        }
    }

    fn manifest() -> Manifest {
        Manifest::parse(
            br#"{"format": 2, "version": "v2026.10.18", "base": "v/v2026.10.18/",
                "reporters": {"a2d": ["31", "32", "999"], "a3d": ["138-2", "1", "138"],
                              "zz": ["4"]},
                "parts": {"a3d": {"138": [
                    {"volume": "138", "first_page": 8, "last_page": 1221},
                    {"volume": "138-2", "first_page": 2, "last_page": 1263}]}},
                "idx": 1}"#,
        )
        .unwrap()
    }

    #[test]
    fn names_variations_and_volumes() {
        let editions = vec![
            edition("A.2d", "Atlantic Reporter", Some("a2d"), true),
            edition("A.3d", "Atlantic Reporter", Some("a3d"), true),
            edition("Hill", "Hill's New York Reports", Some("hill"), true),
            edition(
                "Hill",
                "Hill's South Carolina Reports",
                Some("hill-sc"),
                false,
            ),
            edition("U.S.C.", "United States Code", None, false),
        ];
        let variations = vec![
            VariationInput {
                name: "A. 2d".into(),
                editions: vec![0],
            },
            VariationInput {
                name: "Atl. 2d".into(),
                editions: vec![0],
            },
            VariationInput {
                name: "U. S. C.".into(),
                editions: vec![4],
            },
        ];
        let m = manifest();
        let map = build(&editions, &variations, Some(&m));

        assert_eq!(map.abbreviations["A.2d"], vec!["a2d"]);
        assert_eq!(map.abbreviations["A. 2d"], vec!["a2d"]);
        assert_eq!(map.abbreviations["Hill"], vec!["hill", "hill-sc"]);
        assert!(
            !map.abbreviations.contains_key("U.S.C."),
            "laws have no slug"
        );
        assert!(!map.abbreviations.contains_key("U. S. C."));

        let a2d = &map.reporters["a2d"];
        assert_eq!(a2d.names, vec!["A.2d"]);
        assert_eq!(a2d.variations, vec!["A. 2d", "Atl. 2d"]);
        assert!(a2d.cap);
        assert_eq!(a2d.editions[0].start_year, Some(1938));
        assert_eq!(a2d.editions[0].end_year, None);
        assert_eq!(
            a2d.volumes,
            Some(Volumes {
                count: 3,
                first: "31".into(),
                last: "999".into(),
                split: vec![],
            })
        );
        let a3d = map.reporters["a3d"].volumes.as_ref().unwrap();
        assert_eq!((a3d.first.as_str(), a3d.last.as_str()), ("1", "138-2"));
        assert_eq!(a3d.split, vec!["138"]);
        assert!(!map.reporters["hill-sc"].cap);
        assert_eq!(map.reporters["hill-sc"].volumes, None);
        // Held by the index but unknown to citare: listed with no names.
        assert!(map.reporters["zz"].names.is_empty());
        assert_eq!(map.reporters["zz"].volumes.as_ref().unwrap().count, 1);

        let build = map.generated_from.index_build.as_ref().unwrap();
        assert_eq!(build.version.as_deref(), Some("v2026.10.18"));
        assert_eq!(build.base.as_deref(), Some("v/v2026.10.18/"));
    }

    #[test]
    fn without_a_manifest_no_volumes() {
        let editions = vec![edition("A.2d", "Atlantic Reporter", Some("a2d"), true)];
        let map = build(&editions, &[], None);
        assert_eq!(map.reporters["a2d"].volumes, None);
        assert_eq!(map.generated_from.index_build, None);
    }

    #[test]
    fn from_the_embedded_citare_data() {
        let map = from_citare(None, "citare-data-test.bin");
        assert_eq!(map.abbreviations["A.2d"], vec!["a2d"]);
        assert_eq!(map.abbreviations["F. Supp. 2d"], vec!["f-supp-2d"]);
        assert_eq!(map.abbreviations["N.W.2d"], vec!["nw2d"]);
        assert_eq!(map.abbreviations["NY Slip Op"], vec!["ny-slip-op"]);
        assert!(map.reporters["us"].cap);
        assert!(!map.reporters["ny-slip-op"].cap);
        // A variation reporters-db lists for the Atlantic Reporter, Second Series.
        assert!(map.reporters["a2d"].variations.iter().any(|v| v == "A. 2d"));
        assert!(map.generated_from.reporters_db_commit.is_some());
        // One entry per source (D67): reporters-db, at the commit the bundle records,
        // then citare's own supplement, under the project's terms.
        assert_eq!(map.sources.len(), 2);
        let source = &map.sources[0];
        assert_eq!(source.name, "reporters-db");
        assert_eq!(source.commit, map.generated_from.reporters_db_commit);
        assert_eq!(source.license.id, "BSD-2-Clause");
        assert_eq!(source.license.text, Some(crate::license::REPORTERS_DB.text));
        assert_eq!(source.fields, REPORTERS_DB_FIELDS);
        let citare = &map.sources[1];
        assert_eq!(citare.name, "citare");
        assert_eq!(
            citare.commit.as_deref(),
            Some(crate::license::CITARE_COMMIT)
        );
        assert_eq!(citare.license.id, crate::license::CC_BY_NC_ND.id);
        assert_eq!(citare.license.source, Some(crate::license::SOURCE));
        assert_eq!(citare.license.text, None);
        assert_eq!(citare.fields, CITARE_FIELDS);
        // Every abbreviation names slugs the map lists, and none a replaced one.
        for slugs in map.abbreviations.values() {
            for s in slugs {
                assert!(map.reporters.contains_key(s), "{s}");
                assert_eq!(map.reporters[s].replaced_by, None, "{s}");
            }
        }
        // citare v0.7.2 (citare#105, D78) folded P.R.R. into pr and Cai. R. into cai;
        // the old slugs stay for one release, saying so.
        assert_eq!(map.abbreviations["P.R.R."], vec!["pr"]);
        assert_eq!(map.abbreviations["Cai. R."], vec!["cai"]);
        for (old, new) in REPLACED {
            let r = &map.reporters[*old];
            assert_eq!(r.replaced_by.as_deref(), Some(*new), "{old}");
            assert!(r.names.is_empty() && r.editions.is_empty(), "{old}");
            let to = &map.reporters[*new];
            assert_eq!(to.replaced_by, None, "{new}");
            assert!(!to.names.is_empty(), "{new}");
        }
    }

    #[test]
    fn a_replaced_slug_keeps_an_entry_naming_its_replacement() {
        let editions = vec![
            edition("P.R.", "Puerto Rico Reports", Some("pr"), true),
            edition("P.R.R.", "Puerto Rico Reports", Some("pr"), true),
            edition("A.2d", "Atlantic Reporter", Some("a2d"), true),
        ];
        let mut map = build(&editions, &[], None);
        replace(
            &mut map,
            &[("p-r-r", "pr"), ("a2d", "pr"), ("gone", "nowhere")],
        );
        let old = &map.reporters["p-r-r"];
        assert_eq!(old.replaced_by.as_deref(), Some("pr"));
        assert!(old.names.is_empty() && old.variations.is_empty() && old.editions.is_empty());
        assert!(!old.cap);
        assert_eq!(old.volumes, None);
        assert_eq!(map.reporters["pr"].replaced_by, None);
        // A slug citare still assigns isn't replaced, nor one whose replacement
        // the map doesn't list.
        assert_eq!(map.reporters["a2d"].replaced_by, None);
        assert!(!map.reporters.contains_key("gone"));
        let json = serde_json::to_value(&map).unwrap();
        assert_eq!(json["reporters"]["p-r-r"]["replaced_by"], "pr");
        assert!(json["reporters"]["pr"].get("replaced_by").is_none());
    }
}
