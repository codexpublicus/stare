import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { safeExternalUrl } from '../public/js/citations.js';
import { renderSidebar, updateCitationStatus } from '../public/js/ui.js';
// groupCitations groups through the stare WASM (#198).
import './wasm-node.js';

// Real DOM text-node serialization (what .innerHTML reads back after a
// .textContent write) only escapes '&', '<' and '>'; unlike attribute
// escaping, it leaves quotes alone. ui.js's escapeHtml is attribute-style
// (it also escapes quotes), so it is the wrong function to reuse here.
function escapeTextNode(str) {
  return String(str).replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}

describe('safeExternalUrl', () => {
  test('keeps http and https URLs', () => {
    assert.equal(safeExternalUrl('https://example.org/a'), 'https://example.org/a');
    assert.equal(safeExternalUrl('HTTP://example.org/a'), 'HTTP://example.org/a');
  });

  test('rejects other schemes and missing values', () => {
    assert.equal(safeExternalUrl('javascript:alert(1)'), null);
    assert.equal(safeExternalUrl(' https://example.org'), null);
    assert.equal(safeExternalUrl('//example.org'), null);
    assert.equal(safeExternalUrl(null), null);
    assert.equal(safeExternalUrl(undefined), null);
  });
});

// A minimal DOM stand-in, real enough that renderSidebar's calls
// (innerHTML, insertAdjacentHTML, appendChild, setAttribute, textContent)
// behave the way the real DOM does: appendChild keeps the appended node's
// identity, and an element's innerHTML/outerHTML reflect its actual
// children rather than an opaque string. That identity is exactly what
// the citation-status tests below need to check: that updateCitationStatus
// mutates the same nodes renderSidebar created, instead of renderSidebar
// being called again and building new ones.
class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.className = '';
    this._attrs = {};
    this._parts = [];
  }
  setAttribute(name, value) { this._attrs[name] = value; }
  getAttribute(name) { return this._attrs[name]; }
  set textContent(v) { this._parts = [escapeTextNode(v)]; }
  set innerHTML(html) { this._parts = [html == null ? '' : html]; }
  get innerHTML() {
    return this._parts.map(p => (typeof p === 'string' ? p : p.outerHTML)).join('');
  }
  get outerHTML() {
    const cls = this.className ? ` class="${this.className}"` : '';
    const attrs = Object.entries(this._attrs).map(([k, v]) => ` ${k}="${v}"`).join('');
    return `<${this.tagName}${cls}${attrs}>${this.innerHTML}</${this.tagName}>`;
  }
  insertAdjacentHTML(_position, html) { this._parts.push(html); }
  appendChild(node) { this._parts.push(node); return node; }
}

function installFakeDom() {
  const saved = { window: globalThis.window, document: globalThis.document };
  globalThis.window = { location: { pathname: '/' } };
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  return () => { globalThis.window = saved.window; globalThis.document = saved.document; };
}

describe('renderSidebar external citations', () => {
  // renderSidebar reads window.location and escapes/builds through the DOM.
  let restore;
  before(() => { restore = installFakeDom(); });
  after(() => restore());

  const caseData = { name_abbreviation: 'A v. B', citations: [{ cite: '1 A.2d 1' }] };
  const external = (raw, externalUrl) => ({ raw, externalUrl, resolvable: false, slug: null });

  test('links an https external citation', () => {
    const el = new FakeElement();
    renderSidebar(el, caseData, 'a2d', 1, [], [external('56 Stat. 195', 'https://example.org/s?a=1&b=2')]);
    assert.match(el.innerHTML, /<a class="cited-case-link" href="https:\/\/example.org\/s\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">56 Stat. 195<\/a>/);
  });

  test('does not link a javascript: external citation', () => {
    const el = new FakeElement();
    renderSidebar(el, caseData, 'a2d', 1, [], [external('5 Ext. 6', 'javascript:alert(1)')]);
    assert.doesNotMatch(el.innerHTML, /javascript:/);
    assert.match(el.innerHTML, /<span class="cited-status no">&#10007;<\/span>\s*<span class="cited-case-unresolved">5 Ext. 6<\/span>/);
  });

  test('links a case it does not hold to CourtListener, after held cases and statutes', () => {
    const el = new FakeElement();
    const notHeld = {
      raw: '598 U.S. 175', resolvable: false, slug: 'us', volume: 598, page: '175', externalUrl: null,
      caseLinks: [{ source: 'courtlistener', kind: 'full_text', url: 'https://www.courtlistener.com/c/U.S./598/175/' }],
    };
    const held = { raw: '1 A.2d 2', resolvable: true, slug: 'a2d', volume: 1, page: 2, externalUrl: null, caseLinks: [] };
    renderSidebar(el, caseData, 'a2d', 1, [], [notHeld, external('56 Stat. 195', 'https://example.org/s'), held], 'done');
    assert.match(el.innerHTML,
      /<a class="cited-lookup-link" href="https:\/\/www.courtlistener.com\/c\/U.S.\/598\/175\/" target="_blank" rel="noopener noreferrer">Not in stare.pub: may be at CourtListener<\/a>/);
    const order = [...el.innerHTML.matchAll(/>(1 A\.2d 2|56 Stat\. 195|598 U\.S\. 175)</g)].map(m => m[1]);
    assert.deepEqual(order, ['1 A.2d 2', '56 Stat. 195', '598 U.S. 175']);
  });
});

describe('renderSidebar citation status', () => {
  let restore;
  before(() => { restore = installFakeDom(); });
  after(() => restore());

  const caseData = { name_abbreviation: 'A v. B', citations: [{ cite: '1 A.2d 1' }], cites_to: [] };
  const detected = [{ raw: '1 A.2d 2', resolvable: true, slug: 'a2d', volume: 1, page: 2, externalUrl: null }];

  test('loading status shows a "Finding citations" status with aria-live, no list', () => {
    const el = new FakeElement();
    renderSidebar(el, caseData, 'a2d', 1, [], null, 'loading');
    assert.match(el.innerHTML, /role="status" aria-live="polite"/);
    assert.match(el.innerHTML, /Finding citations/);
    assert.doesNotMatch(el.innerHTML, /cited-case-link/);
  });

  test('error status shows a short failure note with aria-live, not the loading text', () => {
    const el = new FakeElement();
    renderSidebar(el, caseData, 'a2d', 1, [], null, 'error');
    assert.match(el.innerHTML, /role="status" aria-live="polite"/);
    assert.match(el.innerHTML, /couldn.t check citations/i);
    assert.doesNotMatch(el.innerHTML, /Finding citations/);
  });

  test('done status with detected citations shows the list and a short found count', () => {
    const el = new FakeElement();
    renderSidebar(el, caseData, 'a2d', 1, [], detected, 'done');
    assert.doesNotMatch(el.innerHTML, /Finding citations/);
    assert.match(el.innerHTML, /cited-case-link/);
    assert.match(el.innerHTML, /Cited Cases \(1\)/);
    assert.match(el.innerHTML, /1 cited case found \(1 resolvable\)/);
  });

  test('statutes are counted apart from cases, and bare section references not at all', () => {
    const el = new FakeElement();
    const mixed = [
      ...detected,
      { raw: 'N.C. Gen. Stat. § 1-289', type: 'FullLawCitation', law: { code: 'N.C. Gen. Stat.' }, resolvable: false, externalUrl: null, caseLinks: [] },
      { raw: '§', type: 'UnknownCitation', resolvable: false, externalUrl: null, caseLinks: [] },
    ];
    renderSidebar(el, caseData, 'a2d', 1, [], mixed, 'done');
    assert.match(el.innerHTML, /Cited Cases \(2\)/);
    assert.match(el.innerHTML, /1 cited case found \(1 resolvable\), 1 statute/);
    assert.match(el.innerHTML, /Statute; no free source linked yet/);
    assert.doesNotMatch(el.innerHTML, /<span class="cited-case-unresolved">§<\/span>/);
  });

  test('a cached hit (status "done" from the first render) never shows the loading message', () => {
    // Simulates main.js's cached re-render path: citationsByCase already
    // holds this case's result, so showCase renders the finished citations
    // with 'done' on the very first call, skipping the loading state.
    const el = new FakeElement();
    renderSidebar(el, caseData, 'a2d', 1, [], detected, 'done');
    assert.doesNotMatch(el.innerHTML, /Finding citations/);
    assert.match(el.innerHTML, /cited-case-link/);
  });

  test('the cited-cases section wrapper is reserved across loading, error and done (no layout shift)', () => {
    for (const [citations, status] of [[null, 'loading'], [null, 'error'], [detected, 'done']]) {
      const el = new FakeElement();
      renderSidebar(el, caseData, 'a2d', 1, [], citations, status);
      assert.match(
        el.innerHTML,
        /<div class="sidebar-section citation-status">\s*<div class="sidebar-label">Cited Cases/
      );
    }
  });

  test('role="status" aria-live="polite" is on the short status element, never on the list', () => {
    const el = new FakeElement();
    const handle = renderSidebar(el, caseData, 'a2d', 1, [], detected, 'done');
    assert.equal(handle.statusEl.getAttribute('role'), 'status');
    assert.equal(handle.statusEl.getAttribute('aria-live'), 'polite');
    assert.equal(handle.listEl.getAttribute('role'), undefined);
    assert.equal(handle.listEl.getAttribute('aria-live'), undefined);
  });
});

describe('citation status: the live region holds a short sentence, not the list', () => {
  let restore;
  before(() => { restore = installFakeDom(); });
  after(() => restore());

  const caseData = { name_abbreviation: 'A v. B', citations: [{ cite: '1 A.2d 1' }], cites_to: [] };
  // 11 citations: the controller's original bug report was a live region
  // reading a whole 11-link, 1000+ char list aloud on every transition.
  const detected = Array.from({ length: 11 }, (_, i) => ({
    raw: `${i + 1} A.2d ${i + 2}`, resolvable: true, slug: 'a2d', volume: 1, page: i + 2, externalUrl: null,
  }));

  test('statusEl text is short and never contains the list markup', () => {
    const el = new FakeElement();
    const handle = renderSidebar(el, caseData, 'a2d', 1, [], detected, 'done');

    assert.doesNotMatch(handle.statusEl.innerHTML, /cited-case-link/);
    assert.doesNotMatch(handle.statusEl.innerHTML, /<a /);
    assert.equal(handle.statusEl.innerHTML.length < 40, true, `expected a short status, got: ${handle.statusEl.innerHTML}`);
    assert.match(handle.statusEl.innerHTML, /11 cited cases found/);
  });

  test('the list itself lives in listEl, which has no aria-live', () => {
    const el = new FakeElement();
    const handle = renderSidebar(el, caseData, 'a2d', 1, [], detected, 'done');

    const links = handle.listEl.innerHTML.match(/cited-case-link/g) || [];
    assert.equal(links.length, 11);
    assert.equal(handle.listEl.getAttribute('aria-live'), undefined);
  });
});

describe('updateCitationStatus persists the status and list nodes', () => {
  let restore;
  before(() => { restore = installFakeDom(); });
  after(() => restore());

  const caseData = { name_abbreviation: 'A v. B', citations: [{ cite: '1 A.2d 1' }], cites_to: [] };
  const detected = [{ raw: '1 A.2d 2', resolvable: true, slug: 'a2d', volume: 1, page: 2, externalUrl: null }];

  test('loading -> done updates statusEl and listEl in place, by identity', () => {
    const el = new FakeElement();
    const handle = renderSidebar(el, caseData, 'a2d', 1, [], null, 'loading');
    const { statusEl, listEl } = handle;

    assert.match(statusEl.innerHTML, /Finding citations/);
    assert.equal(listEl.innerHTML, '');

    updateCitationStatus(handle, caseData, detected, 'done');

    // Same node objects throughout: identity did not change, only content,
    // which is what an aria-live element requires for a screen reader to
    // pick up and announce the change.
    assert.equal(handle.statusEl, statusEl);
    assert.equal(handle.listEl, listEl);

    assert.doesNotMatch(statusEl.innerHTML, /Finding citations/);
    assert.match(statusEl.innerHTML, /1 cited case found/);
    assert.doesNotMatch(statusEl.innerHTML, /cited-case-link/);

    assert.match(listEl.innerHTML, /cited-case-link/);

    assert.equal(statusEl.getAttribute('role'), 'status');
    assert.equal(statusEl.getAttribute('aria-live'), 'polite');
    assert.equal(listEl.getAttribute('role'), undefined);

    // el's own innerHTML (computed from its live children, including
    // statusEl/listEl by reference) reflects the update too, without
    // el.innerHTML ever having been reassigned wholesale for this
    // transition.
    assert.doesNotMatch(el.innerHTML, /Finding citations/);
    assert.match(el.innerHTML, /cited-case-link/);
  });

  test('loading -> error updates statusEl in place and says why in the list\'s place, with no list', () => {
    const el = new FakeElement();
    const handle = renderSidebar(el, caseData, 'a2d', 1, [], null, 'loading');

    updateCitationStatus(handle, caseData, null, 'error', null, { reason: 'the server couldn\'t be reached' });

    assert.doesNotMatch(handle.statusEl.innerHTML, /Finding citations/);
    assert.match(handle.statusEl.innerHTML, /couldn.t check citations/i);
    assert.match(el.innerHTML, /couldn.t check citations/i);
    // Why, and that the text itself is complete (#271); no list, and no Retry without one.
    assert.match(handle.listEl.innerHTML, /citation check stopped: the server couldn.+t be reached/);
    assert.match(handle.listEl.innerHTML, /The text is complete/);
    assert.doesNotMatch(handle.listEl.innerHTML, /cited-case/);
    assert.doesNotMatch(handle.listEl.innerHTML, /Retry/);
  });

  test('is a no-op when passed a null handle (case changed before detection finished)', () => {
    assert.doesNotThrow(() => updateCitationStatus(null, caseData, detected, 'done'));
  });
});

describe('renderSidebar volume PDF', () => {
  let restore;
  before(() => { restore = installFakeDom(); });
  after(() => restore());

  const caseData = { name_abbreviation: 'A v. B', citations: [{ cite: '1 A.2d 1' }], cites_to: [] };

  test('links the archival PDF at the case\'s page', () => {
    const el = new FakeElement();
    renderSidebar(el, caseData, 'a2d', '31', [], null, 'done', null, 647);
    assert.match(el.innerHTML,
      /<a class="sidebar-action" id="pdf-link" href="https:\/\/data.stare.pub\/pdf\/us\/a2d\/31.pdf#page=647" target="_blank" rel="noopener" title="The whole volume's archival PDF, opened at this case">/);
    assert.match(el.innerHTML, /Download archival PDF/);
  });

  test('links the volume when the page is unknown', () => {
    const el = new FakeElement();
    renderSidebar(el, caseData, 'pr', '1', [], null, 'done');
    assert.match(el.innerHTML, /href="https:\/\/data.stare.pub\/pdf\/pr\/pr\/1.pdf"/);
  });

  test('says a volume without scans has none, with no link', () => {
    const el = new FakeElement();
    renderSidebar(el, caseData, 'a3d', '200', [], null, 'done', null, 3);
    assert.match(el.innerHTML, /No page scans exist for this volume/);
    assert.doesNotMatch(el.innerHTML, /Download archival PDF/);
    assert.doesNotMatch(el.innerHTML, /\.pdf/);
  });
});
