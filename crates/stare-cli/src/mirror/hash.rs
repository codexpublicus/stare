//! A file's SHA-256, size and BitTorrent v2 pieces root, in one read.
//!
//! A mirror release pins every file by all three (`files.json.gz`). The pieces root
//! (BEP 52) is the root of a SHA-256 merkle tree over the file's 16 KiB blocks, the leaf
//! layer padded with zero hashes to a power of two; an empty file has none.
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

/// The merkle tree's block size.
pub const BLOCK: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileHash {
    pub sha256: String,
    pub bytes: u64,
    /// None for an empty file.
    pub btv2: Option<String>,
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The root over `leaves`, padded with zero hashes to a power of two.
pub fn merkle_root(mut layer: Vec<[u8; 32]>) -> Option<[u8; 32]> {
    if layer.is_empty() {
        return None;
    }
    layer.resize(layer.len().next_power_of_two(), [0u8; 32]);
    while layer.len() > 1 {
        layer = layer
            .chunks(2)
            .map(|pair| {
                let mut h = Sha256::new();
                h.update(pair[0]);
                h.update(pair[1]);
                h.finalize().into()
            })
            .collect();
    }
    Some(layer[0])
}

/// Read up to a full block, short only at the end of the stream.
fn fill(r: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(n)
}

/// Hash everything `r` yields.
pub fn hash_reader(mut r: impl Read) -> std::io::Result<FileHash> {
    let mut sha = Sha256::new();
    let mut leaves = Vec::new();
    let mut bytes = 0u64;
    let mut buf = vec![0u8; BLOCK];
    loop {
        let n = fill(&mut r, &mut buf)?;
        if n == 0 {
            break;
        }
        sha.update(&buf[..n]);
        leaves.push(Sha256::digest(&buf[..n]).into());
        bytes += n as u64;
        if n < BLOCK {
            break;
        }
    }
    Ok(FileHash {
        sha256: hex(&sha.finalize()),
        bytes,
        btv2: merkle_root(leaves).map(|r| hex(&r)),
    })
}

pub fn hash_file(path: &Path) -> std::io::Result<FileHash> {
    hash_reader(std::fs::File::open(path)?)
}

/// SHA-256 and size only, for checking a copy against its manifests.
pub fn sha256_file(path: &Path) -> std::io::Result<(String, u64)> {
    let mut f = std::fs::File::open(path)?;
    let mut sha = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut bytes = 0u64;
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        sha.update(&buf[..n]);
        bytes += n as u64;
    }
    Ok((hex(&sha.finalize()), bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_of_one_block_or_less_has_its_sha256_as_pieces_root() {
        // One leaf, so the root is the leaf: the block's own SHA-256. The live release's
        // small files show it (btv2 equal to sha256).
        let h = hash_reader(&b"hello"[..]).unwrap();
        assert_eq!(
            h.sha256,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        assert_eq!(h.btv2.as_deref(), Some(h.sha256.as_str()));
        assert_eq!(h.bytes, 5);
    }

    #[test]
    fn an_empty_file_has_no_pieces_root() {
        let h = hash_reader(&b""[..]).unwrap();
        assert_eq!(h.bytes, 0);
        assert_eq!(h.btv2, None);
    }

    #[test]
    fn three_blocks_pad_to_four_leaves() {
        let data: Vec<u8> = (0..(2 * BLOCK + 100)).map(|i| (i % 251) as u8).collect();
        let leaf = |b: &[u8]| -> [u8; 32] { Sha256::digest(b).into() };
        let (a, b, c) = (
            leaf(&data[..BLOCK]),
            leaf(&data[BLOCK..2 * BLOCK]),
            leaf(&data[2 * BLOCK..]),
        );
        let pair = |x: [u8; 32], y: [u8; 32]| -> [u8; 32] {
            let mut h = Sha256::new();
            h.update(x);
            h.update(y);
            h.finalize().into()
        };
        let want = pair(pair(a, b), pair(c, [0u8; 32]));
        let got = hash_reader(&data[..]).unwrap();
        assert_eq!(got.btv2, Some(hex(&want)));
        assert_eq!(got.bytes, data.len() as u64);
    }

    #[test]
    fn short_reads_still_make_whole_blocks() {
        struct Trickle<'a>(&'a [u8]);
        impl Read for Trickle<'_> {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                let n = self.0.len().min(buf.len()).min(1000);
                buf[..n].copy_from_slice(&self.0[..n]);
                self.0 = &self.0[n..];
                Ok(n)
            }
        }
        let data = vec![7u8; 3 * BLOCK + 5];
        assert_eq!(
            hash_reader(Trickle(&data)).unwrap(),
            hash_reader(&data[..]).unwrap()
        );
    }
}
