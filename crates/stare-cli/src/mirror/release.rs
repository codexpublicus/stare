//! The release list (`stare-mirror-release` 1.x), its pointer (`latest.json`), the
//! per-component file manifests, and the release key that signs them.
//!
//! Only the fields `stare mirror` reads are declared; serde ignores the rest, so a 1.x
//! release that adds fields still reads.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Component as PathComponent, Path, PathBuf};

/// stare.pub's release key (minisign), as `mirror-kit/README.md` and
/// https://stare.pub/.well-known/stare-release-key.pub publish it.
pub const RELEASE_KEY: &str = "RWTR1z+lb96CaCdVkipBJO+O6KJyVIZkYQz2syiFItetSW+S74fWeKrF";
pub const RELEASE_KEY_ID: &str = "6882DE6FA53FD7D1";

/// The release bases a copy starts from before it has read a release list, in order.
pub const DEFAULT_ORIGINS: &[&str] = &[
    "https://data.stare.pub/releases/",
    "https://mirror.stare.pub/releases/",
];

pub const RELEASE_FORMAT: &str = "stare-mirror-release";
pub const LATEST_FORMAT: &str = "stare-mirror-latest";
pub const MIRROR_FORMAT: &str = "stare-mirror";

/// A minisign public key: its base64 form, which `release.json` names, and the parsed key.
pub struct Key {
    pub base64: String,
    key: minisign_verify::PublicKey,
}

impl Key {
    pub fn from_base64(b64: &str) -> Result<Key> {
        let key = minisign_verify::PublicKey::from_base64(b64.trim())
            .map_err(|e| anyhow::anyhow!("not a minisign public key: {e}"))?;
        Ok(Key {
            base64: b64.trim().to_string(),
            key,
        })
    }

    /// The key every stare.pub mirror release is signed with.
    pub fn release() -> Key {
        Key::from_base64(RELEASE_KEY).expect("the built-in release key parses")
    }

    /// A minisign `.pub` file (an untrusted comment line, then the key), or the bare key.
    pub fn from_file(path: &Path) -> Result<Key> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("can't read the key {}", path.display()))?;
        let line = text
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty() && !l.starts_with("untrusted comment:"))
            .with_context(|| format!("{} has no key", path.display()))?;
        Key::from_base64(line)
    }

    /// Check `data` against the minisign signature `sig` (the `.minisig` file's text).
    pub fn verify(&self, data: &[u8], sig: &str, what: &str) -> Result<()> {
        let sig = minisign_verify::Signature::decode(sig)
            .map_err(|e| anyhow::anyhow!("{what}'s signature can't be read: {e}"))?;
        self.key
            .verify(data, &sig, false)
            .map_err(|e| anyhow::anyhow!("{what}'s signature doesn't check: {e}"))
    }
}

/// A file pinned by its path (under the releases base), SHA-256 and size.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Pinned {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Latest {
    pub format: String,
    pub format_version: String,
    pub release: String,
    pub sequence: u64,
    pub release_json: Pinned,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Release {
    pub format: String,
    pub format_version: String,
    pub release: String,
    pub sequence: u64,
    pub data_date: String,
    pub components: Vec<Component>,
    pub tiers: BTreeMap<String, Tier>,
    #[serde(default)]
    pub origins: Vec<Origin>,
    pub signing: Signing,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Component {
    pub id: String,
    pub version: String,
    pub tier: u32,
    pub root: String,
    pub files: u64,
    pub bytes: u64,
    pub files_json: Pinned,
    pub sha256sums: Pinned,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Tier {
    pub components: Vec<String>,
    #[serde(default)]
    pub pointers: Vec<Pinned>,
    #[serde(default)]
    pub symlinks: BTreeMap<String, String>,
    pub tar: Option<TierTar>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TierTar {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
    pub torrent: Option<TorrentEntry>,
}

impl TierTar {
    pub fn pinned(&self) -> Pinned {
        Pinned {
            path: self.path.clone(),
            sha256: self.sha256.clone(),
            bytes: self.bytes,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct TorrentEntry {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
    pub btih: String,
    pub btmh: String,
    pub pieces_root: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Origin {
    pub id: String,
    pub releases: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Signing {
    pub key_id: String,
    pub public_key: String,
}

/// A copy's `mirror/mirror.json`: which release it holds and which tiers.
#[derive(Debug, Clone, Deserialize)]
pub struct MirrorJson {
    pub format: String,
    pub format_version: String,
    pub release: String,
    pub tiers: Vec<u32>,
}

/// One line of a component's `files.json.gz`: a path relative to the copy's root.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct FileEntry {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
    pub btv2: Option<String>,
}

fn major_is_1(version: &str) -> bool {
    version.split('.').next() == Some("1")
}

/// A release or component name used as one path segment.
pub fn check_segment(name: &str, what: &str) -> Result<()> {
    let ok = !name.is_empty()
        && name != "."
        && name != ".."
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !ok {
        bail!("{what} {name:?} isn't a plain name");
    }
    Ok(())
}

/// `rel` as a relative path that stays under the directory it's joined to: no root, no
/// `..`, no backslashes, no empty segments.
pub fn safe_rel(rel: &str) -> Result<PathBuf> {
    let p = Path::new(rel);
    let ok = !rel.is_empty()
        && !rel.contains('\\')
        && !rel
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == "..")
        && p.components()
            .all(|c| matches!(c, PathComponent::Normal(_)));
    if !ok {
        bail!("{rel:?} isn't a safe relative path");
    }
    Ok(p.to_path_buf())
}

impl Latest {
    pub fn parse(data: &[u8]) -> Result<Latest> {
        let l: Latest = serde_json::from_slice(data).context("latest.json isn't valid")?;
        if l.format != LATEST_FORMAT {
            bail!("latest.json isn't a {LATEST_FORMAT} file");
        }
        if !major_is_1(&l.format_version) {
            bail!(
                "latest.json is format_version {}; this stare reads 1.x",
                l.format_version
            );
        }
        check_segment(&l.release, "the release")?;
        safe_rel(&l.release_json.path)?;
        Ok(l)
    }
}

impl Release {
    /// Parse a release list and check it is one this tool reads, signed by `key`, for
    /// `release` (the name it was fetched under).
    pub fn parse(data: &[u8], key: &Key, release: &str) -> Result<Release> {
        let r: Release = serde_json::from_slice(data).context("release.json isn't valid")?;
        if r.format != RELEASE_FORMAT {
            bail!("release.json isn't a {RELEASE_FORMAT} list");
        }
        if !major_is_1(&r.format_version) {
            bail!(
                "release.json is format_version {}; this stare reads 1.x",
                r.format_version
            );
        }
        if r.signing.public_key != key.base64 {
            bail!("release.json names another public key than the one it was checked with");
        }
        if r.release != release {
            bail!("{release}/release.json is for {}", r.release);
        }
        check_segment(&r.release, "the release")?;
        for c in &r.components {
            check_segment(&c.id, "a component")?;
            check_segment(&c.version, "a component version")?;
            safe_rel(&c.root)?;
            safe_rel(&c.files_json.path)?;
            safe_rel(&c.sha256sums.path)?;
        }
        for (name, tier) in &r.tiers {
            for id in &tier.components {
                if r.component(id).is_none() {
                    bail!("tier {name} names a component {id} the release doesn't list");
                }
            }
            for p in &tier.pointers {
                safe_rel(&p.path)?;
            }
            for (link, target) in &tier.symlinks {
                safe_rel(link)?;
                check_segment(target, "a symlink target")?;
            }
            if let Some(tar) = &tier.tar {
                safe_rel(&tar.path)?;
                if let Some(t) = &tar.torrent {
                    safe_rel(&t.path)?;
                }
            }
        }
        Ok(r)
    }

    pub fn component(&self, id: &str) -> Option<&Component> {
        self.components.iter().find(|c| c.id == id)
    }

    pub fn tier(&self, n: u32) -> Option<&Tier> {
        self.tiers.get(&n.to_string())
    }

    /// The components of tiers 1 to `n`: a tier N copy holds every lower tier too.
    pub fn components_through(&self, tiers: &[u32]) -> Vec<&Component> {
        let mut out: Vec<&Component> = Vec::new();
        for n in tiers {
            if let Some(t) = self.tier(*n) {
                for id in &t.components {
                    if let Some(c) = self.component(id) {
                        if !out.iter().any(|o| o.id == c.id) {
                            out.push(c);
                        }
                    }
                }
            }
        }
        out
    }
}

impl MirrorJson {
    pub fn parse(data: &[u8]) -> Result<MirrorJson> {
        let m: MirrorJson =
            serde_json::from_slice(data).context("mirror/mirror.json isn't valid")?;
        if m.format != MIRROR_FORMAT || !major_is_1(&m.format_version) {
            bail!("mirror/mirror.json isn't a {MIRROR_FORMAT} 1.x file");
        }
        check_segment(&m.release, "the release")?;
        Ok(m)
    }
}

/// A component's `files.json.gz`: one JSON object per line, gzipped.
pub fn read_files_json_gz(data: &[u8]) -> Result<Vec<FileEntry>> {
    let mut text = String::new();
    flate2::read::GzDecoder::new(data)
        .read_to_string(&mut text)
        .context("files.json.gz isn't gzipped text")?;
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let e: FileEntry = serde_json::from_str(l).context("a files.json.gz line")?;
            safe_rel(&e.path)?;
            Ok(e)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_built_in_key_parses_and_has_its_id() {
        let k = Key::release();
        assert_eq!(k.base64, RELEASE_KEY);
        // The key ID is bytes 2..10 of the decoded key, little-endian, as minisign prints it.
        use std::fmt::Write;
        let raw = base64_decode(RELEASE_KEY);
        let id = raw[2..10].iter().rev().fold(String::new(), |mut s, b| {
            write!(s, "{b:02X}").unwrap();
            s
        });
        assert_eq!(id, RELEASE_KEY_ID);
    }

    #[test]
    fn the_built_in_key_is_the_one_the_site_publishes() {
        let published = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../web/public/.well-known/stare-release-key.pub"),
        )
        .unwrap();
        assert_eq!(
            published,
            format!("untrusted comment: minisign public key {RELEASE_KEY_ID}\n{RELEASE_KEY}\n")
        );
    }

    fn base64_decode(s: &str) -> Vec<u8> {
        const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut bits = 0u32;
        let mut n = 0;
        let mut out = Vec::new();
        for c in s.bytes().filter(|&c| c != b'=') {
            bits = (bits << 6) | A.iter().position(|&a| a == c).unwrap() as u32;
            n += 6;
            if n >= 8 {
                n -= 8;
                out.push((bits >> n) as u8);
            }
        }
        out
    }

    #[test]
    fn unsafe_paths_are_refused() {
        for bad in [
            "",
            "/etc/passwd",
            "../x",
            "a/../../x",
            "a//b",
            "a/./b",
            "a\\b",
            "a/",
        ] {
            assert!(safe_rel(bad).is_err(), "{bad:?}");
        }
        for good in ["mirror/idx/manifest.json", "site.v2026.11.11.1/index.html"] {
            assert!(safe_rel(good).is_ok(), "{good:?}");
        }
    }

    #[test]
    fn release_names_are_plain_segments() {
        assert!(check_segment("v2026.11.11", "r").is_ok());
        assert!(check_segment("..", "r").is_err());
        assert!(check_segment("v1/x", "r").is_err());
        assert!(check_segment("", "r").is_err());
    }
}
