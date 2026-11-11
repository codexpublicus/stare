// Whether a URL hash names a case, decided before the page paints.
//
// index.astro inlines `isCaseHash` into a script in <head>, which marks <html>
// with data-route="case" so the landing never shows while main.js loads and
// resolves the case, a page view (`~v=pdf&p=3`) included. It has to run before main.js (a module, run after the page
// is parsed) and can't import anything, so it repeats router.js's `parseHash`
// (with manifest.js's VOLUME_KEY and pagekey.js's `pageKey`) in one function.
// web/tests/caseroute.test.js checks the two agree. main.js clears the mark
// once it has decided, so a hash this gets wrong costs a moment of the
// loading shell, never a blank page.

/**
 * True when `path` is a permanent case address the reader opens (#283): `/k/<key>/` or
 * `/c/<jurisdiction>/<slug>/<volume>/<page>/`, as caseaddress.js's `parseCasePath` reads
 * them, malformed ones included, which open the reader to say so.
 */
export function isCasePath(path) {
  return /^\/[kc]\/./.test(String(path || ''));
}

/** True when router.js's `parseHash` would give a case for `hash` (`#a2d/31/647-01`). */
export function isCaseHash(hash) {
  const s = String(hash || '').replace(/^#/, '');
  const m = s.match(/^([^/\s]+)[/\s]+([^/\s]+)[/\s]+(.+)$/);
  if (!m || !/^\d(?:[0-9a-z-]*[0-9a-z])?$/.test(m[2])) return false;
  let decoded;
  try {
    decoded = decodeURIComponent(m[3]);
  } catch {
    return false;
  }
  const p = decoded.match(/^([^@~/]+?)(?:-(\d+))?(?:@(\d+))?(?:~c=([1-9]\d*)|~v=(pdf|scans)(?:&p=([1-9]\d*))?)?$/);
  if (!p) return false;
  const page = p[1].trim().replace(/\s+/g, ' ');
  if (!page) return false;
  if (/^\d+$/.test(page)) return Number.isSafeInteger(Number(page));
  return !(/^\d/.test(page) || page.includes(',') || page.startsWith('#') || /\p{Cc}/u.test(page));
}

// Where the build puts the WASM's preload links in caseRouteScript's output: an empty
// list until src/lib/assetcache.js's casePreloads writes in the hashed names it made.
export const WASM_PRELOADS_MARK = '/*stare:wasm-preloads*/[]';

/**
 * Adds `<link>`s to `doc`'s <head>: each of `links` is `{ rel, href, as?, crossorigin? }`.
 * Inlined into the head script, so it can't import anything.
 */
export function addLinks(links, doc) {
  for (var i = 0; i < links.length; i++) {
    var l = doc.createElement('link');
    l.rel = links[i].rel;
    if (links[i].as) l.as = links[i].as;
    if (links[i].crossorigin) l.crossOrigin = 'anonymous';
    l.href = links[i].href;
    doc.head.appendChild(l);
  }
}

/**
 * The head script for index.astro: on a case hash or a permanent case address, marks <html> data-route="case" and
 * starts what opening the case will need with the HTML, before main.js and its imports
 * have loaded (#262): connections to the index and data hosts (`preconnects`, hrefs),
 * and the WASM module, its glue, its build info and citare's data bundle, which the
 * build fills in at WASM_PRELOADS_MARK. The fetches' modes match the loader's
 * (public/js/wasm.js): fetch() with its default credentials, and import() for the glue,
 * so the browser hands the preloaded responses over instead of fetching again.
 */
export function caseRouteScript(preconnects) {
  const links = preconnects.map((href) => ({ rel: 'preconnect', href, crossorigin: true }));
  return `try { if ((${isCasePath})(location.pathname) || (${isCaseHash})(location.hash)) { document.documentElement.setAttribute('data-route', 'case'); `
    + `(${addLinks})(${JSON.stringify(links)}.concat(${WASM_PRELOADS_MARK}), document); } } catch (e) {}`;
}
