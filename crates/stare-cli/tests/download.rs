//! Integration tests for `stare_cli::download`. Uses `mockito` to spin up local HTTP
//! servers standing in for the index (idx.stare.pub) and data (static.case.law)
//! sources, so nothing here touches the real network.

use stare_cli::download::{run, DownloadConfig, Event, FileStatus};
use std::time::Duration;

fn manifest_json() -> String {
    r#"{"a2d": [31, 32], "us": [3]}"#.to_string()
}

#[test]
fn downloads_missing_files_into_cache_dirs() {
    let mut index_server = mockito::Server::new();
    let mut data_server = mockito::Server::new();

    let _manifest_mock = index_server
        .mock("GET", "/manifest.json")
        .with_status(200)
        .with_body(manifest_json())
        .create();

    let bin_bytes = vec![0u8; 64];
    let _bin_head = index_server
        .mock("HEAD", "/a2d/31.bin")
        .with_status(200)
        .with_header("content-length", &bin_bytes.len().to_string())
        .create();
    let _bin_get = index_server
        .mock("GET", "/a2d/31.bin")
        .with_status(200)
        .with_body(bin_bytes.clone())
        .create();

    let zip_bytes = vec![1u8; 128];
    let _zip_head = data_server
        .mock("HEAD", "/a2d/31.zip")
        .with_status(200)
        .with_header("content-length", &zip_bytes.len().to_string())
        .create();
    let _zip_get = data_server
        .mock("GET", "/a2d/31.zip")
        .with_status(200)
        .with_body(zip_bytes.clone())
        .create();

    let cache = tempfile::tempdir().unwrap();
    let cfg = DownloadConfig {
        index_source: &index_server.url(),
        data_source: &data_server.url(),
        cache_dir: cache.path(),
        reporters: &["a2d".to_string()],
        data_rate_limit: Duration::ZERO,
    };

    // Only volume 31 is mocked; volume 32 will 404 on HEAD and record an error
    // instead of aborting the whole run.
    let mut events = Vec::new();
    let report = run(&cfg, |e| events.push(e)).expect("download run should not hard-fail");

    let bin_path = cache.path().join("bins/a2d/31.bin");
    let zip_path = cache.path().join("zips/a2d/31.zip");
    assert!(bin_path.exists(), "bin file should be written to cache");
    assert!(zip_path.exists(), "zip file should be written to cache");
    assert_eq!(std::fs::read(&bin_path).unwrap(), bin_bytes);
    assert_eq!(std::fs::read(&zip_path).unwrap(), zip_bytes);

    assert_eq!(report.bins_downloaded, 1);
    assert_eq!(report.zips_downloaded, 1);
    assert_eq!(
        report.bytes_downloaded,
        (bin_bytes.len() + zip_bytes.len()) as u64
    );
    // volume 32 has no mocks set up, so both its fetches should have failed
    assert!(report.errors.iter().any(|e| e.contains("32")));

    assert!(events.iter().any(|e| matches!(e, Event::ReporterStart { reporter, volumes } if reporter == "a2d" && *volumes == 2)));
    assert!(events
        .iter()
        .any(|e| matches!(e, Event::ReporterDone { reporter } if reporter == "a2d")));
}

#[test]
fn skips_files_already_cached_at_matching_size() {
    let mut index_server = mockito::Server::new();
    let mut data_server = mockito::Server::new();

    let _manifest_mock = index_server
        .mock("GET", "/manifest.json")
        .with_status(200)
        .with_body(r#"{"us": [3]}"#)
        .create();

    let bin_bytes = vec![9u8; 32];
    let zip_bytes = vec![7u8; 256];

    let cache = tempfile::tempdir().unwrap();
    let bin_path = cache.path().join("bins/us/3.bin");
    let zip_path = cache.path().join("zips/us/3.zip");
    std::fs::create_dir_all(bin_path.parent().unwrap()).unwrap();
    std::fs::create_dir_all(zip_path.parent().unwrap()).unwrap();
    std::fs::write(&bin_path, &bin_bytes).unwrap();
    std::fs::write(&zip_path, &zip_bytes).unwrap();

    // HEAD mocks report the same size as what's on disk; GET mocks are never
    // registered, so a fetch attempt would 501/panic the mock server if hit.
    let _bin_head = index_server
        .mock("HEAD", "/us/3.bin")
        .with_status(200)
        .with_header("content-length", &bin_bytes.len().to_string())
        .create();
    let _zip_head = data_server
        .mock("HEAD", "/us/3.zip")
        .with_status(200)
        .with_header("content-length", &zip_bytes.len().to_string())
        .create();
    // Explicitly assert these are never called.
    let bin_get_guard = index_server
        .mock("GET", "/us/3.bin")
        .with_status(200)
        .expect(0)
        .create();
    let zip_get_guard = data_server
        .mock("GET", "/us/3.zip")
        .with_status(200)
        .expect(0)
        .create();

    let cfg = DownloadConfig {
        index_source: &index_server.url(),
        data_source: &data_server.url(),
        cache_dir: cache.path(),
        reporters: &["us".to_string()],
        data_rate_limit: Duration::ZERO,
    };

    let report = run(&cfg, |_| {}).unwrap();

    assert_eq!(report.bins_cached, 1);
    assert_eq!(report.zips_cached, 1);
    assert_eq!(report.bins_downloaded, 0);
    assert_eq!(report.zips_downloaded, 0);
    assert!(report.errors.is_empty());
    bin_get_guard.assert();
    zip_get_guard.assert();
}

#[test]
fn redownloads_when_cached_size_differs_from_remote() {
    let mut index_server = mockito::Server::new();
    let mut data_server = mockito::Server::new();

    let _manifest_mock = index_server
        .mock("GET", "/manifest.json")
        .with_status(200)
        .with_body(r#"{"us": [3]}"#)
        .create();

    let cache = tempfile::tempdir().unwrap();
    let bin_path = cache.path().join("bins/us/3.bin");
    std::fs::create_dir_all(bin_path.parent().unwrap()).unwrap();
    std::fs::write(&bin_path, vec![0u8; 8]).unwrap(); // stale, wrong size

    let fresh_bin = vec![5u8; 40];
    let _bin_head = index_server
        .mock("HEAD", "/us/3.bin")
        .with_status(200)
        .with_header("content-length", &fresh_bin.len().to_string())
        .create();
    let _bin_get = index_server
        .mock("GET", "/us/3.bin")
        .with_status(200)
        .with_body(fresh_bin.clone())
        .create();

    let zip_bytes = vec![2u8; 16];
    let _zip_head = data_server
        .mock("HEAD", "/us/3.zip")
        .with_status(200)
        .with_header("content-length", &zip_bytes.len().to_string())
        .create();
    let _zip_get = data_server
        .mock("GET", "/us/3.zip")
        .with_status(200)
        .with_body(zip_bytes.clone())
        .create();

    let cfg = DownloadConfig {
        index_source: &index_server.url(),
        data_source: &data_server.url(),
        cache_dir: cache.path(),
        reporters: &["us".to_string()],
        data_rate_limit: Duration::ZERO,
    };

    let report = run(&cfg, |_| {}).unwrap();

    assert_eq!(
        report.bins_downloaded, 1,
        "size mismatch should trigger a re-download"
    );
    assert_eq!(std::fs::read(&bin_path).unwrap(), fresh_bin);
}

#[test]
fn reports_missing_reporter_without_aborting() {
    let mut index_server = mockito::Server::new();
    let data_server = mockito::Server::new();

    let _manifest_mock = index_server
        .mock("GET", "/manifest.json")
        .with_status(200)
        .with_body(r#"{"a2d": [31]}"#)
        .create();

    let cache = tempfile::tempdir().unwrap();
    let cfg = DownloadConfig {
        index_source: &index_server.url(),
        data_source: &data_server.url(),
        cache_dir: cache.path(),
        reporters: &["not-a-real-reporter".to_string()],
        data_rate_limit: Duration::ZERO,
    };

    let mut events = Vec::new();
    let report = run(&cfg, |e| events.push(e)).unwrap();

    assert_eq!(report.volumes_seen, 0);
    assert!(report
        .errors
        .iter()
        .any(|e| e.contains("not-a-real-reporter")));
    assert!(matches!(
        &events[0],
        Event::ReporterMissing { reporter } if reporter == "not-a-real-reporter"
    ));
}

#[test]
fn reporter_slugs_are_case_insensitive() {
    let mut index_server = mockito::Server::new();
    let mut data_server = mockito::Server::new();

    let _manifest_mock = index_server
        .mock("GET", "/manifest.json")
        .with_status(200)
        .with_body(r#"{"a2d": [31]}"#)
        .create();

    let bin_bytes = vec![3u8; 8];
    index_server
        .mock("HEAD", "/a2d/31.bin")
        .with_status(200)
        .with_header("content-length", &bin_bytes.len().to_string())
        .create();
    index_server
        .mock("GET", "/a2d/31.bin")
        .with_status(200)
        .with_body(bin_bytes)
        .create();

    let zip_bytes = vec![4u8; 8];
    data_server
        .mock("HEAD", "/a2d/31.zip")
        .with_status(200)
        .with_header("content-length", &zip_bytes.len().to_string())
        .create();
    data_server
        .mock("GET", "/a2d/31.zip")
        .with_status(200)
        .with_body(zip_bytes)
        .create();

    let cache = tempfile::tempdir().unwrap();
    let cfg = DownloadConfig {
        index_source: &index_server.url(),
        data_source: &data_server.url(),
        cache_dir: cache.path(),
        reporters: &["A2D".to_string()],
        data_rate_limit: Duration::ZERO,
    };

    let report = run(&cfg, |_| {}).unwrap();
    assert_eq!(report.bins_downloaded, 1);
    assert_eq!(report.zips_downloaded, 1);
    assert!(!FileStatus::Cached.is_error());
}

#[test]
fn trusts_cached_file_when_verification_head_fails() {
    let mut index_server = mockito::Server::new();
    let mut data_server = mockito::Server::new();

    let _manifest_mock = index_server
        .mock("GET", "/manifest.json")
        .with_status(200)
        .with_body(r#"{"us": [3]}"#)
        .create();

    let bin_bytes = vec![9u8; 32];
    let zip_bytes = vec![7u8; 256];

    let cache = tempfile::tempdir().unwrap();
    let bin_path = cache.path().join("bins/us/3.bin");
    let zip_path = cache.path().join("zips/us/3.zip");
    std::fs::create_dir_all(bin_path.parent().unwrap()).unwrap();
    std::fs::create_dir_all(zip_path.parent().unwrap()).unwrap();
    std::fs::write(&bin_path, &bin_bytes).unwrap();
    std::fs::write(&zip_path, &zip_bytes).unwrap();

    // Both HEAD checks return 500 (a flaky server / connection blip). Since a
    // same-named file already exists locally, that copy should be trusted rather
    // than reported as an error, and the GET mocks (registered but never expected)
    // should never be hit.
    let _bin_head = index_server
        .mock("HEAD", "/us/3.bin")
        .with_status(500)
        .create();
    let _zip_head = data_server
        .mock("HEAD", "/us/3.zip")
        .with_status(500)
        .create();
    let bin_get_guard = index_server
        .mock("GET", "/us/3.bin")
        .with_status(200)
        .expect(0)
        .create();
    let zip_get_guard = data_server
        .mock("GET", "/us/3.zip")
        .with_status(200)
        .expect(0)
        .create();

    let cfg = DownloadConfig {
        index_source: &index_server.url(),
        data_source: &data_server.url(),
        cache_dir: cache.path(),
        reporters: &["us".to_string()],
        data_rate_limit: Duration::ZERO,
    };

    let mut events = Vec::new();
    let report = run(&cfg, |e| events.push(e)).unwrap();

    assert_eq!(
        report.bins_cached, 1,
        "a failed HEAD with a cached file should count as cached"
    );
    assert_eq!(report.zips_cached, 1);
    assert!(
        report.errors.is_empty(),
        "a failed verification HEAD on a cached file is not an error: {:?}",
        report.errors
    );
    assert!(events.iter().any(|e| matches!(
        e,
        Event::Volume { bin, zip, .. } if *bin == FileStatus::Cached && *zip == FileStatus::Cached
    )));
    bin_get_guard.assert();
    zip_get_guard.assert();
}

#[test]
fn head_failure_without_cached_file_is_an_error() {
    let mut index_server = mockito::Server::new();
    let data_server = mockito::Server::new();

    let _manifest_mock = index_server
        .mock("GET", "/manifest.json")
        .with_status(200)
        .with_body(r#"{"us": [3]}"#)
        .create();

    // Nothing cached locally, and no HEAD mock registered at all (mockito 404s by
    // default for unmocked paths), so both the bin and zip fetch should fail and
    // be recorded as errors rather than panicking or silently succeeding.
    let cache = tempfile::tempdir().unwrap();
    let cfg = DownloadConfig {
        index_source: &index_server.url(),
        data_source: &data_server.url(),
        cache_dir: cache.path(),
        reporters: &["us".to_string()],
        data_rate_limit: Duration::ZERO,
    };

    let report = run(&cfg, |_| {}).unwrap();

    assert_eq!(report.bins_cached, 0);
    assert_eq!(report.bins_downloaded, 0);
    assert!(!report.errors.is_empty());
    assert!(!cache.path().join("bins/us/3.bin").exists());
}
