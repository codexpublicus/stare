//! Where a release's files come from: HTTPS release bases (data.stare.pub's, then
//! mirror.stare.pub's) or local directories laid out the same way (a disk, a share), tried
//! in order for each file.
//!
//! Nothing a source returns is trusted for what it is: a file with a pinned hash is checked
//! against it wherever it came from, and one that doesn't match is thrown away and the next
//! source tried, so an untrusted origin can at worst waste time. Files without a pinned hash
//! (`latest.json` and the signatures) are trusted only through the signature checks the
//! caller makes on them.
use super::hash::{hash_file, FileHash};
use super::release::{safe_rel, Pinned};
use anyhow::{anyhow, bail, Context, Result};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// A download bigger than this logs its progress.
const PROGRESS_OVER: u64 = 64 << 20;

pub struct Sources {
    bases: Vec<String>,
    client: reqwest::blocking::Client,
    log: Box<dyn Fn(&str)>,
}

fn is_loopback(url: &reqwest::Url) -> bool {
    matches!(
        url.host_str(),
        Some("localhost") | Some("127.0.0.1") | Some("[::1]") | Some("::1")
    )
}

/// A base as it is compared and joined: URLs with one trailing slash, paths as given.
fn normalize(base: &str) -> Result<String> {
    if base.starts_with("https://") || base.starts_with("http://") {
        let url = reqwest::Url::parse(base).with_context(|| format!("bad origin {base}"))?;
        if url.scheme() == "http" && !is_loopback(&url) {
            bail!("{base}: origins are HTTPS only (or plain http on this machine)");
        }
        Ok(format!("{}/", base.trim_end_matches('/')))
    } else if base.contains("://") {
        bail!("{base}: an origin is an https:// URL or a directory");
    } else {
        Ok(base.to_string())
    }
}

impl Sources {
    pub fn new(bases: &[String], log: Box<dyn Fn(&str)>) -> Result<Sources> {
        let client = reqwest::blocking::Client::builder()
            .user_agent(crate::download::USER_AGENT)
            .connect_timeout(Duration::from_secs(30))
            // A tier tar is hundreds of megabytes; no limit on the whole transfer.
            .timeout(None::<Duration>)
            .build()
            .context("failed to build HTTP client")?;
        let mut s = Sources {
            bases: Vec::new(),
            client,
            log,
        };
        for b in bases {
            s.add(b)?;
        }
        Ok(s)
    }

    /// Add a base after the ones already there, unless it is one of them.
    pub fn add(&mut self, base: &str) -> Result<()> {
        let b = normalize(base)?;
        if !self.bases.contains(&b) {
            self.bases.push(b);
        }
        Ok(())
    }

    pub fn bases(&self) -> &[String] {
        &self.bases
    }

    pub fn log(&self, msg: &str) {
        (self.log)(msg)
    }

    /// `rel` under the releases base, into `dest/rel`, from the first source that has it
    /// (and, when `want` is given, whose copy matches it). A file already at `dest/rel`
    /// that matches `want` is kept, so a run that stopped halfway carries on.
    pub fn get(&self, rel: &str, dest: &Path, want: Option<&Pinned>) -> Result<PathBuf> {
        let out = dest.join(safe_rel(rel)?);
        if let Some(w) = want {
            if out.is_file() && matches(&hash_file(&out)?, w) {
                return Ok(out);
            }
        }
        if self.bases.is_empty() {
            bail!("no origin to fetch {rel} from");
        }
        let mut errors = Vec::new();
        for (i, base) in self.bases.iter().enumerate() {
            match self.get_one(base, rel, &out, want) {
                Ok(()) => return Ok(out),
                Err(e) => {
                    let msg = format!("{e:#}");
                    if let Some(next) = self.bases.get(i + 1) {
                        self.log(&format!("{msg}; trying {next}"));
                    }
                    errors.push(msg);
                }
            }
        }
        Err(anyhow!(errors.join("; ")))
    }

    /// The whole file as bytes, through [`Sources::get`].
    pub fn get_bytes(&self, rel: &str, dest: &Path, want: Option<&Pinned>) -> Result<Vec<u8>> {
        let p = self.get(rel, dest, want)?;
        std::fs::read(&p).with_context(|| format!("can't read {}", p.display()))
    }

    fn get_one(&self, base: &str, rel: &str, out: &Path, want: Option<&Pinned>) -> Result<()> {
        let part = part_path(out);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("can't create {}", parent.display()))?;
        }
        let where_ = if base.contains("://") {
            let url = format!("{base}{rel}");
            self.download(&url, &part, want.map(|w| w.bytes))?;
            url
        } else {
            let src = Path::new(base).join(safe_rel(rel)?);
            if !src.is_file() {
                bail!("{} doesn't exist", src.display());
            }
            std::fs::copy(&src, &part).with_context(|| format!("can't copy {}", src.display()))?;
            src.display().to_string()
        };
        if let Some(w) = want {
            let got = hash_file(&part)?;
            if !matches(&got, w) {
                let _ = std::fs::remove_file(&part);
                bail!(
                    "{where_} doesn't match the release list ({} bytes, sha256 {}; wanted {} bytes, {})",
                    got.bytes,
                    got.sha256,
                    w.bytes,
                    w.sha256
                );
            }
        }
        std::fs::rename(&part, out)
            .with_context(|| format!("can't move {} into place", part.display()))?;
        Ok(())
    }

    /// Fetch `url` into `part`. With the size known, a shorter `part` from an earlier
    /// run is resumed with a Range request; a server that answers with the whole file
    /// instead starts it over.
    fn download(&self, url: &str, part: &Path, size: Option<u64>) -> Result<()> {
        let have = match (size, std::fs::metadata(part)) {
            (Some(size), Ok(m)) if m.len() > 0 && m.len() < size => m.len(),
            _ => 0,
        };
        let resp = crate::http::send_with_retry(|| {
            let req = self.client.get(url);
            if have > 0 {
                req.header(reqwest::header::RANGE, format!("bytes={have}-"))
            } else {
                req
            }
        })
        .with_context(|| format!("failed to fetch {url}"))?;
        let status = resp.status();
        let append = have > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT;
        if !status.is_success() {
            bail!("HTTP {status} fetching {url}");
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(append)
            .truncate(!append)
            .open(part)
            .with_context(|| format!("can't write {}", part.display()))?;
        let start = if append { have } else { 0 };
        if append {
            self.log(&format!("resuming {url} at byte {have}"));
        }
        let total = size.unwrap_or(0);
        let mut done = start;
        let mut next_report = total / 10;
        let mut body = resp;
        let mut buf = vec![0u8; 1 << 16];
        loop {
            let n = body
                .read(&mut buf)
                .with_context(|| format!("failed reading {url}"))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n])?;
            done += n as u64;
            if let Some(size) = size {
                if done > size {
                    bail!("{url} is longer than the release list says ({size} bytes)");
                }
            }
            if total > PROGRESS_OVER && done >= next_report && done < total {
                self.log(&format!(
                    "  {} of {} MiB ({}%)",
                    done >> 20,
                    total >> 20,
                    done * 100 / total
                ));
                next_report += total / 10;
            }
        }
        file.flush()?;
        Ok(())
    }
}

fn part_path(out: &Path) -> PathBuf {
    let mut name = out.file_name().unwrap_or_default().to_os_string();
    name.push(".part");
    out.with_file_name(name)
}

pub fn matches(got: &FileHash, want: &Pinned) -> bool {
    got.bytes == want.bytes && got.sha256 == want.sha256
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_are_https_or_local() {
        assert_eq!(
            normalize("https://data.stare.pub/releases").unwrap(),
            "https://data.stare.pub/releases/"
        );
        assert_eq!(
            normalize("https://data.stare.pub/releases/").unwrap(),
            "https://data.stare.pub/releases/"
        );
        assert!(normalize("http://example.com/releases/").is_err());
        assert!(normalize("http://127.0.0.1:8080/releases/").is_ok());
        assert!(normalize("ftp://example.com/").is_err());
        assert_eq!(
            normalize("/media/usb/releases").unwrap(),
            "/media/usb/releases"
        );
    }

    #[test]
    fn a_base_is_added_once() {
        let mut s = Sources::new(
            &["https://data.stare.pub/releases/".into()],
            Box::new(|_| {}),
        )
        .unwrap();
        s.add("https://data.stare.pub/releases").unwrap();
        s.add("https://mirror.stare.pub/releases/").unwrap();
        assert_eq!(s.bases().len(), 2);
    }
}
