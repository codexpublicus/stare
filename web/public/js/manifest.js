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

import { indexUrl } from './sources.js';

const VOLUME_KEY = /^\d(?:[0-9a-z-]*[0-9a-z])?$/;

export function isVolumeKey(s) {
  return typeof s === 'string' && VOLUME_KEY.test(s);
}

// Either format, as { legacy, reporters: { slug: [folder, ...] }, parts }.
export function normalizeManifest(raw) {
  const empty = { legacy: true, reporters: {}, parts: {} };
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
  return { legacy: !v2, reporters, parts };
}

export function hasVolume(m, reporter, volume) {
  return (m.reporters[reporter] || []).includes(String(volume));
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
// empty legacy manifest: nothing shows as available, and resolving still works.
export async function loadManifest(fetchFn = globalThis.fetch) {
  if (manifest) return manifest;
  manifest = (async () => {
    try {
      const resp = await fetchFn(indexUrl('manifest.json'));
      return normalizeManifest(resp.ok ? await resp.json() : null);
    } catch {
      return normalizeManifest(null);
    }
  })();
  return manifest;
}
