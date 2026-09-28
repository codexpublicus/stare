/// `stare download` — fetch the citation index (.bin) and case data (.zip) for one or
/// more reporters into the local cache, so later `resolve`/`list` calls work offline.
///
/// Design notes (see docs/plans/extraction-plan.md for the index/data layout):
/// - Files land in the same cache directories `resolve`/`list` already read from
///   (`<cache>/bins/<reporter>/<vol>.bin`, `<cache>/zips/<reporter>/<vol>.zip`), so a
///   download followed by `stare --index <cache>/bins --data <cache>/zips resolve ...`
///   (or just letting the normal cache lookup do its job) works without a network call.
/// - The list of volumes per reporter comes from `manifest.json` at the root of the
///   index source (written by `stare-admin build-manifest`). The manifest is always
///   fetched fresh, not cached, since it grows as the index is built out.
/// - A file already on disk is skipped when its size matches the remote size (via a
///   HEAD request's Content-Length). No checksum is published for .bin/.zip files
///   (only .tar.sha256 exists, and tars aren't part of this command), so size is the
///   best available verification. A size mismatch triggers a re-download.
/// - If the HEAD request itself fails (network error or non-2xx) and a local copy
///   already exists, that copy is trusted as-is and a warning is printed, rather than
///   treating a flaky connection as a reason to error out on an already-downloaded
///   reporter. The error only propagates when there's no local file to fall back on.
/// - Files are written atomically (temp file + rename via `stare::config::atomic_write`)
///   so a killed process or a concurrent reader never sees a partial file.
/// - Requests to the data source (static.case.law) are rate-limited per AGENTS.md
///   (max 1-2 req/sec). The index source is our own R2 bucket and isn't rate-limited.
use anyhow::{bail, Context, Result};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const USER_AGENT: &str = "stare/0.1.0 (case law tool; github.com/codexpublicus/stare)";

/// Conservative default: comfortably under the 1-2 req/sec ceiling in AGENTS.md.
pub const DEFAULT_DATA_RATE_LIMIT: Duration = Duration::from_millis(700);

/// What happened to a single file during a download pass.
#[derive(Debug, Clone, PartialEq)]
pub enum FileStatus {
    /// Already present locally with a size matching the remote.
    Cached,
    /// Fetched from the source; carries the byte count written.
    Downloaded(u64),
    /// Fetch failed; carries a human-readable reason.
    Error(String),
}

impl FileStatus {
    pub fn is_error(&self) -> bool {
        matches!(self, FileStatus::Error(_))
    }
}

/// Progress notifications emitted while downloading. Consumers (the CLI) render these;
/// tests can collect them into a Vec to assert on behavior.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// A requested reporter has no volumes in the manifest.
    ReporterMissing { reporter: String },
    /// Starting work on a reporter with the given volume count.
    ReporterStart { reporter: String, volumes: usize },
    /// One volume's bin + zip fetch finished (successfully or not).
    Volume {
        reporter: String,
        volume: u32,
        index: usize,
        total: usize,
        bin: FileStatus,
        zip: FileStatus,
    },
    /// Finished a reporter.
    ReporterDone { reporter: String },
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Report {
    pub volumes_seen: usize,
    pub bins_downloaded: usize,
    pub bins_cached: usize,
    pub zips_downloaded: usize,
    pub zips_cached: usize,
    pub bytes_downloaded: u64,
    pub errors: Vec<String>,
}

pub struct DownloadConfig<'a> {
    pub index_source: &'a str,
    pub data_source: &'a str,
    pub cache_dir: &'a Path,
    pub reporters: &'a [String],
    /// Minimum interval between requests to the data source. Tests pass `Duration::ZERO`.
    pub data_rate_limit: Duration,
}

/// Rate-limits calls to `wait()` to at most one per `min_interval`.
struct RateLimiter {
    min_interval: Duration,
    last: Option<Instant>,
}

impl RateLimiter {
    fn new(min_interval: Duration) -> Self {
        RateLimiter {
            min_interval,
            last: None,
        }
    }

    fn wait(&mut self) {
        if self.min_interval.is_zero() {
            return;
        }
        if let Some(last) = self.last {
            let elapsed = last.elapsed();
            if elapsed < self.min_interval {
                std::thread::sleep(self.min_interval - elapsed);
            }
        }
        self.last = Some(Instant::now());
    }
}

/// Fetch and parse `manifest.json` from the root of the index source.
/// Format: `{"<reporter-slug>": [<volume>, ...], ...}` (see stare-admin's build-manifest).
fn fetch_manifest(
    client: &reqwest::blocking::Client,
    index_source: &str,
) -> Result<BTreeMap<String, Vec<u32>>> {
    let bytes = if stare_cli_is_url(index_source) {
        let url = format!("{}/manifest.json", index_source);
        let resp = client
            .get(&url)
            .send()
            .with_context(|| format!("failed to fetch {}", url))?;
        if !resp.status().is_success() {
            bail!("HTTP {} fetching {}", resp.status(), url);
        }
        resp.bytes()
            .with_context(|| format!("failed to read body of {}", url))?
            .to_vec()
    } else {
        let path = Path::new(index_source).join("manifest.json");
        std::fs::read(&path).with_context(|| format!("manifest not found: {}", path.display()))?
    };
    serde_json::from_slice(&bytes).context("failed to parse manifest.json")
}

fn stare_cli_is_url(s: &str) -> bool {
    crate::is_url(s)
}

/// Fetch one file (bin or zip) into `cache_subdir/key`, skipping it if a same-size
/// copy already exists. `rate_limiter` is `Some` only for data-source (static.case.law)
/// requests, per AGENTS.md.
fn fetch_and_cache(
    client: &reqwest::blocking::Client,
    source: &str,
    key: &str,
    cache_subdir: &Path,
    mut rate_limiter: Option<&mut RateLimiter>,
) -> Result<FileStatus> {
    let local_path = cache_subdir.join(key);

    if stare_cli_is_url(source) {
        let url = format!("{}/{}", source, key);

        if let Some(limiter) = rate_limiter.as_mut() {
            limiter.wait();
        }
        // A failed or non-2xx HEAD is only fatal when there's nothing local to fall
        // back on. If the file is already cached, a flaky connection or a hiccup on
        // the server shouldn't turn a re-run over an already-downloaded reporter into
        // a wall of errors: trust the cached copy and warn instead.
        let expected_len = match client.head(&url).send() {
            Ok(resp) if resp.status().is_success() => resp
                .headers()
                .get(reqwest::header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok()),
            Ok(resp) => {
                if local_path.exists() {
                    eprintln!(
                        "warning: HTTP {} checking {}, trusting cached file",
                        resp.status(),
                        url
                    );
                    return Ok(FileStatus::Cached);
                }
                bail!("HTTP {} checking {}", resp.status(), url);
            }
            Err(e) => {
                if local_path.exists() {
                    eprintln!(
                        "warning: failed to verify {} ({}), trusting cached file",
                        url, e
                    );
                    return Ok(FileStatus::Cached);
                }
                return Err(e).with_context(|| format!("HEAD request failed for {}", url));
            }
        };

        if local_path.exists() {
            let local_len = std::fs::metadata(&local_path)?.len();
            match expected_len {
                Some(expected) if expected == local_len => return Ok(FileStatus::Cached),
                None => return Ok(FileStatus::Cached), // no size to verify against; trust cache
                Some(_) => {} // size mismatch: fall through and re-download
            }
        }

        if let Some(limiter) = rate_limiter.as_mut() {
            limiter.wait();
        }
        let resp = client
            .get(&url)
            .send()
            .with_context(|| format!("failed to fetch {}", url))?;
        if !resp.status().is_success() {
            bail!("HTTP {} fetching {}", resp.status(), url);
        }
        let bytes = resp
            .bytes()
            .with_context(|| format!("failed to read body of {}", url))?;
        stare::config::atomic_write(&local_path, &bytes)?;
        Ok(FileStatus::Downloaded(bytes.len() as u64))
    } else {
        let src_path = Path::new(source).join(key);
        if local_path.exists() {
            if let (Ok(local_meta), Ok(src_meta)) =
                (std::fs::metadata(&local_path), std::fs::metadata(&src_path))
            {
                if local_meta.len() == src_meta.len() {
                    return Ok(FileStatus::Cached);
                }
            }
        }
        let data = std::fs::read(&src_path)
            .with_context(|| format!("source file not found: {}", src_path.display()))?;
        stare::config::atomic_write(&local_path, &data)?;
        Ok(FileStatus::Downloaded(data.len() as u64))
    }
}

/// Run a download pass: for each requested reporter, look up its volumes in the
/// manifest, then fetch the .bin (index) and .zip (data) for each, skipping files
/// already cached at the correct size. Errors on individual files are recorded and
/// don't stop the rest of the run.
pub fn run(cfg: &DownloadConfig, mut on_event: impl FnMut(Event)) -> Result<Report> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .context("failed to build HTTP client")?;

    let manifest = fetch_manifest(&client, cfg.index_source)?;
    let mut report = Report::default();
    let mut data_limiter = RateLimiter::new(cfg.data_rate_limit);

    let bins_dir: PathBuf = cfg.cache_dir.join("bins");
    let zips_dir: PathBuf = cfg.cache_dir.join("zips");

    for reporter in cfg.reporters {
        let slug = reporter.to_lowercase();
        let volumes = manifest.get(&slug).cloned().unwrap_or_default();

        if volumes.is_empty() {
            report.errors.push(format!(
                "no volumes found for reporter '{}' in manifest",
                slug
            ));
            on_event(Event::ReporterMissing {
                reporter: slug.clone(),
            });
            continue;
        }

        on_event(Event::ReporterStart {
            reporter: slug.clone(),
            volumes: volumes.len(),
        });

        let total = volumes.len();
        for (i, volume) in volumes.iter().enumerate() {
            report.volumes_seen += 1;
            let bin_key = format!("{}/{}.bin", slug, volume);
            let zip_key = format!("{}/{}.zip", slug, volume);

            let bin_status =
                match fetch_and_cache(&client, cfg.index_source, &bin_key, &bins_dir, None) {
                    Ok(status) => status,
                    Err(e) => FileStatus::Error(e.to_string()),
                };
            let zip_status = match fetch_and_cache(
                &client,
                cfg.data_source,
                &zip_key,
                &zips_dir,
                Some(&mut data_limiter),
            ) {
                Ok(status) => status,
                Err(e) => FileStatus::Error(e.to_string()),
            };

            match &bin_status {
                FileStatus::Cached => report.bins_cached += 1,
                FileStatus::Downloaded(n) => {
                    report.bins_downloaded += 1;
                    report.bytes_downloaded += n;
                }
                FileStatus::Error(msg) => report.errors.push(format!("{}: {}", bin_key, msg)),
            }
            match &zip_status {
                FileStatus::Cached => report.zips_cached += 1,
                FileStatus::Downloaded(n) => {
                    report.zips_downloaded += 1;
                    report.bytes_downloaded += n;
                }
                FileStatus::Error(msg) => report.errors.push(format!("{}: {}", zip_key, msg)),
            }

            on_event(Event::Volume {
                reporter: slug.clone(),
                volume: *volume,
                index: i + 1,
                total,
                bin: bin_status,
                zip: zip_status,
            });
        }

        on_event(Event::ReporterDone { reporter: slug });
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_limiter_enforces_minimum_interval() {
        let mut limiter = RateLimiter::new(Duration::from_millis(50));
        let start = Instant::now();
        limiter.wait(); // first call never waits
        limiter.wait(); // second call should wait ~50ms
        assert!(start.elapsed() >= Duration::from_millis(50));
    }

    #[test]
    fn rate_limiter_zero_interval_never_sleeps() {
        let mut limiter = RateLimiter::new(Duration::ZERO);
        let start = Instant::now();
        limiter.wait();
        limiter.wait();
        limiter.wait();
        assert!(start.elapsed() < Duration::from_millis(20));
    }

    #[test]
    fn is_url_detects_schemes() {
        assert!(stare_cli_is_url("https://idx.stare.pub"));
        assert!(stare_cli_is_url("http://localhost:1234"));
        assert!(stare_cli_is_url("ipfs://bafy..."));
        assert!(!stare_cli_is_url("/mnt/mega/codex-publicus"));
        assert!(!stare_cli_is_url("relative/path"));
    }
}
