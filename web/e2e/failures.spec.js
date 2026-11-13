// A fetch that fails says so where it failed, plainly, and leaves the rest of the page
// working: the Raw Scans' text layer (#254), and the rest #271 lists: the manifest, the
// typeahead's reporter list, a page view, the page markers and a hover preview. Each is
// made to fail, then to work, and the test checks the message and that a retry works.
import { test as base, expect } from '@playwright/test';

// Console errors and warnings fail a test, except the ones a test expects: the browser's own
// line for a request the test made fail, and the warnings the page logs for it.
const test = base.extend({
  expected: async ({}, use) => use([]),
  page: async ({ page, expected }, use) => {
    const problems = [];
    page.on('console', (msg) => {
      if (msg.type() !== 'error' && msg.type() !== 'warning') return;
      const text = msg.text();
      if (/^Failed to load resource/.test(text) || expected.some((re) => re.test(text))) return;
      problems.push(`console.${msg.type()}: ${text}`);
    });
    page.on('pageerror', (err) => problems.push(`uncaught: ${err.message}`));
    await use(page);
    expect(problems, 'console errors or warnings').toEqual([]);
  },
});

const CASE = '/#a2d/142/148-01';
const TITLE = 'Renaire Corp. v. Vaughn';

// Make the volume tar's ALTO ranges fail `times` times (a dropped connection), then answer.
// The ALTO entries' offsets come from the tar's .tar.csv as the page reads it.
async function failAlto(page, times) {
  const alto = new Set();
  let failed = 0;
  await page.route(/\.tar\.csv$/, async (route) => {
    const res = await route.fetch();
    const text = await res.text();
    for (const line of text.split('\n')) {
      const [path, offset] = line.split(',');
      if (path?.includes('/alto/')) alto.add(Number(offset));
    }
    await route.fulfill({ response: res, body: text });
  });
  await page.route(/\.tar$/, async (route) => {
    const m = /^bytes=(\d+)-/.exec(route.request().headers().range || '');
    if (m && alto.has(Number(m[1])) && failed < times) {
      failed += 1;
      return route.abort('connectionreset');
    }
    return route.continue();
  });
  return () => failed;
}

async function openScans(page) {
  await page.goto(CASE);
  await expect(page.locator('#topbar-case')).toHaveText(TITLE);
  await page.locator('#tab-pages').click();
  await expect(page.locator('#page-viewer .page-wrapper')).toHaveAttribute('data-rendered', /\d+/, { timeout: 30_000 });
}

test('a dropped ALTO range is tried again, and the text layer shows', async ({ page }) => {
  const failed = await failAlto(page, 1);
  await openScans(page);
  await expect(page.locator('#page-viewer .alto-overlay .alto-line').first()).toBeAttached();
  await expect(page.locator('#pv-notice')).toBeEmpty();
  expect(failed()).toBe(1);
});

test.describe('an ALTO that still fails', () => {
  test.use({ expected: [/Raw Scans: the ALTO for page/] });

  test('says the text layer couldn\'t be loaded, keeps the scan, and Retry puts the text in', async ({ page }) => {
    // The first load and its two retries.
    const failed = await failAlto(page, 3);
    await openScans(page);
    const notice = page.locator('#pv-notice');
    await expect(notice).toContainText('text layer couldn\'t be loaded');
    await expect(notice).toHaveAttribute('role', 'status');
    expect(failed()).toBe(3);
    // The scan is shown and the view still works.
    await expect(page.locator('#page-viewer .page-viewer-img')).toBeVisible();
    await expect(page.locator('#page-viewer .alto-overlay')).toHaveCount(0);
    // Over the page: showing the notice moved nothing.
    const box = await page.locator('#page-viewer .page-wrapper').boundingBox();
    const area = await page.locator('#pv-area').boundingBox();
    await notice.getByRole('button', { name: 'Retry' }).click();
    await expect(page.locator('#page-viewer .alto-overlay .alto-line').first()).toBeAttached();
    await expect(notice).toBeEmpty();
    expect(await page.locator('#page-viewer .page-wrapper').boundingBox()).toEqual(box);
    expect(await page.locator('#pv-area').boundingBox()).toEqual(area);
  });

  test('the notice can be dismissed', async ({ page }) => {
    await failAlto(page, 3);
    await openScans(page);
    const notice = page.locator('#pv-notice');
    await expect(notice).not.toBeEmpty();
    await notice.getByRole('button', { name: 'Dismiss' }).click();
    await expect(notice).toBeEmpty();
    await expect(page.locator('#page-viewer .page-viewer-img')).toBeVisible();
  });
});

const ZIP_URL = 'https://data.stare.pub/cap/a2d/142.zip';

test.describe('the rest of the reader (#271)', () => {
  test.use({
    expected: [
      /Showing the case|Reading the page numbers|failed:|could not load|couldn't be fetched/,
    ],
  });

  test('a manifest that failed once is fetched again by the next lookup', async ({ page }) => {
    let requests = 0;
    await page.route((url) => url.hostname === 'idx.stare.pub' && url.pathname === '/manifest.json', (route) => {
      if (requests++ === 0) return route.abort('connectionreset');
      return route.continue();
    });
    await page.goto(CASE);
    // Kept as unreachable for the session, the first failure was the only request.
    await expect.poll(() => requests).toBeGreaterThan(1);
    await page.goto('/#a2d/142/150-01');
    await page.goto(CASE);
    await expect(page.locator('#topbar-case')).toHaveText(TITLE);
  });

  test('the typeahead says when its reporter list couldn\'t load, and tries again', async ({ page }) => {
    let fail = true;
    await page.route('**/reporters.json', (route) => (fail ? route.fulfill({ status: 503, body: '' }) : route.continue()));
    await page.goto('/');
    const input = page.locator('#landing-input');
    await input.click();
    await input.pressSequentially('A.2');
    const list = page.locator('#landing-suggest');
    await expect(list).toContainText('Suggestions aren\'t available right now');
    await expect(list).toContainText('A full citation still opens');
    fail = false;
    await input.pressSequentially('d');
    await expect(list).not.toContainText('aren\'t available');
    await expect(list.locator('[role="option"]').first()).toBeVisible();
  });

  test('a page view that can\'t fetch the zip says so in the view, with a Retry', async ({ page }) => {
    let fail = true;
    await page.route(ZIP_URL, (route) => {
      if (fail && route.request().method() === 'GET' && !route.request().headers().range) return route.abort('connectionreset');
      return route.continue();
    });
    await page.goto(CASE);
    await expect(page.locator('#topbar-case')).toHaveText(TITLE);
    await page.locator('#tab-pages').click();
    const view = page.locator('#page-viewer');
    await expect(view).toContainText('couldn\'t open this case\'s pages');
    await expect(view).toContainText('The Reader still works');
    fail = false;
    await view.getByRole('button', { name: 'Retry' }).click();
    await expect(page.locator('#page-viewer .page-wrapper')).toHaveAttribute('data-rendered', /\d+/, { timeout: 30_000 });
    // The Reader was never touched.
    await page.locator('#tab-reader').click();
    await expect(page.locator('#reader .reader-text p').first()).not.toBeEmpty();
  });

  test('page markers that can\'t be read are said over the reader, without moving it, and Retry reads them', async ({ page }) => {
    // The span's request answers; the zip's directory and HTML, read by range after it, fail.
    let spans = 0;
    let fail = true;
    await page.route(ZIP_URL, (route) => {
      const range = route.request().headers().range;
      if (route.request().method() !== 'GET' || !range) return route.continue();
      if (spans++ === 0 || !fail) return route.continue();
      return route.abort('connectionreset');
    });
    await page.goto(CASE);
    await expect(page.locator('#topbar-case')).toHaveText(TITLE);
    const notice = page.locator('#case-notice');
    await expect(notice).toContainText('page numbers and footnotes couldn\'t be loaded');
    await expect(notice).toContainText('The text is complete');
    await expect(page.locator('#reader .page-marker')).toHaveCount(0);
    const scroller = await page.locator('.main-content').boundingBox();
    fail = false;
    await notice.getByRole('button', { name: 'Retry' }).click();
    await expect(page.locator('#reader .page-marker').first()).toBeAttached();
    await expect(notice).toBeEmpty();
    expect(await page.locator('.main-content').boundingBox()).toEqual(scroller);
  });

  test('a hover preview that failed is tried again on the next hover', async ({ page }) => {
    let fail = true;
    await page.route(/^https:\/\/data\.stare\.pub\/cap\/va\/164\.zip$/, (route) => (fail ? route.abort('connectionreset') : route.continue()));
    await page.goto(CASE);
    const link = page.locator('#reader a.cite-link[href^="#va/164/"]').first();
    await expect(link).toBeVisible();
    await link.hover();
    const tip = page.locator('.cite-tooltip');
    await expect(tip).toContainText('Couldn\'t load the preview');
    await page.mouse.move(0, 0);
    fail = false;
    await link.hover();
    await expect(tip).toContainText('Universal Credit Co. v. Taylor');
  });
});
