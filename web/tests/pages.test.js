// Pin pages in the hash route and page breaks in the case view (#124).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseHash, pinPage, pinSuffix } from '../public/js/router.js';
import { locatePageBreaks, normalizeText, pageBreaks, paragraphPosition } from '../public/js/pages.js';

describe('parseHash', () => {
  test('reads a pin page after the case', () => {
    assert.deepEqual(parseHash('#p2d/997/1021-01@1023'),
      { reporter: 'p2d', volume: '997', page: 1021, seq: 1, pin: 1023 });
    assert.deepEqual(parseHash('#p2d/997/1021@1023'),
      { reporter: 'p2d', volume: '997', page: 1021, seq: null, pin: 1023 });
  });

  test('has no pin without one', () => {
    assert.deepEqual(parseHash('#a3d/138-2/1012-01'),
      { reporter: 'a3d', volume: '138-2', page: 1012, seq: 1, pin: null });
  });

  test('rejects a malformed pin', () => {
    assert.equal(parseHash('#p2d/997/1021@'), null);
    assert.equal(parseHash('#p2d/997/1021@n.4'), null);
  });
});

describe('pinPage', () => {
  for (const [pin, page] of [
    ['1023', 1023],
    ['1023-24', 1023],
    ['1023–24', 1023],
    ['1022, 1023', 1022],
    ['1023 n.4', 1023],
    ['1023 & n.2', 1023],
    ['*1023', 1023],
    ['at 1023', 1023],
    ['n.3', null],
    ['¶ 10', null],
    ['§ 1985', null],
    ['', null],
    [null, null],
  ]) {
    test(`${JSON.stringify(pin)} → ${page}`, () => assert.equal(pinPage(pin), page));
  }

  test('pinSuffix leaves out a pin at the first page', () => {
    assert.equal(pinSuffix('1023-24', '1021'), '@1023');
    assert.equal(pinSuffix('1021', '1021'), '');
    assert.equal(pinSuffix('n.3', '1021'), '');
    assert.equal(pinSuffix(null, '1021'), '');
  });
});

describe('page breaks', () => {
  test('normalizeText collapses whitespace and maps back to the text', () => {
    const { text, at } = normalizeText('  a\n\n b  c');
    assert.equal(text, 'a b c');
    assert.deepEqual(at, [2, 3, 6, 7, 9]);
  });

  test('a break is placed before the words that follow it', () => {
    const text = 'MACY, Justice.\nThe Roes appeal.\nWe remand this case to the district court for dismissal.';
    const stream = {
      text: 'MACY, Justice. The Roes appeal. We remand this case to the district court for dismissal. ',
      labels: [{ page: '1022', at: 0 }, { page: '1023', at: 'MACY, Justice. The Roes appeal. We remand '.length }],
    };
    const breaks = locatePageBreaks(stream, text);
    assert.deepEqual(breaks, [{ page: '1022', offset: 0 }, { page: '1023', offset: text.indexOf('this case') }]);
  });

  test('a break whose words are not in the text is left out', () => {
    const stream = { text: 'Alpha beta. Gamma delta epsilon.', labels: [{ page: '5', at: 12 }] };
    assert.deepEqual(locatePageBreaks(stream, 'Something else entirely.'), []);
  });

  test('paragraphPosition splits as the reader does', () => {
    const text = 'One.\n\nTwo three.\nFour.';
    assert.deepEqual(paragraphPosition(text, 0), { paragraph: 0, offset: 0 });
    assert.deepEqual(paragraphPosition(text, text.indexOf('three')), { paragraph: 1, offset: 4 });
    // In the break between paragraphs: the start of the next one.
    assert.deepEqual(paragraphPosition(text, 5), { paragraph: 1, offset: 0 });
    assert.deepEqual(paragraphPosition(text, text.indexOf('Four')), { paragraph: 2, offset: 0 });
    assert.equal(paragraphPosition(text, text.length + 1), null);
  });

  test('pageBreaks places each opinion\'s labels in its paragraphs', () => {
    // A stand-in for the parsed CAP HTML: opinionStreams only walks it.
    const el = (tag, attrs, ...children) => ({
      nodeType: 1, tagName: tag.toUpperCase(), childNodes: children,
      classList: { contains: (c) => (attrs.class || '').split(' ').includes(c) },
      getAttribute: (k) => attrs[k] ?? null,
    });
    const txt = (s) => ({ nodeType: 3, nodeValue: s });
    const label = (page) => el('a', { class: 'page-label', 'data-label': page }, txt(`*${page}`));
    const article = el('article', { class: 'opinion' },
      txt('\n  '), el('p', {}, txt('First paragraph here.')),
      txt('\n  '), el('p', {}, txt('Second paragraph, '), label('1023'), txt('continued on the next page.')));
    const doc = {
      querySelectorAll: (sel) => (sel === 'article.opinion' ? [article] : []),
    };
    const breaks = pageBreaks('', [{ text: 'First paragraph here.\nSecond paragraph, continued on the next page.' }], () => doc);
    assert.deepEqual(breaks, [[{ page: '1023', paragraph: 1, offset: 'Second paragraph, '.length }]]);
  });
});
