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
// The requests on a segmented file's segments (`cards/<n>.bin`, `low/<n>.bin`).
const segmentRequests = (page, dir) => page.searchRequests.filter((r) => new RegExp(`/search/${dir}/\\d+\\.bin$`).test(new URL(r.url).pathname));
const status = (page) => page.locator('#search-status');
const live = (page) => page.locator('#search-live');

// The cards of decision ids, read from the fixture's cards segments.
const CARDS_META = JSON.parse(readFileSync(`${TREE_ROOT}${TREE_PATH}/manifest.json`, 'utf8')).metadata.search.files.cards;
const STRIDE = CARDS_META.stride;
const SEGMENT_CARDS = CARDS_META.segment_bytes / STRIDE;
const cardOf = (id) => {
  const seg = readFileSync(`${TREE_ROOT}${TREE_PATH}/${CARDS_META.segments.replace('{segment}', Math.floor(id / SEGMENT_CARDS))}`);
  const at = (id % SEGMENT_CARDS) * STRIDE;
  return JSON.parse(seg.subarray(at, at + STRIDE).toString('utf8').trimEnd());
};
// The cards segments a page of ranked ids falls in, as file names (`3.bin`), sorted.
const cardSegments = (ids) => [...new Set(ids.map((id) => `${Math.floor(id / SEGMENT_CARDS)}.bin`))].sort();
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
  await expect(status(page)).toHaveText('137 matches, page 1 of 7');
  await expect(live(page)).toHaveText('137 matches. Page 1 of 7.');
  const cards = page.locator('#search-results > li');
  await expect(cards).toHaveCount(20);
  const names = await page.locator('#search-results .search-card-name').allTextContents();
  expect(names).toEqual(want.cards.map((c) => c.n));
  const first = want.cards[0];
  await expect(cards.first().locator('a')).toHaveAttribute('href', `/#${first.r}`);
  await expect(cards.first().locator('.search-card-cite')).toHaveText(first.c);
  await expect(cards.first().locator('.search-card-court')).toHaveText(first.ct);
  // the session's reads: the tree's manifest, the word's shard, the low tiers as the client's
  // stage needed, and the page's cards, one multi-range request per cards segment; no facets
  expect(treeRequests(page, 'search/manifest.json')).toHaveLength(1);
  expect(treeRequests(page, '.eidx').length).toBe(1);
  expect(treeRequests(page, 'facets.json')).toEqual([]);
  const cardReads = segmentRequests(page, 'cards');
  expect(cardReads.map((r) => new URL(r.url).pathname.split('/').pop()).sort()).toEqual(cardSegments(want.ranked.slice(0, 20).map(([id]) => id)));
  for (const r of cardReads) expect(r.range).toMatch(/^bytes=\d+-\d+(,\d+-\d+)*$/);
});

test('the next page reads only its cards, and Back shows the first again', async ({ page }) => {
  const want = expected('contract');
  await page.goto('/search/?q=contract');
  await expect(status(page)).toHaveText('137 matches, page 1 of 7');
  const before = page.searchRequests.length;
  await page.getByRole('link', { name: 'Next page, 2' }).click();
  await expect(page).toHaveURL(/\/search\/\?q=contract&page=2$/);
  await expect(status(page)).toHaveText('137 matches, page 2 of 7');
  await expect(page.locator('#search-pages a[aria-current="page"]')).toHaveText('2');
  const names = await page.locator('#search-results .search-card-name').allTextContents();
  expect(names).toEqual(want.ranked.slice(20, 40).map(([id]) => cardOf(id).n));
  const added = page.searchRequests.slice(before);
  expect(added.every((r) => /\/search\/cards\/\d+\.bin$/.test(new URL(r.url).pathname))).toBe(true);
  expect(added.map((r) => new URL(r.url).pathname.split('/').pop()).sort()).toEqual(cardSegments(want.ranked.slice(20, 40).map(([id]) => id)));
  // keyboard users land on the new results
  await expect(page.locator('#search-results-heading')).toBeFocused();
  await page.goBack();
  await expect(status(page)).toHaveText('137 matches, page 1 of 7');
  expect(treeRequests(page, '.eidx').length).toBe(1);
});

test('a query of stopwords only, or a word nothing has, says so', async ({ page }) => {
  await page.goto('/search/?q=the+of+and');
  await expect(status(page)).toHaveText('Nothing to search for');
  await expect(page.locator('#search-empty')).toContainText('Every word in that query is too common to search for.');
  await expect(live(page)).toHaveText('Every word in that query is too common to search for. Try more specific words.');
  await page.fill('#search-q', 'zebra');
  await page.press('#search-q', 'Enter');
  await expect(status(page)).toHaveText('No matches');
  await expect(page.locator('#search-empty')).toContainText('No decisions match zebra.');
  await expect(live(page)).toHaveText('No decisions match.');
  await expect(page.locator('#search-results > li')).toHaveCount(0);
  await expect(page.locator('#search-pages')).toBeHidden();
});

test('the landing hands words that aren\'t a citation to the search', async ({ page }) => {
  await page.goto('/');
  await page.fill('#landing-input', 'kale marauders');
  await expect(page.locator('#landing-btn')).toHaveAccessibleName('Search');
  await page.click('#landing-btn');
  await expect(page).toHaveURL(/\/search\/\?q=kale%20marauders$/);
  await expect(page.locator('#search-q')).toHaveValue('kale marauders');
  await expect(status(page)).toHaveText(`${expected('kale marauders').total} matches, page 1 of 3`);
});

test('keyboard: type, Enter, and Tab reaches the first result', async ({ page }) => {
  await page.goto('/search/');
  await page.locator('#search-q').focus();
  await page.keyboard.type('palsgraf');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/search\/\?q=palsgraf$/);
  await expect(status(page)).toHaveText('22 matches, page 1 of 2');
  await expect(live(page)).toHaveText('22 matches. Page 1 of 2.');
  await expect(live(page)).toHaveAttribute('role', 'status');
  await expect(live(page)).toHaveAttribute('aria-live', 'polite');
  await expect(status(page)).not.toHaveAttribute('aria-live');
  await page.keyboard.press('Tab'); // the button
  await page.keyboard.press('Tab'); // Filters
  await page.keyboard.press('Tab');
  await expect(page.locator('#search-results > li:first-child a')).toBeFocused();
});

test('filters: a court and one year, from facets.json, read once the filters open', async ({ page }) => {
  await page.goto('/search/?q=contract');
  await expect(status(page)).toHaveText('137 matches, page 1 of 7');
  expect(treeRequests(page, 'facets.json')).toEqual([]);
  await page.locator('#search-filters summary').click();
  await expect(page.locator('#search-court option[value="ny"]')).toHaveText('New York Court of Appeals, 1920–1959, 80 decisions');
  await expect(page.locator('#search-jurisdiction option[value="ny"]')).toHaveText('New York, 80 decisions');
  expect(treeRequests(page, 'facets.json')).toHaveLength(1);
  await page.selectOption('#search-court', 'ny');
  await page.fill('#search-from', '1925');
  await page.fill('#search-to', '1925');
  await page.click('#search-btn');
  await expect(page).toHaveURL(/\/search\/\?q=contract&court=ny&from=1925&to=1925$/);
  const want = expected('contract', { court: 'ny', year: '1925' });
  await expect(status(page)).toHaveText(`${want.total} ${want.total === 1 ? 'match' : 'matches'}`);
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
  await expect(status(page)).toHaveText(`${inRange.length} matches`);
  await expect(page.locator('#search-filters')).toHaveAttribute('open', '');
  await expect(page.locator('#search-chips button.search-chip')).toHaveText(['Court: New York Court of Appeals×', 'Decided: 1925 to 1934×']);
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

// Holds the tree's requests matching `re` until release() is called.
function holdRequests(page, re) {
  let release;
  const gate = new Promise((r) => { release = r; });
  const held = [];
  let holding = true;
  return {
    async install() {
      await page.route((url) => re.test(url.pathname), async (route) => {
        if (!holding) return route.fallback();
        held.push(route.request().url());
        await gate;
        await route.fallback().catch(() => {});
      });
    },
    held,
    // later requests go straight through; the held ones wait for release()
    stop: () => { holding = false; },
    release: () => release(),
  };
}

test('the first query shows a skeleton at the list\'s height and says it is loading the index', async ({ page }) => {
  const hold = holdRequests(page, /\/search\/manifest\.json$/);
  await hold.install();
  await page.goto('/search/?q=contract');
  await expect(status(page)).toHaveText('Loading the search index, once per visit…');
  await expect(page.locator('#search-results > li.search-card-skel')).toHaveCount(20);
  await expect(page.locator('#search-progress')).toBeVisible();
  const skelHeight = await page.locator('#search-results').evaluate((el) => el.getBoundingClientRect().height);
  hold.release();
  await expect(status(page)).toHaveText('137 matches, page 1 of 7');
  await expect(page.locator('#search-results > li.search-card-skel')).toHaveCount(0);
  await expect(page.locator('#search-progress')).toBeHidden();
  const height = await page.locator('#search-results').evaluate((el) => el.getBoundingClientRect().height);
  // the skeleton is within a few pixels a card of the real list's height
  expect(Math.abs(height - skelHeight) / 20).toBeLessThan(12);
});

test('a new query keeps the previous results on screen until its own arrive', async ({ page }) => {
  await page.goto('/search/?q=contract');
  await expect(status(page)).toHaveText('137 matches, page 1 of 7');
  const hold = holdRequests(page, /\/search\/cards\/\d+\.bin$/);
  await hold.install();
  await page.fill('#search-q', 'palsgraf');
  await page.press('#search-q', 'Enter');
  await expect(status(page)).toHaveText('Searching…');
  await expect(page.locator('#search-results')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#search-results > li.search-card:not(.search-card-skel)')).toHaveCount(20);
  await expect(page.locator('#search-results > li.search-card-skel')).toHaveCount(0);
  hold.release();
  await expect(status(page)).toHaveText('22 matches, page 1 of 2');
  await expect(page.locator('#search-results')).not.toHaveAttribute('aria-busy');
});

test('a query replaced by another is cancelled, and only the last one\'s results show', async ({ page }) => {
  await page.goto('/search/?q=contract');
  await expect(status(page)).toHaveText('137 matches, page 1 of 7');
  const aborted = [];
  page.on('requestfailed', (r) => { if (r.url().includes('/search/cards/')) aborted.push(r.failure()?.errorText); });
  // jiffy's cards are held, then palsgraf replaces it
  const hold = holdRequests(page, /\/search\/cards\/\d+\.bin$/);
  await hold.install();
  await page.fill('#search-q', 'jiffy');
  await page.press('#search-q', 'Enter');
  await expect.poll(() => hold.held.length).toBeGreaterThan(0);
  hold.stop();
  await page.fill('#search-q', 'palsgraf');
  await page.press('#search-q', 'Enter');
  await expect(status(page)).toHaveText('22 matches, page 1 of 2');
  hold.release();
  await page.waitForTimeout(300);
  await expect(status(page)).toHaveText('22 matches, page 1 of 2');
  const names = await page.locator('#search-results .search-card-name').allTextContents();
  expect(names).toEqual(expected('palsgraf').cards.map((c) => c.n));
  expect(aborted.length).toBeGreaterThan(0);
});

test.describe('a query that fails', () => {
  test.use({ allowedConsole: ['status of 503', 'HTTP 503'] });

  test('says so, and Try again runs it again', async ({ page }) => {
    let fail = true;
    await page.route((url) => /\/search\/cards\/\d+\.bin$/.test(url.pathname), (route) => (fail
      ? route.fulfill({ status: 503, headers: { 'access-control-allow-origin': '*' }, body: 'unavailable' })
      : route.fallback()));
    await page.goto('/search/?q=contract');
    await expect(status(page)).toHaveClass(/search-error/);
    await expect(status(page)).toContainText('503');
    await expect(live(page)).toContainText('503');
    fail = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(status(page)).toHaveText('137 matches, page 1 of 7');
    await expect(status(page)).not.toHaveClass(/search-error/);
  });
});

test('a slow query says so, with a way to try again', async ({ page }) => {
  await page.clock.install();
  const hold = holdRequests(page, /\/search\/cards\/\d+\.bin$/);
  await hold.install();
  await page.goto('/search/?q=contract');
  await expect.poll(() => hold.held.length).toBeGreaterThan(0);
  await page.clock.runFor(9000);
  await expect(status(page)).toContainText('Still searching');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  hold.release();
  await expect(status(page)).toHaveText('137 matches, page 1 of 7');
});

test('the live region speaks once per result set', async ({ page }) => {
  await page.addInitScript(() => {
    window.__said = [];
    document.addEventListener('DOMContentLoaded', () => {
      const el = document.getElementById('search-live');
      new MutationObserver(() => { if (el.textContent) window.__said.push(el.textContent); })
        .observe(el, { childList: true, characterData: true, subtree: true });
    });
  });
  await page.goto('/search/?q=contract');
  await expect(status(page)).toHaveText('137 matches, page 1 of 7');
  await page.getByRole('link', { name: 'Next page, 2' }).click();
  await expect(status(page)).toHaveText('137 matches, page 2 of 7');
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__said)).toEqual(['137 matches. Page 1 of 7.', '137 matches. Page 2 of 7.']);
});

test('the query\'s words are marked in the case names', async ({ page }) => {
  await page.goto('/search/?q=kale+marauders');
  await expect(page.locator('#search-results > li')).toHaveCount(20);
  const first = page.locator('#search-results > li').first();
  await expect(first.locator('.search-card-name')).toHaveText(expected('kale marauders').cards[0].n);
  await expect(first.locator('.search-card-name mark')).toHaveText(['Kale', 'Marauders']);
  // the mark is inside the link, which keeps the whole name
  await expect(first.locator('.search-card-name a')).toHaveText('Kale v. Marauders');
});

test('common words left out of a query are named', async ({ page }) => {
  await page.goto('/search/?q=the+palsgraf');
  await expect(status(page)).toHaveText('22 matches, page 1 of 2');
  await expect(page.locator('#search-note')).toHaveText('Left out as too common to search for: the.');
});

test('a search for a citation asks "Did you mean" it, which opens it in the reader', async ({ page }) => {
  // the reader itself isn't under test here: its page is answered with a stub
  await page.route((url) => url.pathname === '/' && url.port === new URL(page.url() || 'http://x').port, (route) => (route.request().resourceType() === 'document'
    ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>reader</title>' })
    : route.fallback()));
  await page.goto('/search/?q=ny+248+339');
  const offer = page.locator('#search-cite');
  await expect(offer).toBeVisible();
  await expect(offer).toHaveText('Did you mean ny 248 339?');
  await offer.getByRole('button', { name: 'Open ny 248 339 in the reader' }).click();
  await expect(page).toHaveURL(/\/#ny\/248\/339$/);
});

test('a query that isn\'t a citation offers nothing', async ({ page }) => {
  await page.goto('/search/?q=1983+nys2d');
  await expect(status(page)).not.toHaveText('');
  await expect(page.locator('#search-cite')).toBeHidden();
});

test('filters show as chips; a chip removes its filter, and Clear all removes them all', async ({ page }) => {
  await page.goto('/search/?q=contract&court=ny&from=1925&to=1934');
  await expect(page.locator('#search-chips button.search-chip')).toHaveCount(2);
  await expect(page.locator('#search-filter-count')).toHaveText(' (2)');
  await page.getByRole('button', { name: 'Remove filter: Decided, 1925 to 1934' }).click();
  await expect(page).toHaveURL(/\/search\/\?q=contract&court=ny$/);
  const nyTotal = EXPECTED.find((e) => e.q === 'contract' && e.limit === 10000).ranked.filter(([id]) => cardOf(id).r.startsWith('ny/')).length;
  await expect(status(page)).toHaveText(`${nyTotal} matches, page 1 of ${Math.ceil(nyTotal / 20)}`);
  await expect(page.locator('#search-chips button.search-chip')).toHaveCount(1);
  // focus stays on the chips
  await expect(page.locator('#search-chips button.search-chip')).toBeFocused();
  await page.goBack();
  await expect(page).toHaveURL(/from=1925&to=1934$/);
  await expect(page.locator('#search-chips button.search-chip')).toHaveCount(2);
  await page.getByRole('button', { name: 'Clear all' }).click();
  await expect(page).toHaveURL(/\/search\/\?q=contract$/);
  await expect(page.locator('#search-chips')).toBeHidden();
  await expect(status(page)).toHaveText('137 matches, page 1 of 7');
});

test('on a phone the filters stay shut, chips show them, and facets.json waits until they open', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/search/?q=contract&court=ny');
  await expect(status(page)).not.toHaveText(/Searching|Loading/);
  await expect(page.locator('#search-filters')).not.toHaveAttribute('open', '');
  // the court's name, from the results' cards, until facets.json is in
  await expect(page.locator('#search-chips button.search-chip')).toHaveCount(1);
  expect(treeRequests(page, 'facets.json')).toEqual([]);
  await page.locator('#search-filters summary').click();
  await expect(page.locator('#search-court option[value="ny"]')).toHaveText('New York Court of Appeals, 1920–1959, 80 decisions');
  expect(treeRequests(page, 'facets.json')).toHaveLength(1);
  await expect(page.locator('#search-chips button.search-chip')).toHaveText('Court: New York Court of Appeals×');
});

test('the year range: a chart of decisions a year, with sliders tied to the From and To boxes', async ({ page }) => {
  await page.goto('/search/?q=contract');
  await expect(status(page)).toHaveText('137 matches, page 1 of 7');
  await page.locator('#search-filters summary').click();
  const bars = page.locator('#search-year-chart .search-year-bars > span');
  await expect(bars).not.toHaveCount(0);
  // every year in range to start with
  expect(await page.locator('#search-year-chart .search-year-bars > span.in').count()).toBe(await bars.count());
  await page.fill('#search-from', '1930');
  await page.fill('#search-to', '1939');
  const marked = await page.locator('#search-year-chart .search-year-bars > span.in').count();
  expect(marked).toBeGreaterThan(0);
  expect(marked).toBeLessThan(await bars.count());
  await expect(page.locator('#search-year-chart input[type=range]').first()).toHaveValue('1930');
  // a slider moves the boxes; an end at the edge of the years leaves that end open
  const lo = page.locator('#search-year-chart input[type=range]').first();
  await lo.evaluate((el) => { el.value = el.min; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(page.locator('#search-from')).toHaveValue('');
  await expect(page.locator('#search-to')).toHaveValue('1939');
  // the court list narrows as it's typed into
  await page.fill('#search-court-find', 'first');
  await expect(page.locator('#search-court option')).toHaveText(['Any', 'First Circuit, 2010, 29 decisions']);
  await page.fill('#search-court-find', '');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page).toHaveURL(/\/search\/\?q=contract&to=1939$/);
  await expect(page.locator('#search-chips button.search-chip')).toHaveText('Decided: 1939 and earlier×');
});

test('a page change keeps the place: focus on the results, and Back returns to where the page was scrolled', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/search/?q=contract');
  await expect(status(page)).toHaveText('137 matches, page 1 of 7');
  await page.getByRole('link', { name: 'Next page, 2' }).scrollIntoViewIfNeeded();
  const y = await page.evaluate(() => window.scrollY);
  expect(y).toBeGreaterThan(300);
  await page.getByRole('link', { name: 'Next page, 2' }).click();
  await expect(status(page)).toHaveText('137 matches, page 2 of 7');
  await expect(page.locator('#search-results-heading')).toBeFocused();
  // the top of the new results is on screen
  const top = await page.locator('#search-results').evaluate((el) => el.getBoundingClientRect().top);
  expect(top).toBeGreaterThanOrEqual(-5);
  expect(top).toBeLessThan(200);
  await page.goBack();
  await expect(status(page)).toHaveText('137 matches, page 1 of 7');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(y - 5);
});

for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['laptop', { width: 1366, height: 768 }]]) {
  test(`a query with filters and a note under the count moves nothing on screen either (${name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      window.__cls = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await page.goto('/search/?q=the+contract&court=ny&from=1925&to=1934');
    await expect(page.locator('#search-results > li:not(.search-card-skel)')).not.toHaveCount(0);
    await expect(page.locator('#search-note')).toHaveText('Left out as too common to search for: the.');
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__cls)).toBeLessThan(0.05);
  });
}
