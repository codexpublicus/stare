//! Binary citation index format.
//!
//! Each volume gets a `.bin` file where page N maps to byte offset N * ENTRY_SIZE.
//! Each entry is 8 bytes: a null-padded case filename like "0647-01\0".
//! An all-zero entry means no case starts at that page.
//!
//! An entry holds at most 7 bytes of file name. A page whose first case has a longer
//! name (`1107½-01`, `[106]-01`, `1114-1140-01`) gets [`LONG_NAME`] in the `.bin`
//! instead, and every case at that page goes in the `.multi` file, which has no length
//! limit. Readers that predate the marker try to open a case called `*` and fail, as they
//! did on the truncated names it replaces.
//!
//! The `.multi` file is lines of `page,case_file`: the second and later cases at a page,
//! and every case at a [`LONG_NAME`] page. A case whose first page isn't a number (roman
//! numeral front matter like `xxix`, `Supp. 1`) has its page label, lowercased, in place
//! of the number. Readers that parse the page as a number skip those lines.

pub const ENTRY_SIZE: usize = 8;

/// The `.bin` entry for a page whose cases are all in the `.multi` file.
pub const LONG_NAME: &str = "*";

/// Parse an 8-byte bin entry into a case filename, or None if the entry is all zeros
/// (or, in a corrupt index, not UTF-8).
pub fn parse_entry(entry: &[u8; ENTRY_SIZE]) -> Option<&str> {
    if entry.iter().all(|&b| b == 0) {
        return None;
    }
    let end = entry.iter().position(|&b| b == 0).unwrap_or(ENTRY_SIZE);
    std::str::from_utf8(&entry[..end]).ok()
}

/// Byte offset into a .bin file for a given page number.
pub fn page_offset(page: usize) -> usize {
    page * ENTRY_SIZE
}

/// Look up a page in bin data, returning its entry if one exists: a case filename, or
/// [`LONG_NAME`] when the page's cases are in the `.multi` file.
pub fn lookup(bin: &[u8], page: usize) -> Option<&str> {
    let start = page_offset(page);
    if start + ENTRY_SIZE > bin.len() {
        return None;
    }
    let entry: &[u8; ENTRY_SIZE] = bin[start..start + ENTRY_SIZE].try_into().unwrap();
    parse_entry(entry)
}

/// Where a case starts: a page number, or a label for a page that isn't numbered
/// (`xxix`, `supp. 1`).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum PageKey {
    Number(usize),
    Label(String),
}

impl From<usize> for PageKey {
    fn from(n: usize) -> Self {
        PageKey::Number(n)
    }
}

fn is_roman(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| "ivxlcdmIVXLCDM".contains(c))
}

/// The page key for a case, from its first page as CAP labels it (`first_page` in
/// CasesMetadata.json, or the part of the file name before the sequence number):
///
///   "647", "0647"      → 647
///   "1265=1275"        → 1265 (the first of a joined pair)
///   "105, 106"         → 105
///   "1114-1140"        → 1114
///   "428e", "1107½"    → 428, 1107 (pages inserted after the numbered one)
///   "[106]"            → 106
///   "B174", "R1"       → 174, 1 (a one-letter series prefix)
///   "xxix", "000i"     → label "xxix", "i" (roman numeral front matter)
///   "Supp. 1"          → label "supp. 1"
///   "000?"             → label "?"
pub fn page_key(first_page: &str) -> PageKey {
    let raw = first_page.trim();
    let unbracketed: String = raw.chars().filter(|c| !matches!(c, '[' | ']')).collect();
    let chunk = unbracketed
        .split(['=', ',', ' '])
        .next()
        .unwrap_or("")
        .trim();
    let unpadded = chunk.trim_start_matches('0');
    let number = |s: &str| -> Option<usize> {
        let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
        digits.parse().ok()
    };
    if let Some(n) = number(unpadded) {
        return PageKey::Number(n);
    }
    if unpadded.is_empty() && !chunk.is_empty() {
        return PageKey::Number(0);
    }
    if is_roman(unpadded) {
        return PageKey::Label(unpadded.to_lowercase());
    }
    let mut chars = unpadded.chars();
    if matches!(chars.next(), Some(c) if c.is_ascii_alphabetic()) {
        if let Some(n) = number(chars.as_str()) {
            return PageKey::Number(n);
        }
    }
    let label = raw
        .trim_start_matches('0')
        .to_lowercase()
        .replace([',', '\n', '\r'], " ");
    PageKey::Label(if label.is_empty() {
        raw.to_lowercase()
    } else {
        label
    })
}

/// The first page label in a case file name: `0647-01` → `0647`.
pub fn file_page(case_file: &str) -> &str {
    case_file
        .rsplit_once('-')
        .map_or(case_file, |(page, _)| page)
}

/// Result of building an index: the .bin data and the .multi entries.
pub struct BuildResult {
    /// The .bin index data (page → first case at that page, or [`LONG_NAME`])
    pub bin: Vec<u8>,
    /// Overflow entries for numbered pages: (page, case_filename)
    pub multi: Vec<(usize, String)>,
    /// Cases on unnumbered pages: (label, case_filename)
    pub labeled: Vec<(String, String)>,
}

impl BuildResult {
    /// The `.multi` file's contents, or None when the volume needs none.
    pub fn multi_file(&self) -> Option<String> {
        if self.multi.is_empty() && self.labeled.is_empty() {
            return None;
        }
        let mut out = serialize_multi(&self.multi);
        for (label, case_file) in &self.labeled {
            out.push_str(&format!("{},{}\n", label, case_file));
        }
        Some(out)
    }
}

/// Build a .bin index from a list of (case_filename, first_page) pairs.
///
/// The .bin holds the -01 case for each page. If multiple cases share a page,
/// the first (by filename sort order, i.e. -01) goes in .bin and the rest go
/// into the `multi` overflow list. See the module docs for long names and labels.
pub fn build<K: Clone + Into<PageKey>>(cases: &[(&str, K)]) -> BuildResult {
    let mut by_page: std::collections::BTreeMap<usize, Vec<&str>> =
        std::collections::BTreeMap::new();
    let mut labeled = Vec::new();
    for (filename, key) in cases {
        match key.clone().into() {
            PageKey::Number(page) => by_page.entry(page).or_default().push(filename),
            PageKey::Label(label) => labeled.push((label, filename.to_string())),
        }
    }
    labeled.sort();

    let max_page = by_page.keys().next_back().copied().unwrap_or(0);
    let mut bin = vec![0u8; (max_page + 1) * ENTRY_SIZE];
    let mut multi = Vec::new();

    for (page, mut filenames) in by_page {
        // Sort within each page so -01 is first
        filenames.sort();
        let primary = filenames[0];
        let start = page * ENTRY_SIZE;
        let (entry, overflow) = if primary.len() < ENTRY_SIZE {
            (primary, &filenames[1..])
        } else {
            (LONG_NAME, &filenames[..])
        };
        bin[start..start + entry.len()].copy_from_slice(entry.as_bytes());
        for &case_file in overflow {
            multi.push((page, case_file.to_string()));
        }
    }

    BuildResult {
        bin,
        multi,
        labeled,
    }
}

/// Serialize multi-case entries to a text format: "page,case_file\n"
pub fn serialize_multi(multi: &[(usize, String)]) -> String {
    let mut out = String::new();
    for (page, case_file) in multi {
        out.push_str(&format!("{},{}\n", page, case_file));
    }
    out
}

/// Parse multi-case entries from text format: the numbered pages only.
pub fn parse_multi(data: &str) -> Vec<(usize, String)> {
    data.lines()
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let (page_str, case_file) = line.split_once(',')?;
            let page: usize = page_str.parse().ok()?;
            Some((page, case_file.to_string()))
        })
        .collect()
}

/// Parse the `.multi` lines for unnumbered pages: (label, case_file).
pub fn parse_labeled(data: &str) -> Vec<(String, String)> {
    data.lines()
        .filter_map(|line| line.split_once(','))
        .filter(|(page, _)| page.parse::<usize>().is_err())
        .map(|(label, case_file)| (label.to_string(), case_file.to_string()))
        .collect()
}

/// Look up all cases at a page, including multi-case overflow.
pub fn lookup_all<'a>(bin: &'a [u8], multi: &'a [(usize, String)], page: usize) -> Vec<&'a str> {
    let mut results = Vec::new();
    if let Some(primary) = lookup(bin, page).filter(|e| *e != LONG_NAME) {
        results.push(primary);
    }
    for (p, case_file) in multi {
        if *p == page {
            results.push(case_file.as_str());
        }
    }
    results
}

/// Every case filename a volume's index files hold, in index order: the `.bin` entries
/// (less [`LONG_NAME`] markers), then the `.multi` lines, numbered and labeled.
pub fn all_cases<'a>(bin: &'a [u8], multi: Option<&'a str>) -> Vec<&'a str> {
    let mut out: Vec<&str> = bin
        .chunks(ENTRY_SIZE)
        .filter_map(|chunk| <&[u8; ENTRY_SIZE]>::try_from(chunk).ok())
        .filter_map(parse_entry)
        .filter(|e| *e != LONG_NAME)
        .collect();
    if let Some(multi) = multi {
        out.extend(
            multi
                .lines()
                .filter_map(|line| line.split_once(','))
                .map(|(_, case_file)| case_file),
        );
    }
    out
}

/// The cases on an unnumbered page, by label (case-insensitive).
pub fn lookup_label<'a>(labeled: &'a [(String, String)], label: &str) -> Vec<&'a str> {
    let label = label.trim().to_lowercase();
    labeled
        .iter()
        .filter(|(l, _)| *l == label)
        .map(|(_, f)| f.as_str())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_valid_entry() {
        let entry = b"0647-01\0";
        let case_file = parse_entry(entry);
        assert_eq!(case_file, Some("0647-01"));
    }

    #[test]
    fn parse_null_entry_returns_none() {
        let entry = [0u8; ENTRY_SIZE];
        let case_file = parse_entry(&entry);
        assert_eq!(case_file, None);
    }

    #[test]
    fn byte_offset_for_page() {
        assert_eq!(page_offset(647), 647 * ENTRY_SIZE);
        assert_eq!(page_offset(0), 0);
        assert_eq!(page_offset(1), ENTRY_SIZE);
    }

    #[test]
    fn lookup_case_in_bin_data() {
        // Simulate a small .bin with cases at pages 2 and 5
        let mut bin = vec![0u8; ENTRY_SIZE * 6];
        bin[ENTRY_SIZE * 2..ENTRY_SIZE * 3].copy_from_slice(b"0002-01\0");
        bin[ENTRY_SIZE * 5..ENTRY_SIZE * 6].copy_from_slice(b"0005-01\0");

        assert_eq!(lookup(&bin, 2), Some("0002-01"));
        assert_eq!(lookup(&bin, 5), Some("0005-01"));
        assert_eq!(lookup(&bin, 0), None);
        assert_eq!(lookup(&bin, 3), None);
    }

    #[test]
    fn lookup_page_beyond_bin_returns_none() {
        let bin = vec![0u8; ENTRY_SIZE * 3];
        assert_eq!(lookup(&bin, 10), None);
    }

    #[test]
    fn build_bin_from_cases() {
        let cases = vec![("0647-01", 647), ("0649-01", 649), ("0652-01", 652)];
        let result = build(&cases);

        assert_eq!(lookup(&result.bin, 647), Some("0647-01"));
        assert_eq!(lookup(&result.bin, 649), Some("0649-01"));
        assert_eq!(lookup(&result.bin, 652), Some("0652-01"));
        assert_eq!(lookup(&result.bin, 648), None);
        assert!(result.bin.len() >= (652 + 1) * ENTRY_SIZE);
        assert!(result.multi.is_empty());
    }

    #[test]
    fn build_keeps_first_case_in_bin_for_multi_page() {
        let cases = vec![("0657-01", 657), ("0657-02", 657), ("0647-01", 647)];
        let result = build(&cases);

        // -01 should be in .bin
        assert_eq!(lookup(&result.bin, 657), Some("0657-01"));
        // -02 should be in multi
        assert_eq!(result.multi, vec![(657, "0657-02".to_string())]);
    }

    #[test]
    fn build_handles_three_cases_on_same_page() {
        let cases = vec![("0100-03", 100), ("0100-01", 100), ("0100-02", 100)];
        let result = build(&cases);

        assert_eq!(lookup(&result.bin, 100), Some("0100-01"));
        assert_eq!(result.multi.len(), 2);
        assert_eq!(result.multi[0], (100, "0100-02".to_string()));
        assert_eq!(result.multi[1], (100, "0100-03".to_string()));
    }

    #[test]
    fn lookup_all_returns_primary_and_overflow() {
        let cases = vec![("0657-01", 657), ("0657-02", 657), ("0647-01", 647)];
        let result = build(&cases);

        assert_eq!(
            lookup_all(&result.bin, &result.multi, 657),
            vec!["0657-01", "0657-02"]
        );
        assert_eq!(lookup_all(&result.bin, &result.multi, 647), vec!["0647-01"]);
        assert!(lookup_all(&result.bin, &result.multi, 648).is_empty());
    }

    #[test]
    fn long_names_go_to_multi_behind_a_marker() {
        // Seven bytes fit; 1107½-01 is nine. Nothing is truncated.
        let cases = vec![
            ("1107-01", 1107),
            ("1107½-02", 1107),
            ("1107½-01", 1107),
            ("[106]-01", 106),
        ];
        let result = build(&cases);

        assert_eq!(lookup(&result.bin, 1107), Some("1107-01"));
        assert_eq!(lookup(&result.bin, 106), Some(LONG_NAME));
        assert_eq!(
            lookup_all(&result.bin, &result.multi, 1107),
            vec!["1107-01", "1107½-01", "1107½-02"]
        );
        assert_eq!(
            lookup_all(&result.bin, &result.multi, 106),
            vec!["[106]-01"]
        );
    }

    #[test]
    fn long_name_marker_survives_the_multi_file() {
        let result = build(&[("1114-1140-01", 1114), ("1114-1140-02", 1114)]);
        let text = result.multi_file().unwrap();
        let multi = parse_multi(&text);
        assert_eq!(
            lookup_all(&result.bin, &multi, 1114),
            vec!["1114-1140-01", "1114-1140-02"]
        );
        assert_eq!(all_cases(&result.bin, Some(&text)).len(), 2);
    }

    #[test]
    fn labeled_pages_go_to_multi_and_old_readers_skip_them() {
        let cases = vec![
            ("0001-01", PageKey::Number(1)),
            ("xxix-01", PageKey::Label("xxix".into())),
            ("Supp. 1-01", PageKey::Label("supp. 1".into())),
        ];
        let result = build(&cases);
        let text = result.multi_file().unwrap();

        assert_eq!(text, "supp. 1,Supp. 1-01\nxxix,xxix-01\n");
        // A reader that only knows numbered pages sees nothing new.
        assert!(parse_multi(&text).is_empty());
        let labeled = parse_labeled(&text);
        assert_eq!(lookup_label(&labeled, "XXIX"), vec!["xxix-01"]);
        assert_eq!(lookup_label(&labeled, "Supp. 1"), vec!["Supp. 1-01"]);
        assert_eq!(
            all_cases(&result.bin, Some(&text)),
            vec!["0001-01", "Supp. 1-01", "xxix-01"]
        );
    }

    #[test]
    fn no_multi_file_when_every_page_has_one_short_case() {
        assert!(build(&[("0001-01", 1)]).multi_file().is_none());
    }

    #[test]
    fn invalid_utf8_entry_is_no_entry() {
        let entry = [0x31, 0xC2, 0, 0, 0, 0, 0, 0];
        assert_eq!(parse_entry(&entry), None);
    }

    #[test]
    fn page_keys_from_cap_first_pages() {
        use PageKey::{Label, Number};
        let cases: &[(&str, PageKey)] = &[
            ("647", Number(647)),
            ("0647", Number(647)),
            ("1265=1275", Number(1265)),
            ("105, 106", Number(105)),
            ("1114-1140", Number(1114)),
            ("102-2", Number(102)),
            ("428e", Number(428)),
            ("1028A", Number(1028)),
            ("1107½", Number(1107)),
            ("[106]", Number(106)),
            ("0[1]", Number(1)),
            ("B174", Number(174)),
            ("00R1", Number(1)),
            ("0000", Number(0)),
            ("xxix", Label("xxix".into())),
            ("LXII", Label("lxii".into())),
            ("000i", Label("i".into())),
            ("0LXI", Label("lxi".into())),
            ("Supp. 1", Label("supp. 1".into())),
            ("CJP Supp. 1", Label("cjp supp. 1".into())),
            ("000?", Label("?".into())),
        ];
        for (first_page, key) in cases {
            assert_eq!(&page_key(first_page), key, "{first_page}");
        }
    }

    #[test]
    fn file_page_strips_the_sequence() {
        assert_eq!(file_page("0647-01"), "0647");
        assert_eq!(file_page("1114-1140-01"), "1114-1140");
        assert_eq!(file_page("Supp. 1-01"), "Supp. 1");
    }

    #[test]
    fn multi_roundtrip_serialization() {
        let multi = vec![(657, "0657-02".to_string()), (100, "0100-02".to_string())];
        let serialized = serialize_multi(&multi);
        let parsed = parse_multi(&serialized);
        assert_eq!(parsed, multi);
    }
}
