// How a self-hosted copy of stare.pub presents itself (#231, D119). sources.js decides
// whether the page is on a copy (MIRROR, from /mirror/mirror.json); this module says so on
// the page and words the notices for what a copy doesn't hold.
//
// - The header and the footer say "A mirror of stare.pub", link to stare.pub, and give the
//   copy's release and the date of its data. Nothing here says the copy is verified: code a
//   copy serves can't prove that about itself.
// - The canonical link points at the same page on stare.pub.
// - A feature the copy lacks (sources.js hasFeature) is said in place, with a link to the
//   same page on stare.pub. Nothing is fetched from stare.pub.

import { MIRROR, UPSTREAM, hasFeature, upstreamUrl } from './sources.js';

export { hasFeature, upstreamUrl };

/** True on a copy. */
export const onMirror = () => !!MIRROR;

/**
 * The words after "A mirror of stare.pub": `release v2026.11.10, data from 2026-11-08`, with
 * either part left out when mirror.json doesn't give it. Empty for null.
 */
export function mirrorDetail(mirror) {
  if (!mirror) return '';
  const parts = [];
  if (mirror.release) parts.push(`release ${mirror.release}`);
  if (mirror.data_date) parts.push(`data from ${mirror.data_date}`);
  return parts.join(', ');
}

// Text and an `<a>` to stare.pub, as nodes for `doc`.
function mirrorLine(doc, mirror) {
  const a = doc.createElement('a');
  a.href = UPSTREAM;
  a.textContent = 'stare.pub';
  const detail = mirrorDetail(mirror);
  return [doc.createTextNode('A mirror of '), a, doc.createTextNode(detail ? ` (${detail})` : '')];
}

/**
 * On a copy, adds the header banner and the footer line to `doc` and points its canonical
 * link at stare.pub; does nothing on stare.pub, or a second time. `mirror` defaults to the
 * page's.
 */
export function showMirror(doc = globalThis.document, mirror = MIRROR, location = globalThis.location) {
  if (!mirror || !doc?.body || doc.querySelector('[data-mirror-banner]')) return false;
  // The reader's two screens (index.astro) each get the banner at their top, inside the
  // column #resolved fills the window with; any other page, at the top of its body.
  const screens = [doc.getElementById('landing'), doc.getElementById('resolved')].filter(Boolean);
  for (const parent of screens.length ? screens : [doc.body]) {
    const banner = doc.createElement('p');
    banner.className = 'mirror-banner';
    banner.setAttribute('data-mirror-banner', '');
    banner.setAttribute('role', 'note');
    banner.append(...mirrorLine(doc, mirror));
    parent.insertBefore(banner, parent.firstChild);
  }
  for (const line of doc.querySelectorAll('.site-footer-line')) {
    const span = doc.createElement('span');
    span.className = 'site-footer-mirror';
    span.setAttribute('data-mirror-footer', '');
    span.append(...mirrorLine(doc, mirror));
    line.insertBefore(span, line.firstChild);
  }
  setUpstreamCanonical(doc, location);
  return true;
}

/** Sets `doc`'s canonical link to the page's address on stare.pub. */
export function setUpstreamCanonical(doc = globalThis.document, location = globalThis.location) {
  if (!doc?.head || !location) return;
  let link = doc.head.querySelector('link[rel="canonical"]');
  if (!link) {
    link = doc.createElement('link');
    link.rel = 'canonical';
    doc.head.appendChild(link);
  }
  link.href = upstreamUrl(location.pathname || '/');
}

// What each missing feature is called in place.
const MISSING = {
  text: 'Text not in this copy.',
  pages: 'Pages not in this copy.',
  'raw-scans': 'Raw scans not in this copy.',
  search: 'Search needs tier 2 of a stare.pub copy (text and search); this copy doesn’t have it.',
};
const LINK_TEXT = {
  text: 'Read it on stare.pub',
  pages: 'See the pages on stare.pub',
  'raw-scans': 'See the raw scans on stare.pub',
  search: 'Search on stare.pub',
};

/** A copy that lacks a feature, with what a notice needs: the feature and the page on stare.pub. */
export class NotInCopyError extends Error {
  constructor(feature, path = '/') {
    super(MISSING[feature] || 'Not in this copy.');
    this.name = 'NotInCopyError';
    this.feature = feature;
    this.href = upstreamUrl(path);
  }
}

/** Throws NotInCopyError when the page's copy lacks `feature`; `path` is the page on stare.pub. */
export function requireFeature(feature, path = '/') {
  if (!hasFeature(feature)) throw new NotInCopyError(feature, path);
}

/** `[text node, ' ', <a>]` for a NotInCopyError, to put in a status line or a view. */
export function notInCopyNodes(doc, err) {
  const a = doc.createElement('a');
  a.href = err.href;
  a.className = 'not-in-copy-link';
  a.textContent = LINK_TEXT[err.feature] || 'Open it on stare.pub';
  return [doc.createTextNode(err.message), doc.createTextNode(' '), a];
}

/** A NotInCopyError as HTML, for a page view. */
export function notInCopyHtml(err) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<div class="pdf-view-message" role="status" data-not-in-copy="${esc(err.feature)}">${esc(err.message)} `
    + `<a class="not-in-copy-link" href="${esc(err.href)}">${esc(LINK_TEXT[err.feature] || 'Open it on stare.pub')}</a></div>`;
}

/**
 * What a key the copy's ledger doesn't have adds to the "no case with the key" landing:
 * `This copy's data is from 2026-11-08; try stare.pub.` Empty on stare.pub.
 */
export function keyMissNote(mirror = MIRROR) {
  if (!mirror) return '';
  return mirror.data_date
    ? `This copy’s data is from ${mirror.data_date}; try stare.pub.`
    : 'This copy’s data may be older than stare.pub’s; try stare.pub.';
}
