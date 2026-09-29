import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml, safeExternalUrl } from '../public/js/citations.js';
import { renderSidebar, updateCitationStatus } from '../public/js/ui.js';

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
// the citation-status live region test below needs to check: that
// updateCitationStatus mutates the same node renderSidebar created,
// instead of renderSidebar being called again and building a new one.
class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.className = '';
    this._attrs = {};
    this._parts = [];
  }
  setAttribute(name, value) { this._attrs[name] = value; }
  getAttribute(name) { return this._attrs[name]; }
  set textContent(v) { this._parts = [escapeHtml(v)]; }
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
    assert.match(el.innerHTML, /<a class="cited-case-link" href="https:\/\/example.org\/s\?a=1&amp;b=2" target="_blank" rel="noopener">56 Stat. 195<\/a>/);
  });

  test('does not link a javascript: external citation', () => {
    const el = new FakeElement();
    renderSidebar(el, caseData, 'a2d', 1, [], [external('5 Ext. 6', 'javascript:alert(1)')]);
    assert.doesNotMatch(el.innerHTML, /javascript:/);
    assert.match(el.innerHTML, /<span class="cited-status no">&#10007;<\/span>\s*<span class="cited-case-unresolved">5 Ext. 6<\/span>/);
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

  test('done status with detected citations shows the list, not the loading message', () => {
    const el = new FakeElement();
    renderSidebar(el, caseData, 'a2d', 1, [], detected, 'done');
    assert.doesNotMatch(el.innerHTML, /Finding citations/);
    assert.match(el.innerHTML, /cited-case-link/);
    assert.match(el.innerHTML, /Cited Cases \(1\)/);
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
        /<div class="sidebar-section citation-status" role="status" aria-live="polite">\s*<div class="sidebar-label">Cited Cases/
      );
    }
  });
});

describe('updateCitationStatus persists the live region node', () => {
  let restore;
  before(() => { restore = installFakeDom(); });
  after(() => restore());

  const caseData = { name_abbreviation: 'A v. B', citations: [{ cite: '1 A.2d 1' }], cites_to: [] };
  const detected = [{ raw: '1 A.2d 2', resolvable: true, slug: 'a2d', volume: 1, page: 2, externalUrl: null }];

  test('loading -> done updates the same node renderSidebar returned, in place', () => {
    const el = new FakeElement();
    const region = renderSidebar(el, caseData, 'a2d', 1, [], null, 'loading');

    assert.match(region.innerHTML, /Finding citations/);
    assert.match(el.innerHTML, /Finding citations/);

    updateCitationStatus(region, caseData, detected, 'done');

    // Same node: the region object identity did not change, but its own
    // content did, which is what an aria-live element requires in order
    // for a screen reader to pick up and announce the change.
    assert.doesNotMatch(region.innerHTML, /Finding citations/);
    assert.match(region.innerHTML, /cited-case-link/);
    assert.match(region.innerHTML, /Cited Cases \(1\)/);
    assert.equal(region.getAttribute('role'), 'status');
    assert.equal(region.getAttribute('aria-live'), 'polite');

    // el's own innerHTML (computed from its live children, including
    // `region` by reference) reflects the update too, without el.innerHTML
    // ever having been reassigned wholesale for this transition.
    assert.doesNotMatch(el.innerHTML, /Finding citations/);
    assert.match(el.innerHTML, /cited-case-link/);
  });

  test('loading -> error updates the same node in place', () => {
    const el = new FakeElement();
    const region = renderSidebar(el, caseData, 'a2d', 1, [], null, 'loading');

    updateCitationStatus(region, caseData, null, 'error');

    assert.doesNotMatch(region.innerHTML, /Finding citations/);
    assert.match(region.innerHTML, /couldn.t check citations/i);
    assert.match(el.innerHTML, /couldn.t check citations/i);
  });

  test('is a no-op when passed a null region (case changed before detection finished)', () => {
    assert.doesNotThrow(() => updateCitationStatus(null, caseData, detected, 'done'));
  });
});
