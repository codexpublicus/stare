import { isVolumeKey } from './manifest.js';

/**
 * Parse hash params. Supports:
 *   #a2d/31/647       → { reporter, volume: '31', page: 647, seq: null }
 *   #a2d/31/647-01    → { reporter, volume: '31', page: 647, seq: 1 }
 *   #a2d/31/647-02    → { reporter, volume: '31', page: 647, seq: 2 }
 *   #a3d/138-2/1012   → { reporter, volume: '138-2', page: 1012, seq: null }
 *   #p2d/997/1021-01@1023 → { reporter, volume: '997', page: 1021, seq: 1, pin: 1023 }
 *
 * `volume` is a string: a cited number or a CAP volume folder (see manifest.js).
 * `pin` is the page of the case to scroll to (`@1023`), or null.
 */
export function getHashParams() {
  return parseHash(window.location.hash);
}

/** getHashParams for a given hash (`#a2d/31/647-01`), or null. */
export function parseHash(hashWithMark) {
  const hash = String(hashWithMark || '').replace(/^#/, '');
  if (!hash) return null;
  const parts = hash.replace(/\//g, ' ').split(/\s+/);
  if (parts.length !== 3) return null;
  const [reporter, volume, pageStr] = parts;
  if (!isVolumeKey(volume)) return null;

  const pageMatch = pageStr.match(/^(\d+)(?:-(\d+))?(?:@(\d+))?$/);
  if (!pageMatch) return null;
  const page = parseInt(pageMatch[1], 10);
  const seq = pageMatch[2] ? parseInt(pageMatch[2], 10) : null;
  const pin = pageMatch[3] ? parseInt(pageMatch[3], 10) : null;

  return { reporter: reporter.toLowerCase(), volume, page, seq, pin };
}

/**
 * The page a pin cite points to, or null: the first page of a range
 * (`1023-24`) or list (`1022, 1023`), the page of a footnote pin
 * (`1023 n.4`), a starred page (`*1023`). A footnote alone (`n.3`), a
 * paragraph (`¶ 10`) or a section (`§ 1985`) has none.
 */
export function pinPage(pin) {
  if (pin == null) return null;
  const m = String(pin).trim().replace(/^at\s+/i, '').match(/^\*{0,2}(\d+)(?!\d)/);
  return m ? parseInt(m[1], 10) : null;
}

/** `@1023` for a pin page that isn't the case's first page, else ''. */
export function pinSuffix(pin, firstPage = null) {
  const p = pinPage(pin);
  return p !== null && String(p) !== String(firstPage) ? `@${p}` : '';
}

/**
 * Set hash with optional case sequence suffix and pin page.
 * Always includes the suffix for explicitness: #a2d/31/647-01, #p2d/997/1021-01@1023
 */
export function setHash(reporter, volume, page, seq, pin = null) {
  const suffix = `-${String(seq || 1).padStart(2, '0')}`;
  const newHash = `#${reporter}/${volume}/${page}${suffix}${pinSuffix(pin, page)}`;
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
