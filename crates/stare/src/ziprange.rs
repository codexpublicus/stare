//! Reading a few files out of a volume's zip by HTTP range requests (#212), instead of
//! fetching the whole zip (one to a few MB) for a few kilobytes of it.
//!
//! A reader fetches the zip's last [`TAIL`] bytes and reads the central directory from
//! them ([`directory`]); when the directory starts before the tail, it asks for the
//! bytes from where it starts. Each file's local entry runs from its offset to the next
//! entry's (or the directory's), so the files a reader wants are one range
//! ([`span`]), and [`entry`] reads one from it. The I/O is the caller's: the site
//! fetches in JavaScript, the CLI with reqwest. Zip64 archives aren't read; CAP's zips
//! are far smaller than 4 GB.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::io::Read;

/// How many bytes from the end of a zip a reader fetches first: enough for the central
/// directory of most CAP volumes (conn/261's 310 files take about 22 KB).
pub const TAIL: u64 = 64 * 1024;

/// One file in a zip: its name, and where its local entry (header and data) starts and
/// ends in the zip, end exclusive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub name: String,
    pub start: u64,
    pub end: u64,
}

/// What a zip's tail says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Directory {
    /// Every file, in the order of their offsets.
    Entries(Vec<Entry>),
    /// The central directory starts before the tail: fetch from this offset to the end.
    Need(u64),
}

fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

/// The central directory from `tail`, the zip's bytes from offset `tail_start` to its
/// end.
pub fn directory(tail: &[u8], tail_start: u64) -> Result<Directory> {
    // The end of central directory record: 22 bytes plus a comment of up to 64 KB.
    let eocd = (0..tail.len().saturating_sub(21))
        .rev()
        .find(|&i| u32_at(tail, i) == Some(0x0605_4b50))
        .context("no end of central directory in the zip's tail")?;
    let count = u16_at(tail, eocd + 10).context("short end of central directory")? as usize;
    let size = u32_at(tail, eocd + 12).context("short end of central directory")? as u64;
    let offset = u32_at(tail, eocd + 16).context("short end of central directory")? as u64;
    if count == 0xffff || size == 0xffff_ffff || offset == 0xffff_ffff {
        bail!("a zip64 archive");
    }
    if offset < tail_start {
        return Ok(Directory::Need(offset));
    }
    let dir = &tail[(offset - tail_start) as usize..];
    let mut files: Vec<(String, u64)> = Vec::with_capacity(count);
    let mut at = 0usize;
    for _ in 0..count {
        if u32_at(dir, at) != Some(0x0201_4b50) {
            bail!("bad central directory entry at {}", offset + at as u64);
        }
        let short = || anyhow::anyhow!("short central directory entry");
        let name_len = u16_at(dir, at + 28).ok_or_else(short)? as usize;
        let extra_len = u16_at(dir, at + 30).ok_or_else(short)? as usize;
        let comment_len = u16_at(dir, at + 32).ok_or_else(short)? as usize;
        let local = u32_at(dir, at + 42).ok_or_else(short)? as u64;
        let name = dir.get(at + 46..at + 46 + name_len).ok_or_else(short)?;
        files.push((String::from_utf8_lossy(name).into_owned(), local));
        at += 46 + name_len + extra_len + comment_len;
    }
    files.sort_by_key(|(_, start)| *start);
    let ends: Vec<u64> = files
        .iter()
        .skip(1)
        .map(|(_, s)| *s)
        .chain(std::iter::once(offset))
        .collect();
    Ok(Directory::Entries(
        files
            .into_iter()
            .zip(ends)
            .map(|((name, start), end)| Entry { name, start, end })
            .collect(),
    ))
}

/// The one range (start, end exclusive) that holds every one of `names` in `entries`;
/// None when any isn't there.
pub fn span(entries: &[Entry], names: &[&str]) -> Option<(u64, u64)> {
    let mut found = names.iter().map(|n| entries.iter().find(|e| e.name == *n));
    let first = found.next()??;
    found.try_fold((first.start, first.end), |(s, e), next| {
        let next = next?;
        Some((s.min(next.start), e.max(next.end)))
    })
}

/// One file's contents from `bytes`, the zip's bytes from offset `bytes_start`, which
/// hold the file's whole local entry.
pub fn entry(bytes: &[u8], bytes_start: u64, file: &Entry) -> Result<Vec<u8>> {
    let at = file
        .start
        .checked_sub(bytes_start)
        .context("the range starts after the entry")? as usize;
    let local = bytes.get(at..).context("the range ends before the entry")?;
    if u32_at(local, 0) != Some(0x0403_4b50) {
        bail!("no local header for {}", file.name);
    }
    let short = || anyhow::anyhow!("short local header for {}", file.name);
    let method = u16_at(local, 8).ok_or_else(short)?;
    let size = u32_at(local, 18).ok_or_else(short)? as usize;
    let name_len = u16_at(local, 26).ok_or_else(short)? as usize;
    let extra_len = u16_at(local, 28).ok_or_else(short)? as usize;
    let data_at = 30 + name_len + extra_len;
    // A size written after the data (bit 3) is 0 here; the entry's end bounds it.
    let data_end = if size > 0 {
        data_at + size
    } else {
        (file.end - file.start) as usize
    };
    let data = local
        .get(data_at..data_end.min(local.len()))
        .ok_or_else(short)?;
    match method {
        0 => Ok(data.to_vec()),
        8 => {
            let mut out = Vec::new();
            flate2::read::DeflateDecoder::new(data)
                .read_to_end(&mut out)
                .with_context(|| format!("failed to inflate {}", file.name))?;
            Ok(out)
        }
        m => bail!("{} is stored with method {m}", file.name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn zip(files: &[(&str, &str)]) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            let deflated = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            for (i, (name, body)) in files.iter().enumerate() {
                let opts = if i % 2 == 0 {
                    deflated
                } else {
                    deflated.compression_method(zip::CompressionMethod::Stored)
                };
                w.start_file(*name, opts).unwrap();
                w.write_all(body.as_bytes()).unwrap();
            }
            w.finish().unwrap();
        }
        buf.into_inner()
    }

    fn read(zip: &[u8], tail_len: usize, names: &[&str]) -> Vec<String> {
        let tail_start = zip.len().saturating_sub(tail_len);
        let entries = match directory(&zip[tail_start..], tail_start as u64).unwrap() {
            Directory::Entries(e) => e,
            Directory::Need(from) => {
                assert!((from as usize) < tail_start);
                match directory(&zip[from as usize..], from).unwrap() {
                    Directory::Entries(e) => e,
                    Directory::Need(_) => panic!("asked twice"),
                }
            }
        };
        let (s, e) = span(&entries, names).unwrap();
        let bytes = &zip[s as usize..e as usize];
        names
            .iter()
            .map(|n| {
                let file = entries.iter().find(|f| f.name == *n).unwrap();
                String::from_utf8(entry(bytes, s, file).unwrap()).unwrap()
            })
            .collect()
    }

    #[test]
    fn reads_files_out_of_a_range() {
        let body = |n: usize| format!("{{\"name\": \"case {n}\"}}").repeat(40);
        let bodies: Vec<String> = (0..6).map(body).collect();
        let names = [
            "json/0939-01.json",
            "json/0941-01.json",
            "json/0941-02.json",
            "json/0941-03.json",
            "json/0942-01.json",
            "metadata/CasesMetadata.json",
        ];
        let files: Vec<(&str, &str)> = names
            .iter()
            .zip(&bodies)
            .map(|(n, b)| (*n, b.as_str()))
            .collect();
        let z = zip(&files);
        let want = [
            "json/0941-01.json",
            "json/0941-02.json",
            "json/0941-03.json",
        ];
        assert_eq!(read(&z, 64 * 1024, &want), bodies[1..4]);
        // A tail too short for the directory asks for more.
        assert_eq!(read(&z, 100, &want[1..2]), bodies[2..3]);
    }

    #[test]
    fn a_missing_file_has_no_span() {
        let z = zip(&[("json/0001-01.json", "{}")]);
        let Directory::Entries(entries) = directory(&z, 0).unwrap() else {
            panic!("no entries")
        };
        assert_eq!(entries.len(), 1);
        assert!(span(&entries, &["json/0002-01.json"]).is_none());
        assert!(directory(b"not a zip", 0).is_err());
    }
}
