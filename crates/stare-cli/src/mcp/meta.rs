//! Every result's `meta` (design, "Licences and attribution in responses"): the index
//! version it came from, the server's version, whether it was answered without a
//! network request, and each source it used with that source's stated licence, as
//! facts from the files themselves. The server makes no determination about what terms
//! apply to its output.

use super::session::Pin;
use serde_json::{json, Value};

pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The sources one answer used, each once.
#[derive(Default)]
pub struct Sources(Vec<Value>);

impl Sources {
    pub fn add(&mut self, source: Value) {
        if !self.0.contains(&source) {
            self.0.push(source);
        }
    }

    pub fn into_vec(self) -> Vec<Value> {
        self.0
    }
}

/// `meta` for an answer.
pub fn meta(pin: Option<&Pin>, cached: bool, sources: Sources) -> Value {
    json!({
        "index_version": pin.and_then(|p| p.version.clone()),
        "server_version": SERVER_VERSION,
        "cached": cached,
        "sources": sources.into_vec(),
    })
}

/// The citation index: resolution status, provenance labels and the manifest's facts,
/// under the manifest's own `license` and `based_on`.
pub fn index(pin: &Pin) -> Value {
    let manifest = pin.manifest();
    let license = manifest
        .and_then(|m| m.license.clone())
        .map(|l| serde_json::to_value(l).unwrap_or(Value::Null))
        .unwrap_or(Value::Null);
    let based_on = manifest
        .map(|m| serde_json::to_value(&m.based_on).unwrap_or(Value::Null))
        .unwrap_or(Value::Null);
    json!({
        "role": "index",
        "name": "stare.pub citation index",
        "url": stare::license::SOURCE,
        "version": pin.version,
        "license": license,
        "based_on": based_on,
    })
}

/// A CAP case's text and metadata: the Caselaw Access Project, CC0 1.0, the terms CAP
/// published them under, with the file it was read from.
pub fn cap(file: &str) -> Value {
    json!({
        "role": "case",
        "name": "Caselaw Access Project",
        "url": "https://case.law/",
        "file": file,
        "license": stare::license::CC0,
    })
}

/// A CourtListener record: the record's own `license` and `attribution`, copied from
/// it, and its blocked notice when CourtListener blocks it from search engines.
pub fn courtlistener(case: &stare::case::CaseJson, file: &str) -> Value {
    let mut v = json!({
        "role": "case",
        "name": "CourtListener",
        "url": case.attribution.as_ref().and_then(|a| a.url.clone()),
        "file": file,
        "license": case.license,
        "attribution": case.attribution,
    });
    if let Some(b) = case.source.as_ref().and_then(|s| s.cl_blocked.as_ref()) {
        v["blocked_notice"] = b.notice().into();
    }
    v
}

/// citare's detection: the data bundle's sources, reporters-db and courts-db (BSD
/// 2-Clause, Free Law Project) and citare's own supplements (CC BY-NC-ND 4.0), as the
/// bundle's sidecar states them, without the licence texts, which the release archive
/// carries.
pub fn detection() -> Vec<Value> {
    stare::data::embedded_sidecar()
        .sources
        .into_iter()
        .map(|s| {
            json!({
                "role": "detection",
                "name": s.name,
                "publisher": s.publisher,
                "url": s.url,
                "commit": s.commit,
                "license": {"id": s.license.id, "name": s.license.name, "url": s.license.url},
                "copyright": s.copyright,
            })
        })
        .collect()
}

/// The credit line a case text's rendering ends with.
pub fn credit_line(case: &stare::case::CaseJson) -> String {
    let text = match case.source_name() {
        "courtlistener" => {
            let export = case
                .attribution
                .as_ref()
                .and_then(|a| a.export.as_deref())
                .map(|e| format!(", export {e}"))
                .unwrap_or_default();
            let license = case
                .license
                .as_ref()
                .map(|l| l.name.clone())
                .unwrap_or_else(|| "licence as the record states".into());
            format!("Text: CourtListener (Free Law Project){export}, {license}.")
        }
        _ => "Text: Caselaw Access Project, CC0 1.0.".to_string(),
    };
    format!("{text} Citation index: stare.pub, CC BY-NC-ND 4.0.")
}
