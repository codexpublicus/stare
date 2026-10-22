import { indexUrl } from './sources.js';

// The footer's data line: which citation index the site is reading, and the sources
// its manifest says it was built from.
//
// The index manifest (idx.stare.pub/manifest.json) carries a CalVer `version` when
// stare-admin build-manifest wrote it since #63. An older manifest has none, and the
// only thing that says how current it is is the object's Last-Modified header.

export const MANIFEST_URL = indexUrl('manifest.json');

const DATA_VERSION = /^v?\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/;

// The sources a manifest's `based_on` names (stare::license::index_based_on: the
// Caselaw Access Project and CourtListener's bulk data), in its order. A manifest from
// before `based_on`, or an entry without a usable name, contributes nothing.
export function basedOnNames(manifest) {
  const list = manifest && typeof manifest === 'object' ? manifest.based_on : undefined;
  if (!Array.isArray(list)) return [];
  return list
    .map((s) => (s && typeof s === 'object' && typeof s.name === 'string' ? s.name.trim() : ''))
    .filter((name) => name && name.length <= 100);
}

// Returns the line to show, or null when there's nothing trustworthy to say:
// "Index v2026.10.22 · Sources: Caselaw Access Project, CourtListener bulk data".
export function formatDataLine(manifest, lastModified) {
  const version = manifest && typeof manifest === 'object' ? manifest.version : undefined;
  let line = null;
  if (typeof version === 'string' && DATA_VERSION.test(version.trim())) {
    const v = version.trim();
    line = `Index ${v.startsWith('v') ? v : `v${v}`}`;
  } else if (lastModified) {
    const date = new Date(lastModified);
    if (!Number.isNaN(date.getTime())) {
      line = `Index updated ${date.toISOString().slice(0, 10)}`;
    }
  }
  if (!line) return null;
  const names = basedOnNames(manifest);
  return names.length ? `${line} · Sources: ${names.join(', ')}` : line;
}

// Fills `el` with the data line and unhides it; leaves it hidden on any failure.
export async function loadDataLine(el, fetchFn = globalThis.fetch) {
  if (!el || typeof fetchFn !== 'function') return null;
  try {
    const resp = await fetchFn(MANIFEST_URL, { cache: 'no-cache' });
    if (!resp.ok) return null;
    const lastModified = resp.headers.get('last-modified');
    let manifest = null;
    try {
      manifest = await resp.json();
    } catch {
      manifest = null;
    }
    const line = formatDataLine(manifest, lastModified);
    if (!line) return null;
    el.textContent = line;
    el.hidden = false;
    return line;
  } catch {
    return null;
  }
}
