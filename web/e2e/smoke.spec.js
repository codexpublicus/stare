// Smoke checks for a deployed stare.pub (issue #81). The automated form of
// the manual preview checks in
// docs/superpowers/plans/2026-09-27-stare-infra-and-workers.md (Task 6,
// step 5), plus /check exercising citare through the WASM.
import { test as base, expect } from '@playwright/test';

import { casesLabel, yearRange } from '../src/lib/collection.js';

const WASM_PATH = '/wasm/stare_wasm_bg.wasm';

// Every test fails on a console error or warning, or an uncaught exception.
const test = base.extend({
  page: async ({ page }, use) => {
    const problems = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        problems.push(`console.${msg.type()}: ${msg.text()}`);
      }
    });
    page.on('pageerror', (err) => problems.push(`uncaught: ${err.message}`));
    await use(page);
    expect(problems, 'console errors or warnings').toEqual([]);
  },
});

function isWasm(response) {
  return new URL(response.url()).pathname === WASM_PATH;
}

async function expectWasmResponse(response) {
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('application/wasm');
}

test('/ returns 200 with the title and security headers', async ({ page }) => {
  const response = await page.goto('/');
  expect(response.status()).toBe(200);
  await expect(page).toHaveTitle('stare.pub — U.S. Case Law Citation Resolution');

  const headers = response.headers();
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
});

test('/ gives the collection figures from web/src/data/collection.json', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#collection-cases')).toHaveText(casesLabel);
  await expect(page.locator('#collection-cases + span')).toContainText(yearRange);
});

test('the WASM is served as application/wasm', async ({ request }) => {
  await expectWasmResponse(await request.get(WASM_PATH));
});

test('/check lists the citations citare finds', async ({ page }) => {
  // Citations as citare v0.4.1 reports them, unchanged from v0.2.0 for this
  // text. "Id." is the WASM's alone; the old regex fallback never found it.
  const text = [
    "The court in D'Elia & Marks Co. v. Lyon, 31 A.2d 647 (D.C. Mun. Ct. App. 1943),",
    'held that residence is the test. See Barney v. Oelrichs, 138 U.S. 529 (1891).',
    'Id. at 533. See also 42 U.S.C. § 1983.',
  ].join(' ');

  await page.goto('/check');
  await page.fill('#check-input', text);
  const wasm = page.waitForResponse(isWasm);
  await page.click('#check-btn');
  await expectWasmResponse(await wasm);

  await expect(page.locator('#check-results')).toHaveClass(/\bvisible\b/);
  await expect(page.locator('#check-status')).not.toHaveClass(/check-error/);
  // Resolvability comes from idx.stare.pub's manifest; a2d/31 and us/138
  // are both indexed.
  await expect(page.locator('#check-summary')).toHaveText('4 citations found (2 resolvable)');
  // Resolvable citations first, as links to the case viewer; then the
  // statute, linked to its text; then the rest.
  await expect(page.locator('#check-cite-list .cited-case')).toHaveText([
    '✓ 31 A.2d 647',
    '✓ 138 U.S. 529',
    '↗ 42 U.S.C. § 1983',
    '✗ Id.',
  ]);
  const links = page.locator('#check-cite-list a.cited-case-link');
  await expect(links.nth(0)).toHaveAttribute('href', '/#a2d/31/647-01');
  await expect(links.nth(1)).toHaveAttribute('href', '/#us/138/529-01');
  await expect(links.nth(2)).toHaveAttribute('href', 'https://www.law.cornell.edu/uscode/text/42/1983');
});

test('/check links out only for volumes and statutes stare.pub does not hold', async ({ page }) => {
  // Axon (2023) is past CAP's last volumes of the U.S. Reports, so the
  // index can't have it; the Minnesota statute links to the revisor. A.2d
  // 31 is indexed and its last case starts at page 894, so 31 A.2d 950 is a
  // miss in a held volume: a neutral note, and no outside link.
  const text = 'See Axon Enterprise, Inc. v. FTC, 598 U.S. 175 (2023); Minn. Stat. § 609.185; Doe v. Roe, 31 A.2d 950 (1943).';

  // Links only: the page itself must make no request to either site.
  const outside = [];
  page.on('request', (req) => {
    const host = new URL(req.url()).hostname;
    if (/courtlistener|google|revisor/.test(host)) outside.push(req.url());
  });

  await page.goto('/check');
  await page.fill('#check-input', text);
  await page.click('#check-btn');

  await expect(page.locator('#check-results')).toHaveClass(/\bvisible\b/);
  await expect(page.locator('#check-summary')).toHaveText('3 citations found (0 resolvable)');
  await expect(page.locator('#check-cite-list .cited-case')).toHaveText([
    '↗ Minn. Stat. § 609.185',
    '↗ 598 U.S. 175 Not in stare.pub: may be at CourtListener or Google Scholar',
    '✗ 31 A.2d 950 No case found at this page in A.2d vol. 31',
  ]);
  await expect(page.locator('#check-cite-list .cited-case', { hasText: '31 A.2d 950' }).locator('a')).toHaveCount(0);
  await expect(page.locator('#check-rendered .cite-unresolved', { hasText: '31 A.2d 950' }))
    .toHaveAttribute('title', 'No case found at this page in A.2d vol. 31');

  const statute = page.locator('#check-cite-list a.cited-case-link');
  await expect(statute).toHaveAttribute('href', 'https://www.revisor.mn.gov/statutes/cite/609.185');
  await expect(statute).toHaveAttribute('rel', 'noopener noreferrer');

  const courtListener = page.getByRole('link', { name: 'Not in stare.pub: may be at CourtListener' });
  await expect(courtListener).toHaveAttribute('href', 'https://www.courtlistener.com/c/U.S./598/175/');
  await expect(courtListener).toHaveAttribute('target', '_blank');
  await expect(courtListener).toHaveAttribute('rel', 'noopener noreferrer');

  // In the text, the citation itself links out, styled apart from stare.pub's own links.
  const inline = page.locator('#check-rendered a.cite-lookup');
  await expect(inline).toHaveText('598 U.S. 175');
  await expect(inline).toHaveAttribute('href', 'https://www.courtlistener.com/c/U.S./598/175/');
  await expect(page.locator('#check-rendered a.cite-link', { hasText: '598 U.S. 175' })).toHaveCount(0);

  expect(outside).toEqual([]);
});

test('/check survives a multibyte character at the case-name scan boundary', async ({ page }) => {
  // citare v0.4.0 panicked (a WASM trap here) when a multibyte character,
  // here a three-byte curly apostrophe, straddled byte 300 of the
  // case-name scan.
  const text = `Foo v. Bar, 547 So.2d 1034 ${'x'.repeat(297)}’s house.`;

  await page.goto('/check');
  await page.fill('#check-input', text);
  await page.click('#check-btn');

  await expect(page.locator('#check-results')).toHaveClass(/\bvisible\b/);
  await expect(page.locator('#check-status')).not.toHaveClass(/check-error/);
  await expect(page.locator('#check-summary')).toHaveText(/^1 citations found/);
  await expect(page.locator('#check-rendered').locator('.cite-link, .cite-unresolved')).toHaveText([
    '547 So.2d 1034',
  ]);
});

test('/#a2d/31/647-01 resolves through idx.stare.pub and renders the case', async ({ page }) => {
  const wasm = page.waitForResponse(isWasm);
  await page.goto('/#a2d/31/647-01');
  await expectWasmResponse(await wasm);

  await expect(page.locator('#resolved')).toBeVisible();
  await expect(page.locator('#topbar-case')).toHaveText("D'Elia & Marks Co. v. Lyon");
  await expect(page.locator('#reader .reader-title')).toHaveText("D'Elia & Marks Co. v. Lyon");
  await expect(page.locator('#reader .reader-text p').first()).not.toBeEmpty();
  // The sidebar's citation pass finished without its error state.
  await expect(page.locator('#sidebar [role="status"]')).toHaveText(/^\d+ citations? found$/);
});

test('a case page loads Source Serif 4 from stare.pub and nothing from Google Fonts', async ({ page, baseURL }) => {
  // The fonts are self-hosted under /fonts/ (#102); no page may ask Google for one.
  const google = [];
  const fonts = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') google.push(req.url());
    if (url.pathname.endsWith('.woff2')) fonts.push(url);
  });

  await page.goto('/#a2d/31/647-01');
  await expect(page.locator('#reader .reader-text p').first()).not.toBeEmpty();

  await expect.poll(() => page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].some(
      (face) => face.family.replace(/["']/g, '') === 'Source Serif 4' && face.status === 'loaded',
    );
  })).toBe(true);
  const origin = new URL(baseURL).origin;
  expect(fonts.length).toBeGreaterThan(0);
  for (const url of fonts) {
    expect(url.origin).toBe(origin);
    expect(url.pathname).toMatch(/^\/fonts\//);
  }

  await page.goto('/check');
  await page.goto('/about');
  expect(google).toEqual([]);
});

test('138 A.3d 1012 resolves into a3d/138-2, the second folder CAP split the volume over', async ({ page }) => {
  // CAP split 138 A.3d over two folders, a3d/138 and a3d/138-2 (#94). Page 1012 is
  // only in the second; the resolver tries 138 first, then asks the manifest.
  await page.goto('/');
  await page.fill('#landing-input', '138 A.3d 1012');
  await page.click('#landing-btn');

  await expect(page.locator('#resolved')).toBeVisible();
  await expect(page.locator('#topbar-case')).toHaveText('Brooks v. Powers');
  await expect(page.locator('#reader .reader-text p').first()).not.toBeEmpty();
  // The page's URL names the folder the case is in.
  await expect(page).toHaveURL(/#a3d\/138-2\/1012-01$/);
});
