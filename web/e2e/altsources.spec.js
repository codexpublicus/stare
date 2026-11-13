// Other printings and sources (#320): the case sidebar lists the decision's other printings
// and its CourtListener records, looked up after the case is shown. Wynnewood Development,
// Inc. v. Bank & Trust Co. is printed at 551 Pa. 552 and 711 A.2d 1003, and joined to
// CourtListener's cluster 2162554. Its two volumes' index files (build v2026.11.05.3) and
// its ledger row (v2026.11.08) are served from fixtures (web/tests/fixtures/alt-sources/,
// web/tests/fixtures/crk/); the case text comes from the live zips, as in the other specs.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { test as base, expect } from '@playwright/test';

const CRK = new URL('../tests/fixtures/crk/', import.meta.url);
const IDX = new URL('../tests/fixtures/alt-sources/', import.meta.url);
const cors = { 'Access-Control-Allow-Origin': '*' };
const INDEX_FILES = { 'pa/551.idx.gz': 'pa-551.idx', 'a2d/711.idx.gz': 'a2d-711.idx' };
const isIndexFile = (url, path) => url.hostname === 'idx.stare.pub' && url.pathname.endsWith(`/${path}`);

// Serves the ledger and the two index files from the fixtures. Every test fails on a console
// error or warning or an uncaught exception, except the messages `allow` matches.
const test = base.extend({
  allow: [null, { option: true }],
  page: async ({ page, allow }, use) => {
    const problems = [];
    page.on('console', (msg) => {
      if (msg.type() !== 'error' && msg.type() !== 'warning') return;
      if (allow && allow.test(msg.text())) return;
      problems.push(`console.${msg.type()}: ${msg.text()}`);
    });
    page.on('pageerror', (err) => problems.push(`uncaught: ${err.message}`));
    await page.route('https://data.stare.pub/crk/ledger/**', (route) => {
      const path = new URL(route.request().url()).pathname.replace('/crk/ledger/', '');
      if (path === 'latest.json') {
        return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: readFileSync(new URL('latest.json', CRK)) });
      }
      const m = path.match(/^s\/([0-9a-f]{16})\.json\.gz$/);
      let body;
      try {
        body = gzipSync(readFileSync(new URL(`${m?.[1]}.json`, CRK)));
      } catch {
        body = gzipSync(JSON.stringify({ keys: [], decisions: [] }));
      }
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/gzip', body });
    });
    for (const [path, file] of Object.entries(INDEX_FILES)) {
      await page.route((url) => isIndexFile(url, path), (route) => route.fulfill({
        status: 200, headers: cors, contentType: 'application/gzip', body: gzipSync(readFileSync(new URL(file, IDX))),
      }));
    }
    await use(page);
    expect(problems, 'console errors or warnings').toEqual([]);
  },
});

const TITLE = /^Wynnewood Development, Inc\. v\. Bank & Trust Co\./;
const KEY = 'us/pa/0007e.d.appealdocket1997/1998-05-19';
const section = (page) => page.locator('#alt-sources');
const rows = (page) => page.locator('#alt-sources .alt-item');

test('the Pa. printing lists the A.2d printing and the CourtListener record', async ({ page }) => {
  await page.goto('/#pa/551/552-01');
  await expect(page.locator('#topbar-case')).toHaveText(TITLE);
  await expect(section(page).locator('.sidebar-label')).toHaveText('Other printings and sources');
  await expect(rows(page)).toHaveCount(2);
  const printing = rows(page).nth(0);
  await expect(printing.locator('a')).toHaveText('711 A.2d 1003');
  await expect(printing.locator('a')).toHaveAttribute('href', '#a2d/711/1003-01');
  await expect(printing.locator('.alt-source')).toHaveText('CAP');
  const record = rows(page).nth(1);
  await expect(record.locator('a')).toHaveText('Opinion cluster 2162554');
  await expect(record.locator('a')).toHaveAttribute('href', 'https://www.courtlistener.com/opinion/2162554/');
  await expect(record.locator('a')).toHaveAttribute('target', '_blank');
  await expect(record.locator('a')).toHaveAttribute('title', "Listed through CourtListener's citation metadata");
  await expect(record.locator('.alt-source')).toHaveText('CourtListener');
  // Nothing calls a printing official: the ledger doesn't say which is.
  await expect(section(page)).not.toContainText(/official/i);

  // The printing's link opens it.
  await printing.locator('a').click();
  await expect(page).toHaveURL(/#a2d\/711\/1003-01$/);
  await expect(page.locator('#topbar-cite')).toHaveText('711 A.2d 1003');
});

test("the A.2d printing opened by its hash lists nothing: its JSON and its page name no other", async ({ page }) => {
  await page.goto('/#a2d/711/1003-01');
  await expect(page.locator('#topbar-case')).toHaveText(TITLE);
  await expect(page.locator('#sidebar [role="status"]')).toHaveText(/cited cases? found|No citations/);
  await expect(section(page)).toHaveCount(0);
});

test("from the key, the ledger lists the A.2d printing's other printing and record too", async ({ page }) => {
  await page.goto(`/k/${KEY}/`);
  await expect(page.locator('#topbar-cite')).toHaveText('551 Pa. 552');
  await expect(rows(page)).toHaveCount(2);
  // The ledger names the record, so it's no longer only CourtListener's metadata.
  await expect(rows(page).nth(1).locator('a')).toHaveAttribute('title', /no address that opens this record/);

  await rows(page).nth(0).locator('a').click();
  await expect(page.locator('#topbar-cite')).toHaveText('711 A.2d 1003');
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(0).locator('a')).toHaveText('pa 551 552');
  await expect(rows(page).nth(0).locator('a')).toHaveAttribute('href', '#pa/551/552-01');
  await expect(rows(page).nth(1).locator('a')).toHaveText('Opinion cluster 2162554');
});

test('the lookup waits for the case: the text shows while it is held, and nothing moves when it lands', async ({ page }) => {
  await page.addInitScript(() => {
    window.__cls = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  });
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  let asked = 0;
  await page.route((url) => isIndexFile(url, 'a2d/711.idx.gz'), async (route) => {
    asked += 1;
    await released;
    await route.fulfill({ status: 200, headers: cors, contentType: 'application/gzip', body: gzipSync(readFileSync(new URL('a2d-711.idx', IDX))) });
  });
  await page.goto('/#pa/551/552-01');
  await expect(page.locator('#reader .reader-title')).toHaveText(TITLE);
  await expect(page.locator('#reader .reader-text p').first()).not.toBeEmpty();
  await expect(section(page).locator('.alt-status')).toHaveText('Checking the index...');
  await expect.poll(() => asked).toBeGreaterThanOrEqual(1);
  const before = await section(page).boundingBox();
  release();
  await expect(rows(page)).toHaveCount(2);
  const after = await section(page).boundingBox();
  expect(after.height).toBe(before.height);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__cls)).toBeLessThan(0.05);
});

test.describe('when the index can\'t be reached', () => {
  // Chromium logs the aborted request itself.
  test.use({ allow: /Failed to load resource/ });

  test('a citation it could not check says so', async ({ page }) => {
    await page.route((url) => isIndexFile(url, 'a2d/711.idx.gz'), (route) => route.abort('failed'));
    await page.goto('/#pa/551/552-01');
    await expect(page.locator('#topbar-case')).toHaveText(TITLE);
    const first = rows(page).nth(0);
    await expect(first.locator('.alt-text')).toHaveText('711 A.2d 1003');
    await expect(first.locator('.alt-source')).toHaveText('Not checked');
    await expect(first.locator('.alt-text')).toHaveAttribute('title', "Couldn't check the index for this citation");
  });
});
