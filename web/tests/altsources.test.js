import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALT_FAILED, ALT_NONE, ALT_PARTIAL, buildRows, classifyEntries, estimateRows, findAltSources,
  ledgerSources, pageAliases, rowHtml, shownOf,
} from '../public/js/altsources.js';

// Wynnewood Development, Inc. v. Bank & Trust Co., printed at 551 Pa. 552 and 711 A.2d 1003:
// the index lines (build v2026.11.05.3), the case JSONs' citations, and its row in ledger
// v2026.11.08 (key us/pa/0007e.d.appealdocket1997/1998-05-19, id 04ypkyx).
const PA = { reporter: 'pa', volume: '551', page: 552, caseFile: '0552-01' };
const A2D = { reporter: 'a2d', volume: '711', page: 1003, caseFile: '1003-01' };
const PA_CITES = [{ type: 'official', cite: '551 Pa. 552' }, { type: 'parallel', cite: '711 A.2d 1003' }];
const A2D_CITES = [{ type: 'official', cite: '711 A.2d 1003' }];
const PA_552 = [
  { page: '552', source: 'cap', ref: '0552-01', case_file: '0552-01' },
  { page: '552', source: 'cap', ref: 'a2d/711/1003-01', reporter: 'a2d', folder: '711', case_file: '1003-01', via: 'cl:2162554' },
];
const A2D_1003 = [{ page: '1003', source: 'cap', ref: '1003-01', case_file: '1003-01' }];
const ROW = {
  id: '04ypkyx',
  key: 'us/pa/0007e.d.appealdocket1997/1998-05-19',
  sources: ['cap:a2d/711/1003-01', 'cap:pa/551/0552-01', 'cl-cluster:2162554'],
};

const capCase = (r, cites, extra = {}) => ({ ...r, caseData: { name_abbreviation: 'Wynnewood', citations: cites }, ...extra });
const clRecord = (cluster, cites, extra = {}) => ({
  reporter: 'a3d', volume: '250', page: 100, caseFile: `cl/${cluster}`, source: 'courtlistener',
  caseData: { citations: cites, source: { name: 'courtlistener', ids: { cluster } } }, ...extra,
});

// A parser and an index for findAltSources: citations by text, entries by `slug/vol/page`.
const PARSED = {
  '551 Pa. 552': { reporter: 'pa', volume: '551', page: 552 },
  '711 A.2d 1003': { reporter: 'a2d', volume: '711', page: 1003 },
  '20 Pa. D. & C. 4th 1': { reporter: 'pa-d-c-4th', volume: '20', page: 1 },
};
const INDEX = { 'pa/551/552': PA_552, 'a2d/711/1003': A2D_1003 };
const deps = (extra = {}) => ({
  parse: async (text) => PARSED[text] || null,
  entriesAt: async (reporter, volume, page) => {
    const entries = INDEX[`${reporter}/${volume}/${page}`];
    return entries ? { held: true, entries } : { held: false, entries: [] };
  },
  ...extra,
});

describe('shownOf', () => {
  test('a CAP case is its case file; a CourtListener record its cluster', () => {
    assert.deepEqual(shownOf(capCase(PA, PA_CITES)), { reporter: 'pa', folder: '551', file: '0552-01', page: 552, cluster: null });
    assert.equal(shownOf(clRecord(9876543, [])).cluster, 9876543);
    assert.equal(shownOf(clRecord(9876543, [])).file, null);
  });
});

describe('ledgerSources', () => {
  test("a decision row's printings and clusters, a merged row's after", () => {
    assert.deepEqual(ledgerSources(ROW), {
      printings: [{ reporter: 'a2d', folder: '711', file: '1003-01' }, { reporter: 'pa', folder: '551', file: '0552-01' }],
      clusters: [2162554],
    });
    const merged = ledgerSources({ sources: ['cap:pa/551/0552-01'], merged: [{ id: 'x', merged_into: 'y', sources: ['cl-cluster:7'] }] });
    assert.deepEqual(merged.clusters, [7]);
    assert.equal(ledgerSources(null), null);
  });
});

describe('classifyEntries', () => {
  const shown = shownOf(capCase(PA, PA_CITES));
  test("the shown printing's own citation, or one that opens it, is itself", () => {
    assert.deepEqual(classifyEntries(PA_552, PARSED['551 Pa. 552'], shown), { kind: 'self' });
    const alias = [{ page: '287', source: 'cap', reporter: 'pa', folder: '551', case_file: '0552-01', via: 'cl:1' }];
    assert.deepEqual(classifyEntries(alias, { reporter: 'a2d', volume: '1', page: 287 }, shown), { kind: 'self' });
  });
  test('another volume\'s case is a CAP printing; several cases on its page are all named', () => {
    assert.deepEqual(classifyEntries(A2D_1003, PARSED['711 A.2d 1003'], shown), {
      kind: 'cap', targets: [{ reporter: 'a2d', folder: '711', file: '1003-01' }], via: null,
    });
    const two = [
      { page: '1003', source: 'cap', case_file: '1003-01' },
      { page: '1003', source: 'cap', case_file: '1003-02' },
    ];
    assert.equal(classifyEntries(two, PARSED['711 A.2d 1003'], shown).targets.length, 2);
  });
  test("CourtListener's records, a miss, and a volume the index doesn't hold", () => {
    const cl = [{ page: '100', source: 'cl', cluster_id: 5, hash: '0123456789abcdef' }];
    assert.equal(classifyEntries(cl, { reporter: 'a3d', volume: '250', page: 100 }, shown).kind, 'cl');
    assert.deepEqual(classifyEntries(cl, { reporter: 'a3d', volume: '250', page: 100 }, { ...shown, cluster: 5 }), { kind: 'self' });
    assert.deepEqual(classifyEntries([], PARSED['711 A.2d 1003'], shown), { kind: 'missing', reason: 'page' });
    assert.deepEqual(classifyEntries([], PARSED['711 A.2d 1003'], shown, false), { kind: 'missing', reason: 'volume' });
  });
});

describe('pageAliases', () => {
  const shown = shownOf(capCase(PA, PA_CITES));
  test("an alias at the case's page to another volume's case, with its cluster", () => {
    assert.deepEqual(pageAliases(PA_552, shown), [{ target: { reporter: 'a2d', folder: '711', file: '1003-01' }, cluster: 2162554 }]);
  });
  test('none on a page several cases start on, or for an alias not from CourtListener', () => {
    const shared = [PA_552[0], { ...PA_552[0], case_file: '0552-02' }, PA_552[1]];
    assert.deepEqual(pageAliases(shared, shown), []);
    assert.deepEqual(pageAliases([PA_552[0], { ...PA_552[1], via: 'official:pa' }], shown), []);
    // An alias into the case's own volume is the same printing at another page.
    assert.deepEqual(pageAliases([PA_552[0], { ...PA_552[1], reporter: 'pa', folder: '551' }], shown), []);
    assert.deepEqual(pageAliases(null, shown), []);
  });
});

describe('buildRows', () => {
  const shown = shownOf(capCase(PA, PA_CITES));
  const a2dCite = { text: '711 A.2d 1003', cited: PARSED['711 A.2d 1003'], outcome: classifyEntries(A2D_1003, PARSED['711 A.2d 1003'], shown) };
  const selfCite = { text: '551 Pa. 552', cited: PARSED['551 Pa. 552'], outcome: { kind: 'self' } };

  test('a printing named by a citation, an alias and the ledger is one row; the record another', () => {
    const rows = buildRows({ cites: [selfCite, a2dCite], aliases: pageAliases(PA_552, shown), ledger: ledgerSources(ROW), shown });
    assert.deepEqual(rows, [
      { label: '711 A.2d 1003', source: 'cap', href: '#a2d/711/1003-01', external: false, note: null },
      {
        label: 'Opinion cluster 2162554', source: 'cl', href: 'https://www.courtlistener.com/opinion/2162554/',
        external: true, note: "CourtListener's page; stare.pub has no address that opens this record",
      },
    ]);
  });

  test("named only by CourtListener's metadata, a printing says so", () => {
    const rows = buildRows({ aliases: pageAliases(PA_552, shown), shown });
    assert.equal(rows[0].label, 'a2d 711 1003');
    assert.equal(rows[0].note, "Listed through CourtListener's citation metadata");
  });

  test('from the A.2d printing, the ledger gives the Pa. printing and the record', () => {
    const a2d = shownOf(capCase(A2D, A2D_CITES));
    const rows = buildRows({ cites: [{ text: '711 A.2d 1003', cited: PARSED['711 A.2d 1003'], outcome: { kind: 'self' } }], ledger: ledgerSources(ROW), shown: a2d });
    assert.deepEqual(rows.map((r) => [r.label, r.source, r.href]), [
      ['pa 551 552', 'cap', '#pa/551/552-01'],
      ['Opinion cluster 2162554', 'cl', 'https://www.courtlistener.com/opinion/2162554/'],
    ]);
    assert.match(rows[1].note, /no address that opens this record/);
  });

  test('a page several cases start on opens the one the ledger names, else the page', () => {
    const cited = PARSED['711 A.2d 1003'];
    const outcome = { kind: 'cap', targets: [{ reporter: 'a2d', folder: '711', file: '1003-01' }, { reporter: 'a2d', folder: '711', file: '1003-02' }], via: null };
    const ledger = { printings: [{ reporter: 'a2d', folder: '711', file: '1003-02' }], clusters: [] };
    assert.equal(buildRows({ cites: [{ text: '711 A.2d 1003', cited, outcome }], ledger, shown })[0].href, '#a2d/711/1003-02');
    const page = buildRows({ cites: [{ text: '711 A.2d 1003', cited, outcome }], shown });
    assert.equal(page[0].href, '#a2d/711/1003');
    assert.equal(page[0].note, 'One of the 2 cases that start on that page');
  });

  test("a citation stare.pub doesn't hold, can't read, or couldn't check", () => {
    const rows = buildRows({
      cites: [
        { text: '20 Pa. D. & C. 4th 1', cited: PARSED['20 Pa. D. & C. 4th 1'], outcome: { kind: 'missing', reason: 'volume' } },
        { text: '1998 Pa. LEXIS 1', cited: null, outcome: { kind: 'unparsed' } },
        { text: '711 A.2d 1003', cited: PARSED['711 A.2d 1003'], outcome: { kind: 'error' } },
      ],
      shown,
    });
    assert.deepEqual(rows.map((r) => [r.source, r.href, r.note]), [
      ['none', null, "stare.pub doesn't hold this volume"],
      ['none', null, "stare.pub couldn't read this citation"],
      ['unknown', null, "Couldn't check the index for this citation"],
    ]);
  });

  test("a citation that opens CourtListener's record links there, and its cluster isn't listed again", () => {
    const cited = { reporter: 'a3d', volume: '250', page: 100 };
    const outcome = { kind: 'cl', records: [{ cluster_id: 9876543, hash: '0123456789abcdef' }] };
    const rows = buildRows({ cites: [{ text: '250 A.3d 100', cited, outcome }], ledger: { printings: [], clusters: [9876543] }, shown });
    assert.deepEqual(rows, [{ label: '250 A.3d 100', source: 'cl', href: '#a3d/250/100', external: false, note: null }]);
  });

  test("the shown record's own cluster is left out", () => {
    const record = shownOf(clRecord(2162554, []));
    assert.deepEqual(buildRows({ ledger: { printings: [], clusters: [2162554] }, shown: record }), []);
  });
});

describe('estimateRows', () => {
  test('room for the rows a lookup can add, counting a printing a citation and the ledger share once', () => {
    const pa = shownOf(capCase(PA, PA_CITES));
    assert.equal(estimateRows({ citations: PA_CITES }, pa, { aliases: pageAliases(PA_552, pa), ledger: ledgerSources(ROW) }), 2);
    // Opened by its hash: one citation besides its own, and the alias with its cluster.
    assert.equal(estimateRows({ citations: PA_CITES }, pa, { aliases: pageAliases(PA_552, pa) }), 2);
    // A case with only its own citation, its page's entries known: nothing to look up.
    assert.equal(estimateRows({ citations: A2D_CITES }, shownOf(capCase(A2D, A2D_CITES)), { aliases: [] }), 0);
    // Its page's entries not known (opened through an alias): one line for the lookup.
    assert.equal(estimateRows({ citations: A2D_CITES }, shownOf(capCase(A2D, A2D_CITES))), 1);
    // A record with one citation, its own.
    assert.equal(estimateRows({ citations: [{ cite: '250 A.3d 100' }] }, shownOf(clRecord(1, []))), 0);
  });
});

describe('findAltSources', () => {
  test("the Pa. printing opened by its hash: the A.2d printing and CourtListener's record", async () => {
    const found = await findAltSources(capCase(PA, PA_CITES, { pageEntries: PA_552 }), null, deps());
    assert.equal(found.incomplete, false);
    assert.deepEqual(found.rows.map((r) => [r.label, r.source, r.href]), [
      ['711 A.2d 1003', 'cap', '#a2d/711/1003-01'],
      ['Opinion cluster 2162554', 'cl', 'https://www.courtlistener.com/opinion/2162554/'],
    ]);
  });

  test('the A.2d printing opened by its hash finds nothing; from its key, the ledger row', async () => {
    const byHash = await findAltSources(capCase(A2D, A2D_CITES, { pageEntries: A2D_1003 }), null, deps());
    assert.deepEqual(byHash.rows, []);
    const byKey = await findAltSources(capCase(A2D, A2D_CITES), ROW, deps());
    assert.deepEqual(byKey.rows.map((r) => r.label), ['pa 551 552', 'Opinion cluster 2162554']);
  });

  test("a citation in a volume stare.pub doesn't hold, and one the parser can't read", async () => {
    const cites = [...PA_CITES, { cite: '20 Pa. D. & C. 4th 1' }, { cite: 'not a citation' }];
    const found = await findAltSources(capCase(PA, cites, { pageEntries: PA_552 }), null, deps());
    assert.deepEqual(found.rows.map((r) => [r.label, r.source]), [
      ['711 A.2d 1003', 'cap'],
      ['20 Pa. D. & C. 4th 1', 'none'],
      ['not a citation', 'none'],
      ['Opinion cluster 2162554', 'cl'],
    ]);
  });

  test("a lookup that fails says so on its row; the page's own, in the result", async () => {
    const failing = deps({ entriesAt: async () => { throw new Error('offline'); } });
    const found = await findAltSources(capCase(PA, PA_CITES), null, failing);
    assert.equal(found.incomplete, true);
    assert.equal(found.aliasesFailed, true);
    assert.deepEqual(found.rows.map((r) => [r.label, r.source]), [['711 A.2d 1003', 'unknown']]);
    const unreadable = deps({ entriesAt: async () => null });
    assert.equal((await findAltSources(capCase(PA, PA_CITES), null, unreadable)).aliasesFailed, true);
  });
});

describe("a CAP case's official citation", () => {
  // Greenfield v. BFP Investments Ltd., at br/358/0846-01 and f-appx/206/0846-01 and joined to
  // cluster 45361 (decision-route table v2026.11.05.3, id 00bkp96). CAP gives the B.R.
  // printing the citation "358 F. App'x 846", which opens Romano-Dimas v. Holder.
  const BR = { reporter: 'br', volume: '358', page: 846, caseFile: '0846-01' };
  const CITES = [{ type: 'official', cite: "358 F. App'x 846" }];
  const GREENFIELD = { sources: ['cap:br/358/0846-01', 'cap:f-appx/206/0846-01', 'cl-cluster:45361'] };
  const lookups = [];
  const greenfieldDeps = {
    parse: async () => ({ reporter: 'f-appx', volume: '358', page: 846 }),
    entriesAt: async (...at) => {
      lookups.push(at.join('/'));
      return { held: true, entries: [{ page: '846', source: 'cap', case_file: '0846-01' }] };
    },
  };

  test("is the printing's own, so it's neither looked up nor listed", async () => {
    const found = await findAltSources(capCase(BR, CITES), GREENFIELD, greenfieldDeps);
    assert.deepEqual(found.rows.map((r) => [r.label, r.href]), [
      ['f-appx 206 846', '#f-appx/206/846-01'],
      ['Opinion cluster 45361', 'https://www.courtlistener.com/opinion/45361/'],
    ]);
    assert.deepEqual(lookups, ['br/358/846']);
    assert.equal(estimateRows({ citations: CITES }, shownOf(capCase(BR, CITES)), { aliases: [], ledger: ledgerSources(GREENFIELD) }), 2);
  });

  test("a parallel citation the ledger doesn't list says so", () => {
    const shown = shownOf(capCase(BR, CITES));
    const cited = { reporter: 'f-appx', volume: '358', page: 846 };
    const outcome = { kind: 'cap', targets: [{ reporter: 'f-appx', folder: '358', file: '0846-01' }], via: null };
    const rows = buildRows({ cites: [{ text: "358 F. App'x 846", cited, outcome }], ledger: ledgerSources(GREENFIELD), shown });
    assert.equal(rows[0].note, "The key ledger doesn't list this case as a printing of the decision");
  });
});

describe('rowHtml', () => {
  test('escapes the label and opens CourtListener in a new tab', () => {
    const html = rowHtml({ label: '<b>1 A. 1</b>', source: 'cl', href: 'https://www.courtlistener.com/opinion/1/', external: true, note: 'a "note"' });
    assert.match(html, /&lt;b&gt;1 A\. 1&lt;\/b&gt;/);
    assert.match(html, /target="_blank" rel="noopener"/);
    assert.match(html, /title="a &quot;note&quot;"/);
    assert.match(html, /<span class="alt-source" title="CourtListener">CourtListener<\/span>/);
    assert.match(rowHtml({ label: '1 X 1', source: 'none', href: null }), /<span class="alt-text">1 X 1<\/span>/);
  });

  test('the fallback lines read plainly', () => {
    assert.equal(ALT_NONE, 'None found in the index.');
    assert.match(ALT_FAILED, /^Couldn't check the index/);
    assert.match(ALT_PARTIAL, /^Couldn't check the index/);
  });
});
