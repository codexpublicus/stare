/// Binary citation index format.
///
/// Each volume gets a `.bin` file where page N maps to byte offset N * ENTRY_SIZE.
/// Each entry is 8 bytes: a null-padded case filename like "0647-01\0".
/// An all-zero entry means no case starts at that page.

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

/// Build a .bin index from a list of (case_filename, first_page) pairs.
pub fn build(cases: &[(&str, usize)]) -> Vec<u8> {
    let max_page = cases.iter().map(|(_, p)| *p).max().unwrap_or(0);
    let mut bin = vec![0u8; (max_page + 1) * ENTRY_SIZE];
    for &(filename, page) in cases {
        let start = page * ENTRY_SIZE;
        let bytes = filename.as_bytes();
        let len = bytes.len().min(ENTRY_SIZE - 1);
        bin[start..start + len].copy_from_slice(&bytes[..len]);
    }
    bin
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
        let cases = vec![
            ("0647-01", 647),
            ("0649-01", 649),
            ("0652-01", 652),
        ];
        let bin = build(&cases);

        assert_eq!(lookup(&bin, 647), Some("0647-01"));
        assert_eq!(lookup(&bin, 649), Some("0649-01"));
        assert_eq!(lookup(&bin, 652), Some("0652-01"));
        assert_eq!(lookup(&bin, 648), None);
        // Bin should be large enough to hold page 652
        assert!(bin.len() >= (652 + 1) * ENTRY_SIZE);
    }
}
