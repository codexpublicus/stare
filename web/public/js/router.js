import { isVolumeKey } from './manifest.js';
import { pageKey, pageSegment } from './pagekey.js';

/**
 * Parse hash params. Supports:
 *   #a2d/31/647       → { reporter, volume: '31', page: 647, seq: null }
 *   #a2d/31/647-01    → { reporter, volume: '31', page: 647, seq: 1 }
 *   #a2d/31/647-02    → { reporter, volume: '31', page: 647, seq: 2 }
 *   #a3d/138-2/1012   → { reporter, volume: '138-2', page: 1012, seq: null }
 *   #p2d/997/1021-01@1023 → { reporter, volume: '997', page: 1021, seq: 1, pin: 1023 }
 *   #a2d/31/647-01~c=3    → { ..., cite: 3 }
 *   #cai-cas/1/xxix-01    → { reporter, volume: '1', page: 'xxix', seq: 1 }
 *   #cal-app-4th/15/supp.%201-01 → { ..., page: 'supp. 1', seq: 1 }
 *
 * `volume` is a string: a cited number or a CAP volume folder (see manifest.js).
 * `page` is a number, or a page label (front matter, a supplement) lowercased, the
 * way the index keys it (pagekey.js). A label is URI-encoded in the hash, and the
 * last `-<digits>` is always the sequence, so a label ending in one needs it.
 * `pin` is the page of the case to scroll to (`@1023`), or null.
 * `cite` (#159) is a place in the case's text where it cites another case:
 * `~c=3` is the third citation in the text, counting every citation the
 * reader marks, in order, footnotes included (citenav.js numbers them). The
 * reader goes there and highlights the cited case's other places. Null
 * without one.
 */
export function getHashParams() {
  return parseHash(window.location.hash);
}

/** getHashParams for a given hash (`#a2d/31/647-01`), or null. */
export function parseHash(hashWithMark) {
  const hash = String(hashWithMark || '').replace(/^#/, '');
  if (!hash) return null;
  // The reporter and volume are the first two segments; the rest is the page, which
  // can hold a space once decoded (`supp. 1`).
  const m = hash.match(/^([^/\s]+)[/\s]+([^/\s]+)[/\s]+(.+)$/);
  if (!m) return null;
  const [, reporter, volume, encoded] = m;
  if (!isVolumeKey(volume)) return null;
  let pageStr;
  try {
    pageStr = decodeURIComponent(encoded);
  } catch {
    return null;
  }

  const pageMatch = pageStr.match(/^([^@~/]+?)(?:-(\d+))?(?:@(\d+))?(?:~c=([1-9]\d*))?$/);
  if (!pageMatch) return null;
  const page = pageKey(pageMatch[1]);
  if (page === null) return null;
  const seq = pageMatch[2] ? parseInt(pageMatch[2], 10) : null;
  const pin = pageMatch[3] ? parseInt(pageMatch[3], 10) : null;
  const cite = pageMatch[4] ? parseInt(pageMatch[4], 10) : null;

  return { reporter: reporter.toLowerCase(), volume, page, seq, pin, cite };
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
 * The hash for a case, with its sequence suffix always (#a2d/31/647-01), and
 * a pin page (`@1023`) or a place in its text (`~c=3`) when given.
 */
export function caseHash(reporter, volume, page, seq, pin = null, cite = null) {
  const suffix = `-${String(seq || 1).padStart(2, '0')}`;
  const at = cite ? `~c=${cite}` : '';
  return `#${reporter}/${volume}/${pageSegment(page)}${suffix}${pinSuffix(pin, page)}${at}`;
}

/**
 * Set hash with optional case sequence suffix, pin page and cited place.
 * Always includes the suffix for explicitness: #a2d/31/647-01, #p2d/997/1021-01@1023
 */
export function setHash(reporter, volume, page, seq, pin = null, cite = null) {
  const newHash = caseHash(reporter, volume, page, seq, pin, cite);
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
