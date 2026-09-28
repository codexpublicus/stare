use wasm_bindgen::prelude::*;

/// Look up a case filename from a .bin index given a page number.
/// Returns the case filename (e.g., "0647-01") or null if no case at that page.
#[wasm_bindgen]
pub fn lookup_page(bin_data: &[u8], page: u32) -> Option<String> {
    stare::index::lookup(bin_data, page as usize).map(|s| s.to_string())
}

/// Look up all cases at a page (including multi-case overflow).
/// Returns a JSON array of case filenames.
#[wasm_bindgen]
pub fn lookup_page_all(bin_data: &[u8], multi_data: &str, page: u32) -> String {
    let multi = stare::index::parse_multi(multi_data);
    let results = stare::index::lookup_all(bin_data, &multi, page as usize);
    serde_json::to_string(&results).unwrap_or_else(|_| "[]".to_string())
}

/// Extract a case JSON from a zip file's bytes by case filename.
/// Returns the full case JSON string, or throws on error.
#[wasm_bindgen]
pub fn extract_case(zip_bytes: &[u8], case_file: &str) -> Result<String, JsError> {
    let case = stare::case::extract_from_zip(zip_bytes, case_file)
        .map_err(|e| JsError::new(&e.to_string()))?;
    serde_json::to_string(&case).map_err(|e| JsError::new(&e.to_string()))
}

/// Extract a raw file from a zip by path. Returns the file contents as a string.
#[wasm_bindgen]
pub fn extract_file(zip_bytes: &[u8], path: &str) -> Result<String, JsError> {
    stare::case::extract_file_from_zip(zip_bytes, path).map_err(|e| JsError::new(&e.to_string()))
}

/// Extract and parse CasesMetadata.json from a zip. Returns JSON array.
#[wasm_bindgen]
pub fn extract_cases_metadata(zip_bytes: &[u8]) -> Result<String, JsError> {
    let metadata =
        stare::case::extract_cases_metadata(zip_bytes).map_err(|e| JsError::new(&e.to_string()))?;
    serde_json::to_string(&metadata).map_err(|e| JsError::new(&e.to_string()))
}

/// Get page order range for a case. Returns JSON: { first: N, last: N } or null.
#[wasm_bindgen]
pub fn get_page_orders(zip_bytes: &[u8], case_file: &str) -> Result<String, JsError> {
    let orders = stare::case::get_page_orders(zip_bytes, case_file)
        .map_err(|e| JsError::new(&e.to_string()))?;
    match orders {
        Some((first, last)) => Ok(format!("{{\"first\":{},\"last\":{}}}", first, last)),
        None => Ok("null".to_string()),
    }
}

/// Parse gzipped ALTO XML into structured page data with word bounding boxes.
/// Returns JSON: { width, height, lines: [{ x, y, width, height, words: [{ text, x, y, width, height, confidence }] }] }
#[wasm_bindgen]
pub fn parse_alto(gz_data: &[u8]) -> Result<String, JsError> {
    let page = stare::alto::parse_alto_gz(gz_data).map_err(|e| JsError::new(&e.to_string()))?;
    serde_json::to_string(&page).map_err(|e| JsError::new(&e.to_string()))
}

/// Detect citations in text using citare. Returns JSON array of DetectedCitation.
/// Each has: matched_text, citation_type, span, harvard_slug, volume, page, reporter, year.
///
/// `span` is converted here, at the WASM boundary, from citare_core's UTF-8
/// byte offsets to Unicode scalar value (char) offsets, matching how
/// gorsuch-library's page viewer indexes the same served text. JS callers
/// that use `span` with `String.prototype.slice` (UTF-16 code units) still
/// need to convert further; stare's own web UI does not use `span` today.
/// Throws (rejects with a JsError) if a span's byte offset doesn't land on a
/// char boundary in `text`; that should never happen and is a bug upstream,
/// not something this function guesses its way past.
#[wasm_bindgen]
pub fn detect_citations(text: &str) -> Result<String, JsError> {
    let mut citations = stare::cite::detect_citations(text);
    stare::cite::spans_to_char_offsets(text, &mut citations)
        .map_err(|e| JsError::new(&e.to_string()))?;
    serde_json::to_string(&citations).map_err(|e| JsError::new(&e.to_string()))
}

/// List all case filenames in a zip. Returns a JSON array of strings.
#[wasm_bindgen]
pub fn list_cases(zip_bytes: &[u8]) -> Result<String, JsError> {
    let cases =
        stare::case::list_cases_in_zip(zip_bytes).map_err(|e| JsError::new(&e.to_string()))?;
    serde_json::to_string(&cases).map_err(|e| JsError::new(&e.to_string()))
}
