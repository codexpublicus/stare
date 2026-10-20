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
///   fetched fresh, since it changes when the index is rebuilt, and saved as
///   `<cache>/bins/manifest.json`.
/// - Index files are at their path under the manifest's `base` when it has one
///   (`v/v2026.10.03/a3d/138.bin`), on the source and in the cache alike, so files from
///   two index versions never mix and `<cache>/bins` reads like an index source.
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
/// - Requests to a third-party data source, such as static.case.law, are rate-limited
///   per AGENTS.md (max 1-2 req/sec). Our own hosts (data.stare.pub, idx.stare.pub,
///   R2 behind Cloudflare) aren't, and neither is the index source; see `crate::http`.
/// - A 429 or 503 from any host is waited on for its Retry-After and retried.
use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const USER_AGENT: &str = "stare/0.1.0 (case law tool; github.com/codexpublicus/stare)";

/// Conservative default: comfortably under the 1-2 req/sec ceiling in AGENTS.md. It
/// applies only to a data source that isn't one of our hosts (`crate::http`).
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
        /// The CAP volume folder, e.g. `31` or `138-2`.
        volume: String,
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
    /// Minimum interval between requests to a third-party data source; a data source
    /// on one of our hosts isn't throttled whatever this is. Tests pass `Duration::ZERO`.
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

/// Fetch and parse `manifest.json` from the root of the index source, in either the
/// legacy or the current format (see `stare::manifest`), with its bytes.
fn fetch_manifest(
    client: &reqwest::blocking::Client,
    index_source: &str,
) -> Result<(stare::manifest::Manifest, Vec<u8>)> {
    let bytes = if stare_cli_is_url(index_source) {
        let url = format!("{}/manifest.json", index_source);
        let resp = crate::http::send_with_retry(|| client.get(&url))
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
    let manifest =
        stare::manifest::Manifest::parse(&bytes).context("failed to parse manifest.json")?;
    Ok((manifest, bytes))
}

fn stare_cli_is_url(s: &str) -> bool {
    crate::is_url(s)
}

/// Fetch one file (bin or zip) into `cache_subdir/key`, skipping it if a same-size
/// copy already exists. `rate_limiter` is `Some` only for data-source requests; its
/// interval is zero when the data source is one of our hosts.
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
        let expected_len = match crate::http::send_with_retry(|| client.head(&url)) {
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
        let resp = crate::http::send_with_retry(|| client.get(&url))
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

/// Fetch a volume's unified index into the cache: part 0, then every later part its
/// `#parts` header names. Returns part 0's key, the worst status among the parts, and
/// the CAP folders its `cap` lines name (the volume itself, and any folded folder).
fn fetch_idx_volume(
    client: &reqwest::blocking::Client,
    source: &str,
    manifest: &stare::manifest::Manifest,
    slug: &str,
    volume: &str,
    bins_dir: &Path,
) -> (String, FileStatus, Vec<String>) {
    let key_of =
        |part: usize| stare::idx::path(slug, volume, part).map(|p| manifest.index_path(&p));
    let head_key = match key_of(0) {
        Ok(k) => k,
        Err(e) => {
            return (
                format!("{}/{}", slug, volume),
                FileStatus::Error(e.to_string()),
                vec![],
            )
        }
    };
    let mut status = match fetch_and_cache(client, source, &head_key, bins_dir, None) {
        Ok(s) => s,
        Err(e) => return (head_key, FileStatus::Error(e.to_string()), vec![]),
    };
    let read = |key: &str| -> anyhow::Result<stare::idx::VolumeIndex> {
        stare::idx::parse_bytes(&std::fs::read(bins_dir.join(key))?)
    };
    let mut parts = match read(&head_key) {
        Ok(idx) => vec![idx],
        Err(e) => return (head_key, FileStatus::Error(e.to_string()), vec![]),
    };
    for part in 1..=parts[0].parts.len() {
        let fetched = key_of(part).and_then(|key| {
            let s = fetch_and_cache(client, source, &key, bins_dir, None)?;
            Ok((s, read(&key)?))
        });
        match fetched {
            Ok((s, idx)) => {
                if let (FileStatus::Downloaded(a), FileStatus::Downloaded(b)) = (&status, &s) {
                    status = FileStatus::Downloaded(a + b);
                } else if matches!(status, FileStatus::Cached) {
                    status = s;
                }
                parts.push(idx);
            }
            Err(e) => status = FileStatus::Error(e.to_string()),
        }
    }
    let mut folders: Vec<String> = Vec::new();
    for entry in parts.iter().flat_map(|p| &p.entries) {
        if let Some((folder, _)) = entry.cap_case() {
            let folder = folder.unwrap_or(volume).to_string();
            if !folders.contains(&folder) {
                folders.push(folder);
            }
        }
    }
    (head_key, status, folders)
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

    let (manifest, manifest_bytes) = fetch_manifest(&client, cfg.index_source)?;
    let mut report = Report::default();
    let mut data_limiter = RateLimiter::new(crate::http::request_interval(
        cfg.data_source,
        cfg.data_rate_limit,
    ));

    let bins_dir: PathBuf = cfg.cache_dir.join("bins");
    let zips_dir: PathBuf = cfg.cache_dir.join("zips");
    stare::config::atomic_write(&bins_dir.join(crate::MANIFEST_CACHE_KEY), &manifest_bytes)?;

    for reporter in cfg.reporters {
        let slug = reporter.to_lowercase();
        // With the unified index, a volume CAP split over several folders is one
        // `.idx.gz` under the number as cited, and the folded folders have none.
        let volumes = if manifest.has_idx() {
            manifest.idx_volumes(&slug)
        } else {
            manifest.volumes(&slug).to_vec()
        };

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
            let (bin_key, bin_status, folders) = if manifest.has_idx() {
                fetch_idx_volume(
                    &client,
                    cfg.index_source,
                    &manifest,
                    &slug,
                    volume,
                    &bins_dir,
                )
            } else {
                let key = manifest.index_path(&format!("{}/{}.bin", slug, volume));
                let status = match fetch_and_cache(&client, cfg.index_source, &key, &bins_dir, None)
                {
                    Ok(status) => status,
                    Err(e) => FileStatus::Error(e.to_string()),
                };
                (key, status, vec![volume.clone()])
            };
            // The zips of the CAP folders the volume's index names; none for a volume
            // only CourtListener has, whose records `stare resolve` fetches one by one.
            let mut zip_status = FileStatus::Cached;
            for folder in &folders {
                let zip_key = format!("{}/{}.zip", slug, folder);
                let status = match fetch_and_cache(
                    &client,
                    cfg.data_source,
                    &zip_key,
                    &zips_dir,
                    Some(&mut data_limiter),
                ) {
                    Ok(status) => status,
                    Err(e) => FileStatus::Error(e.to_string()),
                };
                match &status {
                    FileStatus::Cached => report.zips_cached += 1,
                    FileStatus::Downloaded(n) => {
                        report.zips_downloaded += 1;
                        report.bytes_downloaded += n;
                    }
                    FileStatus::Error(msg) => report.errors.push(format!("{}: {}", zip_key, msg)),
                }
                if !matches!(zip_status, FileStatus::Error(_)) {
                    zip_status = status;
                }
            }

            match &bin_status {
                FileStatus::Cached => report.bins_cached += 1,
                FileStatus::Downloaded(n) => {
                    report.bins_downloaded += 1;
                    report.bytes_downloaded += n;
                }
                FileStatus::Error(msg) => report.errors.push(format!("{}: {}", bin_key, msg)),
            }

            on_event(Event::Volume {
                reporter: slug.clone(),
                volume: volume.clone(),
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
