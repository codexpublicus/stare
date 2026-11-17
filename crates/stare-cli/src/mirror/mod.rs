//! `stare mirror`: install and check a self-hosted copy of stare.pub from a signed mirror
//! release (#338; the release format is `stare-mirror-release` 1.x, described in
//! `mirror-kit/README.md`).
//!
//! - [`release`]: the release list, `latest.json`, the per-component manifests, the key.
//! - [`source`]: the origins a file is fetched from, each copy checked against its hash.
//! - [`hash`]: SHA-256 and the BitTorrent v2 pieces root in one read.
//! - [`torrent`]: a release torrent's infohashes.
//! - [`copy`]: `install`, `verify` and `scan`.
pub mod copy;
pub mod hash;
pub mod release;
pub mod source;
pub mod torrent;
