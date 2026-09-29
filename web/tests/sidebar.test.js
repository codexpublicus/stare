import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml, safeExternalUrl } from '../public/js/citations.js';
import { renderSidebar } from '../public/js/ui.js';

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

describe('renderSidebar external citations', () => {
  // renderSidebar reads window.location and escapes through a DOM span;
  // stand both in with the smallest stubs that behave the same way.
  const saved = {};
  before(() => {
    saved.window = globalThis.window;
    saved.document = globalThis.document;
    globalThis.window = { location: { pathname: '/' } };
    globalThis.document = {
      createElement: () => ({
        set textContent(v) { this.text = v; },
        get innerHTML() { return escapeHtml(this.text); },
      }),
    };
  });
  after(() => {
    globalThis.window = saved.window;
    globalThis.document = saved.document;
  });

  const caseData = { name_abbreviation: 'A v. B', citations: [{ cite: '1 A.2d 1' }] };
  const external = (raw, externalUrl) => ({ raw, externalUrl, resolvable: false, slug: null });

  test('links an https external citation', () => {
    const el = {};
    renderSidebar(el, caseData, 'a2d', 1, [], [external('56 Stat. 195', 'https://example.org/s?a=1&b=2')]);
    assert.match(el.innerHTML, /<a class="cited-case-link" href="https:\/\/example.org\/s\?a=1&amp;b=2" target="_blank" rel="noopener">56 Stat. 195<\/a>/);
  });

  test('does not link a javascript: external citation', () => {
    const el = {};
    renderSidebar(el, caseData, 'a2d', 1, [], [external('5 Ext. 6', 'javascript:alert(1)')]);
    assert.doesNotMatch(el.innerHTML, /javascript:/);
    assert.match(el.innerHTML, /<span class="cited-status no">&#10007;<\/span>\s*<span class="cited-case-unresolved">5 Ext. 6<\/span>/);
  });
});

describe('renderSidebar citation status', () => {
  // Same window/document stand-ins as above: renderSidebar reads
  // window.location and escapes through a DOM span.
  const saved = {};
  before(() => {
    saved.window = globalThis.window;
    saved.document = globalThis.document;
    globalThis.window = { location: { pathname: '/' } };
    globalThis.document = {
      createElement: () => ({
        set textContent(v) { this.text = v; },
        get innerHTML() { return escapeHtml(this.text); },
      }),
    };
  });
  after(() => {
    globalThis.window = saved.window;
    globalThis.document = saved.document;
  });

  const caseData = { name_abbreviation: 'A v. B', citations: [{ cite: '1 A.2d 1' }], cites_to: [] };
  const detected = [{ raw: '1 A.2d 2', resolvable: true, slug: 'a2d', volume: 1, page: 2, externalUrl: null }];

  test('loading status shows a "Finding citations" status with aria-live, no list', () => {
    const el = {};
    renderSidebar(el, caseData, 'a2d', 1, [], null, 'loading');
    assert.match(el.innerHTML, /role="status" aria-live="polite"/);
    assert.match(el.innerHTML, /Finding citations/);
    assert.doesNotMatch(el.innerHTML, /cited-case-link/);
  });

  test('error status shows a short failure note with aria-live, not the loading text', () => {
    const el = {};
    renderSidebar(el, caseData, 'a2d', 1, [], null, 'error');
    assert.match(el.innerHTML, /role="status" aria-live="polite"/);
    assert.match(el.innerHTML, /couldn.t check citations/i);
    assert.doesNotMatch(el.innerHTML, /Finding citations/);
  });

  test('done status with detected citations shows the list, not the loading message', () => {
    const el = {};
    renderSidebar(el, caseData, 'a2d', 1, [], detected, 'done');
    assert.doesNotMatch(el.innerHTML, /Finding citations/);
    assert.match(el.innerHTML, /cited-case-link/);
    assert.match(el.innerHTML, /Cited Cases \(1\)/);
  });

  test('a cached hit (status "done" from the first render) never shows the loading message', () => {
    // Simulates main.js's cached re-render path: citationsByCase already
    // holds this case's result, so showCase renders the finished citations
    // with 'done' on the very first call, skipping the loading state.
    const el = {};
    renderSidebar(el, caseData, 'a2d', 1, [], detected, 'done');
    assert.doesNotMatch(el.innerHTML, /Finding citations/);
    assert.match(el.innerHTML, /cited-case-link/);
  });

  test('the cited-cases section wrapper is reserved across loading, error and done (no layout shift)', () => {
    for (const [citations, status] of [[null, 'loading'], [null, 'error'], [detected, 'done']]) {
      const el = {};
      renderSidebar(el, caseData, 'a2d', 1, [], citations, status);
      assert.match(
        el.innerHTML,
        /<div class="sidebar-section" role="status" aria-live="polite">\s*<div class="sidebar-label">Cited Cases/
      );
    }
  });
});
