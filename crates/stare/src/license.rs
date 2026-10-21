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

/// An upstream's licence as a published file states it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UpstreamLicense {
    pub id: &'static str,
    pub name: &'static str,
    pub url: &'static str,
    /// The upstream's LICENSE file at `commit`, verbatim.
    pub text: &'static str,
}

/// One entry of a published file's `sources`: an upstream dataset, the commit of it
/// the file was built from, its licence and copyright notice, and which of the file's
/// fields come from it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Source {
    pub name: &'static str,
    pub publisher: &'static str,
    pub url: &'static str,
    /// The commit, from the citare data bundle's provenance; `None` when the bundle
    /// doesn't record it.
    pub commit: Option<String>,
    pub license: UpstreamLicense,
    pub copyright: &'static str,
    pub fields: Vec<&'static str>,
}

impl Upstream {
    /// This upstream as a `sources` entry for a file built from `commit` of it, naming
    /// the file's `fields` that come from it.
    pub fn source(&self, commit: Option<&str>, fields: &[&'static str]) -> Source {
        Source {
            name: self.name,
            publisher: self.publisher,
            url: self.url,
            commit: commit
                .filter(|c| !c.is_empty() && *c != "unknown")
                .map(str::to_string),
            license: UpstreamLicense {
                id: self.license_id,
                name: self.license_name,
                url: self.license_url,
                text: self.text,
            },
            copyright: self.copyright,
            fields: fields.to_vec(),
        }
    }
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
        assert_eq!(REPORTERS_DB.source(Some("unknown"), &[]).commit, None);
        assert_eq!(
            REPORTERS_DB
                .source(Some("e095e6b"), &["x"])
                .commit
                .as_deref(),
            Some("e095e6b")
        );
    }
}
