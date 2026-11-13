// A fetch that fails says so where it failed, plainly, and leaves the rest of the page
// working: the Raw Scans' text layer (#254).
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
