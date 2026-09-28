//! Binary citation index format.
//!
//! Each volume gets a `.bin` file where page N maps to byte offset N * ENTRY_SIZE.
//! Each entry is 8 bytes: a null-padded case filename like "0647-01\0".
//! An all-zero entry means no case starts at that page.

pub const ENTRY_SIZE: usize = 8;

/// Parse an 8-byte bin entry into a case filename, or None if the entry is all zeros.
pub fn parse_entry(entry: &[u8; ENTRY_SIZE]) -> Option<&str> {
    if entry.iter().all(|&b| b == 0) {
        return None;
    }
    let end = entry.iter().position(|&b| b == 0).unwrap_or(ENTRY_SIZE);
    Some(std::str::from_utf8(&entry[..end]).expect("invalid utf-8 in bin entry"))
}

/// Byte offset into a .bin file for a given page number.
pub fn page_offset(page: usize) -> usize {
    page * ENTRY_SIZE
}

/// Look up a page in bin data, returning the case filename if one exists.
pub fn lookup(bin: &[u8], page: usize) -> Option<&str> {
    let start = page_offset(page);
    if start + ENTRY_SIZE > bin.len() {
        return None;
    }
    let entry: &[u8; ENTRY_SIZE] = bin[start..start + ENTRY_SIZE].try_into().unwrap();
    parse_entry(entry)
}

/// Result of building an index: the .bin data and any multi-case overflow entries.
pub struct BuildResult {
    /// The .bin index data (page → first case at that page)
    pub bin: Vec<u8>,
    /// Overflow entries for pages with multiple cases: (page, case_filename)
    pub multi: Vec<(usize, String)>,
}

/// Build a .bin index from a list of (case_filename, first_page) pairs.
///
/// The .bin holds the -01 case for each page. If multiple cases share a page,
/// the first (by filename sort order, i.e. -01) goes in .bin and the rest go
/// into the `multi` overflow list.
pub fn build(cases: &[(&str, usize)]) -> BuildResult {
    let max_page = cases.iter().map(|(_, p)| *p).max().unwrap_or(0);
    let mut bin = vec![0u8; (max_page + 1) * ENTRY_SIZE];
    let mut multi = Vec::new();

    // Group by page, sort within each page to ensure -01 is first
    let mut by_page: std::collections::BTreeMap<usize, Vec<&str>> =
        std::collections::BTreeMap::new();
    for &(filename, page) in cases {
        by_page.entry(page).or_default().push(filename);
    }

    for (page, mut filenames) in by_page {
        filenames.sort();
        // First case goes in .bin
        let primary = filenames[0];
        let start = page * ENTRY_SIZE;
        let bytes = primary.as_bytes();
        let len = bytes.len().min(ENTRY_SIZE - 1);
        bin[start..start + len].copy_from_slice(&bytes[..len]);

        // Remaining cases go in multi
        for &overflow in &filenames[1..] {
            multi.push((page, overflow.to_string()));
        }
    }

    BuildResult { bin, multi }
}

/// Serialize multi-case entries to a text format: "page,case_file\n"
pub fn serialize_multi(multi: &[(usize, String)]) -> String {
    let mut out = String::new();
    for (page, case_file) in multi {
        out.push_str(&format!("{},{}\n", page, case_file));
    }
    out
}

/// Parse multi-case entries from text format.
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

/// Look up all cases at a page, including multi-case overflow.
pub fn lookup_all<'a>(bin: &'a [u8], multi: &'a [(usize, String)], page: usize) -> Vec<&'a str> {
    let mut results = Vec::new();
    if let Some(primary) = lookup(bin, page) {
        results.push(primary);
    }
    for (p, case_file) in multi {
        if *p == page {
            results.push(case_file.as_str());
        }
    }
    results
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
    fn multi_roundtrip_serialization() {
        let multi = vec![(657, "0657-02".to_string()), (100, "0100-02".to_string())];
        let serialized = serialize_multi(&multi);
        let parsed = parse_multi(&serialized);
        assert_eq!(parsed, multi);
    }
}
