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
