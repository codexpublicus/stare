//! Which hosts get throttled, and how a 429 or 503 from any host is retried.
//!
//! The 1-2 requests a second in AGENTS.md is a courtesy to static.case.law, Harvard's
//! academic server. Our own hosts (data.stare.pub and idx.stare.pub, R2 behind
//! Cloudflare's cache) don't need it, so a source on one of them gets no minimum
//! interval. Any other host, static.case.law included, keeps the configured one. A
//! host that answers 429 Too Many Requests or 503 Service Unavailable is waited on and
//! retried, whoever runs it: a 429 always, a 503 only when it sends a Retry-After,
//! since a 503 without one is as likely a broken server as a busy one.
use std::time::Duration;

/// Domains we run. A source on one of them, or on a subdomain of one, isn't throttled.
pub const OWN_DOMAINS: &[&str] = &["stare.pub"];

/// How many times a request that drew a 429, or a 503 with a Retry-After, is sent again before its response
/// is returned as it is.
pub const MAX_RETRIES: u32 = 3;

/// The wait after a 429 without a Retry-After in seconds.
pub const DEFAULT_RETRY_WAIT: Duration = Duration::from_secs(2);

/// The longest a Retry-After is honoured for; a longer one is cut to this.
pub const MAX_RETRY_WAIT: Duration = Duration::from_secs(60);

/// The host of a URL source, lowercased; None for a path or an unparseable URL.
fn host_of(source: &str) -> Option<String> {
    reqwest::Url::parse(source)
        .ok()?
        .host_str()
        .map(|h| h.trim_end_matches('.').to_ascii_lowercase())
}

/// Whether `source` is a URL on one of [`OWN_DOMAINS`] or a subdomain of one.
pub fn is_own_host(source: &str) -> bool {
    host_of(source).is_some_and(|host| {
        OWN_DOMAINS
            .iter()
            .any(|d| host == *d || host.ends_with(&format!(".{d}")))
    })
}

/// The minimum interval between requests to `source`: none for our own hosts,
/// `configured` for any other.
pub fn request_interval(source: &str, configured: Duration) -> Duration {
    if is_own_host(source) {
        Duration::ZERO
    } else {
        configured
    }
}

/// How long a Retry-After header asks for, in its delta-seconds form, capped at
/// [`MAX_RETRY_WAIT`]. The HTTP-date form, or no header, gets [`DEFAULT_RETRY_WAIT`].
pub fn retry_wait(retry_after: Option<&str>) -> Duration {
    retry_after
        .and_then(|v| v.trim().parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_RETRY_WAIT)
        .min(MAX_RETRY_WAIT)
}

/// Send the request `build` makes, and send it again after the wait the server asks
/// for while it answers 429, or 503 with a Retry-After, up to [`MAX_RETRIES`] times. The last response is
/// returned whatever its status; a transport error is returned at once.
pub fn send_with_retry(
    build: impl Fn() -> reqwest::blocking::RequestBuilder,
) -> reqwest::Result<reqwest::blocking::Response> {
    let mut attempt = 0;
    loop {
        let resp = build().send()?;
        let status = resp.status();
        let retry_after = resp
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok());
        let busy = status == reqwest::StatusCode::TOO_MANY_REQUESTS
            || (status == reqwest::StatusCode::SERVICE_UNAVAILABLE && retry_after.is_some());
        if !busy || attempt >= MAX_RETRIES {
            return Ok(resp);
        }
        let wait = retry_wait(retry_after);
        std::thread::sleep(wait);
        attempt += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn our_hosts_are_own_hosts() {
        assert!(is_own_host("https://data.stare.pub/cap"));
        assert!(is_own_host("https://idx.stare.pub"));
        assert!(is_own_host("https://stare.pub/"));
        assert!(is_own_host("https://DATA.Stare.Pub/cap"));
        assert!(is_own_host("https://data.stare.pub./cap"));
    }

    #[test]
    fn third_party_hosts_are_not_own_hosts() {
        assert!(!is_own_host("https://static.case.law"));
        assert!(!is_own_host("https://static.case.law/a2d/31.zip"));
        assert!(!is_own_host("http://127.0.0.1:1234"));
        // A lookalike that merely ends in the same letters isn't ours.
        assert!(!is_own_host("https://notstare.pub"));
        assert!(!is_own_host("https://stare.pub.example.com"));
        assert!(!is_own_host("https://example.com/stare.pub"));
    }

    #[test]
    fn paths_are_not_own_hosts() {
        assert!(!is_own_host("/mnt/mega/codex-publicus"));
        assert!(!is_own_host("relative/stare.pub"));
    }

    #[test]
    fn interval_is_dropped_only_for_our_hosts() {
        let limit = Duration::from_millis(700);
        assert_eq!(
            request_interval("https://data.stare.pub/cap", limit),
            Duration::ZERO
        );
        assert_eq!(request_interval("https://static.case.law", limit), limit);
        assert_eq!(request_interval("http://127.0.0.1:1234", limit), limit);
    }

    #[test]
    fn retry_after_seconds_are_honoured_and_capped() {
        assert_eq!(retry_wait(Some("0")), Duration::ZERO);
        assert_eq!(retry_wait(Some(" 5 ")), Duration::from_secs(5));
        assert_eq!(retry_wait(Some("3600")), MAX_RETRY_WAIT);
        assert_eq!(
            retry_wait(Some("Wed, 21 Oct 2026 07:28:00 GMT")),
            DEFAULT_RETRY_WAIT
        );
        assert_eq!(retry_wait(None), DEFAULT_RETRY_WAIT);
    }
}
