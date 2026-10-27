//! The M1 tools (design, "Tools"). Each takes its arguments as JSON and returns its
//! structured result, without `meta`, and a short text rendering that starts with the
//! counts, for clients that read only `content`. They are synchronous and run on a
//! blocking thread.

use super::cursor::Cursor;
use super::error::{Code, ToolError, ToolResult};
use super::meta;
use super::refs::{case_ref, parse_case_ref, reader_url};
use super::session::{Pin, Session};
use super::text::{find, CaseText};
use crate::engine::check::{check_text, CheckReport, CheckStatus, CheckedCitation};
use crate::engine::resolve::{cited_page, idx_entries, parse_labeled_input};
use crate::engine::Sources;
use serde::Deserialize;
use serde_json::{json, Value};
use stare::parallel::CaseRef;
use std::sync::Arc;

/// The longest text `find_citations_in_text` reads, in characters.
pub const FIND_MAX_CHARS: usize = 200_000;
/// The longest text `check_brief` reads, in characters.
pub const CHECK_MAX_CHARS: usize = 500_000;
/// `get_case`'s default and largest window, in characters.
pub const CASE_DEFAULT_CHARS: usize = 20_000;
pub const CASE_MAX_CHARS: usize = 100_000;
/// The characters around a `find` match, by default and at most, and how many matches.
pub const CONTEXT_DEFAULT: usize = 600;
pub const CONTEXT_MAX: usize = 4_000;
pub const FIND_MATCHES: usize = 10;
/// `check_brief`'s page of citations and cited cases.
pub const ITEMS_DEFAULT: usize = 200;
pub const ITEMS_MAX: usize = 200;

/// One tool call's state: the session, the build it read, and the sources it used.
pub struct Call<'a> {
    pub session: &'a Session,
    pub pin: Option<Arc<Pin>>,
    pub sources: meta::Sources,
}

/// A tool's answer: its structured result (without `meta`) and its text rendering.
pub struct Answer {
    pub structured: Value,
    pub text: String,
}

impl<'a> Call<'a> {
    pub fn new(session: &'a Session) -> Self {
        Call {
            pin: session.current(),
            session,
            sources: meta::Sources::default(),
        }
    }

    /// The pinned build, pinning it now if the session hasn't yet; its sources, and the
    /// index as a source of the answer.
    fn index(&mut self) -> ToolResult<Arc<Sources>> {
        let pin = self.session.pin()?;
        self.sources.add(meta::index(&pin));
        let sources = pin.sources.clone();
        self.pin = Some(pin);
        Ok(sources)
    }

    fn version(&self) -> Option<String> {
        self.pin.as_ref().and_then(|p| p.version.clone())
    }

    fn engine_error(&self, e: &anyhow::Error) -> ToolError {
        ToolError::from_engine(e, self.session.data_is_dir())
    }
}

/// Run tool `name` on `args`: None for a tool this server doesn't have, `Err` for
/// arguments that don't match its input schema (a JSON-RPC error, as the design asks of
/// schema violations), else the tool's answer or its tool error.
pub fn call(
    call: &mut Call,
    name: &str,
    args: Value,
) -> Option<Result<ToolResult<Answer>, String>> {
    fn run<T: serde::de::DeserializeOwned>(
        call: &mut Call,
        args: Value,
        tool: fn(&mut Call, T) -> ToolResult<Answer>,
    ) -> Result<ToolResult<Answer>, String> {
        let input: T = serde_json::from_value(args).map_err(|e| e.to_string())?;
        Ok(tool(call, input))
    }
    Some(match name {
        "find_citations_in_text" => run(call, args, find_citations_in_text),
        "resolve_citation" => run(call, args, resolve_citation),
        "get_case" => run(call, args, get_case),
        "check_brief" => run(call, args, check_brief),
        "index_info" => run(call, args, index_info),
        _ => return None,
    })
}

/// A string, or a number written as one (`"31"` or `31`).
fn string_or_number<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    match Option::<Value>::deserialize(d)? {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(Value::Number(n)) => Ok(Some(n.to_string())),
        Some(v) => Err(serde::de::Error::custom(format!(
            "invalid type: expected a string or number, got {v}"
        ))),
    }
}

fn chars(s: &str) -> usize {
    s.chars().count()
}

/// `1234567` as `1,234,567`.
fn thousands(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

// ---------------------------------------------------------------------------
// find_citations_in_text
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FindInput {
    text: String,
    #[serde(default)]
    types: Option<Vec<String>>,
}

/// What kind of citation `citation_type` is, as `types` filters them.
fn kind(citation_type: &str) -> &'static str {
    match citation_type {
        "FullCaseCitation" => "case",
        "FullLawCitation" => "law",
        "FullJournalCitation" => "journal",
        t if stare::cite::SHORT_FORM_TYPES.contains(&t) => "short",
        _ => "other",
    }
}

pub const KINDS: [&str; 4] = ["case", "law", "journal", "short"];

fn find_citations_in_text(call: &mut Call, input: FindInput) -> ToolResult<Answer> {
    let n = chars(&input.text);
    if n > FIND_MAX_CHARS {
        return Err(ToolError::new(
            Code::BadInput,
            format!(
                "text is {} characters; this tool reads at most {}. Split it, or use check_brief, which reads {}",
                thousands(n),
                thousands(FIND_MAX_CHARS),
                thousands(CHECK_MAX_CHARS)
            ),
        ));
    }
    if let Some(bad) = input
        .types
        .iter()
        .flatten()
        .find(|t| !KINDS.contains(&t.as_str()))
    {
        return Err(ToolError::new(
            Code::BadInput,
            format!("unknown type {bad:?}; types are case, law, journal and short"),
        ));
    }
    for s in meta::detection() {
        call.sources.add(s);
    }
    let mut detected = stare::cite::detect_citations(&input.text);
    stare::cite::spans_to_char_offsets(&input.text, &mut detected)
        .map_err(|e| ToolError::new(Code::DataError, format!("{e:?}")))?;
    let spans: Vec<(usize, usize)> = detected.iter().map(|c| c.span).collect();
    let mut citations = Vec::new();
    let mut counts: std::collections::BTreeMap<&str, usize> = Default::default();
    for (i, c) in detected.iter().enumerate() {
        let k = kind(&c.citation_type);
        if let Some(types) = &input.types {
            if !types.iter().any(|t| t == k) {
                continue;
            }
        }
        *counts.entry(k).or_default() += 1;
        let antecedent = c.antecedent.as_ref().map(|a| {
            json!({
                "raw": a.matched_text,
                "index": spans.iter().position(|s| *s == a.span),
            })
        });
        citations.push(json!({
            "index": i,
            "raw": c.matched_text,
            "type": c.citation_type,
            "kind": k,
            "span": {"start": c.span.0, "end": c.span.1},
            "reporter": c.reporter,
            "corrected_reporter": c.corrected_reporter,
            "slug": c.slug,
            "volume": c.volume,
            "page": c.page,
            "pin": c.pin,
            "year": c.year,
            "case_name": c.case_name,
            "history_name": c.history_name,
            "parallel_of": c.parallel_of,
            "official": c.official,
            "antecedent": antecedent,
            "law": c.law,
            "external_url": c.external_url,
        }));
    }
    let summary: Vec<String> = counts.iter().map(|(k, n)| format!("{n} {k}")).collect();
    let mut text = format!(
        "Found {} in {} characters{}.\n",
        plural(citations.len(), "citation", "citations"),
        thousands(n),
        if summary.is_empty() {
            String::new()
        } else {
            format!(" ({})", summary.join(", "))
        }
    );
    for c in &citations {
        text.push_str(&format!(
            "[{}] {} ({}) at {}-{}\n",
            c["index"],
            c["raw"].as_str().unwrap_or(""),
            c["type"].as_str().unwrap_or(""),
            c["span"]["start"],
            c["span"]["end"]
        ));
    }
    text.push_str(
        "Nothing was looked up; check_brief or resolve_citation says whether each case exists.",
    );
    Ok(Answer {
        structured: json!({ "citations": citations }),
        text,
    })
}

// ---------------------------------------------------------------------------
// resolve_citation
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct ResolveInput {
    #[serde(default)]
    citation: Option<String>,
    #[serde(default)]
    reporter: Option<String>,
    #[serde(default, deserialize_with = "string_or_number")]
    volume: Option<String>,
    #[serde(default, deserialize_with = "string_or_number")]
    page: Option<String>,
    #[serde(default)]
    case_name: Option<String>,
    #[serde(default)]
    year: Option<i32>,
    #[serde(default)]
    parallel: Option<Vec<String>>,
}

/// What resolving a citation found.
struct Resolution {
    status: &'static str,
    citation: Value,
    /// The cases it opens, each with its name (`a2d/31/657-2`), where it's read from and
    /// how it was resolved, when that isn't directly.
    cases: Vec<(String, CaseRef, Option<String>)>,
    by_name: Option<Value>,
    case_links: Vec<stare::cite::CaseLink>,
    external_url: Option<String>,
    conflicts: Vec<String>,
}

fn status_str(s: CheckStatus) -> &'static str {
    s.as_str()
}

/// The `via` of each alias, or official-page line, at a page, by the case it names.
fn vias_at(
    src: &Sources,
    slug: &str,
    volume: &str,
    page: &stare::index::PageKey,
) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    if let Ok(Some(entries)) = idx_entries(src, slug, volume, page) {
        for e in &entries {
            if let Some(via) = &e.via {
                if let Some((id, _)) = stare::parallel::page_case_refs(slug, volume, page, &[e])
                    .into_iter()
                    .next()
                {
                    out.entry(id).or_insert_with(|| via.clone());
                }
            }
        }
    }
    out
}

fn resolve(call: &mut Call, input: &ResolveInput) -> ToolResult<Resolution> {
    let src = call.index()?;
    let parts = (&input.reporter, &input.volume, &input.page);
    match (&input.citation, parts) {
        (Some(c), _) if parse_slug_form(c).is_some() => {
            let (slug, volume, page) = parse_slug_form(c).unwrap();
            resolve_parts(call, &src, &slug, &volume, &page, input)
        }
        (Some(c), _) => resolve_text(call, &src, c, input),
        (None, (Some(r), Some(v), Some(p))) => {
            let slug = r.trim().to_lowercase();
            if stare::cl::is_reporter_slug(&slug) {
                resolve_parts(call, &src, &slug, v.trim(), p.trim(), input)
            } else {
                // A reporter as cited (`A.2d`): read the parts as a citation.
                resolve_text(
                    call,
                    &src,
                    &format!("{} {} {}", v.trim(), r.trim(), p.trim()),
                    input,
                )
            }
        }
        _ => Err(ToolError::new(
            Code::BadInput,
            "give `citation`, or all of `reporter`, `volume` and `page`",
        )),
    }
}

/// The slug form (`a2d 31 647`, `a3d 138-2 1012`, `cai-cas 1 xxix`): (slug, volume, page).
fn parse_slug_form(s: &str) -> Option<(String, String, String)> {
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.len() == 3
        && stare::cl::is_reporter_slug(&parts[0].to_lowercase())
        && stare::manifest::is_volume_key(parts[1])
        && parts[2].parse::<u32>().is_ok()
    {
        return Some((parts[0].to_lowercase(), parts[1].into(), parts[2].into()));
    }
    let slash: Vec<&str> = s.trim().split('/').collect();
    if slash.len() == 3
        && stare::cl::is_reporter_slug(slash[0])
        && stare::manifest::is_volume_key(slash[1])
        && !slash[2].is_empty()
    {
        return Some((slash[0].into(), slash[1].into(), slash[2].into()));
    }
    parse_labeled_input(s)
}

/// A citation in the slug form or as parts: the index alone says what's at the page,
/// and the case name, if given, picks among several cases there.
fn resolve_parts(
    call: &mut Call,
    src: &Sources,
    slug: &str,
    volume: &str,
    page: &str,
    input: &ResolveInput,
) -> ToolResult<Resolution> {
    if !stare::cl::is_reporter_slug(slug) || !stare::manifest::is_volume_key(volume) {
        return Err(ToolError::new(
            Code::BadInput,
            format!("not a reporter slug and volume: {slug:?} {volume:?}"),
        ));
    }
    let key = cited_page(page)
        .ok_or_else(|| ToolError::new(Code::BadInput, format!("not a page: {page:?}")))?;
    let citation = json!({
        "raw": input.citation,
        "slug": slug, "volume": volume, "page": stare::idx::page_text(&key), "reporter": Value::Null,
    });
    let mut r = Resolution {
        status: "held_miss",
        citation,
        cases: Vec::new(),
        by_name: None,
        case_links: Vec::new(),
        external_url: None,
        conflicts: Vec::new(),
    };
    let manifest = src.manifest();
    let held = || {
        manifest.is_some_and(|m| m.holds_volume(slug, volume) || !m.has_alias_volume(slug, volume))
    };
    match idx_entries(src, slug, volume, &key).map_err(|e| call.engine_error(&e))? {
        Some(entries) if !entries.is_empty() => {
            let refs: Vec<&stare::idx::Entry> = entries.iter().collect();
            let page_cases = stare::parallel::page_case_refs(slug, volume, &key, &refs);
            let vias = vias_at(src, slug, volume, &key);
            let mut cases = page_cases;
            if cases.len() > 1 {
                if let Some(name) = &input.case_name {
                    let candidates: Vec<stare::byname::Candidate> = cases
                        .iter()
                        .map(|(id, cr)| match crate::engine::check::case_names(src, cr) {
                            Some(n) => n.candidate(id),
                            None => stare::byname::Candidate {
                                id: id.clone(),
                                ..Default::default()
                            },
                        })
                        .collect();
                    if let Some(pick) = stare::byname::pick(&candidates, name, input.year) {
                        let among = cases.len();
                        r.by_name = Some(json!({
                            "among": among,
                            "note": format!("matched by case name among the {among} cases on this page"),
                        }));
                        cases.retain(|(id, _)| id == pick);
                    }
                }
            }
            r.status = if cases.len() > 1 {
                "ambiguous"
            } else if entries.first().is_some_and(|e| e.via.is_some())
                && cases.first().is_some_and(|(id, _)| vias.contains_key(id))
            {
                "found_alias"
            } else {
                "found"
            };
            r.cases = cases
                .into_iter()
                .map(|(id, cr)| {
                    let via = vias.get(&id).map(|v| stare::idx::via_label(v));
                    (id, cr, via)
                })
                .collect();
        }
        Some(_) => r.status = if held() { "held_miss" } else { "not_held" },
        None => {
            // A build without the unified index: the .bin files.
            let found = match &key {
                stare::index::PageKey::Number(n) => {
                    crate::engine::resolve::resolve_case(src, slug, volume, *n as u32)
                }
                stare::index::PageKey::Label(l) => {
                    crate::engine::resolve::resolve_label(src, slug, volume, l)
                }
            };
            match found {
                Ok(result) => {
                    r.status = "found";
                    r.cases.push((
                        stare::parallel::case_at(slug, volume, &key),
                        CaseRef::Cap {
                            reporter: slug.into(),
                            folder: volume.into(),
                            case_file: result.case_file,
                        },
                        None,
                    ));
                }
                Err(_) => r.status = if held() { "held_miss" } else { "not_held" },
            }
        }
    }
    Ok(r)
}

/// A citation as written: checked the way `check_brief` checks a text made of the
/// citation, its case name, its parallel citations and its year, so the two agree.
fn resolve_text(
    call: &mut Call,
    src: &Sources,
    citation: &str,
    input: &ResolveInput,
) -> ToolResult<Resolution> {
    let detected = stare::cite::detect_citations(citation);
    let first = detected
        .iter()
        .find(|c| c.citation_type == "FullCaseCitation" || c.citation_type == "FullLawCitation")
        .ok_or_else(|| {
            ToolError::new(
                Code::Unparsed,
                format!(
                    "no citation found in {citation:?}; write it as cited (\"31 A.2d 647\"), in the slug form (\"a2d 31 647\"), or pass reporter, volume and page"
                ),
            )
        })?;
    let raw = first.matched_text.clone();
    let name = input.case_name.clone().or_else(|| first.case_name.clone());
    let year = input.year.or(first.year);
    let mut text = String::new();
    if let Some(name) = &name {
        text.push_str(name);
        text.push_str(", ");
    }
    text.push_str(&raw);
    // The run's other printings: those given, and those written in `citation` itself.
    let at = detected.iter().position(|c| c.matched_text == raw);
    let mut parallels: Vec<String> = detected
        .iter()
        .filter(|c| at.is_some() && c.parallel_of == at)
        .map(|c| c.matched_text.clone())
        .collect();
    parallels.extend(input.parallel.iter().flatten().cloned());
    for p in &parallels {
        text.push_str(", ");
        text.push_str(p.trim());
    }
    if let Some(year) = year {
        text.push_str(&format!(" ({year})"));
    }
    text.push('.');
    let report = check_text(src, &text);
    let c = report
        .citations
        .iter()
        .find(|c| c.raw == raw)
        .ok_or_else(|| {
            ToolError::new(Code::Unparsed, format!("no citation found in {citation:?}"))
        })?;
    let mut r = Resolution {
        status: status_str(c.status),
        citation: json!({
            "raw": raw, "slug": c.slug, "volume": c.volume.map(|v| v.to_string()),
            "page": c.page, "reporter": c.reporter,
        }),
        cases: Vec::new(),
        by_name: c
            .by_name
            .as_ref()
            .map(|b| serde_json::to_value(b).unwrap_or(Value::Null)),
        case_links: if c.status == CheckStatus::NotHeld {
            c.case_links.clone()
        } else {
            Vec::new()
        },
        external_url: c.external_url.clone(),
        conflicts: c.conflicts.clone(),
    };
    if !c.resolvable {
        return Ok(r);
    }
    let label = |id: &str| -> Option<String> {
        if c.status == CheckStatus::FoundPartner {
            return c
                .partner
                .as_ref()
                .map(|p| format!("Reported at {p}, inferred from the citing text"));
        }
        (Some(id) == c.case.as_deref())
            .then(|| c.via.as_deref().map(stare::idx::via_label))
            .flatten()
    };
    // Which of the page's cases it can mean: the one its name picked, or the one its
    // parallel run agrees on, or those the run shares, or all of them.
    let ids: Vec<String> = if c.by_name.is_some() || c.status == CheckStatus::FoundPartner {
        c.case.iter().cloned().collect()
    } else if !c.run_cases.is_empty() {
        c.run_cases.clone()
    } else if !c.page_cases.is_empty() {
        c.page_cases.iter().map(|(id, _)| id.clone()).collect()
    } else {
        c.case.iter().cloned().collect()
    };
    let refs: std::collections::HashMap<&String, &CaseRef> = report
        .citations
        .iter()
        .flat_map(|x| x.page_cases.iter().map(|(id, cr)| (id, cr)))
        .collect();
    for id in ids {
        let cr = refs.get(&id).map(|cr| (*cr).clone()).or_else(|| {
            (c.case.as_ref() == Some(&id))
                .then(|| c.case_ref.clone())
                .flatten()
        });
        match cr {
            Some(cr) => {
                let l = label(&id);
                r.cases.push((id, cr, l));
            }
            None => {
                // A build without the unified index names no file; the .bin path does.
                let (slug, volume, page) = (c.slug.clone(), c.volume, c.page.clone());
                if let (Some(slug), Some(volume), Some(page)) = (slug, volume, page) {
                    let resolved = crate::engine::resolve::resolve_input(
                        src,
                        &format!("{slug} {volume} {page}"),
                    )
                    .map_err(|e| call.engine_error(&e))?;
                    r.cases.push((
                        id,
                        CaseRef::Cap {
                            reporter: slug,
                            folder: volume.to_string(),
                            case_file: resolved.case_file,
                        },
                        None,
                    ));
                }
            }
        }
    }
    if r.cases.len() > 1 {
        r.status = "ambiguous";
    }
    Ok(r)
}

/// One case's JSON as stored, from its source, with the file it came from, adding the
/// source to the answer's.
fn read_case(
    call: &mut Call,
    src: &Sources,
    cr: &CaseRef,
) -> ToolResult<(stare::case::CaseJson, Value)> {
    match cr {
        CaseRef::Cap {
            reporter,
            folder,
            case_file,
        } => {
            let file = format!("{}/{reporter}/{folder}.zip", src.data);
            let bytes = crate::engine::case_text::read_entry(
                src,
                reporter,
                folder,
                &format!("json/{case_file}.json"),
            )
            .map_err(|e| {
                let err = call.engine_error(&e);
                if err.code == Code::NotInCopy {
                    ToolError::new(
                        Code::NotInCopy,
                        format!("the mirror at {} has no {reporter}/{folder}.zip; the case is on the public host", src.data),
                    )
                    .with_url(format!("{}/{reporter}/{folder}.zip", stare::config::DEFAULT_DATA_URL))
                } else {
                    err.with_url(file.clone())
                }
            })?;
            let case = stare::case::CaseJson::parse(&bytes)
                .map_err(|e| ToolError::new(Code::DataError, format!("{case_file}: {e:#}")))?;
            let raw: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            call.sources.add(meta::cap(&file));
            Ok((case, raw))
        }
        CaseRef::Cl { cluster_id, hash } => {
            let base = stare::cl::data_base_for(&src.data);
            let file = format!(
                "{base}/{}",
                stare::cl::record_path(*cluster_id, hash)
                    .map_err(|e| ToolError::new(Code::BadRef, format!("{e:#}")))?
            );
            let bytes = crate::engine::fetch::fetch_record(src, *cluster_id, hash)
                .map_err(|e| call.engine_error(&e).with_url(file.clone()))?;
            let case = stare::cl::decode_record(&bytes)
                .map_err(|e| ToolError::new(Code::DataError, format!("{file}: {e:#}")))?;
            call.sources.add(meta::courtlistener(&case, &file));
            Ok((case, Value::Null))
        }
    }
}

/// A case's metadata, as `resolve_citation` and `get_case` give it.
fn summary(
    id: Option<&str>,
    cr: &CaseRef,
    provenance: Option<String>,
    case: &stare::case::CaseJson,
    raw: &Value,
) -> Value {
    let mut v = json!({
        "case_ref": case_ref(cr),
        "name": case.name,
        "name_abbreviation": case.name_abbreviation,
        "decision_date": case.decision_date,
        "court": case.court.name,
        "jurisdiction": case.jurisdiction.name_long,
        "citations": case.citations,
        "first_page": raw.get("first_page"),
        "last_page": raw.get("last_page"),
        "docket_number": raw.get("docket_number"),
        "source": if case.source_name() == "courtlistener" { "courtlistener" } else { "cap" },
        "provenance": provenance,
        "reader_url": id.and_then(reader_url),
    });
    if let Some(s) = case.source.as_ref().filter(|s| s.name == "courtlistener") {
        v["courtlistener"] = json!({
            "url": s.url,
            "export": s.export,
            "docket_number": s.docket_number,
            "precedential_status": s.precedential_status,
            "blocked_notice": s.cl_blocked.as_ref().map(|b| b.notice()),
        });
        if v["docket_number"].is_null() {
            v["docket_number"] = s.docket_number.clone().into();
        }
    }
    v
}

fn resolve_citation(call: &mut Call, input: ResolveInput) -> ToolResult<Answer> {
    let r = resolve(call, &input)?;
    let src = call.index()?;
    let mut cases = Vec::new();
    for (id, cr, provenance) in &r.cases {
        let (case, raw) = read_case(call, &src, cr)?;
        cases.push(summary(Some(id), cr, provenance.clone(), &case, &raw));
    }
    let raw = r.citation["raw"]
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| {
            format!(
                "{} {} {}",
                r.citation["slug"].as_str().unwrap_or(""),
                r.citation["volume"].as_str().unwrap_or(""),
                r.citation["page"].as_str().unwrap_or("")
            )
        });
    let mut text = match r.status {
        "found" => format!("{raw}: found."),
        "found_alias" | "found_partner" => format!(
            "{raw}: {}. Found through the provenance below; it is not verified.",
            r.status
        ),
        "ambiguous" => format!(
            "{raw}: ambiguous. {} cases start at this page and nothing given settles which is meant; all are listed, in CAP's file order. Pass case_name (and year) to pick one.",
            cases.len()
        ),
        "held_miss" => format!(
            "{raw}: held_miss. stare.pub holds this volume and no case starts at this page. That is the strongest sign the data can give of a fabricated or mistyped citation."
        ),
        "not_held" => format!(
            "{raw}: not_held. stare.pub doesn't hold this volume; that means unverified, not false. Try the links."
        ),
        "external" | "statute" => format!("{raw}: a statute or regulation ({}), not a case.", r.status),
        s => format!("{raw}: {s}."),
    };
    for c in &cases {
        text.push_str(&format!(
            "\n- {} ({}), {}{} {}",
            c["name_abbreviation"].as_str().unwrap_or(""),
            c["decision_date"].as_str().unwrap_or(""),
            c["court"].as_str().unwrap_or(""),
            c["provenance"]
                .as_str()
                .map(|p| format!(". {p}"))
                .unwrap_or_default(),
            c["case_ref"].as_str().unwrap_or(""),
        ));
    }
    if let Some(note) = r.by_name.as_ref().and_then(|b| b["note"].as_str()) {
        text.push_str(&format!("\n({note})"));
    }
    if !r.conflicts.is_empty() {
        text.push_str(&format!(
            "\nNeeds review: cited in parallel with {}, which opens a different case.",
            r.conflicts.join(" and ")
        ));
    }
    for l in &r.case_links {
        text.push_str(&format!("\n{}: {}", l.source, l.url));
    }
    if let Some(u) = &r.external_url {
        text.push_str(&format!("\n{u}"));
    }
    Ok(Answer {
        structured: json!({
            "status": r.status,
            "citation": r.citation,
            "cases": cases,
            "by_name": r.by_name,
            "conflicts": r.conflicts,
            "needs_review": !r.conflicts.is_empty(),
            "case_links": r.case_links,
            "external_url": r.external_url,
        }),
        text,
    })
}

// ---------------------------------------------------------------------------
// get_case
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GetCaseInput {
    #[serde(default)]
    case_ref: Option<String>,
    #[serde(default)]
    citation: Option<String>,
    #[serde(default)]
    parts: Option<Vec<String>>,
    #[serde(default)]
    opinion: Option<usize>,
    #[serde(default)]
    find: Option<String>,
    #[serde(default)]
    context_chars: Option<usize>,
    #[serde(default)]
    max_chars: Option<usize>,
    #[serde(default)]
    cursor: Option<String>,
}

fn get_case(call: &mut Call, input: GetCaseInput) -> ToolResult<Answer> {
    let parts = input
        .parts
        .clone()
        .unwrap_or_else(|| vec!["metadata".into(), "text".into()]);
    if let Some(bad) = parts.iter().find(|p| *p != "metadata" && *p != "text") {
        return Err(ToolError::new(
            Code::BadInput,
            format!("unknown part {bad:?}; parts are metadata and text"),
        ));
    }
    let max = input.max_chars.unwrap_or(CASE_DEFAULT_CHARS);
    if max == 0 || max > CASE_MAX_CHARS {
        return Err(ToolError::new(
            Code::BadInput,
            format!("max_chars is 1 to {}", thousands(CASE_MAX_CHARS)),
        ));
    }
    let context = input.context_chars.unwrap_or(CONTEXT_DEFAULT);
    if context > CONTEXT_MAX {
        return Err(ToolError::new(
            Code::BadInput,
            format!("context_chars is at most {}", thousands(CONTEXT_MAX)),
        ));
    }
    let src = call.index()?;
    let (id, cr, provenance) = match (&input.case_ref, &input.citation) {
        (Some(r), None) => (None, parse_case_ref(r.trim())?, None),
        (None, Some(c)) => {
            let r = resolve(
                call,
                &ResolveInput {
                    citation: Some(c.clone()),
                    ..Default::default()
                },
            )?;
            if r.cases.len() != 1 {
                let listed: Vec<Value> = r
                    .cases
                    .iter()
                    .map(|(id, cr, _)| json!({"case_ref": case_ref(cr), "reader_url": reader_url(id)}))
                    .collect();
                let text = match r.status {
                    "ambiguous" => format!(
                        "{c}: {} cases start at this page; call get_case with one of their case_refs: {}",
                        listed.len(),
                        listed.iter().filter_map(|l| l["case_ref"].as_str()).collect::<Vec<_>>().join(", ")
                    ),
                    s => format!("{c}: {s}; no case to read. resolve_citation says more."),
                };
                return Ok(Answer {
                    structured: json!({ "status": r.status, "cases": listed }),
                    text,
                });
            }
            let (id, cr, p) = r.cases.into_iter().next().unwrap();
            (Some(id), cr, p)
        }
        _ => {
            return Err(ToolError::new(
                Code::BadInput,
                "give exactly one of case_ref and citation",
            ))
        }
    };
    let (case, raw) = read_case(call, &src, &cr)?;
    if let Some(n) = input.opinion {
        if n >= case.casebody.opinions.len() {
            return Err(ToolError::new(
                Code::BadInput,
                format!(
                    "opinion {n} doesn't exist; the case has {} (0 to {})",
                    case.casebody.opinions.len(),
                    case.casebody.opinions.len().saturating_sub(1)
                ),
            ));
        }
    }
    let ref_str = case_ref(&cr);
    let mut out = json!({ "status": "found", "case_ref": ref_str });
    let mut text = String::new();
    if parts.iter().any(|p| p == "metadata") {
        let mut m = summary(id.as_deref(), &cr, provenance, &case, &raw);
        m["opinions"] = case
            .casebody
            .opinions
            .iter()
            .map(|o| json!({"type": o.opinion_type, "author": o.author}))
            .collect();
        text.push_str(&format!(
            "{}\n{}  |  {}  |  {}\n",
            case.name_abbreviation,
            case.citations
                .first()
                .map(|c| c.cite.as_str())
                .unwrap_or("—"),
            case.decision_date,
            case.court.name
        ));
        if let Some(n) = m["courtlistener"]["blocked_notice"].as_str() {
            text.push_str(n);
            text.push('\n');
        }
        out["metadata"] = m;
    }
    if parts.iter().any(|p| p == "text") {
        let body = CaseText::new(&case, input.opinion);
        let of = format!(
            "{ref_str}#{}",
            input.opinion.map_or("all".into(), |n| n.to_string())
        );
        let total = body.len();
        out["total_chars"] = total.into();
        if let Some(q) = input.find.as_deref().filter(|q| !q.trim().is_empty()) {
            let matches = find(&body.text, q, FIND_MATCHES);
            let excerpts: Vec<Value> = matches
                .iter()
                .map(|m| {
                    let half = context / 2;
                    let (s, e) = (m.start.saturating_sub(half), (m.end + half).min(total));
                    json!({
                        "opinion": body.opinion_at(m.start),
                        "start": s, "end": e,
                        "match_start": m.start, "match_end": m.end,
                        "match": if m.distance == 0 { "exact" } else { "near" },
                        "distance": m.distance,
                        "text": body.slice(s, e),
                    })
                })
                .collect();
            let near = matches.iter().any(|m| m.distance > 0);
            text.push_str(&format!(
                "{} for {:?} in {} characters{}.\n",
                plural(excerpts.len(), "match", "matches"),
                q,
                thousands(total),
                if near {
                    " (no exact match; the nearest, with its edit distance)"
                } else if excerpts.len() == FIND_MATCHES {
                    " (the first 10)"
                } else {
                    ""
                }
            ));
            for x in &excerpts {
                text.push_str(&format!(
                    "\n[{}-{}{}]\n{}\n",
                    x["match_start"],
                    x["match_end"],
                    if near {
                        format!(", distance {}", x["distance"])
                    } else {
                        String::new()
                    },
                    x["text"].as_str().unwrap_or("")
                ));
            }
            out["excerpts"] = excerpts.into();
            out["truncated"] = false.into();
            out["next_cursor"] = Value::Null;
        } else {
            let start = match &input.cursor {
                Some(c) => Cursor::decode(c, "get_case", &of, call.version().as_deref())?.offset,
                None => 0,
            };
            let start = start.min(total);
            let end = body.window_end(start, max);
            let truncated = end < total;
            let next = truncated.then(|| {
                Cursor {
                    tool: "get_case".into(),
                    of: of.clone(),
                    offset: end,
                    version: call.version(),
                }
                .encode()
            });
            text.push_str(&format!(
                "Showing characters {} to {} of {}{}.\n\n",
                thousands(start),
                thousands(end),
                thousands(total),
                if truncated {
                    "; pass next_cursor for more"
                } else {
                    ""
                }
            ));
            text.push_str(body.slice(start, end));
            out["text"] = body.slice(start, end).into();
            out["start"] = start.into();
            out["end"] = end.into();
            out["truncated"] = truncated.into();
            out["next_cursor"] = next.into();
        }
    }
    text.push_str(&format!("\n{}", meta::credit_line(&case)));
    Ok(Answer {
        structured: out,
        text,
    })
}

// ---------------------------------------------------------------------------
// check_brief
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckInput {
    text: String,
    #[serde(default)]
    include: Option<Vec<String>>,
    #[serde(default)]
    max_items: Option<usize>,
    #[serde(default)]
    cursor: Option<String>,
}

/// A citation as `check_brief` lists it: `stare check --json`'s fields, plus its case's
/// `case_ref` and `reader_url`.
pub fn citation_json(c: &CheckedCitation) -> Value {
    let mut v = serde_json::to_value(c).unwrap_or(Value::Null);
    v["case_ref"] = c.case_ref.as_ref().map(case_ref).into();
    v["reader_url"] = c.case.as_deref().and_then(reader_url).into();
    v
}

/// The counts `check_brief` starts with.
fn brief_summary(report: &CheckReport) -> Value {
    let primary = |i: &usize| &report.citations[*i];
    let count = |s: &[CheckStatus]| {
        report
            .primaries
            .iter()
            .filter(|i| s.contains(&primary(i).status))
            .count()
    };
    let cases = report.cited_cases();
    let mut line = format!(
        "{} found ({} resolvable)",
        plural(cases, "cited case", "cited cases"),
        report.resolvable
    );
    if report.statutes > 0 {
        line.push_str(&format!(
            ", {}",
            plural(report.statutes, "statute", "statutes")
        ));
    }
    if report.needs_review > 0 {
        line.push_str(&format!(
            ", {} {} review",
            report.needs_review,
            if report.needs_review == 1 {
                "needs"
            } else {
                "need"
            }
        ));
    }
    json!({
        "cited_cases": cases,
        "resolvable": report.resolvable,
        "found": count(&[CheckStatus::Found, CheckStatus::FoundAlias]),
        "found_partner": count(&[CheckStatus::FoundPartner]),
        "held_miss": count(&[CheckStatus::HeldMiss]),
        "not_held": count(&[CheckStatus::NotHeld]),
        "unchecked": count(&[CheckStatus::Unchecked, CheckStatus::NoAntecedent]),
        "needs_review": report.needs_review,
        "statutes": report.statutes,
        "citations": report.citations.len(),
        "line": line,
    })
}

fn check_brief(call: &mut Call, input: CheckInput) -> ToolResult<Answer> {
    let n = chars(&input.text);
    if n > CHECK_MAX_CHARS {
        return Err(ToolError::new(
            Code::BadInput,
            format!(
                "text is {} characters; check_brief reads at most {}. Split it",
                thousands(n),
                thousands(CHECK_MAX_CHARS)
            ),
        ));
    }
    let include = input
        .include
        .clone()
        .unwrap_or_else(|| vec!["citations".into(), "cited_cases".into()]);
    if let Some(bad) = include
        .iter()
        .find(|p| *p != "citations" && *p != "cited_cases")
    {
        return Err(ToolError::new(
            Code::BadInput,
            format!("unknown include {bad:?}; include citations and cited_cases"),
        ));
    }
    let max = input.max_items.unwrap_or(ITEMS_DEFAULT);
    if max == 0 || max > ITEMS_MAX {
        return Err(ToolError::new(
            Code::BadInput,
            format!("max_items is 1 to {ITEMS_MAX}"),
        ));
    }
    let src = call.index()?;
    for s in meta::detection() {
        call.sources.add(s);
    }
    let of = stare::data::sha256(input.text.as_bytes())[..16].to_string();
    let offset = match &input.cursor {
        Some(c) => Cursor::decode(c, "check_brief", &of, call.version().as_deref())?.offset,
        None => 0,
    };
    let report = check_text(&src, &input.text);
    let summary = brief_summary(&report);
    let mut out = json!({ "summary": summary });
    let mut text = format!("{}.\n", summary["line"].as_str().unwrap_or(""));
    let mut more = false;
    if include.iter().any(|i| i == "cited_cases") {
        let groups = report.primaries.len();
        let page: Vec<usize> = (offset..groups.min(offset + max)).collect();
        more |= offset + max < groups;
        // The case names, read in parallel: one small file each, mostly cached.
        let names = read_names(call, &src, &report, &page);
        let mut listed = Vec::new();
        for (g, name) in page.iter().zip(names) {
            listed.push(cited_case(&report, *g, name));
        }
        text.push_str(&format!(
            "\nCited cases {} to {} of {}:\n",
            (offset + 1).min(groups),
            groups.min(offset + max),
            groups
        ));
        for c in &listed {
            let forms: Vec<&str> = c["forms"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|f| f["text"].as_str())
                .collect();
            text.push_str(&format!(
                "- {} [{}]{}{}{}\n",
                forms.join(", "),
                c["status"].as_str().unwrap_or(""),
                c["name"]
                    .as_str()
                    .map(|n| format!(" {n}"))
                    .unwrap_or_default(),
                c["case_ref"]
                    .as_str()
                    .map(|r| format!(" {r}"))
                    .unwrap_or_default(),
                if c["needs_review"] == true {
                    " (needs review)"
                } else {
                    ""
                },
            ));
        }
        out["cited_cases"] = listed.into();
    }
    if include.iter().any(|i| i == "citations") {
        let total = report.citations.len();
        more |= offset + max < total;
        out["citations"] = report
            .citations
            .iter()
            .skip(offset)
            .take(max)
            .map(citation_json)
            .collect();
        text.push_str(&format!(
            "\nCitations {} to {} of {} are in the structured result.\n",
            (offset + 1).min(total),
            total.min(offset + max),
            total
        ));
    }
    out["next_cursor"] = more
        .then(|| {
            Cursor {
                tool: "check_brief".into(),
                of,
                offset: offset + max,
                version: call.version(),
            }
            .encode()
        })
        .into();
    if more {
        text.push_str("More follow: pass next_cursor.\n");
    }
    text.push_str(
        "A found case exists and is the one cited; nothing here says whether it is still good law.",
    );
    Ok(Answer {
        structured: out,
        text,
    })
}

/// The names of the cited cases `groups` (indexes into the report's primaries), read
/// a few at a time; None for one that doesn't resolve or can't be read.
fn read_names(
    call: &mut Call,
    src: &Arc<Sources>,
    report: &CheckReport,
    groups: &[usize],
) -> Vec<Option<String>> {
    let refs: Vec<Option<CaseRef>> = groups
        .iter()
        .map(|&g| report.citations[report.primaries[g]].case_ref.clone())
        .collect();
    let mut names: Vec<Option<String>> = vec![None; refs.len()];
    let mut sources: Vec<Value> = Vec::new();
    std::thread::scope(|scope| {
        for (chunk_names, chunk_refs) in names.chunks_mut(8).zip(refs.chunks(8)) {
            let handles: Vec<_> = chunk_refs
                .iter()
                .map(|r| {
                    let src = src.clone();
                    let r = r.clone();
                    scope.spawn(move || -> Option<(String, Value)> {
                        match r? {
                            CaseRef::Cap {
                                reporter,
                                folder,
                                case_file,
                            } => {
                                let case = crate::engine::case_text::read_case(
                                    &src, &reporter, &folder, &case_file,
                                )
                                .ok()?;
                                Some((
                                    case.name_abbreviation,
                                    meta::cap(&format!("{}/{reporter}/{folder}.zip", src.data)),
                                ))
                            }
                            CaseRef::Cl { cluster_id, hash } => {
                                let bytes =
                                    crate::engine::fetch::fetch_record(&src, cluster_id, &hash)
                                        .ok()?;
                                let case = stare::cl::decode_record(&bytes).ok()?;
                                let file = format!(
                                    "{}/{}",
                                    stare::cl::data_base_for(&src.data),
                                    stare::cl::record_path(cluster_id, &hash).ok()?
                                );
                                let s = meta::courtlistener(&case, &file);
                                Some((case.name_abbreviation, s))
                            }
                        }
                    })
                })
                .collect();
            for (slot, h) in chunk_names.iter_mut().zip(handles) {
                if let Some((name, s)) = h.join().ok().flatten() {
                    *slot = Some(name);
                    sources.push(s);
                }
            }
        }
    });
    for s in sources {
        call.sources.add(s);
    }
    names
}

/// One cited case as `check_brief` lists it.
fn cited_case(report: &CheckReport, g: usize, name: Option<String>) -> Value {
    let group = &report.grouping.groups[g];
    let primary = &report.citations[report.primaries[g]];
    let mut forms = Vec::new();
    let (mut id, mut supra, mut short) = (0, 0, 0);
    for &i in &group.members {
        let c = &report.citations[i];
        let n = report.grouping.entry_counts[i];
        match c.citation_type.as_str() {
            "IdCitation" => id += n,
            "SupraCitation" => supra += n,
            "ShortCaseCitation" | "ReferenceCitation" => short += n,
            _ => forms.push(json!({"text": c.raw, "count": n, "status": c.status})),
        }
    }
    if forms.is_empty() {
        // A short form whose antecedent couldn't be identified is a cited case of its own.
        forms.push(json!({"text": primary.raw, "count": group.count, "status": primary.status}));
        (id, supra, short) = (0, 0, 0);
    }
    json!({
        "group": g,
        "case": primary.case,
        "case_ref": primary.case_ref.as_ref().map(case_ref),
        "reader_url": primary.case.as_deref().and_then(reader_url),
        "name": name,
        "status": primary.status,
        "needs_review": group.members.iter().any(|&i| report.citations[i].needs_review),
        "count": group.count,
        "forms": forms,
        "also_cited_as": {"id": id, "supra": supra, "short": short},
        "external_url": primary.external_url,
        "case_links": if primary.status == CheckStatus::NotHeld { primary.case_links.clone() } else { Vec::new() },
    })
}

// ---------------------------------------------------------------------------
// index_info
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InfoInput {
    #[serde(default)]
    refresh: bool,
}

fn index_info(call: &mut Call, input: InfoInput) -> ToolResult<Answer> {
    let pin = if input.refresh {
        call.session.refresh()?
    } else {
        call.session.pin()?
    };
    call.pin = Some(pin.clone());
    call.sources.add(meta::index(&pin));
    for s in meta::detection() {
        call.sources.add(s);
    }
    let live = if input.refresh {
        pin.live_version.clone()
    } else {
        call.session.live_version()
    };
    let m = pin.manifest();
    let slugs: Vec<&String> = m.map(|m| m.reporters.keys().collect()).unwrap_or_default();
    let stats = stare::config::cache_stats();
    let cache: serde_json::Map<String, Value> = stats
        .iter()
        .map(|s| {
            (
                s.kind.to_string(),
                json!({"files": s.count, "bytes": s.total_bytes}),
            )
        })
        .collect();
    let out = json!({
        "index_version": pin.version,
        "pinned_at": pin.pinned_at,
        "live_version": live,
        "source": pin.source,
        "data_source": call.session.data,
        "license": m.and_then(|m| m.license.clone()),
        "based_on": m.map(|m| m.based_on.clone()).unwrap_or_default(),
        "licenses": [
            {"applies_to": "the citation index, the manifest and the provenance labels", "license": m.and_then(|m| m.license.clone())},
            {"applies_to": "CAP case text and metadata, as the Caselaw Access Project published them", "license": stare::license::CC0},
            {"applies_to": "CourtListener records, as each record states", "license": stare::license::PUBLIC_DOMAIN_MARK},
        ],
        "format": {"manifest": stare::manifest::FORMAT, "idx": m.and_then(|m| m.idx)},
        "counts": {
            "volumes": m.and_then(|m| m.volumes),
            "entries": m.and_then(|m| m.entries),
            "reporters": slugs.len(),
            "alias_reporters": m.map(|m| m.aliases.len()),
        },
        "cache": {"location": stare::config::cache_dir(), "stores": cache},
    });
    let mut text = format!(
        "Index {} (pinned {}), from {}.",
        pin.version.as_deref().unwrap_or("without a version"),
        pin.pinned_at,
        pin.source
    );
    match (&live, &pin.version) {
        (Some(l), Some(v)) if l != v => text.push_str(&format!(
            " The live build is {l}; index_info with refresh true moves the session to it."
        )),
        (None, _) => text.push_str(" The live build couldn't be read."),
        _ => {}
    }
    text.push_str(&format!(
        "\n{} reporters, {} CAP volume folders, {} entries.",
        slugs.len(),
        m.and_then(|m| m.volumes)
            .map(|n| thousands(n as usize))
            .unwrap_or("?".into()),
        m.and_then(|m| m.entries)
            .map(|n| thousands(n as usize))
            .unwrap_or("?".into()),
    ));
    text.push_str("\nCitation index: stare.pub, CC BY-NC-ND 4.0. CAP case text: CC0 1.0. CourtListener records: Public Domain Mark 1.0, credit CourtListener (Free Law Project).");
    Ok(Answer {
        structured: out,
        text,
    })
}
