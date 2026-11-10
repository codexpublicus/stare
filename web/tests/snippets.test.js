// The search page's snippets (public/js/snippets.js; D171, #313): a card's route, how its
// case is read (a CAP case by its zip span, a CourtListener record whole, nothing else),
// the case's texts, and the passage shown for a query's tokens.
import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeManifest } from '../public/js/manifest.js';
import { caseReader, caseTexts, findPassage, parseRoute } from '../public/js/snippets.js';
import { tokens } from '../src/vendor/stare-search-format2/tokenize.mjs';

test('a card\'s route is a reporter, volume, page and sequence', () => {
  assert.deepEqual(parseRoute('a2d/142/148-02'), { reporter: 'a2d', volume: '142', page: 148, seq: 2 });
  assert.deepEqual(parseRoute('us/384/436'), { reporter: 'us', volume: '384', page: 436, seq: null });
  assert.deepEqual(parseRoute('a3d/138-2/1012'), { reporter: 'a3d', volume: '138-2', page: 1012, seq: null });
  assert.deepEqual(parseRoute('cal-app-4th/15/supp.%201-01'), { reporter: 'cal-app-4th', volume: '15', page: 'supp. 1', seq: 1 });
  assert.equal(parseRoute(''), null);
  assert.equal(parseRoute('not a route'), null);
});

test('a case\'s texts are its opinions, then its head matter', () => {
  const c = { casebody: { head_matter: 'Head.', opinions: [{ text: 'One.' }, { text: ' ' }, { text: 'Two.' }] } };
  assert.deepEqual(caseTexts(c), ['One.', 'Two.', 'Head.']);
  assert.deepEqual(caseTexts({}), []);
});

test('the passage is the first with every token, marked as the tokenizer folds', () => {
  const text = 'The railroad was sued. Many years later, in a different matter, a guard pushed a passenger. '
    + 'Palsgraf v. Long Island Railroad Co. held the railroad owed no duty to her.';
  const p = findPassage([text], tokens('palsgraf railroad'));
  assert.equal(p.found, 2);
  assert.equal(p.of, 2);
  assert.match(p.text, /^… .*Palsgraf v\. Long Island Railroad/);
  assert.ok(p.text.length < 320);
});

test('without every token together, the passage with the most of them, else none', () => {
  const p = findPassage(['Only negligence is here.'], tokens('res ipsa loquitur negligence'));
  assert.equal(p.found, 1);
  assert.equal(p.text, 'Only negligence is here.');
  assert.equal(findPassage(['Nothing to see.'], tokens('chevron')), null);
  assert.equal(findPassage(['Anything.'], []), null);
});

test('a possessive and curly apostrophe fold as the tokenizer does', () => {
  const p = findPassage(['It was Miranda’s confession in Arizona.'], tokens('miranda arizona'));
  assert.equal(p.found, 2);
});

const H1 = '0f3a9c2e7b1d4a65';
const MANIFEST = normalizeManifest({
  format: 2, idx: 1, base: 'v/v2026.11.05.3/', reporters: { ri: ['69'], a3d: ['999'] }, aliases: { 'n-w': ['260'] },
});
const ENTRIES = {
  'ri/69/51': [{ page: '51', source: 'cap', ref: '0051-01', case_file: '0051-01', zip: { offset: 39997, length: 8435, method: 8 } }],
  'ri/69/52': [
    { page: '52', source: 'cap', ref: '0052-01', case_file: '0052-01', zip: { offset: 1, length: 2, method: 8 } },
    { page: '52', source: 'cap', ref: '0052-02', case_file: '0052-02', zip: { offset: 3, length: 4, method: 8 } },
  ],
  'ri/69/60': [{ page: '60', source: 'cap', ref: '0060-01', case_file: '0060-01' }],
  'n-w/260/287': [{ page: '287', source: 'cap', ref: 'neb/128/0783-01', reporter: 'neb', folder: '128', case_file: '0783-01', via: 'cl:1', zip: { offset: 5, length: 6, method: 8 } }],
  'a3d/999/7': [{ page: '7', source: 'cl', ref: `9/${H1}`, cluster_id: 9, hash: H1 }],
};

function readerDeps(log) {
  return {
    manifest: MANIFEST,
    idxEntries: async (r, v, p) => { log.push(`idx ${r}/${v}`); return ENTRIES[`${r}/${v}/${p}`] || []; },
    readSpan: async (url, span, o) => { log.push(`span ${url} ${span.offset}:${span.length} ${o.key}`); return { text: '{"name":"x"}' }; },
    readRecord: async (e) => { log.push(`record ${e.cluster_id}`); return { name: 'cl' }; },
  };
}

test('a CAP card is read by its span, one Range request, the alias\'s into its own zip', async () => {
  const log = [];
  const read = await caseReader('ri/69/51', readerDeps(log));
  assert.deepEqual(await read(), { name: 'x' });
  assert.deepEqual(log, ['idx ri/69', 'span https://data.stare.pub/cap/ri/69.zip 39997:8435 v/v2026.11.05.3/span/ri/69.zip@39997:8435:8']);
  const log2 = [];
  await (await caseReader('ri/69/52-02', readerDeps(log2)))();
  assert.match(log2[1], / 3:4 /);
  const log3 = [];
  await (await caseReader('n-w/260/287', readerDeps(log3)))();
  assert.match(log3[1], /cap\/neb\/128\.zip 5:6/);
});

test('a CourtListener card fetches its record; a line with no span, or a volume not held, nothing', async () => {
  const log = [];
  assert.deepEqual(await (await caseReader('a3d/999/7', readerDeps(log)))(), { name: 'cl' });
  assert.deepEqual(log, ['idx a3d/999', 'record 9']);
  assert.equal(await caseReader('ri/69/60', readerDeps([])), null);
  const none = [];
  assert.equal(await caseReader('ny/1/4', readerDeps(none)), null);
  assert.deepEqual(none, []);
  assert.equal(await caseReader('ri/69/61', readerDeps([])), null);
});

test('a server that sends the whole zip gives no snippet, not a zip to read', async () => {
  const deps = { ...readerDeps([]), readSpan: async () => ({ whole: new Uint8Array(10) }) };
  assert.equal(await (await caseReader('ri/69/51', deps))(), null);
});
