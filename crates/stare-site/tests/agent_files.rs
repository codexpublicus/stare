//! The files stare.pub publishes for agents (#161): `reporters.json`, which
//! `stare-site export-reporters` writes, matches its schema, and the hand-written
//! `web/public/openapi.json` is valid OpenAPI 3.1 that describes static GETs only.
//!
//! `fixtures/openapi-3.1-schema-2022-10-07.json` is the OpenAPI Initiative's schema
//! for OpenAPI 3.1 documents, https://spec.openapis.org/oas/3.1/schema/2022-10-07,
//! vendored so the test needs no network.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn read_json(path: &Path) -> Value {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn errors(schema: &Value, instance: &Value) -> Vec<String> {
    let validator = jsonschema::validator_for(schema).expect("schema compiles");
    validator
        .iter_errors(instance)
        .map(|e| format!("{} at {}", e, e.instance_path()))
        .take(20)
        .collect()
}

const MANIFEST: &str = r#"{
  "format": 2, "version": "v2026.10.18", "generated_at": "2026-10-18T14:06:54Z",
  "base": "v/v2026.10.18/", "volumes": 4, "entries": 100, "idx": 1,
  "reporters": {"a2d": ["31", "32"], "a3d": ["138", "138-2"], "ny-slip-op": ["2019"]},
  "parts": {"a3d": {"138": [
    {"volume": "138", "first_page": 8, "last_page": 1221},
    {"volume": "138-2", "first_page": 2, "last_page": 1263}]}}
}"#;

fn export_reporters(dir: &Path) -> Value {
    let manifest = dir.join("manifest.json");
    std::fs::write(&manifest, MANIFEST).unwrap();
    let out = dir.join("public/reporters.json");
    let status = Command::new(env!("CARGO_BIN_EXE_stare-site"))
        .arg("export-reporters")
        .arg("--manifest")
        .arg(&manifest)
        .arg(&out)
        .status()
        .unwrap();
    assert!(status.success());
    read_json(&out)
}

#[test]
fn reporters_json_matches_its_schema() {
    let schema: Value = serde_json::from_str(stare::schemas::REPORTERS_V1).unwrap();
    assert!(
        jsonschema::meta::is_valid(&schema),
        "not a valid JSON Schema"
    );
    let dir = tempfile::tempdir().unwrap();
    let map = export_reporters(dir.path());
    assert_eq!(errors(&schema, &map), Vec::<String>::new());

    assert_eq!(map["$schema"], stare::schemas::REPORTERS_V1_ID);
    assert_eq!(map["abbreviations"]["A.2d"], json!(["a2d"]));
    assert_eq!(
        map["reporters"]["a2d"]["volumes"],
        json!({"count": 2, "first": "31", "last": "32"})
    );
    assert_eq!(map["reporters"]["a3d"]["volumes"]["split"], json!(["138"]));
    assert_eq!(map["reporters"]["us"]["volumes"], Value::Null);
    assert_eq!(
        map["generated_from"]["index_build"]["version"],
        json!("v2026.10.18")
    );
    let bundle = stare::data::file_name(stare::data::embedded());
    assert_eq!(map["generated_from"]["citare_data"], json!(bundle));
}

#[test]
fn the_schema_rejects_what_it_should() {
    let schema: Value = serde_json::from_str(stare::schemas::REPORTERS_V1).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let good = export_reporters(dir.path());
    for (pointer, bad) in [
        ("/format", json!(2)),
        ("/abbreviations/A.2d", json!([])),
        ("/abbreviations/A.2d", json!(["A2D"])),
        ("/reporters/a2d/volumes/count", json!(0)),
        ("/urls/index", json!("https://example.com/{slug}")),
    ] {
        let mut map = good.clone();
        *map.pointer_mut(pointer).unwrap() = bad.clone();
        assert!(
            !errors(&schema, &map).is_empty(),
            "{pointer} = {bad} passed"
        );
    }
}

fn openapi() -> Value {
    read_json(&repo().join("web/public/openapi.json"))
}

#[test]
fn openapi_json_is_valid_openapi_3_1() {
    let schema = read_json(
        &Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/openapi-3.1-schema-2022-10-07.json"),
    );
    let doc = openapi();
    assert_eq!(errors(&schema, &doc), Vec::<String>::new());
    assert!(doc["openapi"].as_str().unwrap().starts_with("3.1."));

    // Every schema in it is a valid JSON Schema.
    for (name, s) in doc["components"]["schemas"].as_object().unwrap() {
        let mut s = s.clone();
        s["$schema"] = json!("https://json-schema.org/draft/2020-12/schema");
        assert!(jsonschema::meta::is_valid(&s), "components.schemas.{name}");
    }
}

/// Collects every `$ref` in a document.
fn refs<'a>(value: &'a Value, out: &mut Vec<&'a str>) {
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                match (k.as_str(), v) {
                    ("$ref", Value::String(r)) => out.push(r),
                    _ => refs(v, out),
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|v| refs(v, out)),
        _ => {}
    }
}

#[test]
fn openapi_json_describes_static_gets_only() {
    let doc = openapi();
    let hosts = [
        "https://stare.pub",
        "https://idx.stare.pub",
        "https://data.stare.pub",
    ];
    let mut ids = Vec::new();
    for (path, item) in doc["paths"].as_object().unwrap() {
        for (key, op) in item.as_object().unwrap() {
            match key.as_str() {
                "servers" => {
                    for s in op.as_array().unwrap() {
                        let url = s["url"].as_str().unwrap();
                        assert!(hosts.contains(&url), "{path}: server {url}");
                    }
                }
                "parameters" | "summary" | "description" => {}
                "get" => {
                    ids.push(op["operationId"].as_str().unwrap().to_string());
                    for p in op["parameters"].as_array().into_iter().flatten() {
                        assert_ne!(p["in"], "query", "{path}: a query parameter");
                    }
                    assert!(op.get("requestBody").is_none(), "{path}: a request body");
                    let ok = &op["responses"]["200"];
                    let content = ok["content"].as_object().unwrap();
                    assert_eq!(content.len(), 1, "{path}: one content type");
                    if !path.ends_with(".zip") {
                        assert!(
                            ok["headers"]["Cache-Control"].is_object(),
                            "{path}: no Cache-Control"
                        );
                    }
                }
                other => panic!("{path}: {other} (static files are GET only)"),
            }
        }
    }
    let mut unique = ids.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), ids.len(), "operationIds repeat");

    // Local refs resolve; external ones name a schema this repo publishes.
    let mut all = Vec::new();
    refs(&doc, &mut all);
    for r in all {
        if let Some(pointer) = r.strip_prefix('#') {
            assert!(doc.pointer(pointer).is_some(), "{r} doesn't resolve");
        } else {
            let file = r
                .strip_prefix("https://stare.pub/schemas/")
                .unwrap_or_else(|| panic!("{r}: not a stare.pub schema"));
            let schema = read_json(&repo().join("schemas").join(file));
            assert_eq!(schema["$id"], json!(r));
        }
    }
}

#[test]
fn openapi_json_lists_every_published_schema() {
    let doc = openapi();
    let listed = &doc["paths"]["/schemas/{schema}"]["parameters"][0]["schema"]["enum"];
    let mut listed: Vec<&str> = listed
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    listed.sort();
    let mut files: Vec<String> = std::fs::read_dir(repo().join("schemas"))
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .filter(|n| n.ends_with(".schema.json"))
        .collect();
    files.sort();
    assert_eq!(listed, files);
}
