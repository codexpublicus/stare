// CourtListener records: cases CAP doesn't hold, from CourtListener's bulk data
// (docs/plans/courtlistener-mirror.md). A volume the manifest's `cl` block lists has a
// `.cl` sidecar of `page,cluster_id,hash` lines; each names one gzipped record in the
// same shape as CAP's case JSON plus a `source` block. The paths are in sources.js; the
// parsing is the WASM's (crates/stare/src/cl.rs).
//
// A record has no page scans, ALTO or page numbers, so the case viewer shows its text
// with a source line and no Original Pages tab.

import { fetchCached, fetchCachedText } from './cache.js';
import { escapeHtml, safeExternalUrl } from './citations.js';
import { indexPath } from './manifest.js';
import { clRecordPath, clRecordUrl, clSidecarPath, indexUrl } from './sources.js';
import { loadWasm } from './wasm.js';

export const COURTLISTENER = 'courtlistener';

// Whether a case record came from CourtListener (CAP's have no `source`).
export function isClRecord(caseData) {
  return caseData?.source?.name === COURTLISTENER;
}

// A volume's sidecar text, or null when it has none (a 404).
async function readSidecar(reporter, volume) {
  const key = await indexPath(clSidecarPath(reporter, volume));
  return fetchCachedText('multi', key, indexUrl(key));
}

async function wasmLookup(text, page) {
  const w = await loadWasm();
  return JSON.parse(w.lookup_cl_page(text, page));
}

/**
 * The records that start at `page` of `volume`, in the sidecar's order, as
 * `[{ page, cluster_id, hash }]`; empty when the volume has no sidecar or nothing
 * starts there. Only call it for a volume the manifest's `cl` block lists (hasClVolume).
 * `deps` ({ readSidecar, lookup }) are injectable for tests.
 */
export async function clEntries(reporter, volume, page, deps = {}) {
  const text = await (deps.readSidecar || readSidecar)(reporter, String(volume));
  if (!text) return [];
  return (deps.lookup || wasmLookup)(text, parseInt(page, 10));
}

// Whether `bytes` start with gzip's magic number. A server that sets
// Content-Encoding has the browser gunzip them first, so the record may arrive plain.
export function isGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export async function gunzip(bytes) {
  if (!isGzip(bytes)) return bytes;
  const body = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(body).arrayBuffer());
}

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
