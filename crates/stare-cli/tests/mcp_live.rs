//! The live smoke test (#162): `stare mcp` against idx.stare.pub and data.stare.pub,
//! so a change in the published formats shows up before a user finds it. Not in CI's
//! required set; `mise run mcp-smoke` runs it.
#![cfg(feature = "mcp")]

use rmcp::model::{CallToolRequestParams, CallToolResponse, CallToolResult};
use rmcp::service::RunningService;
use rmcp::transport::TokioChildProcess;
use rmcp::{RoleClient, ServiceExt};
use serde_json::{json, Value};

async fn call(client: &RunningService<RoleClient, ()>, name: &str, args: Value) -> Value {
    let Value::Object(args) = args else {
        unreachable!()
    };
    let params = CallToolRequestParams::new(name.to_string()).with_arguments(args);
    let CallToolResponse::Complete(r): CallToolResponse =
        client.call_tool_once(params).await.unwrap()
    else {
        panic!("{name}: not a complete result");
    };
    let r: CallToolResult = r;
    assert_ne!(r.is_error, Some(true), "{name}: {:?}", r.content);
    r.structured_content.unwrap()
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "reads the live hosts; run with mise run mcp-smoke"]
async fn check_a_short_brief_against_the_live_index() {
    let home = tempfile::tempdir().unwrap();
    let mut cmd = tokio::process::Command::new(env!("CARGO_BIN_EXE_stare"));
    cmd.arg("mcp")
        .env("XDG_CACHE_HOME", home.path().join("cache"))
        .env("XDG_CONFIG_HOME", home.path().join("config"))
        .env_remove("STARE_INDEX")
        .env_remove("STARE_DATA");
    let client = ().serve(TokioChildProcess::new(cmd).unwrap()).await.unwrap();

    let brief = "A residence, not a mailing address, is the test. D'Elia & Marks Co. v. Lyon, \
                 31 A.2d 647 (D.C. 1943). See also Waterman v. Railway Express Agency, 31 A.2d \
                 657 (D.C. 1943); Roe v. Wade, 410 U.S. 113 (1973); 31 A.2d 648.";
    let v = call(&client, "check_brief", json!({ "text": brief })).await;
    let version = v["meta"]["index_version"].as_str().unwrap().to_string();
    assert!(stare::manifest::is_data_version(&version), "{version}");
    let by_raw = |raw: &str| {
        v["citations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["raw"] == raw)
            .cloned()
            .unwrap_or_else(|| panic!("no {raw}"))
    };
    assert_eq!(by_raw("31 A.2d 647")["status"], "found");
    assert_eq!(by_raw("31 A.2d 647")["case_ref"], "cap:a2d/31/0647-01");
    assert_eq!(by_raw("31 A.2d 657")["case"], "a2d/31/657-2");
    assert_eq!(by_raw("31 A.2d 648")["status"], "held_miss");
    assert_eq!(by_raw("410 U.S. 113")["status"], "found");

    let v = call(
        &client,
        "get_case",
        json!({"case_ref": "cap:a2d/31/0647-01", "find": "residence is the test"}),
    )
    .await;
    assert_eq!(v["excerpts"][0]["match"], "exact");
    assert_eq!(v["meta"]["index_version"], version.as_str());

    let v = call(&client, "index_info", json!({})).await;
    assert_eq!(v["source"], "https://idx.stare.pub");
    client.cancel().await.unwrap();
}
