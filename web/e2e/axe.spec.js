// An automated accessibility pass (axe-core, through @axe-core/playwright) over the pages the
// smoke suite loads, in both themes: the landing, a case in each of its three views, /search/
// with results, /about, /data and /check with a result. A serious or critical violation fails
// the test; moderate and minor ones are listed in the output and attached to the report without
// failing it. #270 and a11y.spec.js cover what axe can't see: the keyboard, the focus and the
// live regions.
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';

import { TREE_PATH, TREE_VERSION, TREES, treeResponse } from '../tests/fixtures/searchtree.js';

const IDX = 'https://idx.stare.pub';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'Content-Range,Accept-Ranges,Content-Length,ETag',
};
const CASE = '/#a2d/142/148-01';
const TITLE = 'Renaire Corp. v. Vaughn';
const FAILING = new Set(['serious', 'critical']);

// The search page answered from the format-2 fixture tree (search.spec.js serves it the same
// way), so /search/ has results without a tree on R2.
async function serveSearchTree(page) {
  await page.route(`${IDX}/manifest.json`, (route) => route.fulfill({
    headers: { ...CORS, 'cache-control': 'no-cache' },
    contentType: 'application/json',
    body: JSON.stringify({ format: 2, version: TREE_VERSION, base: `v/${TREE_VERSION}/`, idx: 1, reporters: {} }),
  }));
  await page.route(`${IDX}/${TREE_PATH}/**`, (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { ...CORS, 'access-control-allow-methods': 'GET, HEAD', 'access-control-allow-headers': 'range' } });
    }
    const r = treeResponse(new URL(req.url()).pathname.slice(1), req.headers().range, TREES[2].root);
    return route.fulfill({ status: r.status, headers: { ...CORS, ...r.headers }, body: r.body });
  });
}

async function openCase(page) {
  await page.goto(CASE);
  await expect(page.locator('#topbar-case')).toHaveText(TITLE);
  await expect(page.locator('#reader a.cite-link').first()).toBeVisible();
}

// Each page, and how to get it to the state worth checking.
const PAGES = {
  landing: async (page) => {
    await page.goto('/');
    await expect(page.locator('#landing-input')).toBeVisible();
  },
  'case, Reader': openCase,
  'case, Archival PDF': async (page) => {
    await openCase(page);
    await page.click('#tab-pdf');
    await expect(page.locator('#pdf-viewer .pdf-page').first()).toHaveAttribute('data-rendered', /\d+/, { timeout: 30_000 });
  },
  'case, Raw Scans': async (page) => {
    await openCase(page);
    await page.click('#tab-pages');
    await expect(page.locator('#page-viewer .page-wrapper').first()).toHaveAttribute('data-rendered', /\d+/, { timeout: 30_000 });
  },
  'search with results': async (page) => {
    await serveSearchTree(page);
    await page.goto('/search/?q=contract');
    await expect(page.locator('#search-results > li')).toHaveCount(20);
  },
  about: async (page) => {
    await page.goto('/about');
    await expect(page.locator('h1').first()).toBeVisible();
  },
  data: async (page) => {
    await page.goto('/data');
    await expect(page.locator('h1').first()).toBeVisible();
    await page.waitForLoadState('networkidle');
  },
  'check with a result': async (page) => {
    await page.goto('/check');
    await page.fill('#check-input', 'See Barney v. Oelrichs, 138 U.S. 529 (1891).');
    await page.click('#check-btn');
    await expect(page.locator('#check-summary')).toHaveText('1 cited case found (1 resolvable)');
  },
};

// One violation as a line per element: rule, impact, help, and the element's selector.
const describe = (v) => v.nodes.map((n) => `  [${v.impact}] ${v.id}: ${v.help}\n    ${n.target.join(' ')}\n    ${n.failureSummary?.replace(/\n/g, '\n    ') ?? ''}`).join('\n');

for (const theme of ['light', 'dark']) {
  for (const [name, open] of Object.entries(PAGES)) {
    test(`axe: ${name} (${theme})`, async ({ page }, testInfo) => {
      test.slow(name.startsWith('case, ') && name !== 'case, Reader');
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await open(page);
      const { violations } = await new AxeBuilder({ page }).analyze();
      const failing = violations.filter((v) => FAILING.has(v.impact));
      const reported = violations.filter((v) => !FAILING.has(v.impact));
      if (reported.length) {
        const text = reported.map(describe).join('\n');
        console.log(`axe, moderate and minor, ${name} (${theme}):\n${text}`);
        await testInfo.attach('axe-moderate-minor.txt', { body: text, contentType: 'text/plain' });
      }
      expect(failing.map(describe).join('\n'), 'serious or critical axe violations').toBe('');
    });
  }
}
