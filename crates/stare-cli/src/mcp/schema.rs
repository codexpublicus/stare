//! The tools as `tools/list` gives them: names, descriptions written for the model,
//! input schemas, and output schemas for the structured results. Every result has
//! `meta`; a tool error has `error` instead of the tool's fields.

use super::error::Code;
use super::tools::{
    CASE_DEFAULT_CHARS, CASE_MAX_CHARS, CHECK_MAX_CHARS, CONTEXT_DEFAULT, CONTEXT_MAX,
    FIND_MAX_CHARS, ITEMS_DEFAULT, ITEMS_MAX,
};
use rmcp::model::{Tool, ToolAnnotations};
use serde_json::{json, Value};
use std::sync::Arc;

/// What every tool description ends with: what the data can't tell an agent.
const LIMITS: &str = "A found case exists and is the one the citation names. stare.pub has no treatment, history or citator data: nothing here says whether a case is still good law or whether a holding is still followed.";

fn object(v: Value) -> Arc<serde_json::Map<String, Value>> {
    match v {
        Value::Object(m) => Arc::new(m),
        _ => unreachable!("a schema is an object"),
    }
}

fn meta_schema() -> Value {
    json!({
        "type": "object",
        "description": "Where the answer came from: the pinned index build, this server's version, whether no network request was made, and each source used with the licence it states.",
        "properties": {
            "index_version": {"type": ["string", "null"]},
            "server_version": {"type": "string"},
            "cached": {"type": "boolean"},
            "sources": {"type": "array", "items": {"type": "object"}}
        },
        "required": ["index_version", "server_version", "cached", "sources"]
    })
}

fn error_schema() -> Value {
    let codes: Vec<&str> = Code::ALL.iter().map(|c| c.as_str()).collect();
    json!({
        "type": "object",
        "description": "Set, with isError, when the tool couldn't answer: bad input, or data that couldn't be read. A citation that isn't found is a status, never an error.",
        "properties": {
            "code": {"type": "string", "enum": codes},
            "message": {"type": "string"},
            "url": {"type": "string"}
        },
        "required": ["code", "message"]
    })
}

/// An output schema: the tool's own properties, `meta` and `error`.
fn output(mut properties: Value) -> Arc<serde_json::Map<String, Value>> {
    properties["meta"] = meta_schema();
    properties["error"] = error_schema();
    object(json!({
        "type": "object",
        "properties": properties,
        "required": ["meta"]
    }))
}

fn nullable(t: &str) -> Value {
    json!({"type": [t, "null"]})
}

fn case_schema() -> Value {
    json!({
        "type": "object",
        "description": "One case: its case_ref (pass it to get_case), names, date, court, citations, pages, source (cap or courtlistener), how it was resolved when not directly (provenance; never 'verified'), and its stare.pub address for a person.",
        "properties": {
            "case_ref": {"type": "string"},
            "name": {"type": "string"},
            "name_abbreviation": {"type": "string"},
            "decision_date": {"type": "string"},
            "court": {"type": "string"},
            "jurisdiction": {"type": "string"},
            "citations": {"type": "array", "items": {"type": "object"}},
            "first_page": {},
            "last_page": {},
            "docket_number": {},
            "source": {"type": "string", "enum": ["cap", "courtlistener"]},
            "provenance": nullable("string"),
            "reader_url": nullable("string"),
            "courtlistener": {"type": "object"},
            "opinions": {"type": "array", "items": {"type": "object"}}
        },
        "required": ["case_ref", "name", "decision_date", "source"]
    })
}

const STATUSES: [&str; 10] = [
    "found",
    "found_alias",
    "found_partner",
    "held_miss",
    "not_held",
    "ambiguous",
    "external",
    "statute",
    "no_antecedent",
    "unchecked",
];

pub fn tools() -> Vec<Tool> {
    let read_only = ToolAnnotations::new()
        .read_only(true)
        .destructive(false)
        .idempotent(true)
        .open_world(true);
    vec![
        Tool::new(
            "find_citations_in_text",
            format!(
                "Find every legal citation in a passage, with no lookups and no network: cases, statutes and regulations, journals, and short forms (Id., supra, 31 A.2d at 649) tied to the citation they refer to. Spans are character (code point) offsets. Cheap; use it to see what a text cites. To check that the cases exist, use check_brief. Reads up to {} characters.",
                FIND_MAX_CHARS
            ),
            object(json!({
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "The passage.", "maxLength": FIND_MAX_CHARS},
                    "types": {
                        "type": "array",
                        "description": "Only these kinds; default all.",
                        "items": {"type": "string", "enum": ["case", "law", "journal", "short"]}
                    }
                },
                "required": ["text"],
                "additionalProperties": false
            })),
        )
        .with_title("Find citations in text")
        .with_raw_output_schema(output(json!({
            "citations": {"type": "array", "items": {"type": "object", "properties": {
                "index": {"type": "integer"}, "raw": {"type": "string"}, "type": {"type": "string"},
                "kind": {"type": "string"}, "span": {"type": "object"}
            }}}
        })))
        .with_annotations(read_only.clone()),
        Tool::new(
            "resolve_citation",
            format!(
                "Look up one case citation in stare.pub's index of U.S. case law (the Caselaw Access Project's cases and CourtListener's records). Give the citation as written ('31 A.2d 647', 'Waterman v. Railway Express Agency, 31 A.2d 657 (1943)'), in the slug form ('a2d 31 647'), or as reporter, volume and page; add the citing text's case_name and year, and the run's other printings in parallel, to settle a page several cases start on. Status: found (and found_alias, found_partner, with a provenance label) means the case exists; held_miss means stare.pub holds the volume and no case starts at that page, the strongest sign of a fabricated or mistyped citation; not_held means stare.pub doesn't hold the volume, so the citation is unverified, not false (case_links lists where to try); ambiguous lists every case at the page. {LIMITS}"
            ),
            object(json!({
                "type": "object",
                "properties": {
                    "citation": {"type": "string", "description": "The citation as written, or the slug form 'a2d 31 647'."},
                    "reporter": {"type": "string", "description": "With volume and page, instead of citation: a reporter slug ('a2d') or the reporter as cited ('A.2d')."},
                    "volume": {"type": ["string", "integer"]},
                    "page": {"type": ["string", "integer"], "description": "A page number, or a labelled page ('xxix')."},
                    "case_name": {"type": "string", "description": "The case name the citing text gives, to pick among cases on one page."},
                    "year": {"type": "integer"},
                    "parallel": {"type": "array", "items": {"type": "string"}, "description": "The other printings cited with it ('128 Neb. 783')."}
                },
                "additionalProperties": false
            })),
        )
        .with_title("Resolve a citation")
        .with_raw_output_schema(output(json!({
            "status": {"type": "string", "enum": STATUSES},
            "citation": {"type": "object"},
            "cases": {"type": "array", "items": case_schema()},
            "by_name": {"type": ["object", "null"]},
            "conflicts": {"type": "array", "items": {"type": "string"}},
            "needs_review": {"type": "boolean"},
            "case_links": {"type": "array", "items": {"type": "object"}},
            "external_url": nullable("string")
        })))
        .with_annotations(read_only.clone()),
        Tool::new(
            "get_case",
            format!(
                "Read a case: its metadata and its opinions' text, sized for a context window. Name it by a case_ref from another result, or by citation. The text comes {CASE_DEFAULT_CHARS} characters at a time by default (max_chars up to {CASE_MAX_CHARS}), cut at a paragraph end, with next_cursor for the rest. To check a quotation or proposition, pass find with the quoted words: it returns up to 10 excerpts ({CONTEXT_DEFAULT} characters around each by default, context_chars up to {CONTEXT_MAX}), matching with case, spacing and curly quotes folded, and the nearest match with its edit distance when there is no exact one. Read the excerpt and compare it with the claim; a near match is not the quoted text. When reproducing text, quote the credit line. {LIMITS}"
            ),
            object(json!({
                "type": "object",
                "properties": {
                    "case_ref": {"type": "string", "description": "From a result: cap:a2d/31/0647-01 or cl:4893133/62f253f296600fb7."},
                    "citation": {"type": "string", "description": "Instead of case_ref: a citation, resolved first."},
                    "parts": {"type": "array", "items": {"type": "string", "enum": ["metadata", "text"]}, "description": "Default both."},
                    "opinion": {"type": "integer", "minimum": 0, "description": "One opinion by index; default all."},
                    "find": {"type": "string", "description": "Return excerpts around these words instead of the text."},
                    "context_chars": {"type": "integer", "minimum": 0, "maximum": CONTEXT_MAX},
                    "max_chars": {"type": "integer", "minimum": 1, "maximum": CASE_MAX_CHARS},
                    "cursor": {"type": "string", "description": "A previous call's next_cursor."}
                },
                "additionalProperties": false
            })),
        )
        .with_title("Read a case")
        .with_raw_output_schema(output(json!({
            "status": {"type": "string"},
            "case_ref": {"type": "string"},
            "metadata": case_schema(),
            "text": {"type": "string"},
            "start": {"type": "integer"},
            "end": {"type": "integer"},
            "excerpts": {"type": "array", "items": {"type": "object", "properties": {
                "opinion": {"type": ["integer", "null"]}, "start": {"type": "integer"}, "end": {"type": "integer"},
                "match_start": {"type": "integer"}, "match_end": {"type": "integer"},
                "match": {"type": "string", "enum": ["exact", "near"]}, "distance": {"type": "integer"},
                "text": {"type": "string"}
            }}},
            "truncated": {"type": "boolean"},
            "next_cursor": nullable("string"),
            "total_chars": {"type": "integer"},
            "cases": {"type": "array", "items": {"type": "object"}}
        })))
        .with_annotations(read_only.clone()),
        Tool::new(
            "check_brief",
            format!(
                "Check every citation in a document (a brief, a memo, a draft opinion) against stare.pub's index, the way stare.pub's brief checker does: each citation looked up, parallel citations reconciled, a page several cases start on settled by the citing text's case name, and the citations grouped by the case they cite. Returns a summary, the cited cases (with each case's name, to compare with the name the text gives) and the citations, {ITEMS_DEFAULT} at a time with next_cursor. Use it first on any text with case citations; then read each case a proposition relies on with get_case and find. held_miss is the strongest sign of a fabricated or mistyped citation; not_held means unverified, not false; needs_review means a run's printings open different cases. Reads up to {CHECK_MAX_CHARS} characters; no case text is returned. {LIMITS}"
            ),
            object(json!({
                "type": "object",
                "properties": {
                    "text": {"type": "string", "maxLength": CHECK_MAX_CHARS},
                    "include": {"type": "array", "items": {"type": "string", "enum": ["citations", "cited_cases"]}, "description": "Default both."},
                    "max_items": {"type": "integer", "minimum": 1, "maximum": ITEMS_MAX},
                    "cursor": {"type": "string"}
                },
                "required": ["text"],
                "additionalProperties": false
            })),
        )
        .with_title("Check a brief's citations")
        .with_raw_output_schema(output(json!({
            "summary": {"type": "object", "properties": {"line": {"type": "string"}}},
            "cited_cases": {"type": "array", "items": {"type": "object"}},
            "citations": {"type": "array", "items": {"type": "object", "properties": {
                "raw": {"type": "string"}, "status": {"type": "string", "enum": STATUSES},
                "case_ref": nullable("string"), "reader_url": nullable("string")
            }}},
            "next_cursor": nullable("string")
        })))
        .with_annotations(read_only.clone()),
        Tool::new(
            "index_info",
            "What this server reads and under which terms: the pinned index build, the live one, the source (idx.stare.pub, a mirror directory, or offline), what the index is made from, the licences, counts from the manifest, and the cache. The session reads one build from its first lookup; refresh true moves it to the live build, and cursors from before the move are refused.",
            object(json!({
                "type": "object",
                "properties": {"refresh": {"type": "boolean", "description": "Move the session to the live build."}},
                "additionalProperties": false
            })),
        )
        .with_title("Index and licences")
        .with_raw_output_schema(output(json!({
            "index_version": nullable("string"),
            "pinned_at": {"type": "string"},
            "live_version": nullable("string"),
            "source": {"type": "string"},
            "data_source": {"type": "string"},
            "license": {},
            "based_on": {"type": "array"},
            "licenses": {"type": "array"},
            "format": {"type": "object"},
            "counts": {"type": "object"},
            "cache": {"type": "object"}
        })))
        .with_annotations(ToolAnnotations::new().read_only(true).destructive(false).open_world(true)),
    ]
}
