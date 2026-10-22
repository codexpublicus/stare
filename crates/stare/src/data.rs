//! citare's reporter, edition and court tables, as one data bundle
//! (citare's `docs/data-bundle.md`).
//!
//! With the default `embedded-data` feature the bundle is compiled in and
//! loads itself on first use. stare-wasm builds without it; the site serves
//! the bundle gzipped as `/data/citare/v1/<file_name>.gz`, and the page
//! gunzips it and hands it to [`load`] before detecting citations (#117).
//!
//! The bundle is binary, so its licence and its sources' notices are in a sidecar the
//! site serves next to it, `/data/citare/v1/citare-data-<hash>.json` ([`Sidecar`]):
//! CC BY-NC-ND 4.0 for the bundle, and the sections that come from Free Law Project's
//! reporters-db and courts-db with their licence and copyright notice (D65), and
//! citare's own supplements to reporters-db, under the project's terms (D67).

pub use citare_core::data::{is_available, LoadError, FORMAT_VERSION};

/// Install a data bundle for every later citation lookup. Call it once,
/// before the first; a second call fails with [`LoadError::AlreadyLoaded`].
pub fn load(bytes: &[u8]) -> Result<(), LoadError> {
    citare_core::data::load(bytes)
}

/// The lowercase hex SHA-256 of a bundle.
pub fn sha256(bytes: &[u8]) -> String {
    citare_core::data::content_hash(bytes)
}

/// The name a bundle is published under, `citare-data-<first 16 hex digits
/// of its SHA-256>.bin`, so a name never refers to two different files.
pub fn file_name(bytes: &[u8]) -> String {
    format!("citare-data-{}.bin", &sha256(bytes)[..16])
}

/// The sections of the bundle built from reporters-db, by section number and name in
/// citare's `docs/data-bundle.md`. A few entries in them come from citare's own
/// supplement (its `data/reporters-local.json` and `data/laws-local.json`) instead.
pub const REPORTERS_DB_SECTIONS: &[&str] = &[
    "section 3, reporters",
    "section 4, editions (but not their Caselaw Access Project slugs)",
    "section 5, templates",
    "section 6, reporter map",
    "section 10, reporter jurisdictions",
];

/// The section of the bundle built from courts-db.
pub const COURTS_DB_SECTIONS: &[&str] = &["section 9, court keys"];

/// What reporters-db contributes to the bundle (D67).
pub const REPORTERS_DB_CONTRIBUTES: &str =
    "Most of the reporter, law and journal tables: names, variations, editions, citation patterns and law jurisdictions, from reporters-db's reporters.json, laws.json, journals.json and regexes.json.";

/// What courts-db contributes to the bundle (D67).
pub const COURTS_DB_CONTRIBUTES: &str = "The court table, from courts-db's courts.json.";

/// The sections of the bundle citare's own supplements to reporters-db contribute
/// to: the reporters, editions, variations and patterns `data/reporters-local.json`
/// adds or replaces, and the law spellings and keys `data/laws-local.json` adds.
pub const CITARE_SECTIONS: &[&str] = REPORTERS_DB_SECTIONS;

/// What citare's supplements contribute to the bundle (D67).
pub const CITARE_CONTRIBUTES: &str =
    "The reporters, editions, variations and citation patterns reporters-db doesn't have, from citare's own data/reporters-local.json, and the statute spellings and law keys it doesn't have, from citare's data/laws-local.json.";

/// The sidecar the site serves next to a bundle: what the bundle is, its licence, and
/// the upstream data its sections come from, with their licences and notices.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Sidecar {
    /// The file the site serves, `<bundle>.gz`.
    pub file: String,
    /// The bundle's own name, `citare-data-<hash>.bin`.
    pub bundle: String,
    /// The uncompressed bundle's SHA-256.
    pub sha256: String,
    /// The bundle format version.
    pub format: u16,
    /// CC BY-NC-ND 4.0, for everything in the bundle `sources` doesn't name.
    pub license: crate::license::License,
    /// Every source of the sections that aren't the project's alone, one entry each
    /// (D65, D67): reporters-db, courts-db and citare's own supplements.
    pub sources: Vec<crate::license::Source>,
}

/// The sidecar's name for a bundle: `citare-data-<hash>.json`.
pub fn sidecar_name(bytes: &[u8]) -> String {
    format!("citare-data-{}.json", &sha256(bytes)[..16])
}

/// The sidecar for the embedded bundle, with the reporters-db and courts-db commits
/// the bundle records and the citare commit stare is built with.
#[cfg(feature = "embedded-data")]
pub fn embedded_sidecar() -> Sidecar {
    let bytes = embedded();
    let data = citare_core::data::get();
    let bundle = file_name(bytes);
    Sidecar {
        file: format!("{bundle}.gz"),
        bundle,
        sha256: sha256(bytes),
        format: FORMAT_VERSION,
        license: crate::license::CC_BY_NC_ND,
        sources: vec![
            crate::license::REPORTERS_DB.source(
                data.meta("reporters_db_commit"),
                REPORTERS_DB_CONTRIBUTES,
                REPORTERS_DB_SECTIONS,
            ),
            crate::license::COURTS_DB.source(
                data.meta("courts_db_commit"),
                COURTS_DB_CONTRIBUTES,
                COURTS_DB_SECTIONS,
            ),
            crate::license::citare(CITARE_CONTRIBUTES, CITARE_SECTIONS),
        ],
    }
}

/// The bundle compiled into this build.
#[cfg(feature = "embedded-data")]
pub fn embedded() -> &'static [u8] {
    citare_core::data::EMBEDDED_BUNDLE
}

#[cfg(all(test, feature = "embedded-data"))]
mod tests {
    use super::*;

    #[test]
    fn embedded_bundle_is_a_current_format_bundle() {
        let bytes = embedded();
        assert_eq!(&bytes[..8], b"CITDATA\0");
        assert_eq!(u16::from_le_bytes([bytes[8], bytes[9]]), FORMAT_VERSION);
        assert!(is_available());
    }

    #[test]
    fn the_sidecar_names_the_bundle_its_licence_and_both_upstreams() {
        let s = embedded_sidecar();
        assert_eq!(s.bundle, file_name(embedded()));
        assert_eq!(s.file, format!("{}.gz", s.bundle));
        assert_eq!(sidecar_name(embedded()), s.bundle.replace(".bin", ".json"));
        assert_eq!(s.license, crate::license::CC_BY_NC_ND);
        let names: Vec<_> = s.sources.iter().map(|x| x.name).collect();
        assert_eq!(names, ["reporters-db", "courts-db", "citare"]);
        for source in &s.sources[..2] {
            assert!(
                source.commit.as_deref().is_some_and(|c| c.len() == 40),
                "{source:?}"
            );
            assert_eq!(source.license.id, "BSD-2-Clause");
        }
        let own = &s.sources[2];
        assert_eq!(own.license.id, crate::license::CC_BY_NC_ND.id);
        assert_eq!(own.fields, REPORTERS_DB_SECTIONS);
        assert!(own.contributes.contains("data/reporters-local.json"));
        assert!(own.contributes.contains("data/laws-local.json"));
    }

    #[test]
    fn file_name_is_the_hash_prefix() {
        let name = file_name(embedded());
        assert_eq!(name.len(), "citare-data-.bin".len() + 16);
        assert!(name.starts_with("citare-data-"));
        assert!(sha256(embedded()).starts_with(&name[12..28]));
    }
}
