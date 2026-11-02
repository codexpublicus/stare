// One box, one button (D163, #296): the landing's box, the top bar's and the search page's
// route their text themselves (web/public/js/boxroute.js). A citation opens in the reader,
// with "Search for this text instead"; anything else searches, and a search for text shaped
// like a citation asks "Did you mean ...?".
//
// The cases come from the live index, as in smoke.spec.js. The search tree is the fixture
// (web/tests/fixtures/README.md), served in place of the live build's own under whatever
// version the live manifest names, so the search page finds it the way it finds the real one.
import { test as base, expect } from '@playwright/test';

import { TREE_PATH, treeResponse } from '../tests/fixtures/searchtree.js';

const IDX = 'https://idx.stare.pub';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'Content-Range,Accept-Ranges,Content-Length,ETag',
};
const isWasmUrl = (url) => /^\/wasm\/stare_wasm_bg(\.[0-9a-f]{16})?\.wasm$/.test(new URL(url).pathname);

// Every test fails on a console error or warning, or an uncaught exception. `page.wasmRequests`
// counts the requests for the parser's WASM module.
const test = base.extend({
  page: async ({ page }, use) => {
    const problems = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') problems.push(`console.${msg.type()}: ${msg.text()}`);
    });
    page.on('pageerror', (err) => problems.push(`uncaught: ${err.message}`));
    page.wasmRequests = 0;
    page.on('request', (r) => { if (isWasmUrl(r.url())) page.wasmRequests += 1; });
    await page.route((url) => url.origin === IDX && /^\/v\/[^/]+\/search\//.test(url.pathname), (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: { ...CORS, 'access-control-allow-methods': 'GET, HEAD', 'access-control-allow-headers': 'range' } });
      }
      const rest = new URL(req.url()).pathname.replace(/^\/v\/[^/]+\/search\//, '');
      const r = treeResponse(`${TREE_PATH}/${rest}`, req.headers().range);
      return route.fulfill({ status: r.status, headers: { ...CORS, ...r.headers }, body: r.body });
    });
    await use(page);
    expect(problems, 'console errors or warnings').toEqual([]);
  },
});

const routeNote = (page) => page.locator('#reader .route-note');

test('the landing opens a citation, and the case offers to search for the text instead', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#landing-btn')).toHaveAccessibleName('Search');
  await page.fill('#landing-input', '31 A.2d 647');
  await expect(page.locator('#landing-btn')).toHaveAccessibleName('Open citation');
  await page.click('#landing-btn');
  await expect(page).toHaveURL(/#a2d\/31\/647-01$/);
  await expect(page.locator('#reader .reader-text p').first()).not.toBeEmpty();
  await expect(routeNote(page)).toHaveText('Opened “31 A.2d 647” as a citation. Search for this text instead');
  const link = routeNote(page).getByRole('link', { name: 'Search for this text instead' });
  await expect(link).toHaveAttribute('href', '/search/?q=31%20A.2d%20647');
  await link.click();
  await expect(page).toHaveURL(/\/search\/\?q=31%20A\.2d%20647$/);
  await expect(page.locator('#search-q')).toHaveValue('31 A.2d 647');
  await expect(page.locator('#search-status')).not.toHaveText(/^$|Loading|Searching/);
  await expect(page.locator('#search-cite')).toHaveText('Did you mean 31 A.2d 647?');
});

test('a search for a citation asks "Did you mean", and the parser loads only when that is clicked', async ({ page }) => {
  await page.goto('/search/?q=Brown+v.+Board+of+Education%2C+347+U.S.+483+%281954%29');
  const offer = page.locator('#search-cite');
  await expect(offer).toHaveText('Did you mean 347 U.S. 483?');
  await expect(page.locator('#search-status')).not.toHaveText(/^$|Loading|Searching/);
  expect(page.wasmRequests).toBe(0);
  await offer.getByRole('button', { name: 'Open 347 U.S. 483 in the reader' }).click();
  await expect(page).toHaveURL(/\/#us\/347\/483(-\d\d)?$/);
  await expect(page.locator('#topbar-case')).toHaveText(/Brown/);
  // the case was opened from the search's text, so it offers that search back
  await expect(routeNote(page)).toContainText('Opened “Brown v. Board of Education, 347 U.S. 483 (1954)” as a citation.');
});

test('the landing sends words to the search', async ({ page }) => {
  await page.goto('/');
  await page.fill('#landing-input', 'kale marauders');
  await expect(page.locator('#landing-btn')).toHaveAccessibleName('Search');
  await page.click('#landing-btn');
  await expect(page).toHaveURL(/\/search\/\?q=kale%20marauders$/);
  await expect(page.locator('#search-status')).toHaveText(/matches/);
  await expect(page.locator('#search-cite')).toBeHidden();
});

test('a citation the parser can\'t read goes to the search, which then doesn\'t ask "Did you mean"', async ({ page }) => {
  await page.goto('/');
  await page.fill('#landing-input', '12 Kale Marauders 34');
  await expect(page.locator('#landing-btn')).toHaveAccessibleName('Open citation');
  await page.click('#landing-btn');
  await expect(page).toHaveURL(/\/search\/\?q=12%20Kale%20Marauders%2034$/);
  await expect(page.locator('#search-status')).not.toHaveText(/^$|Loading|Searching/);
  await expect(page.locator('#search-cite')).toBeHidden();
});

test('the search page\'s box opens a citation, loading the parser only on submit', async ({ page }) => {
  await page.goto('/search/?q=kale+marauders');
  await expect(page.locator('#search-status')).toHaveText(/matches/);
  await expect(page.locator('#search-btn')).toHaveAccessibleName('Search');
  await page.fill('#search-q', '31 A.2d 662');
  await expect(page.locator('#search-btn')).toHaveAccessibleName('Open citation');
  expect(page.wasmRequests).toBe(0);
  await page.press('#search-q', 'Enter');
  await expect(page).toHaveURL(/\/#a2d\/31\/662(-01)?$/);
  await expect(page.locator('#reader .reader-text p').first()).not.toBeEmpty();
  await expect(routeNote(page)).toContainText('Opened “31 A.2d 662” as a citation.');
});

test('the search page\'s box searches words, and Apply searches whatever the box holds', async ({ page }) => {
  await page.goto('/search/');
  await page.fill('#search-q', 'palsgraf');
  await expect(page.locator('#search-btn')).toHaveAccessibleName('Search');
  await page.press('#search-q', 'Enter');
  await expect(page).toHaveURL(/\/search\/\?q=palsgraf$/);
  await expect(page.locator('#search-status')).toHaveText('22 matches, page 1 of 2');
  await page.fill('#search-q', '31 A.2d 647');
  await page.locator('#search-filters summary').click();
  await page.click('.search-apply');
  await expect(page).toHaveURL(/\/search\/\?q=31\+A\.2d\+647$/);
  await expect(page.locator('#search-cite')).toHaveText('Did you mean 31 A.2d 647?');
  expect(page.wasmRequests).toBe(0);
});

test('the top bar\'s box routes like the landing\'s, with its own button', async ({ page }) => {
  await page.goto('/#a2d/31/647-01');
  await expect(page.locator('#topbar-case')).not.toBeEmpty();
  await expect(routeNote(page)).toHaveCount(0); // a link, not typed text
  await expect(page.locator('#topbar-go')).toBeHidden();
  await page.click('#topbar-cite');
  await expect(page.locator('#topbar-go')).toBeVisible();
  await expect(page.locator('#topbar-go')).toHaveAccessibleName('Open citation');
  await page.fill('#topbar-cite-input', '31 A.2d 693');
  await page.click('#topbar-go');
  await expect(page).toHaveURL(/#a2d\/31\/693-01$/);
  await expect(page.locator('#topbar-go')).toBeHidden();
  await expect(routeNote(page)).toContainText('Opened “31 A.2d 693” as a citation.');
  await page.click('#topbar-cite');
  await page.fill('#topbar-cite-input', 'kale marauders');
  await expect(page.locator('#topbar-go')).toHaveAccessibleName('Search');
  await page.press('#topbar-cite-input', 'Enter');
  await expect(page).toHaveURL(/\/search\/\?q=kale%20marauders$/);
});

test('the changed route is announced once typing pauses, not on each keystroke', async ({ page }) => {
  await page.goto('/');
  const live = page.locator('#landing-route-status');
  await expect(live).toHaveAttribute('aria-live', 'polite');
  await page.evaluate(() => {
    window.__said = [];
    const el = document.getElementById('landing-route-status');
    new MutationObserver(() => { if (el.textContent) window.__said.push(el.textContent); })
      .observe(el, { childList: true, characterData: true, subtree: true });
  });
  await page.locator('#landing-input').pressSequentially('347 U.S. 483', { delay: 60 });
  await expect(live).toHaveText('Enter opens the citation');
  await page.locator('#landing-input').pressSequentially(' and more', { delay: 60 });
  await page.keyboard.press('Control+A');
  await page.locator('#landing-input').pressSequentially('kale', { delay: 60 });
  await expect(live).toHaveText('Enter searches');
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => window.__said)).toEqual(['Enter opens the citation', 'Enter searches']);
});

for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['laptop', { width: 1366, height: 768 }]]) {
  test(`the button's label changing moves nothing (${name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      window.__cls = 0;
      window.__shifts = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__shifts += e.value;
          if (!e.hadRecentInput) window.__cls += e.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });
    const box = (sel) => page.locator(sel).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height].map(Math.round);
    });
    await page.goto('/');
    const before = { btn: await box('#landing-btn'), input: await box('#landing-input') };
    await page.fill('#landing-input', '31 A.2d 647');
    await expect(page.locator('#landing-btn')).toHaveAccessibleName('Open citation');
    expect({ btn: await box('#landing-btn'), input: await box('#landing-input') }).toEqual(before);
    await page.fill('#landing-input', 'kale marauders');
    await expect(page.locator('#landing-btn')).toHaveAccessibleName('Search');
    expect({ btn: await box('#landing-btn'), input: await box('#landing-input') }).toEqual(before);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__shifts)).toBeLessThan(0.05);

    await page.goto('/search/?q=kale+marauders');
    await expect(page.locator('#search-status')).toHaveText(/matches/);
    const sBefore = { btn: await box('#search-btn'), input: await box('#search-q') };
    await page.fill('#search-q', '31 A.2d 647');
    await expect(page.locator('#search-btn')).toHaveAccessibleName('Open citation');
    expect({ btn: await box('#search-btn'), input: await box('#search-q') }).toEqual(sBefore);
    await page.waitForTimeout(300);
    // a label changing shifts nothing at all, typing or not
    expect(await page.evaluate(() => window.__shifts)).toBeLessThan(0.05);
    expect(await page.evaluate(() => window.__cls)).toBeLessThan(0.05);
  });
}
