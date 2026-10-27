// Moving from one case to another while the first is still loading (#267), going back to
// the landing from a case found there (#282), and switching between the cases that start
// on one page (#268).
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

const LYON = { hash: '#a2d/31/647-01', title: "D'Elia & Marks Co. v. Lyon", files: /\/a2d\/31\.(?:idx\.gz|bin|multi)$/ };
const RENAIRE = { hash: '#a2d/142/148-01', title: 'Renaire Corp. v. Vaughn', files: /\/a2d\/142\.(?:idx\.gz|bin|multi)$/ };
const DONE = /^\d+ cited cases? found/;

// Holds the index requests `match` picks until release() is called.
async function holdIndex(page, match) {
  const held = [];
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  await page.route((url) => url.hostname === 'idx.stare.pub', async (route) => {
    if (!match(route.request().url())) return route.continue();
    held.push(route.request().url());
    await released;
    return route.continue();
  });
  return { held, release };
}

test('a case that finishes loading after the next one opened does not replace it', async ({ page }) => {
  // Lyon's own index file is held, so its lookup is still out when Renaire is opened.
  const lyon = await holdIndex(page, (url) => LYON.files.test(url));
  await page.goto(`/${LYON.hash}`);
  await expect.poll(() => lyon.held.length).toBeGreaterThan(0);

  await page.evaluate((hash) => { window.location.hash = hash; }, RENAIRE.hash);
  await expect(page.locator('#topbar-case')).toHaveText(RENAIRE.title);
  await expect(page.locator('#sidebar [role="status"]')).toHaveText(DONE);

  lyon.release();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#topbar-case')).toHaveText(RENAIRE.title);
  await expect(page.locator('#reader .reader-title')).toHaveText(RENAIRE.title);
  expect(new URL(page.url()).hash).toBe(RENAIRE.hash);
});

test('a citation pass that finishes after the next case opened leaves its cited cases working', async ({ page }) => {
  // Every index request Lyon's citation pass makes is held: those made while it's shown,
  // other than for the two cases themselves.
  let holding = false;
  const lyon = await holdIndex(page, (url) => holding && !/manifest\.json$/.test(url)
    && !LYON.files.test(url) && !RENAIRE.files.test(url));
  await page.goto(`/${LYON.hash}`);
  await expect(page.locator('#topbar-case')).toHaveText(LYON.title);
  holding = true;
  await expect.poll(() => lyon.held.length).toBeGreaterThan(0);
  holding = false;

  await page.evaluate((hash) => { window.location.hash = hash; }, RENAIRE.hash);
  await expect(page.locator('#topbar-case')).toHaveText(RENAIRE.title);
  const status = page.locator('#sidebar [role="status"]');
  await expect(status).toHaveText(DONE);
  const renaireStatus = await status.textContent();
  await expect(page.locator('#sidebar .cited-live')).toHaveCount(1);

  lyon.release();
  await page.waitForLoadState('networkidle');
  // Lyon's pass, had it gone on, would have taken Renaire's list navigation down with it.
  await expect(page.locator('#sidebar .cited-live')).toHaveCount(1);
  await expect(status).toHaveText(renaireStatus);
  expect(new URL(page.url()).hash).toBe(RENAIRE.hash);
  // Hovering a citation in the text still highlights its entry in the list.
  await page.locator('#reader [data-cite-group]').first().hover();
  await expect(page.locator('#sidebar .cited-entry-hover')).toHaveCount(1);
});

test('back from a case found on the landing leaves its status line empty', async ({ page }) => {
  await page.goto('/');
  await page.fill('#landing-input', '142 A.2d 148');
  await page.press('#landing-input', 'Enter');
  await expect(page.locator('#topbar-case')).toHaveText(RENAIRE.title);

  await page.goBack();
  await expect(page.locator('#landing')).toBeVisible();
  await expect(page.locator('#landing-status')).toHaveText('');
  await expect(page.locator('#landing-status')).not.toHaveClass(/\berror\b/);
});

test('switching to another case on the same page shows it without loading the page again', async ({ page }) => {
  await page.goto('/#us/455/989-01');
  const notice = page.locator('#reader .multi-notice');
  await expect(notice).toBeVisible();
  await page.waitForLoadState('networkidle');
  const first = await page.locator('#topbar-case').textContent();
  // A full reload of the case replaces the reader's text container; a switch keeps it.
  await page.locator('#reader .reader').evaluate((el) => { el.dataset.kept = 'yes'; });
  const statuses = [];
  await page.exposeFunction('__status', (s) => statuses.push(s));
  await page.evaluate(() => {
    new MutationObserver(() => window.__status(document.getElementById('status-bar').textContent))
      .observe(document.getElementById('status-bar'), { childList: true, characterData: true, subtree: true });
  });

  await notice.locator('.multi-link').first().click();
  await expect(page.locator('#topbar-case')).not.toHaveText(first);
  expect(new URL(page.url()).hash).toBe('#us/455/989-02');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#reader .reader')).toHaveAttribute('data-kept', 'yes');
  expect(statuses.filter(Boolean)).toEqual([]);
});
