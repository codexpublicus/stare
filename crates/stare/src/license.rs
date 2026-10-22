//! The licences stare.pub states in its machine-readable files (#161). There are two of its own:
//! CC0 1.0 for the Caselaw Access Project data and anything else republished under its
//! source's CC0 terms, and CC BY-NC-ND 4.0 for what the project produces (the citation
//! index, the reporter map, the OpenAPI document and the schemas, case pages and other
//! site data), with stare.pub as the source to credit. These are the owner's choices;
//! the code's own licence is separate and unchanged.
//!
//! The owner's ruling D65 adds the upstreams' own terms where stare.pub republishes
//! their data: the fields of `reporters.json` and the citare data bundle that come from
//! Free Law Project's reporters-db and courts-db name them, with their licence and
//! copyright notice ([`REPORTERS_DB`], [`COURTS_DB`]), and the CourtListener records
//! carry the Public Domain Mark CourtListener puts on its bulk data, crediting
//! CourtListener ([`PUBLIC_DOMAIN_MARK`], [`COURTLISTENER`]).
//!
//! The owner's ruling D67 makes that attribution a list with one entry per source
//! ([`Source`]): some names, variations and editions come from citare's own supplements
//! to reporters-db, not reporters-db, so citare has an entry of its own ([`citare`]),
//! under the project's terms. The index manifest and build reports can say what the
//! build is made from ([`BasedOn`], [`index_based_on`]): the Caselaw Access Project
//! data and CourtListener's bulk data, as facts with URLs.
//!
//! `web/src/lib/license.js` holds the same two for the site's JSON-LD; the tests in
//! `crates/stare-site/tests/agent_files.rs` and `web/tests/agentfiles.test.js` check
//! that every published JSON file names one of them.

use serde::{Deserialize, Serialize};

/// The source a CC BY-NC-ND file credits.
pub const SOURCE: &str = "https://stare.pub";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct License {
    /// The SPDX identifier.
    pub id: &'static str,
    pub name: &'static str,
    pub url: &'static str,
    /// Where the file comes from: stare.pub, which is the authoritative copy.
    pub source: &'static str,
}

/// A licence as a file states it, read back: the same four fields as [`License`], owned,
/// for formats stare reads as well as writes (the index manifest).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stated {
    pub id: String,
    pub name: String,
    pub url: String,
    pub source: String,
}

impl From<License> for Stated {
    fn from(l: License) -> Self {
        Stated {
            id: l.id.into(),
            name: l.name.into(),
            url: l.url.into(),
            source: l.source.into(),
        }
    }
}

/// CC0 1.0, for the Caselaw Access Project data stare.pub republishes.
pub const CC0: License = License {
    id: "CC0-1.0",
    name: "CC0 1.0 Universal",
    url: "https://creativecommons.org/publicdomain/zero/1.0/",
    source: SOURCE,
};

/// CC BY-NC-ND 4.0, for everything else the project produces.
pub const CC_BY_NC_ND: License = License {
    id: "CC-BY-NC-ND-4.0",
    name: "Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International",
    url: "https://creativecommons.org/licenses/by-nc-nd/4.0/",
    source: SOURCE,
};

/// The Public Domain Mark 1.0, which CourtListener puts on its bulk data: its bulk-data
/// page says the files are "free of known copyright restrictions"
/// (https://wiki.free.law/c/courtlistener/help/api/bulk-data/bulk-legal-data). The
/// owner's ruling D65 is to use CourtListener's licence where it has one, with
/// attribution to CourtListener, so the CourtListener records carry this mark and
/// [`COURTLISTENER`] with the export they came from.
pub const PUBLIC_DOMAIN_MARK: License = License {
    id: "CC-PDM-1.0",
    name: "Public Domain Mark 1.0 Universal",
    url: "https://creativecommons.org/publicdomain/mark/1.0/",
    source: SOURCE,
};

/// Who a CourtListener record credits (D65), with the export date in the record's
/// `attribution.export`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Credit {
    pub name: &'static str,
    pub publisher: &'static str,
    pub url: &'static str,
}

/// CourtListener, Free Law Project's case law site, whose bulk data the records come from.
pub const COURTLISTENER: Credit = Credit {
    name: "CourtListener",
    publisher: "Free Law Project",
    url: "https://www.courtlistener.com/",
};

/// A dataset some of a published file comes from, and the licence and copyright notice
/// its own LICENSE file gives (D65). `text` is that file, verbatim; the copies are in
/// `src/licenses/`, and a test checks them against the ones in the citare checkout
/// stare is built with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Upstream {
    pub name: &'static str,
    pub publisher: &'static str,
    pub url: &'static str,
    /// The SPDX identifier the project's `pyproject.toml` declares, and its SPDX name.
    pub license_id: &'static str,
    pub license_name: &'static str,
    pub license_url: &'static str,
    /// The copyright line of its LICENSE file.
    pub copyright: &'static str,
    /// Its LICENSE file.
    pub text: &'static str,
}

/// Free Law Project's reporters-db: the reporter, edition, variation, law and journal
/// tables citare's data bundle is built from. BSD 2-Clause.
pub const REPORTERS_DB: Upstream = Upstream {
    name: "reporters-db",
    publisher: "Free Law Project",
    url: "https://github.com/freelawproject/reporters-db",
    license_id: "BSD-2-Clause",
    license_name: "BSD 2-Clause \"Simplified\" License",
    license_url: "https://spdx.org/licenses/BSD-2-Clause.html",
    copyright: "Copyright (c) 2014, Free Law Project",
    text: include_str!("licenses/reporters-db.LICENSE"),
};

/// Free Law Project's courts-db: the court table citare's data bundle is built from.
/// BSD 2-Clause.
pub const COURTS_DB: Upstream = Upstream {
    name: "courts-db",
    publisher: "Free Law Project",
    url: "https://github.com/freelawproject/courts-db",
    license_id: "BSD-2-Clause",
    license_name: "BSD 2-Clause \"Simplified\" License",
    license_url: "https://spdx.org/licenses/BSD-2-Clause.html",
    copyright: "Copyright (c) 2020, Free Law Project",
    text: include_str!("licenses/courts-db.LICENSE"),
};

/// A source's licence as a published file's `sources` states it: an upstream's, with
/// its LICENSE file in `text`, or the project's own (CC BY-NC-ND 4.0), with stare.pub
/// in `source` as for the file's own `license`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SourceLicense {
    pub id: &'static str,
    pub name: &'static str,
    pub url: &'static str,
    /// The upstream's LICENSE file at `commit`, verbatim.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<&'static str>,
    /// Where the project's own data comes from: stare.pub, the authoritative copy.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<&'static str>,
}

/// One entry of a published file's `sources` (D65, D67): a dataset some of the file
/// comes from, the commit of it the file was built from, its licence (and copyright
/// notice, for an upstream), what it contributes, and which of the file's fields it
/// contributes to. Rows aren't marked; a field can come partly from several sources.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Source {
    pub name: &'static str,
    pub publisher: &'static str,
    pub url: &'static str,
    /// The commit: an upstream's from the citare data bundle's provenance, citare's
    /// from the build ([`CITARE_COMMIT`]); `None` when it isn't known.
    pub commit: Option<String>,
    pub license: SourceLicense,
    /// The copyright line of an upstream's LICENSE file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copyright: Option<&'static str>,
    /// What the source contributes to the file, in prose.
    pub contributes: &'static str,
    pub fields: Vec<&'static str>,
}

impl Upstream {
    /// This upstream as a `sources` entry for a file built from `commit` of it, saying
    /// what it `contributes` and naming the file's `fields` that come from it.
    pub fn source(
        &self,
        commit: Option<&str>,
        contributes: &'static str,
        fields: &[&'static str],
    ) -> Source {
        Source {
            name: self.name,
            publisher: self.publisher,
            url: self.url,
            commit: commit
                .filter(|c| !c.is_empty() && *c != "unknown")
                .map(str::to_string),
            license: SourceLicense {
                id: self.license_id,
                name: self.license_name,
                url: self.license_url,
                text: Some(self.text),
                source: None,
            },
            copyright: Some(self.copyright),
            contributes,
            fields: fields.to_vec(),
        }
    }
}

/// The codexpublicus/citare commit stare is built with, the one `Cargo.lock` pins
/// `citare-core` at. `tests/upstream_licenses.rs` checks it against the checkout cargo
/// built, so a citare bump fails there until this is updated.
pub const CITARE_COMMIT: &str = "ce5d4de9a41bc64f1ff1e08ca60ea922cc711bb5";

/// citare's own supplements to reporters-db as a `sources` entry (D67): its
/// `data/reporters-local.json` and `data/laws-local.json`, which add reporters,
/// editions, variations and statute spellings reporters-db doesn't have. They are
/// the project's, so the entry states the project's terms, CC BY-NC-ND 4.0 with
/// stare.pub as the source, the same as the file's own `license`.
pub fn citare(contributes: &'static str, fields: &[&'static str]) -> Source {
    Source {
        name: "citare",
        publisher: "Codex Publicus",
        url: "https://github.com/codexpublicus/citare",
        commit: Some(CITARE_COMMIT.to_string()),
        license: SourceLicense {
            id: CC_BY_NC_ND.id,
            name: CC_BY_NC_ND.name,
            url: CC_BY_NC_ND.url,
            text: None,
            source: Some(CC_BY_NC_ND.source),
        },
        copyright: None,
        contributes,
        fields: fields.to_vec(),
    }
}

/// The licence or mark a dataset an index build is made from states for itself, by
/// SPDX identifier, name and URL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Marked {
    pub id: String,
    pub name: String,
    pub url: String,
}

impl From<License> for Marked {
    fn from(l: License) -> Self {
        Marked {
            id: l.id.into(),
            name: l.name.into(),
            url: l.url.into(),
        }
    }
}

/// One entry of the index manifest's and build reports' optional `based_on` (D67): a
/// dataset the build is made from, who publishes it, where it is, and the licence or
/// mark it states for its data. Provenance only: facts, no terms.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BasedOn {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    pub url: String,
    pub license: Marked,
}

/// What an index build is made from: the Caselaw Access Project's data (CC0 1.0) and
/// CourtListener's bulk data (the Public Domain Mark 1.0, Free Law Project).
/// stare-builder writes this as `based_on`.
pub fn index_based_on() -> Vec<BasedOn> {
    vec![
        BasedOn {
            name: "Caselaw Access Project".into(),
            publisher: None,
            url: "https://case.law/".into(),
            license: CC0.into(),
        },
        BasedOn {
            name: "CourtListener bulk data".into(),
            publisher: Some(COURTLISTENER.publisher.into()),
            url: "https://www.courtlistener.com/help/api/bulk-data/".into(),
            license: PUBLIC_DOMAIN_MARK.into(),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_upstream_licence_text_starts_with_its_copyright_line() {
        for u in [REPORTERS_DB, COURTS_DB] {
            assert!(u.text.contains(u.copyright), "{}", u.name);
            assert!(u.text.contains("All rights reserved."), "{}", u.name);
            assert!(
                u.text
                    .contains("Redistributions in binary form must reproduce"),
                "{}",
                u.name
            );
        }
        assert!(REPORTERS_DB.text.starts_with(REPORTERS_DB.copyright));
        assert!(COURTS_DB
            .text
            .starts_with("BSD 2-Clause License\n\nCopyright (c) 2020"));
    }

    #[test]
    fn a_source_drops_an_unknown_commit() {
        assert_eq!(REPORTERS_DB.source(Some("unknown"), "", &[]).commit, None);
        assert_eq!(
            REPORTERS_DB
                .source(Some("e095e6b"), "", &["x"])
                .commit
                .as_deref(),
            Some("e095e6b")
        );
    }

    #[test]
    fn an_upstream_entry_has_its_licence_text_and_citares_has_the_projects_terms() {
        let rdb = serde_json::to_value(REPORTERS_DB.source(None, "x", &["y"])).unwrap();
        assert_eq!(rdb["license"]["text"], REPORTERS_DB.text);
        assert!(rdb["license"].get("source").is_none());
        assert_eq!(rdb["copyright"], REPORTERS_DB.copyright);
        assert_eq!(rdb["contributes"], "x");
        let own = serde_json::to_value(citare("z", &["y"])).unwrap();
        assert_eq!(own["name"], "citare");
        assert_eq!(own["url"], "https://github.com/codexpublicus/citare");
        assert_eq!(own["commit"], CITARE_COMMIT);
        assert_eq!(
            own["license"],
            serde_json::to_value(CC_BY_NC_ND).unwrap(),
            "the same four fields as the file's own licence"
        );
        assert!(own.get("copyright").is_none());
    }

    #[test]
    fn an_index_build_is_based_on_cap_and_courtlistener() {
        let json = serde_json::to_value(index_based_on()).unwrap();
        assert_eq!(
            json,
            serde_json::json!([
                {
                    "name": "Caselaw Access Project",
                    "url": "https://case.law/",
                    "license": {
                        "id": "CC0-1.0",
                        "name": "CC0 1.0 Universal",
                        "url": "https://creativecommons.org/publicdomain/zero/1.0/"
                    }
                },
                {
                    "name": "CourtListener bulk data",
                    "publisher": "Free Law Project",
                    "url": "https://www.courtlistener.com/help/api/bulk-data/",
                    "license": {
                        "id": "CC-PDM-1.0",
                        "name": "Public Domain Mark 1.0 Universal",
                        "url": "https://creativecommons.org/publicdomain/mark/1.0/"
                    }
                }
            ])
        );
        let back: Vec<BasedOn> = serde_json::from_value(json).unwrap();
        assert_eq!(back, index_based_on());
    }
}
