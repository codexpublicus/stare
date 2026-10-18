// Labelled pages (#154): front matter (`xxix`) and supplements (`Supp. 1`), which the
// index keys by their label lowercased, in the hash route, the input parser, and the
// page check.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { citedPage, filePage, labelCases, pageKey, pageSegment } from '../public/js/pagekey.js';
import { caseHash, parseHash } from '../public/js/router.js';
import { inputFromCitations, parseInput } from '../public/js/resolve.js';
import { caseIdentity, checkPage } from '../public/js/citations.js';
import { idxEntries } from '../public/js/idx.js';
import { normalizeManifest } from '../public/js/manifest.js';

describe('pageKey', () => {
  for (const [text, key] of [
    ['647', 647], ['0647', 647], [647, 647],
    ['xxix', 'xxix'], ['XXIX', 'xxix'], [' Supp.  1 ', 'supp. 1'], ['?', '?'],
  ]) {
    test(`${JSON.stringify(text)} is ${JSON.stringify(key)}`, () => assert.equal(pageKey(text), key));
  }
  for (const text of ['', '  ', '647a', '647 648', '37,448', '#x', null]) {
    test(`${JSON.stringify(text)} is no page`, () => assert.equal(pageKey(text), null));
  }
});

test('citedPage takes the number a page starts with, else its label', () => {
  assert.equal(citedPage('647'), 647);
  assert.equal(citedPage('1023-24'), 1023);
  assert.equal(citedPage('xxix'), 'xxix');
  assert.equal(citedPage(null), null);
});

test('filePage reads a case file name the way the index keys it', () => {
  assert.equal(filePage('0647-01'), 647);
  assert.equal(filePage('[106]-01'), 106);
  assert.equal(filePage('1114-1140-01'), 1114);
  assert.equal(filePage('xxix-01'), 'xxix');
  assert.equal(filePage('0xxv-01'), 'xxv');
  assert.equal(filePage('Supp. 1-01'), 'supp. 1');
  assert.equal(filePage('0iii-01'), 'iii');
  assert.equal(filePage('B174-01'), 174);
  assert.equal(filePage('1265=1275-01'), 1265);
});

test('labelCases finds a label\'s case files in a .multi', () => {
  const multi = '956,0956-02\nsupp. 1,Supp. 1-01\nsupp. 15,Supp. 15-01\nxxix,xxix-01\n';
  assert.deepEqual(labelCases(multi, 'Supp. 1'), ['Supp. 1-01']);
  assert.deepEqual(labelCases(multi, 'xxix'), ['xxix-01']);
  assert.deepEqual(labelCases(multi, 'xxx'), []);
  assert.deepEqual(labelCases(multi, 956), []);
  assert.deepEqual(labelCases(null, 'xxix'), []);
});

describe('the hash route', () => {
  test('reads a labelled page, with or without a sequence', () => {
    assert.deepEqual(parseHash('#cai-cas/1/xxix-01'),
      { reporter: 'cai-cas', volume: '1', page: 'xxix', seq: 1, pin: null, cite: null });
    assert.deepEqual(parseHash('#cai-cas/1/XXIX'),
      { reporter: 'cai-cas', volume: '1', page: 'xxix', seq: null, pin: null, cite: null });
    assert.deepEqual(parseHash('#cal-app-4th/15/supp.%201-01'),
      { reporter: 'cal-app-4th', volume: '15', page: 'supp. 1', seq: 1, pin: null, cite: null });
    assert.deepEqual(parseHash('#cal-app-4th/15/Supp. 1'),
      { reporter: 'cal-app-4th', volume: '15', page: 'supp. 1', seq: null, pin: null, cite: null });
  });

  test('still reads numbered pages as before, and rejects what it did', () => {
    assert.deepEqual(parseHash('#a2d/31/647-02'),
      { reporter: 'a2d', volume: '31', page: 647, seq: 2, pin: null, cite: null });
    for (const bad of ['#a2d/31', '#a2d/31/647/648', '#a2d/31/647a', '#p2d/997/1021@n.4', '#a2d/x/647', '#a2d/31/%E0%A4%A']) {
      assert.equal(parseHash(bad), null, bad);
    }
  });

  test('writes a label URI-encoded, and reads back what it writes', () => {
    assert.equal(caseHash('cal-app-4th', '15', 'supp. 1', 1), '#cal-app-4th/15/supp.%201-01');
    assert.equal(caseHash('cai-cas', '1', 'xxix', 2), '#cai-cas/1/xxix-02');
    assert.equal(caseHash('a2d', '31', 647, 1), '#a2d/31/647-01');
    assert.equal(pageSegment('supp. 1'), 'supp.%201');
    assert.equal(parseHash(caseHash('cal-app-4th', '15', 'supp. 1', 1)).page, 'supp. 1');
  });
});

describe('the citation input', () => {
  test('takes a labelled page in slug form', async () => {
    assert.deepEqual(await parseInput('cai-cas 1 xxix'), { reporter: 'cai-cas', volume: '1', page: 'xxix', seq: null });
    assert.deepEqual(await parseInput('cal-app-4th 15 Supp. 1'), { reporter: 'cal-app-4th', volume: '15', page: 'supp. 1', seq: null });
    assert.deepEqual(await parseInput('cal-app-4th/15/supp. 1-01'), { reporter: 'cal-app-4th', volume: '15', page: 'supp. 1', seq: 1 });
    assert.deepEqual(await parseInput('a2d 31 647-02'), { reporter: 'a2d', volume: '31', page: 647, seq: 2 });
  });

  test('takes a labelled page citare read from a citation', () => {
    assert.deepEqual(
      inputFromCitations([{ slug: 'cai-cas', volume: '1', page: 'xxix' }]),
      { reporter: 'cai-cas', volume: '1', page: 'xxix', seq: null },
    );
    assert.deepEqual(
      inputFromCitations([{ slug: 'a2d', volume: '31', page: '647' }]),
      { reporter: 'a2d', volume: '31', page: 647, seq: null },
    );
  });
});

describe('the page check', () => {
  const cite = { resolvable: true, type: 'FullCaseCitation', slug: 'cai-cas', volume: 1, page: 'XXIX' };
  test('a citation to a labelled page has the index\'s key as its identity', () => {
    assert.equal(caseIdentity(cite), 'cai-cas/1/xxix');
  });

  test('finds a labelled page in the .multi without the unified index', async () => {
    const log = [];
    const deps = {
      manifest: normalizeManifest({ format: 2, reporters: { 'cai-cas': ['1'] } }),
      readBin: async () => { throw new Error('a label is never looked up in the .bin'); },
      readMulti: async (slug, volume) => { log.push(`${slug}/${volume}`); return 'xxix,xxix-01\n'; },
      lookup: () => null,
      retryDelay: 0,
    };
    assert.equal(await checkPage('cai-cas', 1, 'xxix', deps), true);
    assert.equal(await checkPage('cai-cas', 1, 'XXIX', deps), true);
    assert.equal(await checkPage('cai-cas', 1, 'xxx', deps), false);
    assert.deepEqual(log, ['cai-cas/1', 'cai-cas/1', 'cai-cas/1']);
  });

  test('finds a labelled page in the unified index, in the last part', async () => {
    const files = { 0: '#parts,900\n1,cap,0001-01\n', 1: '900,cap,0900-01\nxxix,cap,xxix-01\n' };
    const parts = [];
    const lookup = (bytes, page) => {
      const lines = Buffer.from(bytes).toString('utf8').split('\n').filter(Boolean);
      const header = lines[0].startsWith('#parts,') ? lines.shift() : null;
      const want = pageKey(page);
      // Labels sort after numbers, so a label is past every numbered part start.
      const part = header && typeof want === 'string' ? 1 : 0;
      const entries = lines.map((l) => l.split(','))
        .filter(([p]) => pageKey(p) === want)
        .map(([p, source, ref]) => ({ page: p, source, ref, case_file: ref }));
      return { part, entries };
    };
    const deps = {
      manifest: normalizeManifest({ format: 2, idx: 1, reporters: { 'cai-cas': ['1'] } }),
      idxEntries: (s, v, p) => idxEntries(s, v, p, {
        readIdx: async (_s, _v, part) => { parts.push(part); return new TextEncoder().encode(files[part]); },
        lookup,
      }),
      retryDelay: 0,
    };
    assert.equal(await checkPage('cai-cas', 1, 'xxix', deps), true);
    assert.deepEqual(parts, [0, 1]);
  });
});
