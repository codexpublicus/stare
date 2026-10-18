// The index manifest (idx.stare.pub/manifest.json): which volumes are indexed, and
// which CAP folders a cited volume number lives in. The Rust side, and the format, are
// in crates/stare/src/manifest.rs.
//
// A volume is named by its CAP folder, a string: usually the number ("138"), but CAP
// split some volumes over two or three folders ("138", "138-2"). Format 2 lists every
// folder and, under `parts`, each split volume's folders with the pages their indexes
// cover. The legacy format is a bare reporter map of integers; it can't name split
// volumes, so with it a miss in "138" falls back to guessing "138-2", the name every
// second part in CAP has.
//
// A manifest built since #63 also has a CalVer data `version` ("v2026.10.03"), and the
// root manifest of the versioned layout a `base` ("v/v2026.10.03/"): the prefix the
// live build's files are under. Each build is uploaded once under its own prefix and
// never changed, so every .bin and .multi is read, and cached, by its path under
// `base` (indexPath). A manifest without `base` has the files at the root, where the
// index lived before.
//
// A manifest with `idx: 1` has the unified per-volume index (idx.js): one `.idx.gz`
// per volume as cited, for every source, read instead of the .bin and .multi files.
// Its `reporters` then covers every source, CourtListener-only reporters and volumes
// included. An older manifest has no `idx`, and only the .bin and .multi files.
// (#148's `cl` block, which nothing ever published, is ignored.)

import { pruneIndexCache } from './cache.js';
import { indexUrl } from './sources.js';

// One or more path segments, each followed by "/"; no "." or "..", no scheme.
const INDEX_BASE = /^(?:(?!\.\.?\/)[A-Za-z0-9._-]+\/)+$/;

export function isIndexBase(s) {
  return typeof s === 'string' && INDEX_BASE.test(s);
}

const VOLUME_KEY = /^\d(?:[0-9a-z-]*[0-9a-z])?$/;

/**
 * The slug a detected citation is looked up under: citare's edition `slug`
 * (citare#71), the reporter's directory in the index for every source. Output
 * from a module or data bundle older than citare v0.6.0 has no `slug` field,
 * and then CAP's `harvard_slug` is used. A `slug` that is present but null
 * (a law, or no edition) means there is none, whatever `harvard_slug` says.
 */
export function citedSlug(c) {
  if (c == null) return null;
  return (c.slug !== undefined ? c.slug : c.harvard_slug) || null;
}

export function isVolumeKey(s) {
  return typeof s === 'string' && VOLUME_KEY.test(s);
}

// Either format, as { legacy, version, base, idx, reporters: { slug: [folder, ...] }, parts }.
// `version` is the data version, or null for a manifest without one; `base` is the
// index files' prefix, or '' for the root; `idx` the unified index's format, or null.
export function normalizeManifest(raw) {
  const empty = { legacy: true, version: null, base: '', idx: null, reporters: {}, parts: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const v2 = 'format' in raw;
  const map = v2 ? raw.reporters : raw;
  if (!map || typeof map !== 'object') return empty;
  const reporters = {};
  for (const [slug, volumes] of Object.entries(map)) {
    if (!Array.isArray(volumes)) continue;
    reporters[slug] = volumes.map(String).filter(isVolumeKey);
  }
  const parts = v2 && raw.parts && typeof raw.parts === 'object' ? raw.parts : {};
  const version = typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : null;
  const base = v2 && isIndexBase(raw.base) ? raw.base : '';
  const idx = v2 && Number.isSafeInteger(raw.idx) ? raw.idx : null;
  return { legacy: !v2, version, base, idx, reporters, parts };
}

// The unified index's format this reader knows.
export const IDX_FORMAT = 1;

// Whether the build has the unified index in a format this reader knows.
export function hasIdx(m) {
  return m?.idx === IDX_FORMAT;
}

export function hasVolume(m, reporter, volume) {
  return (m.reporters[reporter] || []).includes(String(volume));
}

// Whether the index holds `volume` as cited: listed itself (from any source, with the
// unified index), or the number of a volume CAP split over several folders.
export function holdsVolume(m, reporter, volume) {
  return hasVolume(m, reporter, volume) || Array.isArray(m.parts[reporter]?.[String(volume)]);
}

// The volume number a CAP folder is folded into in the unified index ("138" for
// a3d's "138-2", whose cases are in a3d/138.idx.gz with a "138-2/" ref), or null for a
// folder that is its own volume.
export function foldedInto(m, reporter, folder) {
  const f = String(folder);
  for (const [number, parts] of Object.entries(m.parts[reporter] || {})) {
    if (number !== f && Array.isArray(parts) && parts.some((p) => String(p.volume) === f)) return number;
  }
  return null;
}

// The folders to look `page` up in, in order, for a citation to `volume`: a volume CAP
// didn't split is itself; a split one, the parts whose page range holds the page; a
// folder name ("138-2") is itself.
export function volumeCandidates(m, reporter, volume, page) {
  const v = String(volume);
  const parts = m.parts[reporter]?.[v];
  if (Array.isArray(parts)) {
    return parts
      .filter((p) => p.first_page <= page && page <= p.last_page)
      .map((p) => String(p.volume))
      .filter(isVolumeKey);
  }
  if (m.legacy && /^\d+$/.test(v)) return [v, `${v}-2`];
  return [v];
}

let manifest = null;

// The manifest, fetched once per page. An unreachable or unreadable one reads as an
// empty legacy manifest marked `unreachable`: nothing shows as available, and resolving
// still works, from the root.
export async function loadManifest(fetchFn = globalThis.fetch) {
  if (manifest) return manifest;
  manifest = (async () => {
    try {
      // Revalidated, never taken from the HTTP cache as it is: it's the pointer to the
      // live build, and a browser may otherwise reuse an old copy heuristically.
      const resp = await fetchFn(indexUrl('manifest.json'), { cache: 'no-cache' });
      if (!resp.ok) return { ...normalizeManifest(null), unreachable: true };
      return normalizeManifest(await resp.json());
    } catch {
      return { ...normalizeManifest(null), unreachable: true };
    }
  })();
  return manifest;
}

let pruned = false;

// The path of an index file ("a3d/138.bin") on idx.stare.pub, which is also its cache
// key: under the manifest's `base`, or at the root without one. The sidebar, /check and
// the case viewer all read index files through here. The first call on a
// page with a readable manifest also drops other builds' files from the cache, in the
// background.
export async function indexPath(path, load = loadManifest) {
  const m = await load();
  if (!pruned && !m.unreachable) {
    pruned = true;
    setTimeout(() => { pruneIndexCache(m.base).catch(() => {}); }, 0);
  }
  return `${m.base}${path}`;
}
