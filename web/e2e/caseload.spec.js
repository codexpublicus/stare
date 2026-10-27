// Opening a case (#260, #262): the reader doesn't move while a case loads, and the
// case's index file and zip are fetched while the WASM is still on its way.
import { test as base, expect } from '@playwright/test';

// Like smoke.spec.js, every test fails on a console error or warning (an unused or
// mismatched preload is a warning) or an uncaught exception.
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
const READER_TEXT = '#reader .reader-text p';
// The built loader asks for the module by its content-hashed name (src/lib/assetcache.js).
const isWasmUrl = (url) => /^\/wasm\/stare_wasm_bg(\.[0-9a-f]{16})?\.wasm$/.test(new URL(url).pathname);

const SIZES = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  laptop: { viewport: { width: 1366, height: 768 } },
  large: { viewport: { width: 2560, height: 1440 } },
};

// Holds every request for the WASM until release() is called; `held()` says whether it
// still is.
async function holdWasm(page) {
  let release;
  let holding = true;
  const released = new Promise((resolve) => { release = resolve; });
  await page.route((url) => isWasmUrl(url), async (route) => {
    await released;
    await route.continue();
  });
  return {
    release: () => { holding = false; release(); },
    held: () => holding,
  };
}

// Sums the page's layout shifts from the first frame, leaving out those right after
// input, as CLS does; `window.__shifts` lists them for the failure message.
async function watchShifts(page) {
  await page.addInitScript(() => {
    window.__cls = 0;
    window.__shifts = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        window.__cls += e.value;
        window.__shifts.push({
          at: Math.round(e.startTime),
          value: e.value,
          moved: e.sources.map((s) => s.node?.id || s.node?.className || s.node?.nodeName || '?'),
        });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
}

for (const [size, use] of Object.entries(SIZES)) {
  test.describe(`at ${size} size`, () => {
    test.use(use);

    test('opening a case moves nothing: its layout shifts add up to under 0.05', async ({ page }) => {
      await watchShifts(page);
      // Held for a moment, so the loading line and the WASM bar both show, as on a
      // slow connection.
      const wasm = await holdWasm(page);
      await page.goto(CASE);
      await expect(page.getByRole('progressbar', { name: /^Loading the citation parser/ })).toBeVisible();
      wasm.release();

      await expect(page.locator('#topbar-case')).toHaveText(TITLE);
      await expect(page.locator(READER_TEXT).first()).not.toBeEmpty();
      await expect(page.locator('#status-bar')).toBeHidden();
      // The cited-cases list replaces "Finding citations..." last.
      await expect(page.locator('#sidebar [role="status"]')).toHaveText(/cited cases? found/);
      await page.waitForTimeout(500);

      const { cls, shifts } = await page.evaluate(() => ({ cls: window.__cls, shifts: window.__shifts }));
      expect(cls, JSON.stringify(shifts)).toBeLessThan(0.05);
      // The case view is the window, so nothing scrolls the page itself.
      const overflow = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
}

test('a case link fetches its index file and zip before the WASM arrives', async ({ page }) => {
  const wasm = await holdWasm(page);
  const idx = page.waitForRequest((req) => /\/a2d\/142\.idx\.gz$/.test(new URL(req.url()).pathname));
  const zip = page.waitForRequest((req) => new URL(req.url()).pathname === '/cap/a2d/142.zip');
  await page.goto(CASE);

  await idx;
  await zip;
  expect(wasm.held()).toBe(true);
  wasm.release();
  await expect(page.locator('#topbar-case')).toHaveText(TITLE);
  await expect(page.locator(READER_TEXT).first()).not.toBeEmpty();
});

test('a case link preloads the WASM files the loader asks for, and fetches each once', async ({ page, request }) => {
  const loader = await (await request.get('/js/wasm.js')).text();
  const glue = loader.match(/const GLUE_URL = '([^']+)'/)?.[1];
  const module = loader.match(/const WASM_URL = '([^']+)'/)?.[1];
  const { data } = await (await request.get('/wasm/stare_wasm_bg.json')).json();
  expect(module).toMatch(/^\/wasm\/stare_wasm_bg\.[0-9a-f]{16}\.wasm$/);

  const requested = [];
  page.on('request', (req) => requested.push(new URL(req.url()).pathname));
  await page.goto(CASE);
  await expect(page.locator('#topbar-case')).toHaveText(TITLE);

  const links = await page.evaluate(() => [...document.head.querySelectorAll('link[rel="preload"], link[rel="modulepreload"]')]
    .map((l) => `${l.rel} ${new URL(l.href).pathname}`));
  expect(links).toEqual(expect.arrayContaining([
    `preload ${module}`, `modulepreload ${glue}`, 'preload /wasm/stare_wasm_bg.json', `preload ${data.url}`,
  ]));
  // A preload the loader's fetch doesn't match would be fetched twice (and warned about).
  for (const path of [module, glue, data.url]) {
    expect(requested.filter((p) => p === path), path).toHaveLength(1);
  }
});

test('the landing preloads none of the WASM', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#landing')).toBeVisible();
  expect(await page.locator('link[href*="stare_wasm"], link[href*="citare-data"]').count()).toBe(0);
});
