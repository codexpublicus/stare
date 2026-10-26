// The search boxes' typeahead (#248): reading what has been typed, ranking reporters,
// what the volume and page stages suggest, and the citation-as-written pre-fill.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReporterIndex, casesAt, citeFromQuery, citeText, compact, exactReporter, keptTarget,
  pageSuggestions, parseQuery, prefill, rankReporters, stageOf, volumeStatus, words,
} from '../public/js/suggest.js';
import { volumeCaseNames } from '../public/js/casenames.js';
import { normalizeManifest } from '../public/js/manifest.js';

// A few of reporters.json's entries, as `stare-site export-reporters` writes them.
const edition = (name, reporter, start, end) => ({ name, reporter, start_year: start, end_year: end });
const REPORTERS = {
  reporters: {
    misc: {
      names: ['Misc.'], variations: ['Misc', 'Misc Rep', 'Misc Rep.', 'Misc. Rep', 'Misc. Rep.'],
      editions: [edition('Misc.', 'New York Miscellaneous Reports', 1892, 1955)], cap: true,
      volumes: { count: 208, first: '1', last: '208' },
    },
    misc2d: {
      names: ['Misc. 2d'], variations: ['Misc 2d', 'Misc.2d'],
      editions: [edition('Misc. 2d', 'New York Miscellaneous Reports', 1955, 2004)], cap: true,
      volumes: { count: 196, first: '1', last: '196' },
    },
    'ohio-misc': {
      names: ['Ohio Misc.'], variations: ['O.Misc.'],
      editions: [edition('Ohio Misc.', 'Ohio Miscellaneous', 1962, 1982)], cap: true,
      volumes: { count: 70, first: '1', last: '70' },
    },
    'nj-misc': {
      names: ['N.J. Misc.'], variations: [],
      editions: [edition('N.J. Misc.', 'New Jersey Miscellaneous Reports', 1923, 1949)], cap: true,
      volumes: { count: 26, first: '1', last: '26' },
    },
    a2d: {
      names: ['A.2d'], variations: ['A. 2d', 'A2d'],
      editions: [edition('A.2d', 'Atlantic Reporter', 1938, 2010)], cap: true,
      volumes: { count: 975, first: '1', last: '999' },
    },
    a3d: {
      names: ['A.3d'], variations: ['A. 3d'],
      editions: [edition('A.3d', 'Atlantic Reporter', 2010, null)], cap: true,
      volumes: { count: 300, first: '1', last: '300' },
    },
    // A name the index holds no volumes of, which starts with what "N.Y. Misc." is.
    'ny-misc-lexis': {
      names: ['N.Y. Misc. LEXIS'], variations: [],
      editions: [edition('N.Y. Misc. LEXIS', 'Lexis Nexis Citation', null, null)], cap: false, volumes: null,
    },
    // A slug citare stopped assigning: listed, with no names.
    'p-r-r': { names: [], variations: [], editions: [], cap: false, volumes: { count: 83 } },
  },
};

const INDEX = buildReporterIndex(REPORTERS);

const MANIFEST = normalizeManifest({
  format: 2,
  idx: 1,
  reporters: {
    misc: ['1', '2', '30', '32', '33', '40', '208'],
    a3d: ['137', '138', '138-2', '139', '200'],
  },
  parts: { a3d: { 138: [{ volume: '138', first_page: 1, last_page: 1011 }, { volume: '138-2', first_page: 1012, last_page: 1300 }] } },
  aliases: { misc: ['50'] },
});

const slugs = (hits) => hits.map((r) => r.slug);

describe('reading what was typed', () => {
  test('the citation as written, volume first', () => {
    assert.deepEqual(parseQuery('32 Misc. 426'),
      { order: 'cite', volume: '32', reporter: 'Misc.', page: '426', spaceAfter: false });
    assert.deepEqual(parseQuery('31 A.2d 647, 650'),
      { order: 'cite', volume: '31', reporter: 'A.2d', page: '647', spaceAfter: false });
    assert.deepEqual(parseQuery('32 Misc. '),
      { order: 'cite', volume: '32', reporter: 'Misc.', page: null, spaceAfter: true });
  });

  test('reporter first, as the slug form and by abbreviation', () => {
    assert.deepEqual(parseQuery('misc 32 426-02'),
      { order: 'reporter', volume: '32', reporter: 'misc', page: '426-02', spaceAfter: false });
    assert.deepEqual(parseQuery('N.Y. Misc. 32'),
      { order: 'reporter', volume: '32', reporter: 'N.Y. Misc.', page: null, spaceAfter: false });
    assert.deepEqual(parseQuery('misc/32/426'),
      { order: 'reporter', volume: '32', reporter: 'misc', page: '426', spaceAfter: false });
    assert.equal(parseQuery('a3d 138-2 1012').volume, '138-2');
  });

  test('which suggestions each point of the typing wants', () => {
    assert.equal(stageOf(parseQuery('')), 'none');
    assert.equal(stageOf(parseQuery('32')), 'none');
    assert.equal(stageOf(parseQuery('misc')), 'reporter');
    assert.equal(stageOf(parseQuery('misc ')), 'reporter');
    assert.equal(stageOf(parseQuery('32 Mis')), 'reporter');
    assert.equal(stageOf(parseQuery('32 Misc.')), 'reporter');
    assert.equal(stageOf(parseQuery('32 Misc. ')), 'volume');
    assert.equal(stageOf(parseQuery('misc 32')), 'volume');
    assert.equal(stageOf(parseQuery('misc 32 4')), 'page');
    assert.equal(stageOf(parseQuery('32 Misc. 4')), 'page');
  });

  test('names compare by their letters and digits, and by their words', () => {
    assert.equal(compact('N.Y. Misc.'), 'nymisc');
    assert.equal(compact('A. 2d'), 'a2d');
    assert.deepEqual(words('New York Miscellaneous Reports'), ['new', 'york', 'miscellaneous', 'reports']);
    assert.deepEqual(words('N.Y. Misc.'), ['n', 'y', 'misc']);
  });
});

describe('ranking reporters', () => {
  test('a reporter with no names is never suggested', () => {
    assert.ok(!INDEX.some((r) => r.slug === 'p-r-r'));
  });

  test('"misc", "Misc" and "Misc." find Misc. first, with its full name and years', () => {
    for (const q of ['misc', 'Misc', 'Misc.', 'MISC']) {
      const [top] = rankReporters(INDEX, q);
      assert.equal(top.slug, 'misc', q);
      assert.equal(top.abbr, 'Misc.');
      assert.equal(top.fullName, 'New York Miscellaneous Reports');
      assert.equal(top.start, 1892);
      assert.equal(top.end, 1955);
    }
  });

  test('"N.Y. Misc." finds it by its full name\'s words, before a name it starts that the index holds nothing of', () => {
    assert.deepEqual(slugs(rankReporters(INDEX, 'N.Y. Misc.')), ['misc', 'misc2d', 'ny-misc-lexis']);
  });

  test('names a query only starts come after an exact one, more volumes first', () => {
    assert.deepEqual(slugs(rankReporters(INDEX, 'misc')), ['misc', 'misc2d', 'ohio-misc', 'nj-misc', 'ny-misc-lexis']);
    // Neither is exact: the one the index holds more volumes of leads.
    assert.deepEqual(slugs(rankReporters(INDEX, 'a')).slice(0, 2), ['a2d', 'a3d']);
    // The live manifest's counts outrank reporters.json's snapshot.
    const count = (slug) => ({ a3d: 2000 })[slug] ?? null;
    assert.deepEqual(slugs(rankReporters(INDEX, 'a', count)).slice(0, 2), ['a3d', 'a2d']);
  });

  test('a variation finds its reporter, and the slug does too', () => {
    assert.equal(rankReporters(INDEX, 'O.Misc.')[0].slug, 'ohio-misc');
    assert.equal(rankReporters(INDEX, 'nj-misc')[0].slug, 'nj-misc');
    assert.equal(exactReporter(INDEX, 'a 2d').slug, 'a2d');
    assert.equal(exactReporter(INDEX, 'Atl'), null);
  });

  test('an end year still to come is left open, and the limit holds', () => {
    assert.equal(rankReporters(INDEX, 'A.3d')[0].end, null);
    assert.equal(rankReporters(INDEX, 'a', null, 1).length, 1);
    assert.deepEqual(rankReporters(INDEX, '...'), []);
  });
});

describe('volumes', () => {
  test('a volume the index holds says so, with its scans', () => {
    assert.deepEqual(volumeStatus(MANIFEST, 'misc', '32'), { held: true, aliasOnly: false, scans: true, nearest: [] });
    // A volume CAP split is held by its number; a3d 200 has no page scans.
    assert.equal(volumeStatus(MANIFEST, 'a3d', '138').held, true);
    assert.equal(volumeStatus(MANIFEST, 'a3d', '200').scans, false);
  });

  test('a volume of parallel citations only is told apart', () => {
    assert.deepEqual(volumeStatus(MANIFEST, 'misc', '50'), { held: false, aliasOnly: true, scans: true, nearest: [] });
  });

  test('a volume it doesn\'t hold gets the nearest it does, marking those without scans', () => {
    assert.deepEqual(volumeStatus(MANIFEST, 'misc', '31').nearest.map((n) => n.volume), ['30', '32', '33', '40']);
    const near = volumeStatus(MANIFEST, 'a3d', '199').nearest;
    assert.deepEqual(near.map((n) => n.volume), ['137', '138', '139', '200']);
    assert.deepEqual(near.map((n) => n.scans), [true, true, true, false]);
    assert.deepEqual(volumeStatus(MANIFEST, 'nope', '1').nearest, []);
  });
});

describe('pages', () => {
  const cap = (page, file, more = {}) => ({ page, source: 'cap', ref: file, case_file: file, folder: null, ...more });
  const ENTRIES = [
    cap(1, '0001-01'),
    cap(4, '0004-01'),
    cap(42, '0042-01'),
    cap(426, '0426-01'),
    cap(426, '0426-02'),
    { page: 430, source: 'cap', ref: 'ad/5/0010-01', reporter: 'ad', folder: '5', case_file: '0010-01', via: 'cl:1' },
    { page: 460, source: 'cl', ref: '1/abcdefabcdefabcd', cluster_id: 1, hash: 'abcdefabcdefabcd' },
    cap(4260, '4260-01'),
    cap('xxix', 'xxix-01'),
  ];

  test('the pages starting with the digits typed, in order, each with its cases', () => {
    const got = pageSuggestions(ENTRIES, '4');
    assert.deepEqual(got.map((p) => p.page), [4, 42, 426, 430, 460, 4260]);
    assert.deepEqual(got.find((p) => p.page === 426).cases.map((c) => c.seq), [1, 2]);
    assert.deepEqual(pageSuggestions(ENTRIES, '426').map((p) => p.page), [426, 4260]);
    assert.deepEqual(pageSuggestions(ENTRIES, '426-02').map((p) => p.page), [426, 4260]);
  });

  test('a page no case starts on gets the cases either side (a pin cite)', () => {
    assert.deepEqual(pageSuggestions(ENTRIES, '427').map((p) => p.page), [426, 430]);
  });

  test('at most `limit` cases', () => {
    const got = pageSuggestions(ENTRIES, '4', 3);
    assert.equal(got.flatMap((p) => p.cases).length, 3);
  });

  test('a page\'s cases are the resolver\'s: CAP\'s own, else the alias, else CourtListener\'s', () => {
    assert.deepEqual(casesAt([cap(426, '0426-01'), cap(426, '0426-02')]).map((c) => [c.kind, c.seq, c.caseFile]),
      [['cap', 1, '0426-01'], ['cap', 2, '0426-02']]);
    assert.deepEqual(casesAt(ENTRIES.filter((e) => e.page === 430)), [{ kind: 'alias', reporter: 'ad', folder: '5', seq: null }]);
    assert.deepEqual(casesAt(ENTRIES.filter((e) => e.page === 460)), [{ kind: 'cl', seq: 1 }]);
    // A split volume's other folder.
    assert.equal(casesAt([cap(1012, '1012-01', { folder: '138-2' })])[0].folder, '138-2');
  });
});

describe('submitting', () => {
  test('a reporter typed first by its abbreviation names a case', () => {
    assert.deepEqual(citeFromQuery(INDEX, 'Misc. 32 426'), { reporter: 'misc', volume: '32', page: 426, seq: null });
    assert.deepEqual(citeFromQuery(INDEX, '32 Misc 426-02'), { reporter: 'misc', volume: '32', page: 426, seq: 2 });
    assert.equal(citeFromQuery(INDEX, 'Misc. 32'), null);
    assert.equal(citeFromQuery(INDEX, 'Miscellany 32 426'), null);
  });

  test('a citation renders as written', () => {
    assert.equal(citeText('Misc.', '32', 426), '32 Misc. 426');
    assert.equal(citeText('Misc.', '32'), '32 Misc.');
  });
});

describe('the citation-as-written pre-fill', () => {
  const shown = { reporter: 'misc', volume: '32', page: 426, seq: 2, pin: null, cite: null };

  test('is the case\'s citation, remembering the case without putting its sequence in the text', () => {
    const filled = prefill('32 Misc. 426', shown);
    assert.equal(filled.text, '32 Misc. 426');
    assert.deepEqual(filled.target, { reporter: 'misc', volume: '32', page: 426, seq: 2 });
  });

  test('submitting it unchanged reopens the same case; any edit lets it go', () => {
    const filled = prefill('32 Misc. 426', shown);
    assert.deepEqual(keptTarget(filled, '32 Misc. 426'), filled.target);
    assert.deepEqual(keptTarget(filled, ' 32 Misc. 426 '), filled.target);
    assert.equal(keptTarget(filled, '32 Misc. 427'), null);
    assert.equal(keptTarget(null, '32 Misc. 426'), null);
  });

  test('a case with no citation falls back to the slug form', () => {
    assert.equal(prefill('', shown).text, 'misc 32 426-02');
    assert.equal(prefill(undefined, { ...shown, seq: null }).text, 'misc 32 426-01');
    assert.deepEqual(prefill('', null), { text: '', target: null });
  });
});

describe('a volume\'s case names', () => {
  test('come from the zip\'s CasesMetadata.json by range requests, then from the cache', async () => {
    const meta = [
      { file_name: '0426-01', name_abbreviation: 'People ex rel. Smith v. Jones' },
      { file_name: '0426-02', name_abbreviation: 'Matter of Brown' },
      { file_name: 'broken' },
    ];
    const ranges = [];
    const store = new Map();
    const deps = {
      fresh: true,
      fetchRange: async (url, range) => { ranges.push([url, range]); return { bytes: new Uint8Array(1), start: 0 }; },
      wasm: {
        zip_directory: () => JSON.stringify({ entries: [{ name: 'metadata/CasesMetadata.json', start: 100, end: 200 }] }),
        zip_entry: () => JSON.stringify(meta),
      },
      cacheGet: async (s, k) => store.get(`${s}:${k}`) || null,
      cacheSet: async (s, k, v) => { store.set(`${s}:${k}`, v); },
    };
    const names = await volumeCaseNames('misc', '32', deps);
    assert.deepEqual(names, { '0426-01': 'People ex rel. Smith v. Jones', '0426-02': 'Matter of Brown' });
    assert.deepEqual(ranges, [
      ['https://data.stare.pub/cap/misc/32.zip', 'bytes=-65536'],
      ['https://data.stare.pub/cap/misc/32.zip', 'bytes=100-199'],
    ]);
    assert.ok(store.has('multi:names/misc/32'));
    ranges.length = 0;
    assert.deepEqual(await volumeCaseNames('misc', '32', deps), names);
    assert.deepEqual(ranges, []);
  });
});
