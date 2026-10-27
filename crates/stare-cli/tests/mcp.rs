//! `stare mcp`'s protocol (#162): an rmcp client in this process talks to the server
//! over a duplex pipe, as a stdio client would. It lists the tools and checks their
//! schemas against the JSON Schema meta-schema, calls each tool and checks its result
//! against its output schema, follows cursors, and draws every error code M1 can give.
//! The fixture mirror is `tests/common`'s; the cache is one temporary directory for the
//! whole test binary, since it is found through the environment.
#![cfg(feature = "mcp")]

mod common;

use rmcp::model::{CallToolRequestParams, CallToolResponse, CallToolResult, Tool};
use rmcp::service::RunningService;
use rmcp::{RoleClient, ServiceExt};
use serde_json::{json, Value};
use stare_cli::mcp::{Options, StareServer};
use std::sync::OnceLock;

/// Point the cache and config at a temporary directory, once for the binary.
fn home() {
    static HOME: OnceLock<tempfile::TempDir> = OnceLock::new();
    HOME.get_or_init(|| {
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("XDG_CACHE_HOME", home.path().join("cache"));
        std::env::set_var("XDG_CONFIG_HOME", home.path().join("config"));
        home
    });
}

/// The mirror most tests read.
fn mirror() -> &'static common::Mirror {
    static MIRROR: OnceLock<common::Mirror> = OnceLock::new();
    home();
    MIRROR.get_or_init(common::mirror)
}

fn options(m: &common::Mirror) -> Options {
    Options {
        index: Some(m.index().to_string_lossy().into_owned()),
        data: Some(m.data().to_string_lossy().into_owned()),
        index_version: None,
    }
}

async fn connect(options: Options) -> RunningService<RoleClient, ()> {
    home();
    let (server_end, client_end) = tokio::io::duplex(1 << 20);
    let server = StareServer::new(options);
    tokio::spawn(async move {
        let running = server.serve(server_end).await.unwrap();
        let _ = running.waiting().await;
    });
    ().serve(client_end).await.unwrap()
}

async fn call(client: &RunningService<RoleClient, ()>, name: &str, args: Value) -> CallToolResult {
    let Value::Object(args) = args else {
        panic!("arguments are an object")
    };
    let params = CallToolRequestParams::new(name.to_string()).with_arguments(args);
    match client.call_tool_once(params).await.unwrap() {
        CallToolResponse::Complete(r) => r,
        other => panic!("{name}: {other:?}"),
    }
}

/// The structured result, checked against the tool's output schema.
fn structured(tools: &[Tool], name: &str, r: &CallToolResult) -> Value {
    let v = r.structured_content.clone().expect("structured content");
    let tool = tools.iter().find(|t| t.name == name).unwrap();
    let schema = Value::Object((*tool.output_schema.clone().unwrap()).clone());
    let validator = jsonschema::validator_for(&schema).unwrap();
    let errors: Vec<String> = validator.iter_errors(&v).map(|e| e.to_string()).collect();
    assert!(errors.is_empty(), "{name}: {errors:?}");
    assert_eq!(v["meta"]["server_version"], env!("CARGO_PKG_VERSION"));
    v
}

fn text(r: &CallToolResult) -> String {
    r.content
        .iter()
        .filter_map(|c| c.as_text().map(|t| t.text.clone()))
        .collect()
}

fn error_code(r: &CallToolResult) -> String {
    assert_eq!(r.is_error, Some(true), "{}", text(r));
    r.structured_content.as_ref().unwrap()["error"]["code"]
        .as_str()
        .unwrap()
        .to_string()
}

#[tokio::test(flavor = "multi_thread")]
async fn initialize_and_list_the_tools() {
    let client = connect(options(mirror())).await;
    let info = client.peer_info().unwrap();
    let server = info.server_info.as_ref().unwrap();
    assert_eq!(server.name, "stare");
    assert_eq!(server.version, env!("CARGO_PKG_VERSION"));
    assert!(info.instructions.as_deref().unwrap().contains("good law"));

    let tools = client.list_all_tools().await.unwrap();
    let names: Vec<&str> = tools.iter().map(|t| t.name.as_ref()).collect();
    assert_eq!(
        names,
        [
            "find_citations_in_text",
            "resolve_citation",
            "get_case",
            "check_brief",
            "index_info"
        ]
    );
    for t in &tools {
        let input = Value::Object((*t.input_schema).clone());
        let output = Value::Object((*t.output_schema.clone().unwrap()).clone());
        for (which, schema) in [("input", &input), ("output", &output)] {
            if let Err(e) = jsonschema::meta::validate(schema) {
                panic!("{}'s {which} schema: {e}", t.name);
            }
        }
        assert_eq!(input["additionalProperties"], false, "{}", t.name);
        let description = t.description.as_deref().unwrap();
        if t.name != "index_info" && t.name != "find_citations_in_text" {
            assert!(description.contains("good law"), "{}", t.name);
        }
    }
    client.cancel().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn each_tool_answers_with_its_schema_and_meta() {
    let client = connect(options(mirror())).await;
    let tools = client.list_all_tools().await.unwrap();

    let r = call(&client, "index_info", json!({})).await;
    let v = structured(&tools, "index_info", &r);
    assert_eq!(v["index_version"], common::VERSION);
    assert_eq!(v["meta"]["index_version"], common::VERSION);

    let r = call(
        &client,
        "find_citations_in_text",
        json!({"text": "Café owners rely on D'Elia & Marks Co. v. Lyon, 31 A.2d 647 (1943). Id. at 648.", "types": ["case", "short"]}),
    )
    .await;
    let v = structured(&tools, "find_citations_in_text", &r);
    let c = &v["citations"];
    assert_eq!(c[0]["raw"], "31 A.2d 647");
    // Character offsets: "Café" is one character and two bytes.
    assert_eq!(c[0]["span"]["start"], 48);
    assert_eq!(c[1]["antecedent"]["index"], 0);
    let roles: Vec<&str> = v["meta"]["sources"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["name"].as_str().unwrap())
        .collect();
    assert_eq!(roles, ["reporters-db", "courts-db", "citare"]);

    let r = call(
        &client,
        "resolve_citation",
        json!({"citation": "31 A.2d 647"}),
    )
    .await;
    let v = structured(&tools, "resolve_citation", &r);
    assert_eq!(v["status"], "found");
    assert_eq!(v["cases"][0]["case_ref"], "cap:a2d/31/0647-01");
    assert_eq!(
        v["cases"][0]["reader_url"],
        "https://stare.pub/#a2d/31/647-01"
    );
    let licences: Vec<&str> = v["meta"]["sources"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|s| s["license"]["id"].as_str())
        .collect();
    assert_eq!(licences, ["CC-BY-NC-ND-4.0", "CC0-1.0"]);

    let r = call(
        &client,
        "get_case",
        json!({"case_ref": "cl:9876543/0f3a9c2e7b1d4a65", "parts": ["metadata"]}),
    )
    .await;
    let v = structured(&tools, "get_case", &r);
    assert_eq!(v["metadata"]["source"], "courtlistener");
    let cl = v["meta"]["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == "CourtListener")
        .unwrap();
    assert_eq!(cl["license"]["id"], "CC-PDM-1.0");
    assert_eq!(cl["attribution"]["publisher"], "Free Law Project");

    let brief = std::fs::read_to_string(common::tests_dir().join("fixtures/brief.txt")).unwrap();
    let r = call(&client, "check_brief", json!({"text": brief})).await;
    let v = structured(&tools, "check_brief", &r);
    assert_eq!(v["summary"]["cited_cases"], 14);
    assert!(
        text(&r).starts_with("14 cited cases found (9 resolvable), 3 statutes, 1 needs review.")
    );
    client.cancel().await.unwrap();
}

/// The resolution statuses, through every way of naming a citation.
#[tokio::test(flavor = "multi_thread")]
async fn resolve_citation_statuses() {
    let client = connect(options(mirror())).await;
    let status = |v: &CallToolResult| v.structured_content.as_ref().unwrap()["status"].clone();
    for (args, want) in [
        (json!({"citation": "31 A.2d 647"}), "found"),
        (json!({"citation": "a2d 31 647"}), "found"),
        (
            json!({"reporter": "a2d", "volume": 31, "page": 647}),
            "found",
        ),
        (
            json!({"reporter": "A.2d", "volume": "31", "page": "647"}),
            "found",
        ),
        (json!({"citation": "260 N.W. 287"}), "found_alias"),
        (json!({"citation": "n-w 260 287"}), "found_alias"),
        (
            json!({"citation": "Pettegrew v. Pettegrew, 128 Neb. 783 (1935)", "parallel": ["260 N.W. 287"]}),
            "found_partner",
        ),
        (json!({"citation": "31 A.2d 657"}), "ambiguous"),
        (json!({"citation": "a2d 31 657"}), "ambiguous"),
        (
            json!({"citation": "31 A.2d 657", "case_name": "Waterman v. Railway Express Agency", "year": 1943}),
            "found",
        ),
        (
            json!({"citation": "a2d 31 657", "case_name": "Brooks v. District of Columbia"}),
            "found",
        ),
        (json!({"citation": "31 A.2d 648"}), "held_miss"),
        (json!({"citation": "260 N.W. 288"}), "not_held"),
        (json!({"citation": "410 U.S. 113"}), "not_held"),
        (json!({"citation": "250 A.3d 100"}), "found"),
        (json!({"citation": "2021 NY Slip Op 01234"}), "found"),
        (
            json!({"citation": "Smith v. Jones, 250 A.3d 100, 31 A.2d 660 (Pa. 2021)"}),
            "found",
        ),
        (json!({"citation": "42 U.S.C. § 1983"}), "external"),
    ] {
        let r = call(&client, "resolve_citation", args.clone()).await;
        assert_eq!(status(&r), want, "{args}: {}", text(&r));
    }
    // Two printings that open different cases need review.
    let r = call(
        &client,
        "resolve_citation",
        json!({"citation": "250 A.3d 100", "case_name": "Smith v. Jones", "parallel": ["31 A.2d 660"]}),
    )
    .await;
    let v = r.structured_content.unwrap();
    assert_eq!(v["needs_review"], true);
    assert_eq!(v["conflicts"], json!(["31 A.2d 660"]));
    // The ambiguous page lists both cases, in CAP's file order.
    let r = call(
        &client,
        "resolve_citation",
        json!({"citation": "31 A.2d 657"}),
    )
    .await;
    let refs: Vec<Value> = r.structured_content.unwrap()["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["case_ref"].clone())
        .collect();
    assert_eq!(
        refs,
        [json!("cap:a2d/31/0657-01"), json!("cap:a2d/31/0657-02")]
    );
    client.cancel().await.unwrap();
}

/// get_case's windows join into the whole text, cut at paragraph ends, and its `find`
/// reports exact and near matches.
#[tokio::test(flavor = "multi_thread")]
async fn get_case_pages_and_finds() {
    let client = connect(options(mirror())).await;
    let tools = client.list_all_tools().await.unwrap();
    let whole = call(
        &client,
        "get_case",
        json!({"case_ref": "cap:a2d/31/0662-01", "parts": ["text"], "max_chars": 100000}),
    )
    .await;
    let whole = structured(&tools, "get_case", &whole);
    let total = whole["total_chars"].as_u64().unwrap() as usize;
    assert_eq!(whole["truncated"], false);
    assert!(total > 20_000, "{total}");

    let mut joined = String::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;
    loop {
        let mut args =
            json!({"case_ref": "cap:a2d/31/0662-01", "parts": ["text"], "max_chars": 8000});
        if let Some(c) = &cursor {
            args["cursor"] = c.clone().into();
        }
        let r = call(&client, "get_case", args).await;
        let v = structured(&tools, "get_case", &r);
        let page = v["text"].as_str().unwrap();
        assert!(page.chars().count() <= 8000);
        assert!(text(&r).starts_with(&format!(
            "Showing characters {}",
            thousands(v["start"].as_u64().unwrap())
        )));
        if v["truncated"] == true {
            // A cut at a paragraph end when one is in the window's last tenth.
            let tail: String = page.chars().rev().take(800).collect();
            if tail.contains('\n') {
                assert!(page.ends_with('\n'), "page {pages} ends mid-paragraph");
            }
        }
        joined.push_str(page);
        pages += 1;
        match v["next_cursor"].as_str() {
            Some(c) => cursor = Some(c.to_string()),
            None => break,
        }
    }
    assert!(pages > 2);
    assert_eq!(joined, whole["text"].as_str().unwrap());

    let r = call(
        &client,
        "get_case",
        json!({"citation": "31 A.2d 647", "find": "A MAN'S RESIDENCE IS WHERE HE ACTUALLY DWELLS"}),
    )
    .await;
    let v = structured(&tools, "get_case", &r);
    assert_eq!(v["excerpts"][0]["match"], "exact");
    assert!(v["excerpts"][0]["text"]
        .as_str()
        .unwrap()
        .contains("A man’s residence is where he actually dwells"));
    assert!(text(&r).ends_with(
        "Text: Caselaw Access Project, CC0 1.0. Citation index: stare.pub, CC BY-NC-ND 4.0."
    ));
    let r = call(
        &client,
        "get_case",
        json!({"citation": "31 A.2d 647", "find": "a mans residence is where he usually dwells"}),
    )
    .await;
    let v = structured(&tools, "get_case", &r);
    assert_eq!(v["excerpts"][0]["match"], "near");
    assert!(v["excerpts"][0]["distance"].as_u64().unwrap() > 0);

    // A citation several cases start on names no case to read; it lists them.
    let r = call(&client, "get_case", json!({"citation": "31 A.2d 657"})).await;
    let v = structured(&tools, "get_case", &r);
    assert_eq!(v["status"], "ambiguous");
    assert_eq!(v["cases"].as_array().unwrap().len(), 2);
    client.cancel().await.unwrap();
}

fn thousands(n: u64) -> String {
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

/// check_brief pages its lists with a cursor, and its citations are `stare check
/// --json`'s, byte for byte, once `case_ref` and `reader_url` are dropped.
#[tokio::test(flavor = "multi_thread")]
async fn check_brief_pages_and_matches_stare_check_json() {
    let client = connect(options(mirror())).await;
    let brief = std::fs::read_to_string(common::tests_dir().join("fixtures/brief.txt")).unwrap();
    let mut citations: Vec<Value> = Vec::new();
    let mut cases = 0;
    let mut cursor: Option<String> = None;
    loop {
        let mut args = json!({"text": brief, "max_items": 5});
        if let Some(c) = &cursor {
            args["cursor"] = c.clone().into();
        }
        let r = call(&client, "check_brief", args).await;
        let v = r.structured_content.unwrap();
        citations.extend(v["citations"].as_array().unwrap().iter().cloned());
        cases += v["cited_cases"].as_array().unwrap().len();
        match v["next_cursor"].as_str() {
            Some(c) => cursor = Some(c.to_string()),
            None => break,
        }
    }
    assert_eq!(cases, 17);
    for c in &mut citations {
        let o = c.as_object_mut().unwrap();
        o.remove("case_ref");
        o.remove("reader_url");
    }
    let ours = serde_json::to_string_pretty(&Value::Array(citations)).unwrap() + "\n";
    let golden = std::fs::read_to_string(common::tests_dir().join("golden/check.json")).unwrap();
    assert_eq!(ours, golden);

    // A cursor for another text is refused.
    let r = call(
        &client,
        "check_brief",
        json!({"text": brief, "max_items": 5}),
    )
    .await;
    let next = r.structured_content.unwrap()["next_cursor"]
        .as_str()
        .unwrap()
        .to_string();
    let r = call(
        &client,
        "check_brief",
        json!({"text": "Other text.", "cursor": next}),
    )
    .await;
    assert_eq!(error_code(&r), "bad_input");
    client.cancel().await.unwrap();
}

/// Every tool error code M1 can give (`offline_miss` comes with `--offline` in M2), and
/// the JSON-RPC errors for an unknown tool and arguments outside the schema.
#[tokio::test(flavor = "multi_thread")]
async fn every_error_code() {
    let m = mirror();
    let client = connect(options(m)).await;
    let r = call(
        &client,
        "find_citations_in_text",
        json!({"text": "x", "types": ["dicta"]}),
    )
    .await;
    assert_eq!(error_code(&r), "bad_input");
    let r = call(
        &client,
        "get_case",
        json!({"case_ref": "cap:a2d/31/0647-01", "max_chars": 100001}),
    )
    .await;
    assert_eq!(error_code(&r), "bad_input");
    let long = "x".repeat(200_001);
    let r = call(&client, "find_citations_in_text", json!({ "text": long })).await;
    assert_eq!(error_code(&r), "bad_input");
    let r = call(
        &client,
        "resolve_citation",
        json!({"citation": "nothing to see"}),
    )
    .await;
    assert_eq!(error_code(&r), "unparsed");
    let r = call(&client, "get_case", json!({"case_ref": "a2d/31/0647-01"})).await;
    assert_eq!(error_code(&r), "bad_ref");
    let r = call(&client, "get_case", json!({"case_ref": "cap:a2d/31/../x"})).await;
    assert_eq!(error_code(&r), "bad_ref");

    // A cursor made under another index version.
    let stale = stare_cli::mcp::cursor::Cursor {
        tool: "get_case".into(),
        of: "cap:a2d/31/0647-01#all".into(),
        offset: 100,
        version: Some("v2020.01.01".into()),
    }
    .encode();
    let r = call(
        &client,
        "get_case",
        json!({"case_ref": "cap:a2d/31/0647-01", "parts": ["text"], "cursor": stale}),
    )
    .await;
    assert_eq!(error_code(&r), "stale_cursor");

    // Unknown tool, unknown argument, wrong type: JSON-RPC errors.
    for (name, args) in [
        ("no_such_tool", json!({})),
        ("resolve_citation", json!({"cite": "31 A.2d 647"})),
        ("get_case", json!({"case_ref": 7})),
    ] {
        let Value::Object(args) = args else {
            unreachable!()
        };
        let e = client
            .call_tool_once(CallToolRequestParams::new(name.to_string()).with_arguments(args))
            .await
            .unwrap_err();
        assert!(
            format!("{e}").contains("-32602")
                || format!("{e:?}").contains("InvalidParams")
                || format!("{e:?}").contains("32602"),
            "{name}: {e:?}"
        );
    }
    client.cancel().await.unwrap();

    // A mirror of the index without the case data (a tier-1 copy).
    let tier1 = common::mirror_at("v2026.10.25");
    std::fs::remove_file(tier1.data().join("a2d/31.zip")).unwrap();
    let client = connect(options(&tier1)).await;
    let r = call(
        &client,
        "resolve_citation",
        json!({"citation": "31 A.2d 648"}),
    )
    .await;
    assert_eq!(r.structured_content.unwrap()["status"], "held_miss");
    let r = call(
        &client,
        "get_case",
        json!({"case_ref": "cap:a2d/31/0647-01"}),
    )
    .await;
    assert_eq!(error_code(&r), "not_in_copy");
    assert_eq!(
        r.structured_content.unwrap()["error"]["url"],
        "https://data.stare.pub/cap/a2d/31.zip"
    );
    client.cancel().await.unwrap();

    // A corrupt gzip index file.
    let broken = common::mirror_at("v2026.10.24");
    std::fs::write(
        broken.index().join("v/v2026.10.24/a2d/31.idx.gz"),
        b"\x1f\x8b\x08\x00 not gzip",
    )
    .unwrap();
    let client = connect(options(&broken)).await;
    let r = call(
        &client,
        "resolve_citation",
        json!({"citation": "a2d 31 647"}),
    )
    .await;
    assert_eq!(error_code(&r), "data_error");
    client.cancel().await.unwrap();

    // A manifest newer than this binary reads.
    let newer = common::mirror_at("v2026.10.23");
    let path = newer.index().join("manifest.json");
    let mut manifest: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    manifest["format"] = 3.into();
    std::fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let client = connect(options(&newer)).await;
    let r = call(
        &client,
        "resolve_citation",
        json!({"citation": "31 A.2d 647"}),
    )
    .await;
    assert_eq!(error_code(&r), "index_too_new");
    client.cancel().await.unwrap();

    // An index host that doesn't answer, with an --index-version not in the cache.
    let client = connect(Options {
        index: Some("http://127.0.0.1:1".into()),
        data: Some("http://127.0.0.1:1/cap".into()),
        index_version: Some("v2019.01.01".into()),
    })
    .await;
    let r = call(
        &client,
        "resolve_citation",
        json!({"citation": "31 A.2d 647"}),
    )
    .await;
    assert_eq!(error_code(&r), "network");
    assert_eq!(
        r.structured_content.unwrap()["error"]["url"],
        "http://127.0.0.1:1/v/v2019.01.01/manifest.json"
    );
    client.cancel().await.unwrap();
}

/// The session reads one build until `index_info(refresh: true)`, and `--index-version`
/// reads the one it names; cursors from before a move are refused.
#[tokio::test(flavor = "multi_thread")]
async fn the_session_is_pinned() {
    let m = common::mirror_at("v2026.10.20");
    let client = connect(options(&m)).await;
    let r = call(
        &client,
        "get_case",
        json!({"case_ref": "cap:a2d/31/0662-01", "parts": ["text"], "max_chars": 1000}),
    )
    .await;
    let v = r.structured_content.unwrap();
    assert_eq!(v["meta"]["index_version"], "v2026.10.20");
    let cursor = v["next_cursor"].as_str().unwrap().to_string();

    // A new build goes live: the session keeps reading its own.
    let root = m.index();
    std::fs::rename(root.join("v/v2026.10.20"), root.join("v/v2026.10.21")).unwrap();
    std::fs::create_dir_all(root.join("v/v2026.10.20")).unwrap();
    for e in std::fs::read_dir(root.join("v/v2026.10.21")).unwrap() {
        let e = e.unwrap();
        copy_dir(&e.path(), &root.join("v/v2026.10.20").join(e.file_name()));
    }
    let path = root.join("manifest.json");
    let text = std::fs::read_to_string(&path)
        .unwrap()
        .replace("v2026.10.20", "v2026.10.21");
    std::fs::write(&path, text).unwrap();
    let r = call(&client, "index_info", json!({})).await;
    let v = r.structured_content.unwrap();
    assert_eq!(v["index_version"], "v2026.10.20");
    assert_eq!(v["live_version"], "v2026.10.21");

    let r = call(&client, "index_info", json!({"refresh": true})).await;
    assert_eq!(
        r.structured_content.unwrap()["index_version"],
        "v2026.10.21"
    );
    let r = call(
        &client,
        "get_case",
        json!({"case_ref": "cap:a2d/31/0662-01", "parts": ["text"], "cursor": cursor}),
    )
    .await;
    assert_eq!(error_code(&r), "stale_cursor");
    client.cancel().await.unwrap();

    // --index-version reads the build it names.
    let client = connect(Options {
        index_version: Some("v2026.10.20".into()),
        ..options(&m)
    })
    .await;
    let r = call(&client, "index_info", json!({})).await;
    let v = r.structured_content.unwrap();
    assert_eq!(v["index_version"], "v2026.10.20");
    assert_eq!(v["live_version"], "v2026.10.21");
    client.cancel().await.unwrap();
}

fn copy_dir(from: &std::path::Path, to: &std::path::Path) {
    if from.is_dir() {
        std::fs::create_dir_all(to).unwrap();
        for e in std::fs::read_dir(from).unwrap() {
            let e = e.unwrap();
            copy_dir(&e.path(), &to.join(e.file_name()));
        }
    } else {
        std::fs::copy(from, to).unwrap();
    }
}

/// No result is over its ceiling on the fixture set's largest case.
#[tokio::test(flavor = "multi_thread")]
async fn results_keep_to_their_budgets() {
    let client = connect(options(mirror())).await;
    let r = call(
        &client,
        "get_case",
        json!({"case_ref": "cap:a2d/31/0662-01"}),
    )
    .await;
    let v = r.structured_content.unwrap();
    assert!(v["text"].as_str().unwrap().chars().count() <= 20_000);
    let r = call(
        &client,
        "get_case",
        json!({"case_ref": "cap:a2d/31/0662-01", "find": "the", "context_chars": 4000}),
    )
    .await;
    let v = r.structured_content.unwrap();
    let excerpts = v["excerpts"].as_array().unwrap();
    assert_eq!(excerpts.len(), 10);
    for x in excerpts {
        assert!(x["text"].as_str().unwrap().chars().count() <= 4000 + 3);
    }
    client.cancel().await.unwrap();
}
