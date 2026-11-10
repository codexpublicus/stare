// Opening a CAP case by its index line's zip span (D180, #313): one Range request for the
// case's JSON before its text shows, the page markers read by range after it, the PDF
// link's page read when the link is about to be used, the page views fetching the zip as
// before, and the fallbacks: a line with no span, a server that answers the range with
// the whole zip, and one that answers it with other bytes. The live index carries spans
// since v2026.11.05.3; the fallbacks rewrite what it and data.stare.pub send.
import { gunzipSync, gzipSync } from 'node:zlib';

import { test as base, expect } from '@playwright/test';

const test = base.extend({
  page: async ({ page }, use) => {
    const problems = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') problems.push(`console.${msg.type()}: ${msg.text()}`);
    });
    page.on('pageerror', (err) => problems.push(`uncaught: ${err.message}`));
    // Every request for the case's zip, in order, with its Range and, once answered, status.
    const zip = [];
    page.on('request', (r) => {
      if (r.url() === ZIP_URL) zip.push({ method: r.method(), range: r.headers().range ?? null, request: r });
    });
    page.on('response', (r) => {
      const z = zip.find((x) => x.request === r.request());
      if (z) z.status = r.status();
    });
    page.zipRequests = () => zip.map(({ method, range, status }) => ({ method, range, status }));
    await use(page);
    expect(problems, 'console errors or warnings').toEqual([]);
  },
});

const CASE = '/#a2d/142/148-01';
const TITLE = 'Renaire Corp. v. Vaughn';
const ZIP_URL = 'https://data.stare.pub/cap/a2d/142.zip';
const READER_TEXT = '#reader .reader-text p';
const EXPLICIT = /^bytes=\d+-\d+$/;

// The volume's index files with their spans taken out, as a build from before D180 has them.
async function stripSpans(page) {
  await page.route((url) => url.hostname === 'idx.stare.pub' && /\/a2d\/142(\.\d+)?\.idx\.gz$/.test(url.pathname), async (route) => {
    const res = await route.fetch();
    const text = gunzipSync(await res.body()).toString('utf8').replace(/,zip=\d+:\d+:\d+/g, '');
    await route.fulfill({ response: res, body: gzipSync(Buffer.from(text)) });
  });
}

test('a case whose line has a span opens with one Range request for its JSON', async ({ page }) => {
  await page.goto(CASE);
  await expect(page.locator('#topbar-case')).toHaveText(TITLE);
  await expect(page.locator(READER_TEXT).first()).not.toBeEmpty();
  // By the time the text shows, the only request for the zip is the span's.
  const atText = page.zipRequests();
  expect(atText.length).toBe(1);
  expect(atText[0]).toMatchObject({ method: 'GET', status: 206 });
  expect(atText[0].range).toMatch(EXPLICIT);

  // Then the case's page markers, by range: the zip's directory and the HTML's entry.
  await expect(page.locator('#reader .page-marker').first()).toBeAttached();
  await page.waitForLoadState('networkidle');
  for (const r of page.zipRequests()) {
    expect(r.method).toBe('GET');
    expect(r.range).toMatch(EXPLICIT);
    expect(r.status).toBe(206);
  }
  expect(page.zipRequests().length).toBeLessThanOrEqual(4);
});

test('opened again, the case and its page markers come from the cache, with no request', async ({ page }) => {
  await page.goto(CASE);
  await expect(page.locator('#reader .page-marker').first()).toBeAttached();
  await page.waitForLoadState('networkidle');
  const before = page.zipRequests().length;
  await page.reload();
  await expect(page.locator('#topbar-case')).toHaveText(TITLE);
  await expect(page.locator('#reader .page-marker').first()).toBeAttached();
  await page.waitForLoadState('networkidle');
  expect(page.zipRequests().slice(before)).toEqual([]);
});

test('a pin cite goes to its page once the markers are in', async ({ page }) => {
  await page.goto('/#a2d/142/148-01@150');
  await expect(page.locator('#reader .page-marker.page-target')).toBeVisible();
});

test('the previous and next cases come from the index, without the zip', async ({ page }) => {
  await page.goto(CASE);
  await expect(page.locator('#topbar-case')).toHaveText(TITLE);
  await expect(page.locator('#prev-btn')).toBeEnabled();
  await page.locator('#next-btn').click();
  await expect(page.locator('#topbar-case')).not.toHaveText(TITLE);
  await expect(page.locator(READER_TEXT).first()).not.toBeEmpty();
  expect(page.zipRequests().filter((r) => !r.range)).toEqual([]);
});

test('the PDF link opens at the case\'s page once a pointer is over it', async ({ page }) => {
  await page.goto(CASE);
  await expect(page.locator('#topbar-case')).toHaveText(TITLE);
  const link = page.locator('#pdf-link');
  await expect(link).not.toHaveAttribute('href', /#page=/);
  await link.hover();
  await expect(link).toHaveAttribute('href', /#page=\d+$/);
  expect(page.zipRequests().filter((r) => !r.range)).toEqual([]);
});

test('a page view fetches the zip, as before', async ({ page }) => {
  await page.goto(CASE);
  await expect(page.locator('#topbar-case')).toHaveText(TITLE);
  await page.locator('#tab-pages').click();
  await expect(page.locator('#page-viewer .page-wrapper')).toHaveAttribute('data-rendered', /\d+/, { timeout: 30_000 });
  expect(page.zipRequests().some((r) => r.method === 'GET' && !r.range)).toBe(true);
});

test('without a span the case comes from the whole zip, as before', async ({ page }) => {
  await stripSpans(page);
  await page.goto(CASE);
  await expect(page.locator('#topbar-case')).toHaveText(TITLE);
  await expect(page.locator(READER_TEXT).first()).not.toBeEmpty();
  await expect(page.locator('#reader .page-marker').first()).toBeAttached();
  expect(page.zipRequests().filter((r) => r.method === 'GET')).toEqual([{ method: 'GET', range: null, status: 200 }]);
});

test('a server that ignores the Range sends the zip, which the case is read out of', async ({ page }) => {
  await page.route(ZIP_URL, async (route) => {
    const req = route.request();
    if (req.method() !== 'GET' || !req.headers().range) return route.continue();
    const headers = { ...req.headers() };
    delete headers.range;
    const res = await route.fetch({ headers });
    return route.fulfill({ response: res, status: 200 });
  });
  await page.goto(CASE);
  await expect(page.locator('#topbar-case')).toHaveText(TITLE);
  await expect(page.locator(READER_TEXT).first()).not.toBeEmpty();
  await expect(page.locator('#reader .page-marker').first()).toBeAttached();
  const gets = page.zipRequests().filter((r) => r.method === 'GET');
  expect(gets.length).toBe(1);
  expect(gets[0].status).toBe(200);
});

test('a span answered with other bytes falls back to the whole zip', async ({ page }) => {
  await page.route(ZIP_URL, async (route) => {
    const req = route.request();
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers().range || '');
    if (req.method() !== 'GET' || !m) return route.continue();
    const res = await route.fetch();
    const size = (res.headers()['content-range'] || '').split('/')[1];
    return route.fulfill({
      response: res,
      headers: { ...res.headers(), 'content-range': `bytes ${Number(m[1]) + 1}-${Number(m[2]) + 1}/${size}` },
    });
  });
  await page.goto(CASE);
  await expect(page.locator('#topbar-case')).toHaveText(TITLE);
  await expect(page.locator(READER_TEXT).first()).not.toBeEmpty();
  const gets = page.zipRequests().filter((r) => r.method === 'GET');
  expect(gets.map((r) => r.range === null)).toEqual([false, true]);
});
