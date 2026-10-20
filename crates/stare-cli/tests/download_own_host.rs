//! #76: a data source on one of our hosts (data.stare.pub) isn't throttled. The
//! requests for `http://data.stare.pub` go through an HTTP proxy that is a local mock
//! server, so nothing touches the real network. The proxy is set in the environment,
//! which is why this test has a file, and a process, of its own.

use stare_cli::download::{run, DownloadConfig};
use std::time::{Duration, Instant};

#[test]
fn own_data_host_is_not_throttled() {
    let mut index_server = mockito::Server::new();
    let mut data_proxy = mockito::Server::new();

    // The index server is reached directly; only data.stare.pub goes to the proxy.
    std::env::set_var("HTTP_PROXY", data_proxy.url());
    std::env::set_var("http_proxy", data_proxy.url());
    std::env::set_var("NO_PROXY", "127.0.0.1,localhost");
    std::env::set_var("no_proxy", "127.0.0.1,localhost");

    let _manifest = index_server
        .mock("GET", "/manifest.json")
        .with_status(200)
        .with_body(r#"{"a2d": [1, 2, 3]}"#)
        .create();
    let mut mocks = Vec::new();
    for v in 1..=3 {
        for method in ["HEAD", "GET"] {
            let bin = index_server
                .mock(method, format!("/a2d/{v}.bin").as_str())
                .with_status(200)
                .with_header("content-length", "4")
                .with_body("abcd")
                .create();
            let zip = data_proxy
                .mock(method, mockito::Matcher::Regex(format!(r"/a2d/{v}\.zip$")))
                .with_status(200)
                .with_header("content-length", "4")
                .with_body("abcd")
                .create();
            mocks.push(bin);
            mocks.push(zip);
        }
    }

    let cache = tempfile::tempdir().unwrap();
    let limit = Duration::from_secs(2);
    let cfg = DownloadConfig {
        index_source: &index_server.url(),
        data_source: "http://data.stare.pub/cap",
        cache_dir: cache.path(),
        reporters: &["a2d".to_string()],
        data_rate_limit: limit,
    };

    let start = Instant::now();
    let report = run(&cfg, |_| {}).unwrap();
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(report.zips_downloaded, 3);
    // Throttled, six requests would take five 2 s waits.
    assert!(start.elapsed() < limit, "took {:?}", start.elapsed());
}
