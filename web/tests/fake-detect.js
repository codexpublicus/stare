// A stand-in for detectCitations in tests. Node can't load the citare WASM
// from the site path ('/wasm/stare_wasm.js'), so tests that need detected
// citations inject this instead. It finds "<volume> <reporter> <page>" with
// a regex and reports the same shape, with code point offsets, as
// detectCitations; it is a test fixture, not a citation parser.

const CASE_PATTERN = /(\d{1,4})\s+([A-Z][A-Za-z.]+(?:\s+\d+[a-z]{1,2})?(?:\.\d+[a-z]{0,2})?)\s+(\d{1,4})/g;

/**
 * Convert a UTF-16 code unit offset (a native JS string index) to a Unicode
 * code point offset.
 */
export function codePointOffset(text, utf16Index) {
  return [...text.slice(0, utf16Index)].length;
}

export function fakeDetect(text) {
  return [...text.matchAll(CASE_PATTERN)].map((m) => ({
    raw: m[0],
    type: 'FullCaseCitation',
    harvard_slug: null,
    volume: parseInt(m[1], 10),
    page: m[3],
    reporter: m[2].trim(),
    year: null,
    start: codePointOffset(text, m.index),
    end: codePointOffset(text, m.index + m[0].length),
    externalUrl: null,
    caseLinks: [],
  }));
}
