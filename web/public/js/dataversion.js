import { indexUrl } from './sources.js';

// The footer's data line: which citation index the site is reading.
//
// The index manifest (idx.stare.pub/manifest.json) will carry a CalVer `version`
// once #63 lands; until then it's a bare reporter map, and the only thing that
// says how current it is is the object's Last-Modified header.

export const MANIFEST_URL = indexUrl('manifest.json');

const DATA_VERSION = /^v?\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/;

// Returns the line to show, or null when there's nothing trustworthy to say.
export function formatDataLine(manifest, lastModified) {
  const version = manifest && typeof manifest === 'object' ? manifest.version : undefined;
  if (typeof version === 'string' && DATA_VERSION.test(version.trim())) {
    const v = version.trim();
    return `Index ${v.startsWith('v') ? v : `v${v}`}`;
  }
  if (lastModified) {
    const date = new Date(lastModified);
    if (!Number.isNaN(date.getTime())) {
      return `Index updated ${date.toISOString().slice(0, 10)}`;
    }
  }
  return null;
}

// Fills `el` with the data line and unhides it; leaves it hidden on any failure.
export async function loadDataLine(el, fetchFn = globalThis.fetch) {
  if (!el || typeof fetchFn !== 'function') return null;
  try {
    const resp = await fetchFn(MANIFEST_URL);
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
