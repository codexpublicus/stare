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
 *   #a2d/31/647-01~v=pdf&p=3 → { ..., view: 'pdf', viewPage: 3 }
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
 * `view` (#246) is a page view the case opens in, 'pdf' (the Archival PDF) or
 * 'scans' (the Raw Scans), and `viewPage` the case's page it shows, counting
 * from 1 at the case's first page, as the view's "Page i of n" does (`~v=pdf&p=3`).
 * Both null for the Reader. A link has a place in the text or a page view, not
 * both.
 */
export function getHashParams() {
  return parseHash(window.location.hash || routeHash());
}

// The permanent address the page shows a case at (#283, caseaddress.js): `/k/<key>/` or
// `/c/<jurisdiction>/<slug>/<volume>/<page>/`, with `hash`, the case it opened, as the
// hash setHash first gave it (null until then). While the shown case is that one, the
// address stays the path, with the hash only for a place in it (`~c=3`, `~v=pdf&p=3`, `@1023`);
// moving to another case leaves the path for `/#<case>`. Null on `/`.
let route = null;

/**
 * Shows cases at `path` from now on (null: at `/`), with `canonical`, an absolute URL, as
 * the page's canonical link while it does (removed with the route). `hash` is the case the
 * path shows when it is known already; a `/d/<id>/` record, which no case hash names, passes
 * one that names no case, so any case the reader moves to leaves the path.
 */
export function setRoute(path, canonical = null, hash = null) {
  route = path ? { path, hash } : null;
  setCanonical(route ? canonical : null);
}

/** The route's path, or null. */
export function routePath() {
  return route?.path || null;
}

// The route's case hash when the address is the route's path with no hash, else ''.
function routeHash() {
  return route?.hash && window.location.pathname === route.path ? route.hash : '';
}

function setCanonical(href) {
  const doc = globalThis.document;
  if (!doc?.head) return;
  let link = doc.head.querySelector('link[rel="canonical"]');
  if (!href) {
    link?.remove();
    return;
  }
  if (!link) {
    link = doc.createElement('link');
    link.rel = 'canonical';
    doc.head.appendChild(link);
  }
  link.href = href;
}

// Whether two hashes name the same case, whatever place in it they add.
function sameCase(a, b) {
  const p = parseHash(a);
  const q = parseHash(b);
  return !!p && !!q && p.reporter === q.reporter && p.volume === q.volume
    && p.page === q.page && (p.seq || 1) === (q.seq || 1);
}

// setHash on a route: true when it handled the address.
function setRouteHash(newHash) {
  if (!route) return false;
  if (!route.hash) route.hash = caseOnly(newHash);
  if (sameCase(newHash, route.hash)) {
    const target = newHash === route.hash ? route.path : `${route.path}${newHash}`;
    if (window.location.pathname + window.location.hash !== target) {
      history.replaceState(history.state, '', target);
    }
    return true;
  }
  // Another case: the address leaves the path. A link in the text already added the
  // history entry (the hash is there), so that one is replaced.
  const replace = window.location.hash === newHash;
  setRoute(null);
  if (replace) history.replaceState(history.state, '', `/${newHash}`);
  else history.pushState(null, '', `/${newHash}`);
  return true;
}

/**
 * Replaces the address's hash with `hash` without a history entry or a hashchange: on a
 * route showing its case, the route's path with `hash` only when it adds a place.
 */
export function replaceHash(hash) {
  let target = hash;
  if (route?.hash && sameCase(hash, route.hash)) target = hash === route.hash ? route.path : `${route.path}${hash}`;
  history.replaceState(history.state, '', target);
}

// A case hash without its pin, cited place or page view.
function caseOnly(hash) {
  const p = parseHash(hash);
  return p ? caseHash(p.reporter, p.volume, p.page, p.seq) : hash;
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

  const pageMatch = pageStr.match(/^([^@~/]+?)(?:-(\d+))?(?:@(\d+))?(?:~c=([1-9]\d*)|~v=(pdf|scans)(?:&p=([1-9]\d*))?)?$/);
  if (!pageMatch) return null;
  const page = pageKey(pageMatch[1]);
  if (page === null) return null;
  const seq = pageMatch[2] ? parseInt(pageMatch[2], 10) : null;
  const pin = pageMatch[3] ? parseInt(pageMatch[3], 10) : null;
  const cite = pageMatch[4] ? parseInt(pageMatch[4], 10) : null;
  const view = pageMatch[5] || null;
  const viewPage = view ? parseInt(pageMatch[6] || '1', 10) : null;

  return { reporter: reporter.toLowerCase(), volume, page, seq, pin, cite, view, viewPage };
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
 * a pin page (`@1023`) and a place in its text (`~c=3`) or a page view
 * (`~v=pdf&p=3`, from `view` as { view, page }) when given.
 */
export function caseHash(reporter, volume, page, seq, pin = null, cite = null, view = null) {
  const suffix = `-${String(seq || 1).padStart(2, '0')}`;
  let at = '';
  if (cite) at = `~c=${cite}`;
  else if (view?.view === 'pdf' || view?.view === 'scans') at = `~v=${view.view}&p=${view.page || 1}`;
  return `#${reporter}/${volume}/${pageSegment(page)}${suffix}${pinSuffix(pin, page)}${at}`;
}

/**
 * Set hash with optional case sequence suffix, pin page, cited place and page view.
 * Always includes the suffix for explicitness: #a2d/31/647-01, #p2d/997/1021-01@1023
 */
export function setHash(reporter, volume, page, seq, pin = null, cite = null, view = null) {
  const newHash = caseHash(reporter, volume, page, seq, pin, cite, view);
  if (setRouteHash(newHash)) return;
  // Off `/` with no route (an address that named nothing), a case goes to `/`.
  if (window.location.pathname !== '/') {
    history.pushState(null, '', `/${newHash}`);
    return;
  }
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
