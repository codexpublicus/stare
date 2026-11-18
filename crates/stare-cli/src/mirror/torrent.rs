//! A release torrent's infohashes, from its bencoded bytes.
//!
//! The torrent is pinned by its SHA-256 in the signed `release.json`, which also gives its
//! v1 infohash (SHA-1 of the bencoded `info` dictionary), its v2 infohash (SHA-256 of the
//! same bytes) and the v2 pieces root of the file it carries. Recomputing the three checks
//! that the release list and the torrent agree, as the release builder's own check does.
use super::hash::hex;
use anyhow::{bail, Context, Result};
use sha1::Sha1;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TorrentHashes {
    pub btih: String,
    /// The v2 infohash as hex, without the multihash prefix (`1220`).
    pub btmh: String,
    /// The single file's v2 pieces root, when the torrent has a v2 file tree.
    pub pieces_root: Option<String>,
}

enum Value<'a> {
    Int,
    Bytes(&'a [u8]),
    List,
    Dict(Vec<(&'a [u8], Node<'a>)>),
}

struct Node<'a> {
    start: usize,
    end: usize,
    value: Value<'a>,
}

const MAX_DEPTH: usize = 64;

fn parse(buf: &[u8], pos: usize, depth: usize) -> Result<Node<'_>> {
    if depth > MAX_DEPTH {
        bail!("bencode nested too deeply");
    }
    let start = pos;
    match buf.get(pos) {
        Some(b'i') => {
            let end = buf[pos..]
                .iter()
                .position(|&b| b == b'e')
                .context("unterminated integer")?;
            Ok(Node {
                start,
                end: pos + end + 1,
                value: Value::Int,
            })
        }
        Some(b'l') => {
            let mut p = pos + 1;
            while buf.get(p) != Some(&b'e') {
                p = parse(buf, p, depth + 1)?.end;
            }
            Ok(Node {
                start,
                end: p + 1,
                value: Value::List,
            })
        }
        Some(b'd') => {
            let mut p = pos + 1;
            let mut items = Vec::new();
            while buf.get(p) != Some(&b'e') {
                let key = parse(buf, p, depth + 1)?;
                let Value::Bytes(k) = key.value else {
                    bail!("dictionary key isn't a string");
                };
                let val = parse(buf, key.end, depth + 1)?;
                p = val.end;
                items.push((k, val));
            }
            Ok(Node {
                start,
                end: p + 1,
                value: Value::Dict(items),
            })
        }
        Some(b'0'..=b'9') => {
            let colon = buf[pos..]
                .iter()
                .position(|&b| b == b':')
                .context("string without a length")?;
            let len: usize = std::str::from_utf8(&buf[pos..pos + colon])?.parse()?;
            let s = pos + colon + 1;
            let e = s.checked_add(len).context("string length overflows")?;
            if e > buf.len() {
                bail!("string runs past the end");
            }
            Ok(Node {
                start,
                end: e,
                value: Value::Bytes(&buf[s..e]),
            })
        }
        _ => bail!("not bencode at byte {pos}"),
    }
}

fn get<'a, 'b>(node: &'b Node<'a>, key: &[u8]) -> Option<&'b Node<'a>> {
    match &node.value {
        Value::Dict(items) => items.iter().find(|(k, _)| *k == key).map(|(_, v)| v),
        _ => None,
    }
}

/// The infohashes of a torrent file's bytes.
pub fn describe(data: &[u8]) -> Result<TorrentHashes> {
    let top = parse(data, 0, 0).context("the torrent isn't bencode")?;
    if top.end != data.len() {
        bail!("trailing bytes after the torrent");
    }
    let info = get(&top, b"info").context("the torrent has no info dictionary")?;
    let raw = &data[info.start..info.end];
    let pieces_root = get(info, b"file tree").and_then(|tree| {
        // A single-file torrent: { name: { "": { length, pieces root } } }.
        let Value::Dict(files) = &tree.value else {
            return None;
        };
        let [(_, file)] = files.as_slice() else {
            return None;
        };
        match &get(get(file, b"")?, b"pieces root")?.value {
            Value::Bytes(b) => Some(hex(b)),
            _ => None,
        }
    });
    Ok(TorrentHashes {
        btih: hex(&Sha1::digest(raw)),
        btmh: hex(&Sha256::digest(raw)),
        pieces_root,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bstr(s: &[u8]) -> Vec<u8> {
        let mut v = format!("{}:", s.len()).into_bytes();
        v.extend_from_slice(s);
        v
    }

    #[test]
    fn hashes_the_info_dictionary_bytes_exactly() {
        let root = [0xabu8; 32];
        let mut info = b"d9:file treed5:a.tard0:d6:lengthi5e11:pieces root".to_vec();
        info.extend(bstr(&root));
        info.extend(b"eee12:meta versioni2e4:name5:a.tare");
        let mut t = b"d8:announce3:udp4:info".to_vec();
        t.extend(&info);
        t.extend(b"e");
        let got = describe(&t).unwrap();
        assert_eq!(got.btih, hex(&Sha1::digest(&info)));
        assert_eq!(got.btmh, hex(&Sha256::digest(&info)));
        assert_eq!(got.pieces_root, Some(hex(&root)));
    }

    #[test]
    fn rejects_what_isnt_a_torrent() {
        assert!(describe(b"not bencode").is_err());
        assert!(describe(b"d4:infod").is_err());
        assert!(describe(b"d3:fooi1ee").is_err());
        assert!(describe(b"d4:infodee").is_ok());
        assert!(describe(b"d4:infodeeXX").is_err());
        assert!(describe(b"d4:info999:x").is_err());
    }

    #[test]
    fn deep_nesting_is_refused_not_overflowed() {
        let mut t = b"d4:info".to_vec();
        t.extend(std::iter::repeat_n(b'l', 10_000));
        assert!(describe(&t).is_err());
    }
}
