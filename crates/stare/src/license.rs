//! The licences stare.pub states in its machine-readable files (#161). There are two:
//! CC0 1.0 for the Caselaw Access Project data and anything else republished under its
//! source's CC0 terms, and CC BY-NC-ND 4.0 for what the project produces (the citation
//! index, the reporter map, the OpenAPI document and the schemas, case pages and other
//! site data), with stare.pub as the source to credit. These are the owner's choices;
//! the code's own licence is separate and unchanged.
//!
//! `web/src/lib/license.js` holds the same two for the site's JSON-LD; the tests in
//! `crates/stare-site/tests/agent_files.rs` and `web/tests/agentfiles.test.js` check
//! that every published JSON file names one of them.

use serde::Serialize;

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
