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
