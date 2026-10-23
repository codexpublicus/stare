use wasm_bindgen::prelude::*;

/// Look up a case filename from a .bin index given a page number.
/// Returns the case filename (e.g., "0647-01"), "*" when the page's cases have names too
/// long for the .bin and are all in the .multi (use `lookup_page_all`), or null if no
/// case starts at that page.
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

/// Parse one case record's JSON (a CAP case, or a CourtListener record with its
/// `source` block) into the shape `extract_case` returns. Throws on a record that
/// doesn't have it.
#[wasm_bindgen]
pub fn parse_case_json(json: &[u8]) -> Result<String, JsError> {
    let case = stare::case::CaseJson::parse(json).map_err(|e| JsError::new(&format!("{e:#}")))?;
    serde_json::to_string(&case).map_err(|e| JsError::new(&e.to_string()))
}

/// Parse one part of a volume's unified index (`<reporter>/<volume>.idx.gz`), gzipped or
/// plain. Returns JSON: `{ parts: ["1012", ...], entries: [entry], malformed: [line
/// numbers] }`, each entry `{ page, source, ref }` plus `folder` and `case_file` for a
/// `cap` line or `cluster_id` and `hash` for a `cl` line. An alias (#151), a `cap` line
/// naming a case in another volume, also has `reporter` (that case's slug, with `folder`
/// its folder) and `via` (where the alias came from, `cl:8077312`). Throws on bytes
/// that aren't gzip or UTF-8 text.
#[wasm_bindgen]
pub fn parse_idx(bytes: &[u8]) -> Result<String, JsError> {
    let idx = stare::idx::parse_bytes(bytes).map_err(|e| JsError::new(&format!("{e:#}")))?;
    let json = serde_json::json!({
        "parts": idx.parts.iter().map(stare::idx::page_text).collect::<Vec<_>>(),
        "entries": idx.entries.iter().map(|e| e.view()).collect::<Vec<_>>(),
        "malformed": idx.malformed,
    });
    Ok(json.to_string())
}

/// Look `page` (as cited: digits, or a label like `xxix`) up in one part of a volume's
/// unified index, gzipped or plain. Returns JSON: `{ part, entries }`. `entries` are the
/// lines at the page, the volume's own CAP cases first, then aliases, then
/// CourtListener's records, shaped as in `parse_idx`. `part` is the part the page
/// falls in, from part 0's `#parts` header: when it isn't 0 and this was part 0, fetch
/// `<volume>.<part>.idx.gz` and look again there. Throws on unreadable bytes or a page
/// that can't be one.
#[wasm_bindgen]
pub fn lookup_idx(bytes: &[u8], page: &str) -> Result<String, JsError> {
    let key = stare::idx::parse_page(page)
        .ok_or_else(|| JsError::new(&format!("bad page {:?}", page)))?;
    let idx = stare::idx::parse_bytes(bytes).map_err(|e| JsError::new(&format!("{e:#}")))?;
    let json = serde_json::json!({
        "part": idx.part_for(&key),
        "entries": idx.lookup(&key).iter().map(|e| e.view()).collect::<Vec<_>>(),
    });
    Ok(json.to_string())
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

/// Load citare's data bundle: the gunzipped contents of
/// `/data/citare/v1/citare-data-<hash>.bin.gz`, which `/wasm/stare_wasm_bg.json`
/// names. This module is built without the bundle, so
/// `detect_citations` throws until this has run; the page's loader
/// (`web/public/js/wasm.js`) calls it before handing the module out. Throws on
/// bytes that aren't a bundle this build reads, or if data is already loaded.
#[wasm_bindgen]
pub fn init_data(bytes: &[u8]) -> Result<(), JsError> {
    stare::data::load(bytes).map_err(|e| JsError::new(&e.to_string()))
}

/// Whether citare's data is loaded (or compiled in, in a native build).
#[wasm_bindgen]
pub fn data_loaded() -> bool {
    stare::data::is_available()
}

/// Detect citations in text using citare. Returns JSON array of DetectedCitation.
/// Each has: matched_text, citation_type, span, harvard_slug, slug (the index slug), volume, page, reporter, corrected_reporter (the edition a variation was read as), official (an official reporter), year.
///
/// `span` is converted here, at the WASM boundary, from citare_core's UTF-8
/// byte offsets to Unicode scalar value (char) offsets, matching how
/// gorsuch-library's page viewer indexes the same served text. JS callers
/// that use `span` with `String.prototype.slice` (UTF-16 code units) still
/// need to convert further, as `renderParagraphHtml` in
/// `web/public/js/citations.js` does when it highlights by `span`.
/// Throws (rejects with a JsError) if a span's byte offset doesn't land on a
/// char boundary in `text`; that should never happen and is a bug upstream,
/// not something this function guesses its way past.
#[wasm_bindgen]
pub fn detect_citations(text: &str) -> Result<String, JsError> {
    if !stare::data::is_available() {
        return Err(JsError::new(
            "citare data is not loaded: call init_data with the citare data bundle first",
        ));
    }
    let mut citations = stare::cite::detect_citations(text);
    stare::cite::spans_to_char_offsets(text, &mut citations)
        .map_err(|e| JsError::new(&e.to_string()))?;
    serde_json::to_string(&citations).map_err(|e| JsError::new(&e.to_string()))
}

/// Parallel-citation reconciliation (#160, D35): `stare::parallel::reconcile`, the
/// rules `stare check` applies, for the site's `checkCitations`. Takes a JSON array of
/// printings, `{ run, official, lookup }`, `lookup` being `{ status: "found", cases }`
/// (every case at the page, #204), `{ status: "held_miss" }`, `{ status: "not_held" }`
/// or `{ status: "unknown" }`. Returns a JSON array of one
/// `{ partner, conflicts, preferred, case, tied? }` per printing, in order, `partner` an
/// index or null, `case` the case a run that agrees opens, or null, and `tied`, when
/// its members share more than one case, all of them (#212). Throws on JSON that isn't
/// a list of printings.
#[wasm_bindgen]
pub fn reconcile_parallels(printings: &str) -> Result<String, JsError> {
    let printings: Vec<stare::parallel::Printing> =
        serde_json::from_str(printings).map_err(|e| JsError::new(&e.to_string()))?;
    serde_json::to_string(&stare::parallel::reconcile(&printings))
        .map_err(|e| JsError::new(&e.to_string()))
}

/// Cited cases (#198): `stare::cited::group`, which `stare check` uses too, for the
/// site's `groupCitations`. Takes JSON `{ entries, places }`: entries
/// `{ key, case, citation, antecedent, review }`, places `{ key, parallel_of }` in text
/// order. Returns `{ groups, entries, places, entry_counts }`: each group
/// `{ members, count }`, each entry's group, each place's citing place (null for a key
/// that is no entry's), and each entry's own count of citing places.
/// Throws on JSON of another shape.
#[wasm_bindgen]
pub fn group_citations(input: &str) -> Result<String, JsError> {
    let input: stare::cited::Input =
        serde_json::from_str(input).map_err(|e| JsError::new(&e.to_string()))?;
    serde_json::to_string(&stare::cited::group(&input.entries, &input.places))
        .map_err(|e| JsError::new(&e.to_string()))
}

/// A zip's central directory from its tail (#212, `stare::ziprange::directory`): `tail`
/// is the zip's bytes from offset `tail_start` to its end. Returns JSON
/// `{ "entries": [{ name, start, end }] }`, each file's local entry by offset, or
/// `{ "need": offset }` when the directory starts before the tail. Throws on bytes with
/// no end of central directory.
#[wasm_bindgen]
pub fn zip_directory(tail: &[u8], tail_start: f64) -> Result<String, JsError> {
    let dir = stare::ziprange::directory(tail, tail_start as u64)
        .map_err(|e| JsError::new(&e.to_string()))?;
    serde_json::to_string(&dir).map_err(|e| JsError::new(&e.to_string()))
}

/// One file's text from a range of a zip (`stare::ziprange::entry`): `bytes` from offset
/// `bytes_start`, holding the whole local entry of `entry`, one of `zip_directory`'s
/// `{ name, start, end }` as JSON.
#[wasm_bindgen]
pub fn zip_entry(bytes: &[u8], bytes_start: f64, entry: &str) -> Result<String, JsError> {
    let entry: stare::ziprange::Entry =
        serde_json::from_str(entry).map_err(|e| JsError::new(&e.to_string()))?;
    let data = stare::ziprange::entry(bytes, bytes_start as u64, &entry)
        .map_err(|e| JsError::new(&e.to_string()))?;
    String::from_utf8(data).map_err(|e| JsError::new(&e.to_string()))
}

/// The case the citing text's `name` (and `year`, or none) means among the cases at a
/// page (#212, `stare::byname::pick`), from JSON `[{ id, names, date }]`: its `id`, or
/// undefined when no one case matches clearly.
#[wasm_bindgen]
pub fn match_case_name(
    cases: &str,
    name: &str,
    year: Option<i32>,
) -> Result<Option<String>, JsError> {
    let cases: Vec<stare::byname::Candidate> =
        serde_json::from_str(cases).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(stare::byname::pick(&cases, name, year).map(str::to_string))
}

/// The owner's rulings D90 and D98 (1) (`stare::byname::pick_on_official_page`): for
/// the official printing of a parallel run whose printings share `shared` (a JSON array
/// of ids), the case on its whole page (`cases`, JSON `[{ id, names, date }]`) the
/// citing text's `name` means, when the shared cases miss it (several, none of which
/// fits it, or one that clearly doesn't) and exactly one case on the page fits: its
/// `id`, or undefined.
#[wasm_bindgen]
pub fn match_case_name_official(
    cases: &str,
    shared: &str,
    name: &str,
    year: Option<i32>,
) -> Result<Option<String>, JsError> {
    let cases: Vec<stare::byname::Candidate> =
        serde_json::from_str(cases).map_err(|e| JsError::new(&e.to_string()))?;
    let shared: Vec<String> =
        serde_json::from_str(shared).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(stare::byname::pick_on_official_page(&cases, &shared, name, year).map(str::to_string))
}

/// List all case filenames in a zip. Returns a JSON array of strings.
#[wasm_bindgen]
pub fn list_cases(zip_bytes: &[u8]) -> Result<String, JsError> {
    let cases =
        stare::case::list_cases_in_zip(zip_bytes).map_err(|e| JsError::new(&e.to_string()))?;
    serde_json::to_string(&cases).map_err(|e| JsError::new(&e.to_string()))
}
