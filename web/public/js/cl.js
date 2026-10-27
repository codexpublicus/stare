// CourtListener records: cases CAP doesn't hold, from CourtListener's bulk data
// (docs/plans/courtlistener-mirror.md). The unified index's `cl` lines (idx.js) each name
// one gzipped record in the same shape as CAP's case JSON plus a `source` block. The
// paths are in sources.js.
//
// A record has no page scans, ALTO or page numbers, so the case viewer shows its text
// with a source line and no Archival PDF or Raw Scans tab.

import { fetchCached, gunzip } from './cache.js';
import { escapeHtml, safeExternalUrl } from './citations.js';
import { clRecordPath, clRecordUrl } from './sources.js';
import { loadWasm } from './wasm.js';

export const COURTLISTENER = 'courtlistener';

// Whether a case record came from CourtListener (CAP's have no `source`).
export function isClRecord(caseData) {
  return caseData?.source?.name === COURTLISTENER;
}

// A server that sets Content-Encoding has the browser gunzip a record first, so it may
// arrive plain; gunzip passes plain bytes through (cache.js, which idx.js shares).
export { gunzip, isGzip } from './cache.js';

/**
 * One record, fetched (and cached under its immutable path), gunzipped and parsed into
 * the shape the case viewer reads (the WASM's parse_case_json, which throws on a record
 * that doesn't have it). Throws a ClRecordError for a record it can't read, and the
 * fetch's own error for one it couldn't fetch.
 */
export async function fetchClRecord(entry) {
  const key = clRecordPath(entry.cluster_id, entry.hash);
  const gz = await fetchCached('zips', key, clRecordUrl(entry.cluster_id, entry.hash));
  const w = await loadWasm();
  try {
    return JSON.parse(w.parse_case_json(await gunzip(gz)));
  } catch (e) {
    throw new ClRecordError(`${key}: ${e.message}`);
  }
}

// A record that was fetched but isn't gzip, or isn't a case in the viewer's shape.
export class ClRecordError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ClRecordError';
  }
}

/**
 * The source line for a CourtListener record: "From CourtListener's bulk data, export
 * 2026-09-30", linking the case on CourtListener when the record has an http(s) URL,
 * then the docket number (unless `docket` is false, where the docket is shown apart)
 * and precedential status when it has them, in a div of `className`. '' for a CAP case.
 */
export function sourceLineHtml(caseData, className = 'reader-source', { docket = true } = {}) {
  if (!isClRecord(caseData)) return '';
  const s = caseData.source;
  const label = escapeHtml(`From CourtListener's bulk data${s.export ? `, export ${s.export}` : ''}`);
  const url = safeExternalUrl(s.url);
  const from = url
    ? `<a class="source-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
    : label;
  const extra = [
    docket && s.docket_number ? `Docket ${escapeHtml(s.docket_number)}` : '',
    s.precedential_status ? escapeHtml(s.precedential_status) : '',
  ].filter(Boolean).map((t) => ` &middot; <span>${t}</span>`).join('');
  return `<div class="${escapeHtml(className)}">${from}${extra}</div>`;
}

// The provenance line's wording. Placeholder; the owner chooses the final text.
export const CL_BLOCKED_NOTICE = 'CourtListener excludes this case from search engines.';

const REASON_PHRASES = {
  'id-number': 'a redacted ID number in the text',
  'unpublished-30y': 'unpublished within 30 years',
  'court-category': 'a military, tax or similar court within 30 years',
  'bankruptcy-docket': 'a bankruptcy docket',
  'keyword:minor+child': 'mentions "minor" and "child" within 30 years',
};

// A short readable phrase for one `source.cl_blocked` reason code; an unrecognized code as is.
export function reasonPhrase(code) {
  if (Object.hasOwn(REASON_PHRASES, code)) return REASON_PHRASES[code];
  if (code.startsWith('keyword:')) return `mentions "${code.slice(8)}" within 30 years`;
  return code;
}

/**
 * The provenance line for a case CourtListener blocks from search engines (its record's
 * `source.cl_blocked`, from stare-builder's blocking.py): the notice, then the reasons
 * as inferred, "(inferred: unpublished within 30 years)", in a div of `className`. The
 * reasons are stare-builder's inference, never CourtListener's statement. Nothing else
 * about the case changes. '' for a case that isn't blocked. Mirrors `ClBlocked::notice`
 * in crates/stare/src/case.rs.
 */
export function blockedLineHtml(caseData, className = 'reader-blocked') {
  const b = isClRecord(caseData) ? caseData.source.cl_blocked : null;
  if (!b || typeof b !== 'object') return '';
  const unverifiable = b.unverifiable && typeof b.unverifiable === 'object' ? b.unverifiable : {};
  const known = (Array.isArray(b.reasons) ? b.reasons : [])
    .filter((r) => typeof r === 'string' && r !== 'unknown')
    .map((r) => (Object.hasOwn(unverifiable, r) ? `${reasonPhrase(r)}, unverified` : reasonPhrase(r)));
  const why = known.length ? `(inferred: ${known.join('; ')})` : '(reason unknown)';
  const title = typeof b.reason_basis === 'string' ? ` title="${escapeHtml(b.reason_basis)}"` : '';
  return `<div class="${escapeHtml(className)}"${title}>${escapeHtml(`${CL_BLOCKED_NOTICE} ${why}`)}</div>`;
}
