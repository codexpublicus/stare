// The search page (search.astro, public/js/searchpage.js) on the fixture search tree
// (web/tests/fixtures/README.md), served through routes in place of idx.stare.pub's, so
// nothing here needs a tree on R2. The root index manifest is answered too, naming the
// fixture's version, so the page finds the tree the way it finds the live one.
import { readFileSync } from 'node:fs';

import { test as base, expect } from '@playwright/test';

import { SEARCH_CLIENT_URL } from '../public/js/searchclient-path.js';
import { EXPECTED, TREE_PATH, TREE_ROOT, TREE_VERSION, treeResponse } from '../tests/fixtures/searchtree.js';

const IDX = 'https://idx.stare.pub';
const TREE = `${IDX}/${TREE_PATH}`;
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'Content-Range,Accept-Ranges,Content-Length,ETag',
};

// Every test fails on a console error or warning, or an uncaught exception, but for a 404
// a test expects (`expectedMissing`, URLs), which Chromium logs as a failed load.
const test = base.extend({
  expectedMissing: [[], { option: true }],
  // Console messages a test causes on purpose, as RegExp sources.
  allowedConsole: [[], { option: true }],
  // { manifest: false } answers the tree's manifest.json with a 404, as a build without search/ does.
  tree: [{ manifest: true }, { option: true }],
  page: async ({ page, expectedMissing, allowedConsole, tree }, use) => {
    const problems = [];
    page.on('console', (msg) => {
      if (msg.type() !== 'error' && msg.type() !== 'warning') return;
      const missing = expectedMissing.includes(msg.location().url)
        && /^Failed to load resource: the server responded with a status of 404\b/.test(msg.text());
      if (!missing && !allowedConsole.some((re) => new RegExp(re).test(msg.text()))) problems.push(`console.${msg.type()}: ${msg.text()}`);
    });
    page.on('pageerror', (err) => problems.push(`uncaught: ${err.message}`));
    const requests = [];
    page.on('request', (r) => { if (r.url().startsWith(IDX) && r.method() === 'GET') requests.push({ url: r.url(), range: r.headers().range ?? null }); });
    page.searchRequests = requests;
    await page.route(`${IDX}/manifest.json`, (route) => route.fulfill({
      headers: { ...CORS, 'cache-control': 'no-cache' },
      contentType: 'application/json',
      body: JSON.stringify({ format: 2, version: TREE_VERSION, base: `v/${TREE_VERSION}/`, idx: 1, reporters: {} }),
    }));
    await page.route(`${TREE}/**`, (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: { ...CORS, 'access-control-allow-methods': 'GET, HEAD', 'access-control-allow-headers': 'range' } });
      }
      const path = new URL(req.url()).pathname.slice(1);
      if (!tree.manifest && path.endsWith('search/manifest.json')) {
        return route.fulfill({ status: 404, headers: CORS, contentType: 'text/plain', body: 'Not Found' });
      }
      const r = treeResponse(path, req.headers().range);
      return route.fulfill({
        status: r.status,
        headers: { ...CORS, ...r.headers, 'cache-control': 'public, max-age=31536000, immutable' },
        body: r.body,
      });
    });
    await use(page);
    expect(problems, 'console errors or warnings').toEqual([]);
  },
});

const treeRequests = (page, end) => page.searchRequests.filter((r) => new URL(r.url).pathname.endsWith(end));
const status = (page) => page.locator('#search-status');

// The cards of decision ids, read from the fixture's cards.bin.
const CARDS = readFileSync(`${TREE_ROOT}${TREE_PATH}/cards.bin`);
const STRIDE = 160;
const cardOf = (id) => JSON.parse(CARDS.subarray(id * STRIDE, (id + 1) * STRIDE).toString('utf8').trimEnd());
const expected = (q, filters) => EXPECTED.find((e) => e.q === q && !e.limit && JSON.stringify(e.filters ?? {}) === JSON.stringify(filters ?? {}));

test('the empty page fetches nothing from the index, and no search client', async ({ page }) => {
  const client = [];
  page.on('request', (r) => { if (r.url().includes('/vendor/stare-search-')) client.push(r.url()); });
  await page.goto('/search/');
  await expect(page.locator('h1')).toHaveText('Search case law');
  await expect(page.getByRole('search')).toBeVisible();
  await expect(page.getByLabel('Words in the decision or its name')).toBeVisible();
  await page.waitForTimeout(500);
  expect(page.searchRequests.filter((r) => r.url.includes('/v/'))).toEqual([]);
  expect(client).toEqual([]);
});

test('a query shows 20 cards ranked as stare-builder\'s client ranks them, linked to the reader', async ({ page }) => {
  const want = expected('contract');
  await page.goto('/search/?q=contract');
  await expect(status(page)).toHaveText('137 decisions match. Page 1 of 7.');
  const cards = page.locator('#search-results > li');
  await expect(cards).toHaveCount(20);
  const names = await page.locator('#search-results .search-card-name').allTextContents();
  expect(names).toEqual(want.cards.map((c) => c.n));
  const first = want.cards[0];
  await expect(cards.first().locator('a')).toHaveAttribute('href', `/#${first.r}`);
  await expect(cards.first().locator('.search-card-cite')).toHaveText(first.c);
  await expect(cards.first().locator('.search-card-court')).toHaveText(first.ct);
  // the session's reads: the tree's manifest, the word's shard, low.bin as the client's stage
  // needed, and the page's cards in one multi-range request; no facets
  expect(treeRequests(page, 'search/manifest.json')).toHaveLength(1);
  expect(treeRequests(page, '.eidx').length).toBe(1);
  expect(treeRequests(page, 'facets.json')).toEqual([]);
  const cardReads = treeRequests(page, 'cards.bin');
  expect(cardReads).toHaveLength(1);
  expect(cardReads[0].range).toMatch(/^bytes=\d+-\d+(,\d+-\d+)*$/);
});

test('the next page reads only its cards, and Back shows the first again', async ({ page }) => {
  const want = expected('contract');
  await page.goto('/search/?q=contract');
  await expect(status(page)).toHaveText('137 decisions match. Page 1 of 7.');
  const before = page.searchRequests.length;
  await page.getByRole('link', { name: 'Next page, 2' }).click();
  await expect(page).toHaveURL(/\/search\/\?q=contract&page=2$/);
  await expect(status(page)).toHaveText('137 decisions match. Page 2 of 7.');
  await expect(page.locator('#search-pages a[aria-current="page"]')).toHaveText('2');
  const names = await page.locator('#search-results .search-card-name').allTextContents();
  expect(names).toEqual(want.ranked.slice(20, 40).map(([id]) => cardOf(id).n));
  const added = page.searchRequests.slice(before);
  expect(added.map((r) => new URL(r.url).pathname.split('/').pop())).toEqual(['cards.bin']);
  // keyboard users land on the new results
  await expect(page.locator('#search-results-heading')).toBeFocused();
  await page.goBack();
  await expect(status(page)).toHaveText('137 decisions match. Page 1 of 7.');
  expect(treeRequests(page, '.eidx').length).toBe(1);
});

test('a query of stopwords only, or a word nothing has, says so', async ({ page }) => {
  await page.goto('/search/?q=the+of+and');
  await expect(status(page)).toHaveText('Every word in that query is too common to search for. Try more specific words.');
  await page.fill('#search-q', 'zebra');
  await page.press('#search-q', 'Enter');
  await expect(status(page)).toHaveText('No decisions match.');
  await expect(page.locator('#search-results > li')).toHaveCount(0);
  await expect(page.locator('#search-pages')).toBeHidden();
});

test('the landing hands words that aren\'t a citation to the search', async ({ page }) => {
  await page.goto('/');
  await page.fill('#landing-input', 'kale marauders');
  await page.click('#landing-btn');
  await expect(page).toHaveURL(/\/search\/\?q=kale%20marauders$/);
  await expect(page.locator('#search-q')).toHaveValue('kale marauders');
  await expect(status(page)).toHaveText(`${expected('kale marauders').total} decisions match. Page 1 of 3.`);
});

test('keyboard: type, Enter, and Tab reaches the first result', async ({ page }) => {
  await page.goto('/search/');
  await page.locator('#search-q').focus();
  await page.keyboard.type('palsgraf');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/search\/\?q=palsgraf$/);
  await expect(status(page)).toHaveText('22 decisions match. Page 1 of 2.');
  await expect(status(page)).toHaveAttribute('role', 'status');
  await expect(status(page)).toHaveAttribute('aria-live', 'polite');
  await page.keyboard.press('Tab'); // the button
  await page.keyboard.press('Tab'); // Filters
  await page.keyboard.press('Tab');
  await expect(page.locator('#search-results > li:first-child a')).toBeFocused();
});

test('filters: a court and one year, from facets.json, read once the filters open', async ({ page }) => {
  await page.goto('/search/?q=contract');
  await expect(status(page)).toHaveText('137 decisions match. Page 1 of 7.');
  expect(treeRequests(page, 'facets.json')).toEqual([]);
  await page.locator('#search-filters summary').click();
  await expect(page.locator('#search-court option[value="ny"]')).toHaveText('New York Court of Appeals (1920–1959)');
  expect(treeRequests(page, 'facets.json')).toHaveLength(1);
  await page.selectOption('#search-court', 'ny');
  await page.fill('#search-from', '1925');
  await page.fill('#search-to', '1925');
  await page.click('#search-btn');
  await expect(page).toHaveURL(/\/search\/\?q=contract&court=ny&from=1925&to=1925$/);
  const want = expected('contract', { court: 'ny', year: '1925' });
  await expect(status(page)).toHaveText(`${want.total} decisions match.`);
  expect(await page.locator('#search-results .search-card-name a').evaluateAll((as) => as.map((a) => a.getAttribute('href'))))
    .toEqual(want.cards.map((c) => `/#${c.r}`));
});

test('a year range finds the decisions of those years', async ({ page }) => {
  const all = EXPECTED.find((e) => e.q === 'contract' && e.limit === 10000);
  const inRange = all.ranked.filter(([id]) => {
    const c = cardOf(id);
    return c.r.startsWith('ny/') && c.d.slice(0, 4) >= '1925' && c.d.slice(0, 4) <= '1934';
  });
  await page.goto('/search/?q=contract&court=ny&from=1925&to=1934');
  await expect(status(page)).toHaveText(`${inRange.length} decisions match.`);
  await expect(page.locator('#search-filters')).toHaveAttribute('open', '');
  const dates = await page.locator('#search-results .search-card-date').allTextContents();
  expect(dates.length).toBe(Math.min(20, inRange.length));
  for (const d of dates) expect(Number(d.slice(-4))).toBeGreaterThanOrEqual(1925);
});

test('the bundled client ranks as stare-builder\'s client does', async ({ page }) => {
  await page.goto('/search/');
  const queries = EXPECTED.filter((e) => !e.limit).slice(0, 10);
  const got = await page.evaluate(async ({ url, tree, queries }) => {
    const client = await import(url);
    const out = [];
    for (const q of queries) {
      const s = await client.openSearch(tree, { fetch: (u, i) => fetch(u, i) });
      const r = await client.search(s, q.q, { filters: q.filters ?? {} });
      out.push({ total: r.total, stage: r.stage, ranked: r.ranked.map((h) => h.id), cards: r.hits.map((h) => h.card) });
    }
    return out;
  }, { url: SEARCH_CLIENT_URL, tree: TREE, queries });
  expect(got).toEqual(queries.map((q) => ({ total: q.total, stage: q.stage, ranked: q.ranked.map(([id]) => id), cards: q.cards })));
});

test.describe('an index build without a search tree', () => {
  test.use({ tree: { manifest: false }, expectedMissing: [`${TREE}/manifest.json`] });

  test('says search isn\'t available yet, not an error', async ({ page }) => {
    await page.goto('/search/?q=contract');
    await expect(status(page)).toHaveText('Search isn’t available for this index yet. You can still open a case by its citation on the home page.');
    await expect(status(page)).not.toHaveClass(/search-error/);
    await expect(page.locator('#search-results > li')).toHaveCount(0);
  });
});

test.describe('a search client a content blocker refuses', () => {
  test.use({ allowedConsole: ['ERR_BLOCKED_BY_CLIENT', 'dynamically imported module'] });

  test('says so', async ({ page }) => {
    await page.route((url) => url.pathname === SEARCH_CLIENT_URL, (route) => route.abort('blockedbyclient'));
    await page.goto('/search/?q=contract');
    await expect(status(page)).toContainText('content blocker');
    await expect(status(page)).toHaveClass(/search-error/);
  });
});

for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['laptop', { width: 1280, height: 800 }]]) {
  test(`results arriving move nothing on screen (${name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      window.__cls = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await page.goto('/search/?q=contract');
    await expect(page.locator('#search-results > li')).toHaveCount(20);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__cls)).toBeLessThan(0.05);
  });
}
