// A script that doesn't load (#265): a content blocker refusing it, as uBlock Origin did
// js/pageview.js in v2026.10.26.5, or a 404 mid-deploy. The page views and the typeahead
// are imported when first wanted, so blocking one costs that feature and its view says
// so; blocking a module main.js imports statically stops the reader, and the boot guard
// in <head> (src/lib/bootguard.js) says so instead of leaving "Loading..." up.
import { test as base, expect } from '@playwright/test';

// Like smoke.spec.js, every test fails on a console error or warning or an uncaught
// exception, except the browser's failed-load message for a URL the test blocks and
// `allowedConsole`, the messages the site logs for it.
const test = base.extend({
  blocked: [[], { option: true }],
  allowedConsole: [[], { option: true }],
  page: async ({ page, blocked, allowedConsole }, use) => {
    const problems = [];
    page.on('console', (msg) => {
      if (msg.type() !== 'error' && msg.type() !== 'warning') return;
      const url = msg.location().url || '';
      const blockedLoad = blocked.some((p) => url.endsWith(p)) && /^Failed to load resource: net::ERR_BLOCKED_BY_CLIENT/.test(msg.text());
      if (!blockedLoad && !allowedConsole.some((re) => re.test(msg.text()))) {
        problems.push(`console.${msg.type()}: ${msg.text()}`);
      }
    });
    page.on('pageerror', (err) => problems.push(`uncaught: ${err.message}`));
    // What a content blocker does: the request fails with ERR_BLOCKED_BY_CLIENT.
    for (const path of blocked) {
      await page.route((url) => url.pathname === path, (route) => route.abort('blockedbyclient'));
    }
    await use(page);
    expect(problems, 'console errors or warnings').toEqual([]);
  },
});

const READER_TEXT = '#reader .reader-text p';

test.describe('a page view whose script is blocked', () => {
  test.use({
    blocked: ['/js/pdfviewer.js', '/js/scanviewer.js'],
    allowedConsole: [/^The (Archival PDF|Raw Scans) view could not load:/],
  });

  test('the Reader works, and each view says it couldn\'t load', async ({ page }) => {
    await page.goto('/#a2d/142/148-01');
    await expect(page.locator('#reader .reader-title')).toHaveText('Renaire Corp. v. Vaughn');
    await expect(page.locator(READER_TEXT).first()).not.toBeEmpty();
    await expect(page.locator('#sidebar [role="status"]')).toHaveText(/cited cases? found/);

    await page.click('#tab-pdf');
    const pdf = page.locator('#pdf-viewer [data-view-failed="pdf"]');
    await expect(pdf).toBeVisible();
    await expect(pdf).toContainText('The Archival PDF view couldn’t load');
    await expect(pdf).toContainText('content blocker');
    await expect(pdf.locator('a')).toHaveText('reload the page');

    await page.click('#tab-pages');
    await expect(page.locator('#page-viewer [data-view-failed="scans"]')).toContainText('The Raw Scans view couldn’t load');

    await page.click('#tab-reader');
    await expect(page.locator('#reader')).toBeVisible();
    await expect(page.locator(READER_TEXT).first()).not.toBeEmpty();
    await expect(page).toHaveURL(/#a2d\/142\/148-01$/);
  });

  test('a link to the view opens the case, and the view says it couldn\'t load', async ({ page }) => {
    await page.goto('/#a2d/142/148-01~v=pdf&p=2');
    await expect(page.locator('#pdf-viewer [data-view-failed="pdf"]')).toBeVisible();
    await expect(page.locator('#topbar-case')).toHaveText('Renaire Corp. v. Vaughn');
    await page.click('#tab-reader');
    await expect(page.locator(READER_TEXT).first()).not.toBeEmpty();
  });
});

test.describe('the typeahead blocked', () => {
  test.use({
    blocked: ['/js/searchbox.js'],
    allowedConsole: [/^The search suggestions could not load/],
  });

  test('the landing\'s box and the top bar\'s editor still open citations', async ({ page }) => {
    await page.goto('/');
    await page.fill('#landing-input', '31 A.2d 647');
    await expect(page.locator('#landing-suggest')).toBeHidden();
    await page.press('#landing-input', 'Enter');
    await expect(page.locator('#reader .reader-title')).toHaveText("D'Elia & Marks Co. v. Lyon");

    await page.click('#topbar-cite');
    await expect(page.locator('#topbar-cite-input')).toHaveValue('31 A.2d 647');
    await page.fill('#topbar-cite-input', '142 A.2d 148');
    await page.press('#topbar-cite-input', 'Enter');
    await expect(page.locator('#reader .reader-title')).toHaveText('Renaire Corp. v. Vaughn');
  });
});

// With nothing blocked the typeahead loads on focus, and Escape closes its list before the
// top bar's editor: its key handling must still come first, though it attaches later.
test('the typeahead loads on focus, and takes Escape first in the top bar', async ({ page }) => {
  const loads = [];
  page.on('request', (r) => { if (r.url().endsWith('/js/searchbox.js')) loads.push(r.url()); });
  await page.goto('/#a2d/31/647-01');
  await expect(page.locator('#reader .reader-title')).toHaveText("D'Elia & Marks Co. v. Lyon");
  expect(loads).toEqual([]);
  await page.click('#topbar-cite');
  await page.fill('#topbar-cite-input', 'A.2d');
  await expect(page.locator('#topbar-suggest')).toBeVisible();
  expect(loads).toHaveLength(1);
  await page.press('#topbar-cite-input', 'Escape');
  await expect(page.locator('#topbar-suggest')).toBeHidden();
  await expect(page.locator('#topbar-cite-input')).toBeVisible();
  await page.press('#topbar-cite-input', 'Escape');
  await expect(page.locator('#topbar-cite-input')).toBeHidden();
});

test.describe('a module main.js imports statically, blocked', () => {
  test.use({ blocked: ['/js/resolve.js'] });

  test('a case link says the reader didn\'t start, within 3 seconds', async ({ page }) => {
    await page.goto('/#a2d/31/647-01');
    const msg = page.locator('#status-bar [data-boot-guard="error"]');
    await expect(msg).toBeVisible({ timeout: 3_000 });
    await expect(msg).toContainText('The reader didn’t start');
    await expect(msg).toContainText('content blocker');
    await expect(page.locator('#status-bar')).toHaveClass(/error/);
    // The message replaces "Loading...", the stylesheet's text for an empty status line.
    expect(await page.locator('#status-bar').evaluate((el) => getComputedStyle(el, '::before').content)).toBe('none');
    await expect(msg.locator('a')).toHaveText('reload the page');
  });

  test('the landing says so under its box', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#landing-status [data-boot-guard="error"]')).toContainText('The reader didn’t start', { timeout: 3_000 });
  });
});

test.describe('the checker\'s module blocked', () => {
  test.use({ blocked: ['/js/citenav.js'] });

  test('/check says the checker didn\'t start', async ({ page }) => {
    await page.goto('/check');
    await expect(page.locator('#check-status [data-boot-guard="error"]')).toContainText('The citation checker didn’t start', { timeout: 3_000 });
  });
});

// A module that never answers: no error event, so the guard's timer says it.
test('a module that hangs gets the slow message after 10 seconds, and a late start takes it down', async ({ page }) => {
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route((url) => url.pathname === '/js/ui.js', async (route) => {
    await held;
    await route.continue();
  });
  await page.clock.install();
  // The held module keeps the page from finishing loading.
  await page.goto('/#a2d/31/647-01', { waitUntil: 'commit' });
  await expect(page.locator('#status-bar')).toBeVisible();
  await expect(page.locator('#status-bar [data-boot-guard]')).toHaveCount(0);
  await page.clock.fastForward(10_500);
  const msg = page.locator('#status-bar [data-boot-guard="timeout"]');
  await expect(msg).toContainText('The reader hasn’t started after 10 seconds');
  release();
  await expect(msg).toHaveCount(0);
  await expect(page.locator('#reader .reader-title')).toHaveText("D'Elia & Marks Co. v. Lyon");
});
