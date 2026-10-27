// The case zips' IndexedDB cache (#269, web/public/js/cache.js): a full quota or an
// IndexedDB that doesn't answer still opens the case, from the network, and a case opened
// again comes from the cache.
import { test as base, expect } from '@playwright/test';

// Like smoke.spec.js, every test fails on a console error or warning or an uncaught
// exception.
const test = base.extend({
  page: async ({ page }, use) => {
    const problems = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') problems.push(`console.${msg.type()}: ${msg.text()}`);
    });
    page.on('pageerror', (err) => problems.push(`uncaught: ${err.message}`));
    await use(page);
    expect(problems, 'console errors or warnings').toEqual([]);
  },
});

const CASE = '/#a2d/142/148-01';
const TITLE = 'Renaire Corp. v. Vaughn';
const ZIP = '/cap/a2d/142.zip';
const isZip = (req) => req.url().startsWith('https://data.stare.pub/') && new URL(req.url()).pathname === ZIP;

test('a case opens when the browser\'s storage quota is too small for its zip', async ({ page, baseURL }) => {
  // Chromium's own quota for the site, far below the zip's size: the write is refused
  // with a QuotaExceededError when its transaction commits.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Storage.overrideQuotaForOrigin', { origin: new URL(baseURL).origin, quotaSize: 64 * 1024 });
  await page.goto(CASE);
  await expect(page.locator('#topbar-case')).toHaveText(TITLE);
  await expect(page.locator('#reader .reader-text p').first()).not.toBeEmpty();
  await expect(page.locator('#status-bar')).toBeHidden();
});

test('a case opens when IndexedDB never answers', async ({ page }) => {
  // An open request that never fires an event, as a blocked upgrade or a browser that
  // refuses storage without saying so leaves it.
  await page.addInitScript(() => {
    IDBFactory.prototype.open = function open() { return {}; };
  });
  await page.goto(CASE);
  await expect(page.locator('#topbar-case')).toHaveText(TITLE);
  await expect(page.locator('#reader .reader-text p').first()).not.toBeEmpty();
});

test('a case opened again comes from the cache, with one HEAD to check the zip is current', async ({ page }) => {
  await page.goto(CASE);
  await expect(page.locator('#topbar-case')).toHaveText(TITLE);
  await page.waitForLoadState('networkidle');

  const requests = [];
  page.on('request', (req) => { if (isZip(req)) requests.push(req.method()); });
  await page.reload();
  await expect(page.locator('#topbar-case')).toHaveText(TITLE);
  // The HEAD goes out once the cached zip has been read, in the background.
  await expect.poll(() => requests).toEqual(['HEAD']);
  await page.waitForLoadState('networkidle');
  expect(requests).toEqual(['HEAD']);
});
