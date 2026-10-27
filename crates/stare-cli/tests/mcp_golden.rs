//! Golden vectors for `stare mcp`'s tools (#162): each input in `VECTORS` and the
//! result `stare mcp`, run as a child process over stdio against the fixture mirror,
//! gives for it, in `tests/mcp/<name>.json`. The server's version, the time the session
//! pinned its build, the mirror's path and the cache's contents are masked.
//! `UPDATE_GOLDEN=1 cargo test -p stare-cli --test mcp_golden` rewrites them for review.
#![cfg(feature = "mcp")]

mod common;

use rmcp::model::{CallToolRequestParams, CallToolResponse};
use rmcp::transport::TokioChildProcess;
use rmcp::ServiceExt;
use serde_json::{json, Value};

/// (golden file, tool, arguments). `@brief` is `tests/fixtures/brief.txt`.
fn vectors() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        ("index-info", "index_info", json!({})),
        (
            "find-citations",
            "find_citations_in_text",
            json!({"text": "@brief"}),
        ),
        (
            "find-citations-law",
            "find_citations_in_text",
            json!({"text": "@brief", "types": ["law"]}),
        ),
        (
            "resolve-found",
            "resolve_citation",
            json!({"citation": "31 A.2d 647"}),
        ),
        (
            "resolve-slug",
            "resolve_citation",
            json!({"citation": "a2d 31 647"}),
        ),
        (
            "resolve-alias",
            "resolve_citation",
            json!({"citation": "260 N.W. 287"}),
        ),
        (
            "resolve-partner",
            "resolve_citation",
            json!({"citation": "Pettegrew v. Pettegrew, 128 Neb. 783 (1935)", "parallel": ["260 N.W. 287"]}),
        ),
        (
            "resolve-ambiguous",
            "resolve_citation",
            json!({"citation": "31 A.2d 657"}),
        ),
        (
            "resolve-by-name",
            "resolve_citation",
            json!({"reporter": "a2d", "volume": 31, "page": 657, "case_name": "Waterman v. Railway Express Agency", "year": 1943}),
        ),
        (
            "resolve-held-miss",
            "resolve_citation",
            json!({"citation": "31 A.2d 648"}),
        ),
        (
            "resolve-not-held",
            "resolve_citation",
            json!({"citation": "Roe v. Wade, 410 U.S. 113 (1973)"}),
        ),
        (
            "resolve-courtlistener",
            "resolve_citation",
            json!({"citation": "250 A.3d 100"}),
        ),
        (
            "resolve-unparsed",
            "resolve_citation",
            json!({"citation": "no citation here"}),
        ),
        (
            "get-case-metadata",
            "get_case",
            json!({"case_ref": "cap:a2d/31/0647-01", "parts": ["metadata"]}),
        ),
        (
            "get-case-text",
            "get_case",
            json!({"case_ref": "cap:a2d/31/0662-01", "parts": ["text"], "max_chars": 3000}),
        ),
        (
            "get-case-find",
            "get_case",
            json!({"citation": "31 A.2d 647", "find": "residence is the test", "context_chars": 300}),
        ),
        (
            "get-case-courtlistener",
            "get_case",
            json!({"case_ref": "cl:9876543/0f3a9c2e7b1d4a65"}),
        ),
        (
            "get-case-bad-ref",
            "get_case",
            json!({"case_ref": "a2d 31 647"}),
        ),
        ("check-brief", "check_brief", json!({"text": "@brief"})),
        (
            "check-brief-page",
            "check_brief",
            json!({"text": "@brief", "max_items": 3}),
        ),
    ]
}

/// `v` with what differs from run to run masked.
fn mask(v: Value, mirror: &str) -> Value {
    match v {
        Value::String(s) => Value::String(s.replace(mirror, "<mirror>")),
        Value::Array(a) => Value::Array(a.into_iter().map(|x| mask(x, mirror)).collect()),
        Value::Object(o) => Value::Object(
            o.into_iter()
                .map(|(k, x)| {
                    let x = match k.as_str() {
                        "server_version" => json!("<server_version>"),
                        "pinned_at" => json!("<pinned_at>"),
                        "cache" if x.get("stores").is_some() => json!("<cache>"),
                        _ => mask(x, mirror),
                    };
                    (k, x)
                })
                .collect(),
        ),
        other => other,
    }
}

/// A rendering with `(pinned 2026-10-27T12:28:23Z)` masked.
fn mask_text(text: &str) -> String {
    match text.split_once("(pinned ") {
        Some((head, tail)) => match tail.split_once(')') {
            Some((_, rest)) => format!("{head}(pinned <pinned_at>){rest}"),
            None => text.to_string(),
        },
        None => text.to_string(),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn tool_results_match_the_golden_vectors() {
    let mirror = common::mirror();
    let home = tempfile::tempdir().unwrap();
    let mut cmd = tokio::process::Command::new(env!("CARGO_BIN_EXE_stare"));
    cmd.arg("--index")
        .arg(mirror.index())
        .arg("--data")
        .arg(mirror.data())
        .arg("mcp")
        .env("XDG_CACHE_HOME", home.path().join("cache"))
        .env("XDG_CONFIG_HOME", home.path().join("config"))
        .env_remove("STARE_INDEX")
        .env_remove("STARE_DATA");
    let client = ().serve(TokioChildProcess::new(cmd).unwrap()).await.unwrap();
    let brief = std::fs::read_to_string(common::tests_dir().join("fixtures/brief.txt")).unwrap();
    let root = mirror.root().to_string_lossy().into_owned();
    for (name, tool, args) in vectors() {
        let mut sent = args.clone();
        if sent["text"] == "@brief" {
            sent["text"] = brief.clone().into();
        }
        let Value::Object(o) = sent else {
            unreachable!()
        };
        let params = CallToolRequestParams::new(tool.to_string()).with_arguments(o);
        let CallToolResponse::Complete(r) = client.call_tool_once(params).await.unwrap() else {
            panic!("{name}: not a complete result");
        };
        let text: String = r
            .content
            .iter()
            .filter_map(|c| c.as_text().map(|t| t.text.clone()))
            .collect();
        let vector = json!({
            "tool": tool,
            "arguments": args,
            "is_error": r.is_error.unwrap_or(false),
            "structured": mask(r.structured_content.clone().unwrap_or(Value::Null), &root),
            "text": mask_text(&text.replace(&root, "<mirror>")),
        });
        let out = serde_json::to_string_pretty(&vector).unwrap() + "\n";
        common::golden(&format!("../mcp/{name}.json"), &out);
    }
    client.cancel().await.unwrap();
}
