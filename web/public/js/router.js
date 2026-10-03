import { isVolumeKey } from './manifest.js';

/**
 * Parse hash params. Supports:
 *   #a2d/31/647       → { reporter, volume: '31', page: 647, seq: null }
 *   #a2d/31/647-01    → { reporter, volume: '31', page: 647, seq: 1 }
 *   #a2d/31/647-02    → { reporter, volume: '31', page: 647, seq: 2 }
 *   #a3d/138-2/1012   → { reporter, volume: '138-2', page: 1012, seq: null }
 *
 * `volume` is a string: a cited number or a CAP volume folder (see manifest.js).
 */
export function getHashParams() {
  const hash = window.location.hash.slice(1);
  if (!hash) return null;
  const parts = hash.replace(/\//g, ' ').split(/\s+/);
  if (parts.length !== 3) return null;
  const [reporter, volume, pageStr] = parts;
  if (!isVolumeKey(volume)) return null;

  const pageMatch = pageStr.match(/^(\d+)(?:-(\d+))?$/);
  if (!pageMatch) return null;
  const page = parseInt(pageMatch[1], 10);
  const seq = pageMatch[2] ? parseInt(pageMatch[2], 10) : null;

  return { reporter: reporter.toLowerCase(), volume, page, seq };
}

/**
 * Set hash with optional case sequence suffix.
 * Always includes the suffix for explicitness: #a2d/31/647-01
 */
export function setHash(reporter, volume, page, seq) {
  const suffix = `-${String(seq || 1).padStart(2, '0')}`;
  const newHash = `#${reporter}/${volume}/${page}${suffix}`;
  if (window.location.hash !== newHash) {
    window.location.hash = newHash;
  }
}

export function onHashChange(callback) {
  window.addEventListener('hashchange', () => {
    const params = getHashParams();
    if (params) callback(params);
  });
}
