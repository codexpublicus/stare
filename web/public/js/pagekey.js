// Pages as the index keys them (crates/stare/src/idx.rs, `parse_page`): a number, or,
// for a page CAP didn't number, its label lowercased. Front matter is labelled with a
// roman numeral (`xxix`) and some supplements by name (`supp. 1`), and the unified index
// and the .multi files key those cases by the label (#154).

/**
 * A page as cited or typed: a number for digits (`647`, `0647`), else the label,
 * trimmed, lowercased, with its spaces collapsed (`Supp.  1` is `supp. 1`). Null for
 * an empty page, or one no index line could hold. A label never starts with a digit,
 * as in the CLI's `parse_labeled_input`, so `647a` or `647 648` isn't a page.
 */
export function pageKey(text) {
  if (typeof text === 'number') return Number.isSafeInteger(text) && text >= 0 ? text : null;
  const s = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : null;
  }
  if (/^\d/.test(s) || s.includes(',') || s.startsWith('#') || /\p{Cc}/u.test(s)) return null;
  return s.toLowerCase();
}

/**
 * The page a citation names, from citare's `page` field: the number a page starting
 * with digits begins with (`1023`, or `1023` of `1023-24`), as before labels; else
 * its label (`xxix`). Null when there's none.
 */
export function citedPage(page) {
  if (page == null) return null;
  const s = String(page).trim();
  if (/^\d/.test(s)) return parseInt(s, 10);
  return pageKey(s);
}

/**
 * The page a CAP case file starts on, from its name, `<first page>-<seq>`: a number
 * (`0647-01` is 647, `[106]-01` 106, `1114-1140-01` 1114), or a label the way the
 * index keys it (`xxix-01` is `xxix`, `0xxv-01` `xxv`, `Supp. 1-01` `supp. 1`).
 * Null for a name with neither.
 */
export function filePage(caseFile) {
  // crates/stare/src/index.rs, `page_key`, on the name less its sequence.
  const raw = String(caseFile ?? '').replace(/-\d+$/, '').trim();
  const chunk = raw.replace(/[[\]]/g, '').split(/[=, ]/)[0].trim();
  const unpadded = chunk.replace(/^0+/, '');
  const digits = (s) => /^\d+/.exec(s)?.[0];
  if (digits(unpadded)) return parseInt(digits(unpadded), 10);
  if (!unpadded && chunk) return 0;
  if (/^[ivxlcdm]+$/i.test(unpadded)) return unpadded.toLowerCase();
  if (/^[a-z]\d/i.test(unpadded)) return parseInt(digits(unpadded.slice(1)), 10);
  return pageKey(raw.replace(/^0+/, ''));
}

/** A page as a hash segment: a number as is, a label URI-encoded (`supp.%201`). */
export function pageSegment(page) {
  return typeof page === 'number' ? String(page) : encodeURIComponent(String(page));
}

/**
 * The case files on the labelled page `label` from a `.multi` file's text, whose
 * labelled lines are `<label>,<case file>` (crates/stare/src/index.rs,
 * `parse_labeled`). Empty when there are none.
 */
export function labelCases(multi, label) {
  const want = pageKey(label);
  if (!multi || typeof want !== 'string') return [];
  const out = [];
  for (const line of multi.split('\n')) {
    const i = line.indexOf(',');
    if (i <= 0) continue;
    if (pageKey(line.slice(0, i)) === want) out.push(line.slice(i + 1).trim());
  }
  return out;
}
