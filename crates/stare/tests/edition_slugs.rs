//! The CourtListener pipeline's copy of citare's `data/edition-slugs.json`
//! (`pipelines/courtlistener/src/stare_courtlistener/data/`) names every edition
//! with the slugs the citare stare builds with gives it, so the pipeline, the index
//! build and the resolvers can't drift apart. After a citare bump, refresh it with
//! `uv run python scripts/edition_slugs.py <citare checkout>` in that directory.

use std::collections::BTreeMap;

#[test]
fn the_pipelines_edition_slugs_are_citares() {
    let vendored: BTreeMap<String, Vec<String>> = serde_json::from_str(include_str!(
        "../../../pipelines/courtlistener/src/stare_courtlistener/data/edition-slugs.json"
    ))
    .unwrap();
    let citare = stare::cite::edition_slug_table();
    let differ: Vec<_> = citare
        .keys()
        .chain(vendored.keys())
        .filter(|name| citare.get(*name) != vendored.get(*name).map(|s| sorted(s)).as_ref())
        .collect();
    assert!(
        differ.is_empty(),
        "edition-slugs.json differs from citare for {differ:?}; refresh it with \
         pipelines/courtlistener/scripts/edition_slugs.py"
    );
}

fn sorted(slugs: &[String]) -> Vec<String> {
    let mut s = slugs.to_vec();
    s.sort();
    s
}
