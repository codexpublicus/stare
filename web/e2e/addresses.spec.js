// Permanent case addresses (#283, D147): `/k/<key>/` from the minted-key ledger,
// `/c/<jurisdiction>/<slug>/<volume>/<page>/` from the per-volume index, and `/d/<id>/`
// from the index build's decision-route table, served as the reader by the
// single-page-application fallback to browser navigations only. The ledger is
// served from recorded fixtures (web/tests/fixtures/crk/), so a new ledger version changes
// nothing here; the index and the zips are the live ones, as in the other specs.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { test as base, expect } from '@playwright/test';

const FIXTURES = new URL('../tests/fixtures/crk/', import.meta.url);
const fixture = (name) => readFileSync(new URL(name, FIXTURES));

// Like smoke.spec.js, every test fails on a console error or warning or an uncaught
// exception. Every test serves the ledger from the fixtures.
const test = base.extend({
  page: async ({ page }, use) => {
    const problems = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') problems.push(`console.${msg.type()}: ${msg.text()}`);
    });
    page.on('pageerror', (err) => problems.push(`uncaught: ${err.message}`));
    await page.route('https://data.stare.pub/crk/ledger/**', (route) => {
      const path = new URL(route.request().url()).pathname.replace('/crk/ledger/', '');
      const cors = { 'Access-Control-Allow-Origin': '*' };
      if (path === 'latest.json') {
        return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: fixture('latest.json') });
      }
      const m = path.match(/^s\/([0-9a-f]{16})\.json\.gz$/);
      let body = null;
      try {
        body = m ? gzipSync(fixture(`${m[1]}.json`)) : null;
      } catch {
        body = null;
      }
      // A shard the fixtures don't hold is an empty one: its keys aren't minted.
      if (m && !body) body = gzipSync(JSON.stringify({ keys: [], decisions: [] }));
      if (!body) return route.fulfill({ status: 404, headers: cors, body: '' });
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/gzip', body });
    });
    await use(page);
    expect(problems, 'console errors or warnings').toEqual([]);
  },
});

const LYON = { key: 'us/dc/69/1943-05-11', title: "D'Elia & Marks Co. v. Lyon" };
const RENAIRE = { hash: '#a2d/142/148-01', title: 'Renaire Corp. v. Vaughn' };
const canonical = (page) => page.locator('link[rel="canonical"]').getAttribute('href');

test('a key opens its case and keeps its address', async ({ page }) => {
  const resp = await page.goto(`/k/${LYON.key}/`);
  expect(resp.status()).toBe(200);
  await expect(page.locator('#topbar-case')).toHaveText(LYON.title);
  await expect(page.locator('#reader .reader-title')).toHaveText(LYON.title);
  const url = new URL(page.url());
  expect(url.pathname).toBe(`/k/${LYON.key}/`);
  expect(url.hash).toBe('');
  expect(await canonical(page)).toBe(`https://stare.pub/k/${LYON.key}/`);
  await expect(page.locator('#key-notice')).toBeHidden();
});

test('a replaced key moves the address to its current key', async ({ page }) => {
  await page.goto(`/k/${LYON.key}~9/`);
  await expect(page.locator('#topbar-case')).toHaveText(LYON.title);
  expect(new URL(page.url()).pathname).toBe(`/k/${LYON.key}/`);
  expect(await canonical(page)).toBe(`https://stare.pub/k/${LYON.key}/`);
});

test('a key the ledger has no row for says so', async ({ page }) => {
  await page.goto('/k/us/dc/70/1943-05-11/');
  await expect(page.locator('#landing-status')).toContainText('stare.pub has no case with the key us/dc/70/1943-05-11');
  await expect(page.locator('#landing')).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
  expect(await page.locator('link[rel="canonical"]').count()).toBe(0);
  // A court the ledger has no keys in, and a path that isn't a key at all.
  await page.goto('/k/us/zz/1/2000-01-01/');
  await expect(page.locator('#landing-status')).toContainText('has no case with the key us/zz/1/2000-01-01');
  await page.goto('/k/us/');
  await expect(page.locator('#landing-status')).toContainText("isn't a case key");
});

test('a citation address opens the case at that page', async ({ page }) => {
  await page.goto('/c/us/a2d/31/647/');
  await expect(page.locator('#topbar-case')).toHaveText(LYON.title);
  expect(new URL(page.url()).pathname).toBe('/c/us/a2d/31/647/');
  expect(await canonical(page)).toBe('https://stare.pub/c/us/a2d/31/647/');
});

test('another case leaves the address, and Back returns to it', async ({ page }) => {
  await page.goto(`/k/${LYON.key}/`);
  await expect(page.locator('#topbar-case')).toHaveText(LYON.title);
  await page.evaluate((hash) => { window.location.hash = hash; }, RENAIRE.hash);
  await expect(page.locator('#topbar-case')).toHaveText(RENAIRE.title);
  expect(new URL(page.url()).pathname + new URL(page.url()).hash).toBe(`/${RENAIRE.hash}`);
  expect(await page.locator('link[rel="canonical"]').count()).toBe(0);
  await page.goBack();
  await expect(page.locator('#topbar-case')).toHaveText(LYON.title);
  expect(new URL(page.url()).pathname).toBe(`/k/${LYON.key}/`);
});

test('an old hash link still opens its case at /', async ({ page }) => {
  await page.goto('/#a2d/31/647-01');
  await expect(page.locator('#topbar-case')).toHaveText(LYON.title);
  expect(new URL(page.url()).hash).toBe('#a2d/31/647-01');
});

test('a path nothing serves says so to a browser', async ({ page }) => {
  await page.goto('/no-such-page/');
  await expect(page.locator('#landing-status')).toContainText("There's no page at /no-such-page/");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
});

test('a script or crawler asking for an address gets a 404, and real files still win', async ({ request }) => {
  // No Sec-Fetch-Mode: navigate, so no fallback (D147: crawl policy unchanged).
  for (const path of [`/k/${LYON.key}/`, '/c/us/a2d/31/647/', '/no-such-page/', '/data/a2d/no-such.bin']) {
    const resp = await request.get(path);
    expect(resp.status(), path).toBe(404);
    expect(resp.headers()['content-type'], path).not.toContain('text/html');
  }
  for (const path of ['/', '/about', '/robots.txt']) {
    expect((await request.get(path)).status(), path).toBe(200);
  }
});

// `/d/<id>/` (decisionroute.js): the build's decision-route table names the record. The
// table's shard and the record are served here: the hand-made record the Rust tests read,
// under an id the live ledger gave a CourtListener-only decision.
const DECISION = { id: '01cm306', title: 'Smith v. Jones' };
const LYON_ID = '01cd294';
const RECORD_URL = 'https://data.stare.pub/cl/c/9876543/0f3a9c2e7b1d4a65.json.gz';
const RECORD = readFileSync(new URL('../../crates/stare/tests/fixtures/cl-record.json', import.meta.url));

async function serveDecisionTable(page) {
  const cors = { 'Access-Control-Allow-Origin': '*' };
  await page.route(/^https:\/\/idx\.stare\.pub\/(v\/[^/]+\/)?d\/[0-9a-z]\.json\.gz$/, (route) => {
    const shard = route.request().url().match(/\/d\/([0-9a-z])\.json\.gz$/)[1];
    const records = shard === DECISION.id[5]
      ? { [DECISION.id]: [{ cluster: 9876543, hash: '0f3a9c2e7b1d4a65' }] }
      : {};
    // Lyon's decision, as if an unrouted record's cluster were joined to it (D208)
    const cap = shard === LYON_ID[5]
      ? { [LYON_ID]: { key: LYON.key, sources: ['cap:a2d/31/0647-01'], clusters: [5123106] } }
      : {};
    const body = gzipSync(JSON.stringify({ format: 'stare-decision-routes-shard', format_version: 1, shard, records, cap }));
    return route.fulfill({ status: 200, headers: cors, contentType: 'application/gzip', body });
  });
  await page.route(RECORD_URL, (route) => route.fulfill({
    status: 200, headers: cors, contentType: 'application/gzip', body: gzipSync(RECORD),
  }));
}

test('a decision id opens its CourtListener record and keeps its address', async ({ page }) => {
  await serveDecisionTable(page);
  const resp = await page.goto(`/d/${DECISION.id}/`);
  expect(resp.status()).toBe(200);
  await expect(page.locator('#topbar-case')).toHaveText(DECISION.title);
  await expect(page.locator('#reader .reader-title')).toHaveText(DECISION.title);
  await expect(page.locator('#sidebar')).toContainText("From CourtListener's bulk data");
  const url = new URL(page.url());
  expect(url.pathname).toBe(`/d/${DECISION.id}/`);
  expect(url.hash).toBe('');
  expect(await canonical(page)).toBe(`https://stare.pub/d/${DECISION.id}/`);
  await expect(page.locator('#prev-btn')).toBeDisabled();
});

test('an id typed in capitals or with misread letters moves to its canonical form', async ({ page }) => {
  await serveDecisionTable(page);
  await page.goto('/d/0LCM3O6/');
  await expect(page.locator('#topbar-case')).toHaveText(DECISION.title);
  expect(new URL(page.url()).pathname).toBe(`/d/${DECISION.id}/`);
});

test('another case leaves a decision address, and Back returns to it', async ({ page }) => {
  await serveDecisionTable(page);
  await page.goto(`/d/${DECISION.id}/`);
  await expect(page.locator('#topbar-case')).toHaveText(DECISION.title);
  await page.evaluate((hash) => { window.location.hash = hash; }, RENAIRE.hash);
  await expect(page.locator('#topbar-case')).toHaveText(RENAIRE.title);
  expect(new URL(page.url()).pathname + new URL(page.url()).hash).toBe(`/${RENAIRE.hash}`);
  await page.goBack();
  await expect(page.locator('#topbar-case')).toHaveText(DECISION.title);
  expect(new URL(page.url()).pathname).toBe(`/d/${DECISION.id}/`);
});

test('an id the table has no record for, or no id at all, says so', async ({ page }) => {
  await serveDecisionTable(page);
  await page.goto('/d/075000d/');
  await expect(page.locator('#landing-status')).toContainText('stare.pub has no record for the decision 075000d');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
  await page.goto('/d/01cm307/');
  await expect(page.locator('#landing-status')).toContainText("isn't a decision address");
});

test('a script or crawler asking for a decision address gets a 404', async ({ request }) => {
  const resp = await request.get(`/d/${DECISION.id}/`);
  expect(resp.status()).toBe(404);
  expect(resp.headers()['content-type']).not.toContain('text/html');
});

test('a decision with a CAP printing opens the CAP case, with its key as the canonical', async ({ page }) => {
  await serveDecisionTable(page);
  await page.goto(`/d/${LYON_ID}/`);
  await expect(page.locator('#topbar-case')).toHaveText(LYON.title);
  const url = new URL(page.url());
  expect(url.pathname).toBe(`/d/${LYON_ID}/`);
  expect(url.hash).toBe('');
  expect(await canonical(page)).toBe(`https://stare.pub/k/${LYON.key}/`);
});
