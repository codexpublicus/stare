import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_MESSAGE, MANIFEST_URL, REPORTS_URL, coverage, emptyState, formatPercent,
  historyFromIndex, linePath, liveReportUrl, mountDataPage, reporterRows, scale, seriesFor,
} from '../public/js/datapage.js';

const totals = (over = {}) => ({
  reporters: 2, volumes: 3, split_volumes: 0, split_parts: 0, cases: 100, entries: 98,
  shortfall: 2, labeled: 1, long_names: 0, allowed: 1, failed: 2, ...over,
});

// reports/index.json as index-publish writes it, out of order to check the sort.
const INDEX = {
  format: 1,
  reports: [
    { version: 'v2026.10.05', generated_at: '2026-10-05T09:00:00Z', report: 'v/v2026.10.05/report.json', totals: totals({ volumes: 4, entries: 100, cases: 100, allowed: 0, failed: 0 }) },
    { version: 'v2026.10.04', generated_at: '2026-10-04T09:00:00Z', report: 'v/v2026.10.04/report.json', totals: totals() },
  ],
};

const REPORT = {
  format: 1,
  version: 'v2026.10.05',
  generated_at: '2026-10-05T09:00:00Z',
  totals: totals({ entries: 100, cases: 101 }),
  reporters: {
    us: { volumes: 2, cases: 60, entries: 59, shortfall: 1 },
    a2d: { volumes: 1, cases: 41, entries: 41, shortfall: 0 },
  },
};

describe('historyFromIndex', () => {
  test('sorts oldest first and derives coverage and exceptions', () => {
    const rows = historyFromIndex(INDEX);
    assert.deepEqual(rows.map((r) => r.version), ['v2026.10.04', 'v2026.10.05']);
    assert.equal(rows[0].coverage, 0.98);
    assert.equal(rows[0].exceptions, 3);
    assert.equal(rows[1].coverage, 1);
    assert.equal(rows[1].exceptions, 0);
    assert.equal(rows[1].volumes, 4);
    assert.equal(rows[1].report, 'v/v2026.10.05/report.json');
  });

  test('takes a bare array of entries', () => {
    const rows = historyFromIndex(INDEX.reports);
    assert.equal(rows.length, 2);
  });

  test('two builds the same day order by .N', () => {
    const same = '2026-10-04T09:00:00Z';
    const rows = historyFromIndex([
      { version: 'v2026.10.04.1', generated_at: same, totals: totals() },
      { version: 'v2026.10.04', generated_at: same, totals: totals() },
    ]);
    assert.deepEqual(rows.map((r) => r.version), ['v2026.10.04', 'v2026.10.04.1']);
    assert.equal(rows[1].report, 'v/v2026.10.04.1/report.json');
  });

  test('skips malformed entries and malformed indexes', () => {
    const rows = historyFromIndex({
      format: 1,
      reports: [
        null,
        { version: 'latest', totals: totals() },
        { version: 'v2026.10.04' },
        { version: 'v2026.10.04', totals: { cases: 'many', entries: 1, volumes: 1 } },
        { version: 'v2026.10.06', generated_at: 'not a date', totals: totals({ cases: 0, entries: 0 }) },
      ],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].generatedAt, null);
    assert.equal(rows[0].coverage, null);
    for (const bad of [null, undefined, 'x', 42, {}, { reports: 'no' }]) {
      assert.deepEqual(historyFromIndex(bad), []);
    }
  });
});

describe('chart shaping', () => {
  test('seriesFor leaves out rows without a value', () => {
    const rows = historyFromIndex([
      { version: 'v2026.10.04', generated_at: '2026-10-04T00:00:00Z', totals: totals({ cases: 0, entries: 0 }) },
      { version: 'v2026.10.05', generated_at: '2026-10-05T00:00:00Z', totals: totals() },
    ]);
    assert.deepEqual(seriesFor(rows, 'coverage').map((p) => p.version), ['v2026.10.05']);
    assert.deepEqual(seriesFor(rows, 'entries').map((p) => p.value), [0, 98]);
  });

  test('scale maps linearly and puts a flat domain in the middle', () => {
    assert.equal(scale([0, 10], [0, 100])(5), 50);
    assert.equal(scale([0, 10], [100, 0])(10), 0);
    assert.equal(scale([3, 3], [0, 100])(3), 50);
  });

  test('linePath for one point is a centered dot with no path', () => {
    const geo = linePath([{ version: 'v2026.10.04', value: 7 }], { width: 100, height: 50, pad: 10 });
    assert.equal(geo.d, '');
    assert.deepEqual(geo.points.map((p) => [p.x, p.y]), [[50, 25]]);
    assert.equal(geo.min, 7);
    assert.equal(geo.max, 7);
  });

  test('linePath for several points spans the box, highest value at the top', () => {
    const geo = linePath(
      [{ version: 'a', value: 10 }, { version: 'b', value: 30 }, { version: 'c', value: 20 }],
      { width: 100, height: 50, pad: 10 },
    );
    assert.equal(geo.d, 'M10,40 L50,10 L90,25');
    assert.equal(geo.min, 10);
    assert.equal(geo.max, 30);
    assert.deepEqual(linePath([]), { points: [], d: '', min: null, max: null });
  });

  test('coverage and percentages', () => {
    assert.equal(coverage(98, 100), 0.98);
    assert.equal(coverage(1, 0), null);
    assert.equal(formatPercent(0.98), '98.00%');
    assert.equal(formatPercent(0.99994), '99.994%');
    assert.equal(formatPercent(1), '100.00%');
    assert.equal(formatPercent(null), '–');
  });
});

describe('reporterRows', () => {
  test('sorts by slug and computes coverage', () => {
    const rows = reporterRows(REPORT);
    assert.deepEqual(rows.map((r) => r.reporter), ['a2d', 'us']);
    assert.deepEqual(rows[1], { reporter: 'us', volumes: 2, cases: 60, entries: 59, shortfall: 1, coverage: 59 / 60 });
  });

  test('is empty for anything that is not a report', () => {
    for (const bad of [null, {}, { reporters: 3 }, 'x']) assert.deepEqual(reporterRows(bad), []);
  });
});

describe('liveReportUrl', () => {
  const rows = historyFromIndex(INDEX);
  test("uses the root manifest's base", () => {
    assert.equal(liveReportUrl({ base: 'v/v2026.10.04/' }, rows), 'https://idx.stare.pub/v/v2026.10.04/report.json');
  });
  test('falls back to the newest report without a usable base', () => {
    for (const m of [null, {}, { base: '../evil/' }, { base: 'v/latest/' }]) {
      assert.equal(liveReportUrl(m, rows), 'https://idx.stare.pub/v/v2026.10.05/report.json');
    }
    assert.equal(liveReportUrl(null, []), null);
  });
});

// Just enough DOM for mountDataPage: elements with children, text, attributes and a
// class name, and a way to read all the text back.
function fakeDocument() {
  const doc = {
    createElement: (tag) => node(tag),
    createElementNS: (_ns, tag) => node(tag),
  };
  function node(tag) {
    const n = {
      tagName: tag, ownerDocument: doc, children: [], attributes: {}, className: '', _text: '',
      appendChild(c) { this.children.push(c); return c; },
      replaceChildren(...cs) { this.children = cs; this._text = ''; },
      setAttribute(k, v) { this.attributes[k] = v; },
      get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
      set textContent(v) { this._text = String(v); this.children = []; },
      findAll(pred, out = []) {
        if (pred(this)) out.push(this);
        for (const c of this.children) c.findAll(pred, out);
        return out;
      },
    };
    return n;
  }
  return { doc, root: node('div') };
}

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const body = routes[url];
    if (body instanceof Error) throw body;
    if (body === undefined) return { ok: false, status: 404, json: async () => { throw new Error('not json'); } };
    return { ok: true, status: 200, json: async () => (typeof body === 'string' ? JSON.parse(body) : body) };
  };
  fn.calls = calls;
  return fn;
}

describe('mountDataPage', () => {
  test('emptyState', () => {
    assert.equal(emptyState([]), EMPTY_MESSAGE);
    assert.equal(emptyState(null), EMPTY_MESSAGE);
    assert.equal(emptyState([{}]), null);
  });

  test('a missing reports/index.json shows the empty state', async () => {
    const { root } = fakeDocument();
    const fetch = fakeFetch({});
    assert.equal(await mountDataPage(root, fetch), 'empty');
    assert.equal(root.textContent, 'Index reports start with the next rebuild.');
    assert.deepEqual(fetch.calls.map((c) => c.url), [REPORTS_URL]);
    assert.equal(fetch.calls[0].init.cache, 'no-cache');
  });

  test('an index with no reports, malformed JSON or a network error shows the empty state', async () => {
    for (const body of [{ format: 1, reports: [] }, '{"format": 1, "rep', new TypeError('Failed to fetch')]) {
      const { root } = fakeDocument();
      assert.equal(await mountDataPage(root, fakeFetch({ [REPORTS_URL]: body })), 'empty');
      assert.equal(root.textContent, EMPTY_MESSAGE);
    }
  });

  test('reports draw four charts and the live reporter table', async () => {
    const { root } = fakeDocument();
    const fetch = fakeFetch({
      [REPORTS_URL]: INDEX,
      [MANIFEST_URL]: { format: 2, version: 'v2026.10.05', base: 'v/v2026.10.05/' },
      'https://idx.stare.pub/v/v2026.10.05/report.json': REPORT,
    });
    assert.equal(await mountDataPage(root, fetch), 'full');
    const figures = root.findAll((n) => n.tagName === 'figure');
    assert.equal(figures.length, 4);
    // Two builds: each chart has a path and two dots, each with a hover title.
    for (const fig of figures) {
      assert.equal(fig.findAll((n) => n.tagName === 'path').length, 1);
      assert.equal(fig.findAll((n) => n.tagName === 'circle').length, 2);
    }
    assert.match(root.textContent, /v2026\.10\.04: 98\b/);
    const cells = root.findAll((n) => n.tagName === 'td').map((n) => n.textContent);
    assert.deepEqual(cells.slice(0, 6), ['a2d', '1', '41', '41', '0', '100.00%']);
    assert.match(root.textContent, /v2026\.10\.05, built 2026-10-05: 100 entries for 101 cases in 3 volumes \(99\.01%\)/);
    assert.ok(!root.textContent.includes(EMPTY_MESSAGE));
  });

  test("keeps the charts when the live report can't be loaded", async () => {
    const { root } = fakeDocument();
    const fetch = fakeFetch({ [REPORTS_URL]: INDEX });
    assert.equal(await mountDataPage(root, fetch), 'charts');
    assert.equal(root.findAll((n) => n.tagName === 'figure').length, 4);
    assert.match(root.textContent, /couldn’t be loaded/);
    // Without a manifest it asked for the newest report in the history.
    assert.ok(fetch.calls.some((c) => c.url === 'https://idx.stare.pub/v/v2026.10.05/report.json'));
  });
});
