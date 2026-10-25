//! The unified per-volume citation index: one gzipped text file per volume, for every
//! source (docs/plans/courtlistener-mirror.md, "Index"; measured in #110).
//!
//! ```text
//! v/<ver>/<slug>/<vol>.idx.gz      part 0
//! v/<ver>/<slug>/<vol>.<n>.idx.gz  part n of a split volume
//! ```
//!
//! Each line is `page,source,ref`:
//!
//! ```text
//! #parts,1012
//! 8,cap,0008-01
//! 8,cap,138-2/0008-01
//! 647,cap,0647-01
//! 647,cl,9876543/0f3a9c2e7b1d4a65
//! xxix,cap,xxix-01
//! ```
//!
//! - `page` is the cited page: a number (`647`, a neutral or slip-opinion sequence
//!   number like `125678`), or a CAP page label, lowercased (`xxix`, `supp. 1`). Numbers
//!   sort before labels, numbers numerically and labels as strings.
//! - `source` is `cap` or `cl`. A reader skips a line whose tag it doesn't know, so later
//!   sources can add one.
//! - A `cap` ref is CAP's case file name inside the volume zip (`0647-01`). A volume CAP
//!   split over several folders (`a3d/138` and `138-2`) is one file under the number as
//!   cited, and a case from a folder other than that number has the folder in front:
//!   `138-2/1012-01` is `1012-01` in `138-2.zip`.
//! - A `cl` ref is `<cluster_id>/<hash>`, the CourtListener record at
//!   `cl/c/<cluster_id>/<hash>.json.gz` (see [`crate::cl`]).
//! - Several lines can share a page. CAP's come first; a resolver shows the first and
//!   lists the others.
//!
//! **Aliases** (#151). A `cap` ref can name a case in another volume, as
//! `<slug>/<folder>/<file>`: the case `<file>` in `cap/<slug>/<folder>.zip`. That's a
//! parallel citation: the line says a case printed in another volume is also cited at
//! this page. After the ref a line can carry `key=value` fields; `via` records where an
//! alias came from:
//!
//! ```text
//! 287,cap,neb/128/0783-01,via=cl:8077312
//! ```
//!
//! `via=nominative:us` is a nominative alias (stare-builder#32): U.S. Reports volumes 1 to
//! 90 are the early reporters' volumes (Dall., Cranch, Wheat., Pet., How., Black, Wall.)
//! renumbered, and the index files each case under its reporter's name and volume too:
//! `238,cap,us/89/0238-01,via=nominative:us` in `wall/22.idx.gz`.
//!
//! `via=official:<slug>` is an official-page alias (stare-builder#41, #48): a case whose
//! official citation gives another page than the one CAP's scan numbers it by (a reprint
//! paged differently, an orders section CAP numbers on from the opinions, a misnumbered
//! page) is filed at its official page in its own volume too:
//! `29,cap,us/8/0018-01,via=official:us` in `us/8.idx.gz` (`8 U.S. 29`, printed at the
//! reprint's page 18), `119,cap,ohio/20/0101-01,via=official:ohio` in `ohio/20.idx.gz`. The
//! build leaves out an own line at a page another case is officially at, so the alias is
//! the first line there.
//!
//! `via=cl:<cluster>` is CourtListener's `citations` table, the cluster's own reporter
//! citations from publisher, scraper and import data. It's a third party's metadata, not
//! an eyecite detection and not a human check, so a reader labels the link with its
//! source ([`via_label`]) and never calls it verified. A page's own CAP cases come
//! before its aliases, and both before CourtListener's records, so an alias never
//! hides a case CAP printed at the page (the R-rules in #160). A reader skips a field it
//! doesn't know. A volume whose file has only aliases isn't held: the manifest lists it
//! under `aliases`, not `reporters` ([`crate::manifest`]), and a miss in it links out.
//! Readers from before aliases skip these lines as malformed, which leaves them
//! resolving what they did before.
//!
//! A volume past [`SPLIT_LINES`] lines is split: a part ends once it passes that many
//! lines, at the next page boundary, so a page never straddles two parts. Part 0 then
//! starts with `#parts,<first page of part 1>,<first page of part 2>,…`, and a reader
//! fetches the later part a page falls in ([`VolumeIndex::part_for`]).
//!
//! Readers trim whitespace, skip blank lines and `#` comment lines, and skip a malformed
//! line (reporting its 1-based number) rather than rejecting the volume.
//!
//! Files are gzipped with mtime 0 and no file name ([`gzip`]), so a volume whose lines
//! didn't change is byte-identical from one build to the next.

use crate::index::PageKey;
use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::cmp::Ordering;
use std::io::{Read, Write};

/// The index format the manifest's `idx` field names.
pub const FORMAT: u32 = 1;

/// A part ends at the first page boundary after it has this many lines.
pub const SPLIT_LINES: usize = 1000;

/// The header on part 0 of a split volume.
pub const PARTS_HEADER: &str = "#parts";

/// Where a line's case is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Source {
    /// CAP: the ref is a case file in the volume's zip.
    Cap,
    /// CourtListener: the ref is `<cluster_id>/<hash>`.
    Cl,
}

impl Source {
    pub fn tag(self) -> &'static str {
        match self {
            Source::Cap => "cap",
            Source::Cl => "cl",
        }
    }

    fn from_tag(tag: &str) -> Option<Source> {
        match tag {
            "cap" => Some(Source::Cap),
            "cl" => Some(Source::Cl),
            _ => None,
        }
    }
}

/// One line: a case that starts at `page`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub page: PageKey,
    pub source: Source,
    pub reference: String,
    /// Where the line came from (`cl:8077312`), for an alias; see [`via_label`].
    pub via: Option<String>,
}

/// The field a line's provenance is in.
pub const VIA: &str = "via";

/// Where a `cap` ref's case is: `file` in the volume's own zip, `folder/file` in another
/// folder of a volume CAP split, or `slug/folder/file` in another reporter or volume
/// (an alias).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CapRef<'a> {
    /// The reporter slug of an alias's case; None for a case in this volume.
    pub reporter: Option<&'a str>,
    pub folder: Option<&'a str>,
    pub case_file: &'a str,
}

/// Whether `s` can be a `via` value: `<source>:<id>`, a lowercase tag and an id of ASCII
/// letters, digits, `.`, `_` and `-`.
pub fn is_via(s: &str) -> bool {
    let Some((tag, id)) = s.split_once(':') else {
        return false;
    };
    is_tag(tag)
        && !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// The CourtListener cluster a `via` names (`cl:8077312` → 8077312).
pub fn via_cluster(via: &str) -> Option<u64> {
    let id = via.strip_prefix("cl:")?;
    (!id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
        .then(|| id.parse().ok())
        .flatten()
}

/// How a reader labels a link that came through an alias: "Resolved through
/// CourtListener's citation metadata (cluster 8077312)". Never "verified": only a human
/// check is that.
pub fn via_label(via: &str) -> String {
    if via == VIA_NOMINATIVE {
        return NOMINATIVE_LABEL.to_string();
    }
    if is_official(via) {
        return OFFICIAL_LABEL.to_string();
    }
    match via_cluster(via) {
        Some(id) => format!("Resolved through CourtListener's citation metadata (cluster {id})"),
        None => format!("Resolved through {via}"),
    }
}

/// The `via` of a nominative alias (stare-builder#32): a case in U.S. Reports volumes 1
/// to 90 filed under the early reporter's own name and volume (`22 Wall. 238` is `89 U.S.
/// 238`). The concordance is the Supreme Court's, so the label states it as fact.
pub const VIA_NOMINATIVE: &str = "nominative:us";

/// How a reader labels a link through a nominative alias.
pub const NOMINATIVE_LABEL: &str = "Resolved as the U.S. Reports under its reporter's name";

/// The `via` of an official-page alias in the U.S. Reports (stare-builder#41): a case
/// filed at the page its official citation gives (`8 U.S. 29` is CAP's `us/8` page 18).
/// Every reporter's is `official:<slug>` ([`is_official`]).
pub const VIA_OFFICIAL: &str = "official:us";

/// The tag of an official-page alias's `via`, `official:<slug>` (stare-builder#48).
pub const OFFICIAL_TAG: &str = "official";

/// Whether `via` is an official-page alias's, in any reporter (`official:ohio`).
pub fn is_official(via: &str) -> bool {
    via.split_once(':')
        .is_some_and(|(tag, slug)| tag == OFFICIAL_TAG && !slug.is_empty())
}

/// How a reader labels a link through an official-page alias.
pub const OFFICIAL_LABEL: &str =
    "Resolved by the reporter's official page; CAP's scan numbers the case on another page";

/// Whether a tag could be a source: lowercase ASCII letters.
fn is_tag(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_lowercase())
}

/// Whether `s` can be a CAP case file name in a ref: not empty, no `/`, no control
/// characters, and no surrounding whitespace. CAP has names with a comma (ohio/10's
/// `11, 12-01`) and with `=` (a3d/48's `1265=1275-01`); see [`split_fields`].
fn is_case_file(s: &str) -> bool {
    !s.is_empty() && s.trim() == s && !s.contains('/') && !s.chars().any(char::is_control)
}

/// Whether a comma-separated piece at the end of a line is a field: `key=value`, the key
/// lowercase ASCII letters and the value without whitespace.
fn is_field(s: &str) -> bool {
    s.split_once('=')
        .is_some_and(|(k, v)| is_tag(k) && !v.is_empty() && !v.chars().any(char::is_whitespace))
}

/// A line's ref and its trailing `key=value` fields. The ref is everything after the
/// tag up to the fields, so a CAP case file with a comma in its name stays whole: a
/// piece is a field only from the end of the line and only in that shape, and the ref
/// keeps at least one piece.
fn split_fields(rest: &str) -> (&str, Vec<&str>) {
    let mut reference = rest;
    let mut fields = Vec::new();
    while let Some((head, tail)) = reference.rsplit_once(',') {
        if !is_field(tail.trim()) || head.trim().is_empty() {
            break;
        }
        fields.push(tail.trim());
        reference = head;
    }
    fields.reverse();
    (reference.trim(), fields)
}

/// `(folder, case_file)` of a CAP ref to a case in this volume: `0647-01` →
/// `(None, "0647-01")`, `138-2/1012-01` → `(Some("138-2"), "1012-01")`. None for an
/// alias (`neb/128/0783-01`; see [`parse_cap_target`]).
pub fn parse_cap_ref(reference: &str) -> Option<(Option<&str>, &str)> {
    match parse_cap_target(reference)? {
        CapRef {
            reporter: None,
            folder,
            case_file,
        } => Some((folder, case_file)),
        _ => None,
    }
}

/// Any CAP ref taken apart: the volume's own case, another folder's, or an alias's
/// (`neb/128/0783-01` → reporter `neb`, folder `128`, file `0783-01`).
pub fn parse_cap_target(reference: &str) -> Option<CapRef<'_>> {
    let segs: Vec<&str> = reference.split('/').collect();
    let (reporter, folder, case_file) = match segs[..] {
        [file] => (None, None, file),
        [folder, file] => (None, Some(folder), file),
        [slug, folder, file] => {
            if !crate::cl::is_reporter_slug(slug) {
                return None;
            }
            (Some(slug), Some(folder), file)
        }
        _ => return None,
    };
    if folder.is_some_and(|f| !crate::manifest::is_volume_key(f)) || !is_case_file(case_file) {
        return None;
    }
    Some(CapRef {
        reporter,
        folder,
        case_file,
    })
}

/// `(cluster_id, hash)` of a CourtListener ref: `9876543/0f3a9c2e7b1d4a65`.
pub fn parse_cl_ref(reference: &str) -> Option<(u64, &str)> {
    let (id, hash) = reference.split_once('/')?;
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) || !crate::cl::is_hash(hash) {
        return None;
    }
    Some((id.parse().ok()?, hash))
}

/// A page as a line writes it: a number in decimal, a label as is.
pub fn page_text(page: &PageKey) -> String {
    match page {
        PageKey::Number(n) => n.to_string(),
        PageKey::Label(l) => l.clone(),
    }
}

/// Whether a label can be written as a page: not empty, lowercase, no comma, no
/// control characters, no surrounding whitespace, not all digits (that's a number) and
/// not starting with `#` (a comment).
fn is_label(s: &str) -> bool {
    !s.is_empty()
        && s.trim() == s
        && !s.contains(',')
        && !s.starts_with('#')
        && !s.chars().any(char::is_control)
        && s.to_lowercase() == s
        && !s.bytes().all(|b| b.is_ascii_digit())
}

/// A page as written in a line or as cited: digits are a number (leading zeros
/// dropped); anything else is a label, lowercased. None for an empty page, a number too
/// large, or a label a line can't hold.
pub fn parse_page(s: &str) -> Option<PageKey> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    if s.bytes().all(|b| b.is_ascii_digit()) {
        return s.parse().ok().map(PageKey::Number);
    }
    let label = s.to_lowercase();
    is_label(&label).then_some(PageKey::Label(label))
}

impl Entry {
    /// A CAP case at `page`: `case_file` in the volume's own zip, or in `folder`'s when
    /// the volume is split over several folders and the case isn't in the one named as
    /// cited.
    pub fn cap(page: PageKey, folder: Option<&str>, case_file: &str) -> Result<Entry> {
        let reference = match folder {
            Some(f) => format!("{}/{}", f, case_file),
            None => case_file.to_string(),
        };
        if parse_cap_ref(&reference).is_none() {
            bail!("bad CAP ref {:?}", reference);
        }
        Entry::checked(page, Source::Cap, reference)
    }

    /// A CourtListener record at `page`.
    pub fn cl(page: PageKey, cluster_id: u64, hash: &str) -> Result<Entry> {
        if !crate::cl::is_hash(hash) {
            bail!("bad record hash {:?}", hash);
        }
        Entry::checked(page, Source::Cl, format!("{}/{}", cluster_id, hash))
    }

    /// An alias at `page`: the CAP case `case_file` in `cap/<reporter>/<folder>.zip`,
    /// from CourtListener cluster `cluster_id`'s citations (`via=cl:<cluster_id>`).
    pub fn alias(
        page: PageKey,
        reporter: &str,
        folder: &str,
        case_file: &str,
        cluster_id: u64,
    ) -> Result<Entry> {
        let reference = format!("{}/{}/{}", reporter, folder, case_file);
        if parse_cap_target(&reference).is_none_or(|r| r.reporter.is_none()) {
            bail!("bad alias ref {:?}", reference);
        }
        Entry::checked(page, Source::Cap, reference)?.with_via(&format!("cl:{}", cluster_id))
    }

    /// This entry with its provenance set (`cl:8077312`).
    pub fn with_via(mut self, via: &str) -> Result<Entry> {
        if !is_via(via) {
            bail!("bad via {:?}", via);
        }
        self.via = Some(via.to_string());
        Ok(self)
    }

    fn checked(page: PageKey, source: Source, reference: String) -> Result<Entry> {
        if let PageKey::Label(l) = &page {
            if !is_label(l) {
                bail!("bad page label {:?}", l);
            }
        }
        Ok(Entry {
            page,
            source,
            reference,
            via: None,
        })
    }

    /// The line for this entry, without a newline.
    pub fn line(&self) -> String {
        let mut line = format!(
            "{},{},{}",
            page_text(&self.page),
            self.source.tag(),
            self.reference
        );
        if let Some(via) = &self.via {
            line.push_str(&format!(",{}={}", VIA, via));
        }
        line
    }

    /// `(folder, case_file)` for a CAP entry whose case is in this volume; None for an
    /// alias ([`Entry::alias_target`]).
    pub fn cap_case(&self) -> Option<(Option<&str>, &str)> {
        (self.source == Source::Cap)
            .then(|| parse_cap_ref(&self.reference))
            .flatten()
    }

    /// `(reporter, folder, case_file)` of an alias's case, in another volume.
    pub fn alias_target(&self) -> Option<(&str, &str, &str)> {
        if self.source != Source::Cap {
            return None;
        }
        match parse_cap_target(&self.reference)? {
            CapRef {
                reporter: Some(r),
                folder: Some(f),
                case_file,
            } => Some((r, f, case_file)),
            _ => None,
        }
    }

    /// Whether this line is an alias: a case printed in another volume.
    pub fn is_alias(&self) -> bool {
        self.alias_target().is_some()
    }

    /// Where a page's entries go in a lookup: its own CAP cases, then aliases, then
    /// CourtListener's records.
    fn rank(&self) -> u8 {
        match self.source {
            Source::Cap if self.is_alias() => 1,
            Source::Cap => 0,
            Source::Cl => 2,
        }
    }

    /// `(cluster_id, hash)` for a CourtListener entry.
    pub fn cl_record(&self) -> Option<(u64, &str)> {
        (self.source == Source::Cl)
            .then(|| parse_cl_ref(&self.reference))
            .flatten()
    }

    /// The entry as the WASM and JSON callers see it.
    pub fn view(&self) -> EntryView<'_> {
        let cap = (self.source == Source::Cap)
            .then(|| parse_cap_target(&self.reference))
            .flatten();
        let cl = self.cl_record();
        EntryView {
            page: page_text(&self.page),
            source: self.source.tag(),
            reference: &self.reference,
            reporter: cap.and_then(|c| c.reporter),
            folder: cap.and_then(|c| c.folder),
            case_file: cap.map(|c| c.case_file),
            cluster_id: cl.map(|(id, _)| id),
            hash: cl.map(|(_, h)| h),
            via: self.via.as_deref(),
        }
    }
}

/// An entry with its ref taken apart, for JSON. An alias has `reporter` (the slug its
/// case is under), `folder`, `case_file` and `via`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EntryView<'a> {
    pub page: String,
    pub source: &'static str,
    #[serde(rename = "ref")]
    pub reference: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reporter: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub via: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub case_file: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cluster_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<&'a str>,
}

/// One parsed part of a volume's index.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VolumeIndex {
    /// The first page of each later part (part 0's `#parts` header); empty for a volume
    /// that isn't split, or for a later part.
    pub parts: Vec<PageKey>,
    pub entries: Vec<Entry>,
    /// 1-based numbers of the lines that were skipped as malformed.
    pub malformed: Vec<usize>,
}

fn parse_line(line: &str) -> Result<Option<Entry>, ()> {
    let mut pieces = line.splitn(3, ',');
    let (Some(page), Some(tag), Some(rest)) = (pieces.next(), pieces.next(), pieces.next()) else {
        return Err(());
    };
    let page = parse_page(page).ok_or(())?;
    let tag = tag.trim();
    if !is_tag(tag) {
        return Err(());
    }
    let Some(source) = Source::from_tag(tag) else {
        return Ok(None); // a source this reader doesn't know
    };
    let (reference, fields) = split_fields(rest);
    let mut via = None;
    for field in fields {
        let (key, value) = field.split_once('=').ok_or(())?;
        if key == VIA {
            if via.is_some() || !is_via(value) {
                return Err(());
            }
            via = Some(value.to_string());
        } // a field this reader doesn't know is skipped
    }
    let ok = match source {
        Source::Cap => parse_cap_target(reference).is_some(),
        Source::Cl => parse_cl_ref(reference).is_some(),
    };
    if !ok {
        return Err(());
    }
    Ok(Some(Entry {
        page,
        source,
        reference: reference.to_string(),
        via,
    }))
}

fn parse_parts(line: &str) -> Option<Vec<PageKey>> {
    let rest = line.strip_prefix(PARTS_HEADER)?.strip_prefix(',')?;
    let pages = rest
        .split(',')
        .map(parse_page)
        .collect::<Option<Vec<_>>>()?;
    let ascending = pages.windows(2).all(|w| w[0] < w[1]);
    (!pages.is_empty() && ascending).then_some(pages)
}

/// Parse one part's text.
pub fn parse(text: &str) -> VolumeIndex {
    let mut index = VolumeIndex::default();
    let mut first = true;
    for (i, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let was_first = std::mem::replace(&mut first, false);
        if line.starts_with('#') {
            if line.starts_with(PARTS_HEADER) {
                match parse_parts(line) {
                    Some(parts) if was_first => index.parts = parts,
                    _ => index.malformed.push(i + 1),
                }
            }
            continue;
        }
        match parse_line(line) {
            Ok(Some(entry)) => index.entries.push(entry),
            Ok(None) => {}
            Err(()) => index.malformed.push(i + 1),
        }
    }
    index
}

/// A fetched index file's text: gunzipped when it's gzip, as stored, or taken as is (a
/// server that already undid the gzip with `Content-Encoding`).
pub fn decode(bytes: &[u8]) -> Result<String> {
    if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut text = String::new();
        flate2::read::GzDecoder::new(bytes)
            .read_to_string(&mut text)
            .context("failed to gunzip index file")?;
        Ok(text)
    } else {
        String::from_utf8(bytes.to_vec()).context("index file isn't UTF-8")
    }
}

/// Parse a fetched index file, gzipped or plain.
pub fn parse_bytes(bytes: &[u8]) -> Result<VolumeIndex> {
    Ok(parse(&decode(bytes)?))
}

/// Which part a page is in, given part 0's `#parts` header: 0 before the first later
/// part's first page, and so on.
pub fn part_for(parts: &[PageKey], page: &PageKey) -> usize {
    parts.iter().take_while(|p| *p <= page).count()
}

impl VolumeIndex {
    /// Every entry at `page`: the volume's own CAP cases first, then aliases, then
    /// CourtListener's records, each in file order.
    pub fn lookup(&self, page: &PageKey) -> Vec<&Entry> {
        let mut found: Vec<&Entry> = self.entries.iter().filter(|e| e.page == *page).collect();
        found.sort_by_key(|e| e.rank());
        found
    }

    /// Whether any line is a case of this volume's own (a CAP case in its zip, or a
    /// CourtListener record), not only aliases into other volumes.
    pub fn holds_own_cases(&self) -> bool {
        self.entries.iter().any(|e| !e.is_alias())
    }

    /// Which part `page` is in, when this is part 0.
    pub fn part_for(&self, page: &PageKey) -> usize {
        part_for(&self.parts, page)
    }
}

/// A volume's index file name: `138.idx.gz`, or `138.<n>.idx.gz` for part `n` > 0.
pub fn file_name(volume: &str, part: usize) -> String {
    if part == 0 {
        format!("{}.idx.gz", volume)
    } else {
        format!("{}.{}.idx.gz", volume, part)
    }
}

/// A volume's index file relative to the index build (the manifest's `base`):
/// `<slug>/<file_name>`.
pub fn path(slug: &str, volume: &str, part: usize) -> Result<String> {
    if !crate::cl::is_reporter_slug(slug) {
        bail!("bad reporter slug {:?}", slug);
    }
    if !crate::manifest::is_volume_key(volume) {
        bail!("bad volume {:?}", volume);
    }
    Ok(format!("{}/{}", slug, file_name(volume, part)))
}

/// Order two refs of one source: CourtListener's by cluster id, then hash; CAP's as
/// strings, which puts a folder's cases in file name order and a folded part's after
/// the volume's own.
fn compare_refs(source: Source, a: &str, b: &str) -> Ordering {
    if source == Source::Cl {
        if let (Some(x), Some(y)) = (parse_cl_ref(a), parse_cl_ref(b)) {
            return x.cmp(&y);
        }
    }
    a.cmp(b)
}

/// Sort a volume's entries into file order (page, then the volume's own CAP cases,
/// aliases and CourtListener's records, then ref, then `via`) and drop exact
/// duplicates.
pub fn sort_entries(entries: &mut Vec<Entry>) {
    entries.sort_by(|a, b| {
        a.page
            .cmp(&b.page)
            .then(a.rank().cmp(&b.rank()))
            .then_with(|| compare_refs(a.source, &a.reference, &b.reference))
            .then_with(|| a.via.cmp(&b.via))
    });
    entries.dedup();
}

/// Write a volume's entries as its parts' texts: one part, or several when it passes
/// `split` lines (part 0 then starts with the `#parts` header). The entries are sorted
/// and de-duplicated first. An empty volume has no parts.
pub fn write_parts(mut entries: Vec<Entry>, split: usize) -> Vec<String> {
    sort_entries(&mut entries);
    let mut groups: Vec<&[Entry]> = Vec::new();
    let mut start = 0;
    for i in 1..entries.len() {
        if i - start >= split && entries[i].page != entries[i - 1].page {
            groups.push(&entries[start..i]);
            start = i;
        }
    }
    if !entries.is_empty() {
        groups.push(&entries[start..]);
    }
    let mut texts: Vec<String> = groups
        .iter()
        .map(|g| {
            let mut out = String::new();
            for e in *g {
                out.push_str(&e.line());
                out.push('\n');
            }
            out
        })
        .collect();
    if groups.len() > 1 {
        let header: Vec<String> = groups[1..].iter().map(|g| page_text(&g[0].page)).collect();
        texts[0] = format!("{},{}\n{}", PARTS_HEADER, header.join(","), texts[0]);
    }
    texts
}

/// Gzip an index file deterministically: best compression, mtime 0, no file name.
pub fn gzip(text: &str) -> Vec<u8> {
    let mut gz = flate2::GzBuilder::new()
        .mtime(0)
        .write(Vec::new(), flate2::Compression::best());
    gz.write_all(text.as_bytes())
        .expect("writing to a Vec can't fail");
    gz.finish().expect("writing to a Vec can't fail")
}

/// A volume's lines from its CAP `.bin` and `.multi` files: the `.bin`'s entries (less
/// [`crate::index::LONG_NAME`] markers), then every `.multi` line, numbered or labelled.
/// `folder` is set for a folder folded into another volume's file.
pub fn entries_from_bin(
    bin: &[u8],
    multi: Option<&str>,
    folder: Option<&str>,
) -> Result<Vec<Entry>> {
    use crate::index::{parse_entry, ENTRY_SIZE, LONG_NAME};
    let mut out = Vec::new();
    for (page, chunk) in bin.chunks(ENTRY_SIZE).enumerate() {
        let Ok(entry) = <&[u8; ENTRY_SIZE]>::try_from(chunk) else {
            continue;
        };
        if let Some(name) = parse_entry(entry).filter(|n| *n != LONG_NAME) {
            out.push(Entry::cap(PageKey::Number(page), folder, name)?);
        }
    }
    for line in multi.unwrap_or("").lines() {
        let Some((page, case_file)) = line.split_once(',') else {
            continue;
        };
        let key = parse_page(page).with_context(|| format!("bad .multi page {:?}", page))?;
        out.push(Entry::cap(key, folder, case_file)?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use PageKey::{Label, Number};

    const H1: &str = "0f3a9c2e7b1d4a65";
    const H2: &str = "a1b2c3d4e5f60718";

    fn cap(page: PageKey, file: &str) -> Entry {
        Entry::cap(page, None, file).unwrap()
    }

    fn cl(page: PageKey, id: u64, hash: &str) -> Entry {
        Entry::cl(page, id, hash).unwrap()
    }

    #[test]
    fn parses_lines_with_labels_and_shared_pages() {
        let text = format!(
            "647,cl,9876543/{H1}\n647,cap,0647-01\n647,cap,0647-02\nxxix,cap,xxix-01\n\
             supp. 1,cap,Supp. 1-01\n8,cap,138-2/0008-01\n"
        );
        let idx = parse(&text);
        assert!(idx.malformed.is_empty());
        assert!(idx.parts.is_empty());
        let at_647: Vec<&str> = idx
            .lookup(&Number(647))
            .iter()
            .map(|e| e.reference.as_str())
            .collect();
        // CAP first, then CourtListener, each in file order.
        assert_eq!(at_647, ["0647-01", "0647-02", &format!("9876543/{H1}")]);
        assert_eq!(idx.lookup(&Label("xxix".into()))[0].reference, "xxix-01");
        assert_eq!(
            idx.lookup(&parse_page("Supp. 1").unwrap())[0].reference,
            "Supp. 1-01"
        );
        let folded = idx.lookup(&Number(8))[0];
        assert_eq!(folded.cap_case(), Some((Some("138-2"), "0008-01")));
        assert!(idx.lookup(&Number(648)).is_empty());
        let rec = idx.lookup(&Number(647))[2];
        assert_eq!(rec.cl_record(), Some((9876543, H1)));
        assert_eq!(rec.cap_case(), None);
    }

    #[test]
    fn parses_aliases_with_their_source() {
        // Pettegrew: 260 N.W. 287 is neb/128/0783-01 (stare#160).
        let text = format!(
            "287,cap,neb/128/0783-01,via=cl:8077312\n\
             287,cl,8077312/{H1}\n\
             290,cap,0290-01\n\
             290,cap,neb/128/0790-01,via=cl:5\n\
             291,cap,a3d/138-2/1012-01 , via=cl:6 ,later=x\n"
        );
        let idx = parse(&text);
        assert!(idx.malformed.is_empty(), "{:?}", idx.malformed);
        let at = idx.lookup(&Number(287));
        assert_eq!(at.len(), 2);
        let alias = at[0];
        assert!(alias.is_alias());
        assert_eq!(alias.alias_target(), Some(("neb", "128", "0783-01")));
        assert_eq!(alias.cap_case(), None);
        assert_eq!(alias.via.as_deref(), Some("cl:8077312"));
        assert_eq!(alias.line(), "287,cap,neb/128/0783-01,via=cl:8077312");
        // The alias comes before CourtListener's record at the page...
        assert_eq!(at[1].source, Source::Cl);
        // ...and after the volume's own case.
        let at = idx.lookup(&Number(290));
        assert_eq!(at[0].reference, "0290-01");
        assert!(at[1].is_alias());
        // Whitespace around fields, and a field this reader doesn't know.
        let at = idx.lookup(&Number(291));
        assert_eq!(at[0].alias_target(), Some(("a3d", "138-2", "1012-01")));
        assert_eq!(at[0].via.as_deref(), Some("cl:6"));
        assert!(idx.holds_own_cases());
        assert!(!parse("1,cap,neb/1/0001-01,via=cl:1\n").holds_own_cases());

        let json = serde_json::to_value(alias.view()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"page": "287", "source": "cap", "ref": "neb/128/0783-01",
                               "reporter": "neb", "folder": "128", "case_file": "0783-01",
                               "via": "cl:8077312"})
        );
    }

    #[test]
    fn case_files_with_commas_and_equals_signs_stay_whole() {
        // ohio/10 has `11, 12-01`; a3d/48 has `1265=1275-01`.
        let idx =
            parse("11,cap,11, 12-01\n1265,cap,1265=1275-01\n12,cap,neb/1/11, 12-01,via=cl:9\n");
        assert!(idx.malformed.is_empty());
        assert_eq!(
            idx.lookup(&Number(11))[0].cap_case(),
            Some((None, "11, 12-01"))
        );
        assert_eq!(
            idx.lookup(&Number(1265))[0].cap_case(),
            Some((None, "1265=1275-01"))
        );
        let e = idx.lookup(&Number(12))[0];
        assert_eq!(e.alias_target(), Some(("neb", "1", "11, 12-01")));
        assert_eq!(e.via.as_deref(), Some("cl:9"));
        // Round trip through the writer.
        assert_eq!(parse(&e.line()).entries[0], *e);
    }

    #[test]
    fn rejects_bad_aliases() {
        let text = [
            "1,cap,neb/128/0783-01,via=bogus", // 1: via without a source
            "2,cap,Neb/128/0783-01",           // 2: slug not lowercase
            "3,cap,neb/x128/0783-01",          // 3: folder isn't a volume
            "4,cap,a/b/c/d",                   // 4: four segments
            "5,cap,neb/128/0783-01,via=cl:1,via=cl:2", // 5: two sources
            "6,cap,neb/128/0783-01,via=cl:1",  // fine
        ]
        .join("\n");
        let idx = parse(&text);
        assert_eq!(idx.malformed, [1, 2, 3, 4, 5]);
        assert_eq!(idx.entries.len(), 1);
        assert!(Entry::alias(Number(1), "Neb", "128", "0783-01", 1).is_err());
        assert!(Entry::alias(Number(1), "neb", "../x", "0783-01", 1).is_err());
        assert!(Entry::cap(Number(1), None, "0001-01")
            .unwrap()
            .with_via("nope")
            .is_err());
    }

    #[test]
    fn writer_orders_own_cases_aliases_then_records() {
        let entries = vec![
            cl(Number(5), 1, H1),
            Entry::alias(Number(5), "neb", "128", "0783-01", 9).unwrap(),
            cap(Number(5), "0005-01"),
            Entry::alias(Number(5), "a2d", "31", "0647-01", 8).unwrap(),
            Entry::alias(Number(5), "a2d", "31", "0647-01", 8).unwrap(),
        ];
        assert_eq!(
            write_parts(entries, SPLIT_LINES),
            [format!(
                "5,cap,0005-01\n5,cap,a2d/31/0647-01,via=cl:8\n\
                 5,cap,neb/128/0783-01,via=cl:9\n5,cl,1/{H1}\n"
            )]
        );
    }

    #[test]
    fn via_labels_name_the_source_and_never_say_verified() {
        assert_eq!(via_cluster("cl:8077312"), Some(8077312));
        assert_eq!(via_cluster("cl:x"), None);
        assert_eq!(via_cluster("other:1"), None);
        let label = via_label("cl:8077312");
        assert_eq!(
            label,
            "Resolved through CourtListener's citation metadata (cluster 8077312)"
        );
        assert!(!label.to_lowercase().contains("verif"));
        assert_eq!(via_label("human:7"), "Resolved through human:7");
        assert_eq!(
            via_label("nominative:us"),
            "Resolved as the U.S. Reports under its reporter's name"
        );
        assert_eq!(via_cluster("nominative:us"), None);
        for via in ["official:us", "official:ohio", "official:ohio-st"] {
            assert_eq!(via_label(via), "Resolved by the reporter's official page; CAP's scan numbers the case on another page");
            assert!(!via_label(via).to_lowercase().contains("verif"));
        }
        assert_eq!(via_label("officials:us"), "Resolved through officials:us");
    }

    #[test]
    fn skips_malformed_lines_and_reports_them() {
        let text = [
            "1,cap,0001-01",                 // 1
            "",                              // 2: blank
            "# a comment",                   // 3: ignored
            "2,cap",                         // 4: too few fields
            "x,y,z,w",                       // 5: bad tag "y"? no: tag must be known or lowercase
            "3,CAP,0003-01",                 // 6: uppercase tag
            &format!("4,cl,12/{H1}x"),       // 7: bad hash
            "5,cl,../x",                     // 8: not a record
            ",cap,0005-01",                  // 9: no page
            "6,cap,",                        // 10: no ref
            "7,cap,../7/0007-01",            // 11: folder isn't a volume
            "8,future,whatever",             // 12: an unknown source, skipped quietly
            "99999999999999999999999,cap,x", // 13: page too large
            " 9,cap,0009-01 \r",             // 14: fine once trimmed
            "#parts,10",                     // 15: a header not on the first line
        ]
        .join("\n");
        let idx = parse(&text);
        let refs: Vec<&str> = idx.entries.iter().map(|e| e.reference.as_str()).collect();
        // Line 5 has a known-shape tag "y" that no reader knows: skipped, not malformed.
        assert_eq!(refs, ["0001-01", "0009-01"]);
        assert_eq!(idx.malformed, [4, 6, 7, 8, 9, 10, 11, 13, 15]);
        assert!(idx.parts.is_empty());
    }

    #[test]
    fn parts_header_and_part_selection() {
        let idx = parse("#parts,500,1200,xx\n1,cap,0001-01\n");
        assert_eq!(idx.parts, [Number(500), Number(1200), Label("xx".into())]);
        assert_eq!(idx.part_for(&Number(1)), 0);
        assert_eq!(idx.part_for(&Number(499)), 0);
        assert_eq!(idx.part_for(&Number(500)), 1);
        assert_eq!(idx.part_for(&Number(1199)), 1);
        assert_eq!(idx.part_for(&Number(5000)), 2);
        // Labels sort after every number.
        assert_eq!(idx.part_for(&Label("i".into())), 2);
        assert_eq!(idx.part_for(&Label("xxix".into())), 3);
        // A header out of order is malformed, and the volume reads as unsplit.
        let bad = parse("#parts,10,5\n1,cap,0001-01\n");
        assert!(bad.parts.is_empty());
        assert_eq!(bad.malformed, [1]);
        assert_eq!(bad.entries.len(), 1);
    }

    #[test]
    fn writes_sorted_deduplicated_lines() {
        let entries = vec![
            cl(Number(100), 20, H2),
            cl(Number(100), 3, H1),
            cap(Label("xxix".into()), "xxix-01"),
            cap(Number(100), "0100-02"),
            Entry::cap(Number(100), Some("5-2"), "0100-01").unwrap(),
            cap(Number(100), "0100-01"),
            cap(Number(9), "0009-01"),
            cap(Number(9), "0009-01"),
        ];
        let parts = write_parts(entries, SPLIT_LINES);
        assert_eq!(
            parts,
            [format!(
                "9,cap,0009-01\n100,cap,0100-01\n100,cap,0100-02\n100,cap,5-2/0100-01\n\
                 100,cl,3/{H1}\n100,cl,20/{H2}\nxxix,cap,xxix-01\n"
            )]
        );
        assert!(write_parts(Vec::new(), SPLIT_LINES).is_empty());
    }

    #[test]
    fn splits_at_the_page_boundary_after_the_limit() {
        // Pages 1..=5 with three cases each, a split every 4 lines: a part ends once it
        // has 4 or more lines, at the next page, so parts hold 6, 6 and 3 lines.
        let mut entries = Vec::new();
        for page in 1..=5 {
            for seq in 1..=3 {
                entries.push(cap(Number(page), &format!("{page:04}-{seq:02}")));
            }
        }
        let parts = write_parts(entries, 4);
        assert_eq!(parts.len(), 3);
        assert!(parts[0].starts_with("#parts,3,5\n1,cap,0001-01\n"));
        assert!(parts[1].starts_with("3,cap,0003-01\n"));
        assert_eq!(parts[2], "5,cap,0005-01\n5,cap,0005-02\n5,cap,0005-03\n");
        let p0 = parse(&parts[0]);
        assert_eq!(p0.entries.len(), 6);
        assert_eq!(p0.part_for(&Number(4)), 1);
        assert_eq!(p0.part_for(&Number(5)), 2);
        // No page straddles two parts.
        for (i, text) in parts.iter().enumerate() {
            for e in parse(text).entries {
                assert_eq!(p0.part_for(&e.page), i, "{}", e.line());
            }
        }
    }

    #[test]
    fn one_huge_page_stays_in_one_part() {
        let entries: Vec<Entry> = (0..30).map(|i| cl(Number(7), i, H1)).collect();
        assert_eq!(write_parts(entries, 4).len(), 1);
    }

    #[test]
    fn gzip_is_deterministic_and_decodes() {
        let text = "1,cap,0001-01\n";
        let a = gzip(text);
        assert_eq!(a, gzip(text));
        // mtime is zero.
        assert_eq!(&a[4..8], &[0, 0, 0, 0]);
        assert_eq!(decode(&a).unwrap(), text);
        assert_eq!(decode(text.as_bytes()).unwrap(), text);
        assert_eq!(parse_bytes(&a).unwrap().entries.len(), 1);
        assert!(decode(&[0x1f, 0x8b, 0, 0]).is_err());
    }

    #[test]
    fn paths_and_file_names() {
        assert_eq!(path("a3d", "138", 0).unwrap(), "a3d/138.idx.gz");
        assert_eq!(
            path("ny-slip-op", "2019", 2).unwrap(),
            "ny-slip-op/2019.2.idx.gz"
        );
        assert!(path("../a3d", "1", 0).is_err());
        assert!(path("a3d", "1/..", 0).is_err());
        assert_eq!(file_name("33-suppl", 0), "33-suppl.idx.gz");
    }

    #[test]
    fn pages_parse_as_cited() {
        assert_eq!(parse_page("0647"), Some(Number(647)));
        assert_eq!(parse_page(" XXIX "), Some(Label("xxix".into())));
        assert_eq!(parse_page("125678"), Some(Number(125678)));
        assert_eq!(parse_page(""), None);
        assert_eq!(parse_page("a,b"), None);
        assert_eq!(parse_page("#1"), None);
    }

    #[test]
    fn entries_validate() {
        assert!(Entry::cl(Number(1), 1, "nothex").is_err());
        assert!(Entry::cap(Number(1), Some("../x"), "0001-01").is_err());
        assert!(Entry::cap(Number(1), None, "a/b").is_err());
        assert!(Entry::cap(Label("A".into()), None, "0001-01").is_err());
        assert!(Entry::cap(Label("12".into()), None, "0001-01").is_err());
    }

    #[test]
    fn converts_bin_and_multi_losslessly() {
        let built = crate::index::build(&[
            ("0005-01", Number(5)),
            ("0005-02", Number(5)),
            ("[106]-01", Number(106)),
            ("xxix-01", Label("xxix".into())),
        ]);
        let multi = built.multi_file();
        let mut entries = entries_from_bin(&built.bin, multi.as_deref(), None).unwrap();
        sort_entries(&mut entries);
        let lines: Vec<String> = entries.iter().map(Entry::line).collect();
        assert_eq!(
            lines,
            [
                "5,cap,0005-01",
                "5,cap,0005-02",
                "106,cap,[106]-01",
                "xxix,cap,xxix-01"
            ]
        );
        let folded = entries_from_bin(&built.bin, None, Some("1-2")).unwrap();
        assert_eq!(folded[0].reference, "1-2/0005-01");
    }

    #[test]
    fn view_takes_refs_apart() {
        let e = Entry::cap(Number(8), Some("138-2"), "0008-01").unwrap();
        let json = serde_json::to_value(e.view()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"page": "8", "source": "cap", "ref": "138-2/0008-01",
                               "folder": "138-2", "case_file": "0008-01"})
        );
        let e = cl(Label("xx".into()), 5, H1);
        let json = serde_json::to_value(e.view()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"page": "xx", "source": "cl", "ref": format!("5/{H1}"),
                               "cluster_id": 5, "hash": H1})
        );
    }

    /// A small deterministic generator for the property tests (no extra dependency).
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    fn random_entries(rng: &mut Rng) -> Vec<Entry> {
        let n = rng.below(400) as usize;
        let labels = ["i", "ii", "xxix", "supp. 1", "?"];
        (0..n)
            .map(|_| {
                let page = if rng.below(10) == 0 {
                    Label(labels[rng.below(labels.len() as u64) as usize].to_string())
                } else {
                    Number(rng.below(120) as usize)
                };
                let p = page_text(&page);
                match rng.below(4) {
                    0 => cl(page, rng.below(1_000_000), H1),
                    3 => Entry::alias(
                        page,
                        "neb",
                        &rng.below(200).to_string(),
                        &format!("{:04}-01", rng.below(900)),
                        rng.below(10),
                    )
                    .unwrap(),
                    1 => {
                        Entry::cap(page, Some("9-2"), &format!("{p}-{:02}", rng.below(4))).unwrap()
                    }
                    _ => cap(page, &format!("{p}-{:02}", rng.below(4))),
                }
            })
            .collect()
    }

    #[test]
    fn property_round_trip_split_and_lookup() {
        let mut rng = Rng(0x5eed_1101);
        for _ in 0..300 {
            let entries = random_entries(&mut rng);
            let split = 1 + rng.below(60) as usize;
            let parts = write_parts(entries.clone(), split);
            let mut expected = entries.clone();
            sort_entries(&mut expected);

            // Round trip: every part parses cleanly and together they hold every entry
            // once, in file order.
            let parsed: Vec<VolumeIndex> = parts.iter().map(|p| parse(p)).collect();
            let all: Vec<Entry> = parsed.iter().flat_map(|p| p.entries.clone()).collect();
            assert_eq!(all, expected);
            assert!(parsed.iter().all(|p| p.malformed.is_empty()));
            let head = parsed.first().cloned().unwrap_or_default();
            assert_eq!(head.parts.len(), parts.len().saturating_sub(1));

            for (i, part) in parsed.iter().enumerate() {
                // Every part but the last passes the limit; no page straddles a boundary.
                if i + 1 < parsed.len() {
                    assert!(part.entries.len() >= split);
                }
                for e in &part.entries {
                    assert_eq!(head.part_for(&e.page), i);
                }
            }

            // Lookup through the part a page falls in finds exactly the page's entries,
            // CAP first.
            for e in &entries {
                let part = &parsed[head.part_for(&e.page)];
                let found = part.lookup(&e.page);
                assert!(found.contains(&e));
                let want: Vec<&Entry> = expected.iter().filter(|x| x.page == e.page).collect();
                assert_eq!(found, want);
                let ranks: Vec<u8> = found.iter().map(|x| x.rank()).collect();
                assert!(ranks.windows(2).all(|w| w[0] <= w[1]));
            }

            // Gzip is a pure function of the text.
            for p in &parts {
                assert_eq!(decode(&gzip(p)).unwrap(), *p);
            }
        }
    }
}
