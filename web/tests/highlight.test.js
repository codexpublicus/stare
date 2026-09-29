import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  codePointOffset,
  detectCitationsRegex,
  escapeHtml,
  formatPlainText,
  renderParagraphHtml,
  renderTextHtml,
} from '../public/js/citations.js';

// Citation info as processCitations produces it, keyed by raw string.
const RESOLVABLE = { slug: 'us', volume: 123, page: '456', resolvable: true, externalUrl: null };
const UNRESOLVED = { slug: null, volume: 78, page: '90', resolvable: false, externalUrl: null };
const EXTERNAL = {
  slug: null,
  volume: 5,
  page: '6',
  resolvable: false,
  externalUrl: 'https://example.org/cite?a=1&b=2',
};

const linkFor = (raw) =>
  `<a class="cite-link" href="#us/123/456" data-slug="us" data-volume="123" data-page="456" title="${raw}">${raw}</a>`;
const unresolvedFor = (raw) => `<span class="cite-unresolved" title="Not yet indexed">${raw}</span>`;

// Occurrences in the shape processCitations reports per opinion: code point
// offsets into the whole opinion text.
function occurrencesIn(text) {
  return detectCitationsRegex(text).map(({ raw, start, end }) => ({ raw, start, end }));
}

// The regex-replace highlighter this work replaces, kept here only as an
// oracle: for text with one occurrence of each citation and nothing to
// escape, the offset renderer must produce the same markup it did.
function legacyHighlight(escapedText, citationMap) {
  let result = escapedText;
  const entries = [...citationMap.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [raw, info] of entries) {
    const re = new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    if (info.externalUrl) {
      result = result.replace(re,
        `<a class="cite-link cite-external" href="${info.externalUrl}" target="_blank" rel="noopener" title="View on external site">${raw}</a>`);
    } else if (info.resolvable) {
      result = result.replace(re,
        `<a class="cite-link" href="#${info.slug}/${info.volume}/${info.page}" data-slug="${info.slug}" data-volume="${info.volume}" data-page="${info.page}" title="${raw}">${raw}</a>`);
    } else {
      result = result.replace(re, `<span class="cite-unresolved" title="Not yet indexed">${raw}</span>`);
    }
  }
  return result;
}

describe('escapeHtml', () => {
  test('escapes markup characters and quotes', () => {
    assert.equal(escapeHtml(`a & b < c > d "e" 'f'`), 'a &amp; b &lt; c &gt; d &quot;e&quot; &#39;f&#39;');
  });

  test('empty and missing values become an empty string', () => {
    assert.equal(escapeHtml(''), '');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });
});

describe('formatPlainText', () => {
  test('escapes and wraps page markers', () => {
    assert.equal(formatPlainText('a < b [*647] c'), 'a &lt; b <span class="page-marker">[*647]</span> c');
  });
});

describe('renderParagraphHtml', () => {
  test('wraps each of two identical citations exactly once, at its own position', () => {
    const text = 'See 123 U.S. 456; accord 123 U.S. 456.';
    const map = new Map([['123 U.S. 456', RESOLVABLE]]);
    const html = renderParagraphHtml(text, 0, occurrencesIn(text), map);
    assert.equal(html, `See ${linkFor('123 U.S. 456')}; accord ${linkFor('123 U.S. 456')}.`);
  });

  test('uses code point offsets: a citation after an astral character', () => {
    const text = '\u{1F600} See 123 U.S. 456 here.';
    const occ = occurrencesIn(text);
    // The emoji is one code point but two UTF-16 units.
    assert.equal(occ[0].start, 6);
    const map = new Map([['123 U.S. 456', RESOLVABLE]]);
    assert.equal(renderParagraphHtml(text, 0, occ, map), `\u{1F600} See ${linkFor('123 U.S. 456')} here.`);
  });

  test('a citation next to a page marker keeps both', () => {
    const text = '[*647]123 U.S. 456 [*648]';
    const map = new Map([['123 U.S. 456', RESOLVABLE]]);
    assert.equal(
      renderParagraphHtml(text, 0, occurrencesIn(text), map),
      `<span class="page-marker">[*647]</span>${linkFor('123 U.S. 456')} <span class="page-marker">[*648]</span>`
    );
  });

  test('escapes < and & around a citation', () => {
    const text = 'A<B & 123 U.S. 456 & C>D';
    const map = new Map([['123 U.S. 456', RESOLVABLE]]);
    assert.equal(
      renderParagraphHtml(text, 0, occurrencesIn(text), map),
      `A&lt;B &amp; ${linkFor('123 U.S. 456')} &amp; C&gt;D`
    );
  });

  test('renders external, resolvable and unresolved markup', () => {
    const text = 'First 123 U.S. 456, then 78 N.E.2d 90, then 5 Ext. 6.';
    const map = new Map([
      ['123 U.S. 456', RESOLVABLE],
      ['78 N.E.2d 90', UNRESOLVED],
      ['5 Ext. 6', EXTERNAL],
    ]);
    assert.equal(
      renderParagraphHtml(text, 0, occurrencesIn(text), map),
      `First ${linkFor('123 U.S. 456')}, then ${unresolvedFor('78 N.E.2d 90')}, then ` +
        '<a class="cite-link cite-external" href="https://example.org/cite?a=1&amp;b=2" target="_blank" rel="noopener" title="View on external site">5 Ext. 6</a>.'
    );
  });

  test('matches the legacy highlighter on text it handled correctly', () => {
    const text = 'Cf. 123 U.S. 456 and 78 N.E.2d 90 at [*12] and 5 Ext. 6.';
    const map = new Map([
      ['123 U.S. 456', RESOLVABLE],
      ['78 N.E.2d 90', UNRESOLVED],
      ['5 Ext. 6', { ...EXTERNAL, externalUrl: 'https://example.org/x' }],
    ]);
    assert.equal(
      renderParagraphHtml(text, 0, occurrencesIn(text), map),
      legacyHighlight(formatPlainText(text), map)
    );
  });

  test('leaves occurrences with no citation info, or outside the paragraph, as plain text', () => {
    const text = 'See 123 U.S. 456.';
    const occ = [
      { raw: '123 U.S. 456', start: 4, end: 16 },
      { raw: '9 X. 9', start: 40, end: 46 },
    ];
    assert.equal(renderParagraphHtml(text, 0, occ, new Map()), 'See 123 U.S. 456.');
  });

  test('ignores occurrences with non-integer offsets', () => {
    const text = 'See 123 U.S. 456.';
    const map = new Map([['123 U.S. 456', RESOLVABLE]]);
    const occ = [{ raw: '123 U.S. 456', start: 4.5, end: 16 }];
    assert.equal(renderParagraphHtml(text, 0, occ, map), 'See 123 U.S. 456.');
  });

  test('renders an external citation without an http(s) URL as unresolved', () => {
    const text = 'See 5 Ext. 6.';
    const map = new Map([['5 Ext. 6', { ...EXTERNAL, externalUrl: 'javascript:alert(1)' }]]);
    assert.equal(renderParagraphHtml(text, 0, occurrencesIn(text), map), `See ${unresolvedFor('5 Ext. 6')}.`);
  });

  test('drops an occurrence that overlaps an earlier one', () => {
    const text = 'See 123 U.S. 456.';
    const map = new Map([
      ['123 U.S. 456', RESOLVABLE],
      ['U.S. 456', UNRESOLVED],
    ]);
    const occ = [
      { raw: 'U.S. 456', start: 8, end: 16 },
      { raw: '123 U.S. 456', start: 4, end: 16 },
    ];
    assert.equal(renderParagraphHtml(text, 0, occ, map), `See ${linkFor('123 U.S. 456')}.`);
  });
});

describe('renderTextHtml', () => {
  test('paragraphs after the first get correct offsets', () => {
    const text = 'Intro \u{1F600} line.\n\n\nSee 123 U.S. 456 twice: 123 U.S. 456.\nLast 78 N.E.2d 90.';
    const map = new Map([
      ['123 U.S. 456', RESOLVABLE],
      ['78 N.E.2d 90', UNRESOLVED],
    ]);
    assert.deepEqual(renderTextHtml(text, occurrencesIn(text), map), [
      'Intro \u{1F600} line.',
      `See ${linkFor('123 U.S. 456')} twice: ${linkFor('123 U.S. 456')}.`,
      `Last ${unresolvedFor('78 N.E.2d 90')}.`,
    ]);
  });

  test('a citation spanning a newline is not highlighted', () => {
    const text = 'See 123\nU.S. 456 here.';
    const occ = occurrencesIn(text);
    // The regex fallback treats the newline as whitespace and matches
    // across it, the case the paragraph split has to guard against.
    assert.equal(occ.length, 1);
    const map = new Map([[occ[0].raw, RESOLVABLE]]);
    assert.deepEqual(renderTextHtml(text, occ, map), ['See 123', 'U.S. 456 here.']);
  });

  test('skips blank paragraphs without shifting later offsets', () => {
    const text = '   \n  \nSee 123 U.S. 456.';
    const map = new Map([['123 U.S. 456', RESOLVABLE]]);
    assert.deepEqual(renderTextHtml(text, occurrencesIn(text), map), [`See ${linkFor('123 U.S. 456')}.`]);
  });

  test('accepts a plain-text formatter for text without page markers', () => {
    const text = '[*1] 123 U.S. 456';
    const map = new Map([['123 U.S. 456', RESOLVABLE]]);
    assert.deepEqual(renderTextHtml(text, occurrencesIn(text), map, escapeHtml), [`[*1] ${linkFor('123 U.S. 456')}`]);
  });

  test('with no citations, renders escaped and formatted paragraphs', () => {
    assert.deepEqual(renderTextHtml('a & b\n[*2] c', [], null), [
      'a &amp; b',
      '<span class="page-marker">[*2]</span> c',
    ]);
  });

  test('offsets agree with codePointOffset for the opinion text', () => {
    const text = 'x\n\u{1F600}\u{1F600} 123 U.S. 456';
    const [occ] = occurrencesIn(text);
    assert.equal(occ.start, codePointOffset(text, text.indexOf('123')));
    const map = new Map([['123 U.S. 456', RESOLVABLE]]);
    assert.deepEqual(renderTextHtml(text, [occ], map), ['x', `\u{1F600}\u{1F600} ${linkFor('123 U.S. 456')}`]);
  });
});
