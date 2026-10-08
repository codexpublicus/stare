// Smoke checks for a deployed stare.pub (issue #81). The automated form of
// the manual preview checks in
// docs/superpowers/plans/2026-09-27-stare-infra-and-workers.md (Task 6,
// step 5), plus /check exercising citare through the WASM.
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import { test as base, expect } from '@playwright/test';

import { casesLabel, yearRange } from '../src/lib/collection.js';

const WASM_PATH = '/wasm/stare_wasm_bg.wasm';
const WASM_SIZE_PATH = '/wasm/stare_wasm_bg.json';
const BUNDLE_DIR = '/data/citare/v1/';

// Every test fails on a console error or warning, or an uncaught exception.
// `expectedMissing` lists URLs a test expects to 404: Chromium logs every failed
// fetch as a console error, and only that exact message for that exact URL is let
// through.
const test = base.extend({
  expectedMissing: [[], { option: true }],
  page: async ({ page, expectedMissing }, use) => {
    const problems = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        const missing = expectedMissing.includes(msg.location().url)
          && /^Failed to load resource: the server responded with a status of 404\b/.test(msg.text());
        if (!missing) problems.push(`console.${msg.type()}: ${msg.text()}`);
      }
    });
    page.on('pageerror', (err) => problems.push(`uncaught: ${err.message}`));
    await use(page);
    expect(problems, 'console errors or warnings').toEqual([]);
  },
});

// A request or response for the WASM module.
function isWasm(message) {
  return new URL(message.url()).pathname === WASM_PATH;
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

test('the WASM is served as application/wasm, compressed', async ({ request }) => {
  const response = await request.get(WASM_PATH, { headers: { 'Accept-Encoding': 'br, gzip' } });
  await expectWasmResponse(response);
  expect(['br', 'gzip']).toContain(response.headers()['content-encoding']);
});

test('/wasm/stare_wasm_bg.json gives the WASM module\'s uncompressed size', async ({ request }) => {
  const size = await request.get(WASM_SIZE_PATH);
  expect(size.status()).toBe(200);
  const { bytes } = await size.json();
  const wasm = await request.get(WASM_PATH);
  expect((await wasm.body()).length).toBe(bytes);
});

// citare's data bundle (#117), as the build info names it.
async function bundleInfo(request) {
  const info = await request.get(WASM_SIZE_PATH);
  expect(info.status()).toBe(200);
  const { data } = await info.json();
  expect(data.url).toMatch(/^\/data\/citare\/v1\/citare-data-[0-9a-f]{16}\.bin\.gz$/);
  return data;
}

test('citare\'s data bundle is served as immutable application/gzip, not re-encoded, matching the build info', async ({ request }) => {
  const data = await bundleInfo(request);
  expect(data.sha256.startsWith(data.url.slice(-23, -7))).toBe(true);
  const response = await request.get(data.url, { headers: { 'Accept-Encoding': 'br, gzip, zstd' } });
  expect(response.status()).toBe(200);
  const headers = response.headers();
  expect(headers['cache-control']).toBe('public, max-age=31536000, immutable');
  expect(headers['content-type']).toBe('application/gzip');
  // No Content-Encoding: Cloudflare sends the file as it is and the browser
  // hands the loader the gzip bytes.
  expect(headers['content-encoding']).toBeUndefined();
  const gz = await response.body();
  expect(gz.length).toBe(data.bytes);
  const body = gunzipSync(gz);
  expect(body.length).toBe(data.uncompressedBytes);
  expect(createHash('sha256').update(body).digest('hex')).toBe(data.sha256);
});

test('/check fetches the bundle alongside the WASM and keeps it cached across a reload', async ({ page, request }) => {
  const data = await bundleInfo(request);
  const fetched = page.waitForResponse((r) => new URL(r.url()).pathname === data.url);
  await page.goto('/check');
  expect((await fetched).status()).toBe(200);
  await page.fill('#check-input', 'See Barney v. Oelrichs, 138 U.S. 529 (1891).');
  await page.click('#check-btn');
  await expect(page.locator('#check-summary')).toHaveText('1 citations found (1 resolvable)');

  // On the next visit the bundle comes from the browser's cache: no bytes
  // transferred and no revalidation.
  await page.reload();
  await page.fill('#check-input', 'See Barney v. Oelrichs, 138 U.S. 529 (1891).');
  await page.click('#check-btn');
  await expect(page.locator('#check-summary')).toHaveText('1 citations found (1 resolvable)');
  const entry = await page.evaluate((url) => {
    const e = performance.getEntriesByType('resource').find((r) => new URL(r.name).pathname === url);
    return e && { transferSize: e.transferSize, decodedBodySize: e.decodedBodySize };
  }, data.url);
  expect(entry).toEqual({ transferSize: 0, decodedBodySize: data.bytes });
});

// A plain test: the failed loads log console errors on purpose.
base('/check reports a failed bundle load and retries it', async ({ page }) => {
  let failing = true;
  await page.route(`**${BUNDLE_DIR}*`, (route) => (failing ? route.abort() : route.continue()));
  await page.goto('/check');
  await page.fill('#check-input', 'See Barney v. Oelrichs, 138 U.S. 529 (1891).');
  await page.click('#check-btn');

  const alert = page.getByRole('alert');
  await expect(alert).toHaveText("Couldn't load the citation parser. Retry");
  failing = false;
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(alert).toHaveCount(0);
  await expect(page.locator('#check-summary')).toHaveText('1 citations found (1 resolvable)');
});

for (const path of ['/', '/check']) {
  test(`${path} loads the WASM in the background, after first paint`, async ({ page }) => {
    const wasm = page.waitForResponse(isWasm);
    const response = await page.goto(path);
    // Nothing in the HTML asks for it up front.
    expect(await response.text()).not.toContain('stare_wasm');
    await wasm;

    // The resource timing entry appears once the whole body is in, after
    // the response the wait above saw; poll for it and the paint entry.
    const timing = () => page.evaluate((wasmPath) => ({
      fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime,
      wasmStart: performance.getEntriesByType('resource')
        .find((e) => new URL(e.name).pathname === wasmPath)?.startTime,
      load: performance.getEntriesByType('navigation')[0].loadEventEnd,
    }), WASM_PATH);
    await expect.poll(async () => {
      const t = await timing();
      return t.fcp !== undefined && t.wasmStart !== undefined;
    }).toBe(true);
    const { fcp, wasmStart, load } = await timing();
    expect(fcp).toBeGreaterThan(0);
    expect(wasmStart).toBeGreaterThan(fcp);
    expect(wasmStart).toBeGreaterThanOrEqual(load);
  });
}

test('/about does not load the WASM', async ({ page }) => {
  const wasm = [];
  page.on('request', (req) => { if (isWasm(req)) wasm.push(req.url()); });
  await page.goto('/about', { waitUntil: 'load' });
  await page.waitForTimeout(4000);
  expect(wasm).toEqual([]);
});

// Holds every request for the WASM until release() is called.
async function holdWasm(page) {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  await page.route(`**${WASM_PATH}`, async (route) => {
    await released;
    await route.continue();
  });
  return release;
}

test('/check shows a loading bar while the WASM loads, then the results', async ({ page }) => {
  const release = await holdWasm(page);
  await page.goto('/check');
  await page.fill('#check-input', 'See Barney v. Oelrichs, 138 U.S. 529 (1891).');
  await page.click('#check-btn');

  const bar = page.getByRole('progressbar', { name: /^Loading the citation parser/ });
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute('aria-valuemax', '100');
  // The rest of the page still works while it loads.
  await page.fill('#check-input', 'See Barney v. Oelrichs, 138 U.S. 529 (1891). And more.');

  release();
  await expect(bar).toHaveCount(0);
  await expect(page.locator('#check-results')).toHaveClass(/\bvisible\b/);
  await expect(page.locator('#check-summary')).toHaveText('1 citations found (1 resolvable)');
});

test('the case view shows a loading bar while the WASM loads, then the case', async ({ page }) => {
  const release = await holdWasm(page);
  await page.goto('/#a2d/31/647-01');

  const bar = page.getByRole('progressbar', { name: /^Loading the citation parser/ });
  await expect(bar).toBeVisible();
  release();
  await expect(bar).toHaveCount(0);
  await expect(page.locator('#topbar-case')).toHaveText("D'Elia & Marks Co. v. Lyon");
});

// A plain test: the failed loads log console errors on purpose.
base('/check reports a failed WASM load and retries it', async ({ page }) => {
  let failing = true;
  await page.route(`**${WASM_PATH}`, (route) => (failing ? route.abort() : route.continue()));
  await page.goto('/check');
  await page.fill('#check-input', 'See Barney v. Oelrichs, 138 U.S. 529 (1891).');
  await page.click('#check-btn');

  const alert = page.getByRole('alert');
  await expect(alert).toHaveText("Couldn't load the citation parser. Retry");
  await expect(page.locator('#check-status')).not.toHaveClass(/check-error/);
  await expect(page.locator('#check-btn')).toBeEnabled();

  failing = false;
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(alert).toHaveCount(0);
  // The retry reruns the check.
  await expect(page.locator('#check-results')).toHaveClass(/\bvisible\b/);
  await expect(page.locator('#check-summary')).toHaveText('1 citations found (1 resolvable)');
});

test('/check lists the citations citare finds', async ({ page }) => {
  // Citations as citare v0.5.0 reports them, unchanged from v0.2.0 for this
  // text. "Id." is the WASM's alone; the old regex fallback never found it.
  const text = [
    "The court in D'Elia & Marks Co. v. Lyon, 31 A.2d 647 (D.C. Mun. Ct. App. 1943),",
    'held that residence is the test. See Barney v. Oelrichs, 138 U.S. 529 (1891).',
    'Id. at 533. See also 42 U.S.C. § 1983.',
  ].join(' ');

  // The page starts loading the WASM in the background once it has painted,
  // so the response may come before the click.
  const wasm = page.waitForResponse(isWasm);
  await page.goto('/check');
  await page.fill('#check-input', text);
  await page.click('#check-btn');
  await expectWasmResponse(await wasm);

  await expect(page.locator('#check-results')).toHaveClass(/\bvisible\b/);
  await expect(page.locator('#check-status')).not.toHaveClass(/check-error/);
  // Resolvability comes from idx.stare.pub's manifest; a2d/31 and us/138
  // are both indexed.
  await expect(page.locator('#check-summary')).toHaveText('4 citations found (3 resolvable)');
  // Resolvable citations first, as links to the case viewer; then the
  // statute, linked to its text. "Id." resolves through Barney, the
  // citation before it (#120).
  await expect(page.locator('#check-cite-list .cited-case')).toHaveText([
    '✓ 31 A.2d 647',
    '✓ 138 U.S. 529',
    '✓ Id. Refers to 138 U.S. 529',
    '↗ 42 U.S.C. § 1983',
  ]);
  const links = page.locator('#check-cite-list a.cited-case-link');
  await expect(links.nth(0)).toHaveAttribute('href', '/#a2d/31/647-01');
  await expect(links.nth(1)).toHaveAttribute('href', '/#us/138/529-01');
  await expect(links.nth(2)).toHaveAttribute('href', '/#us/138/529-01');
  await expect(links.nth(3)).toHaveAttribute('href', 'https://www.law.cornell.edu/uscode/text/42/1983');
  await expect(page.locator('#check-rendered a.cite-link', { hasText: 'Id.' }))
    .toHaveAttribute('title', 'Refers to 138 U.S. 529, at 533');
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

test('short cites and Id.s in a case link to their antecedent\'s case (#120)', async ({ page }) => {
  // McCallister v. State, 2019 WY 47, cites Roe v. Board of County
  // Commissioners, 997 P.2d 1021, then "997 P.2d at 1023". Burnett v.
  // State starts at page 1023, where the short cite used to link.
  await page.goto('/#p3d/440/1078-01');
  await expect(page.locator('#reader .reader-title')).toContainText('McCallister');
  await expect(page.locator('#sidebar [role="status"]')).toHaveText(/^\d+ citations? found$/);

  const roe = page.locator('#reader a.cite-link', { hasText: '997 P.2d at 1023' });
  await expect(roe).toHaveAttribute('href', '#p2d/997/1021@1023');
  await expect(roe).toHaveAttribute('title', 'Refers to 997 P.2d 1021, at 1023');
  await expect(page.locator('#reader a.cite-link[href="#p2d/997/1023"]')).toHaveCount(0);
  await expect(page.locator('#sidebar .cited-case', { hasText: '997 P.2d at 1023' }))
    .toHaveText('✓ 997 P.2d at 1023 Refers to 997 P.2d 1021');

  // Three Id.s after Anderson v. W. Hodgeman & Sons, 524 N.W.2d 418, each
  // with its own pin, link to Anderson.
  const ids = page.locator('#reader a.cite-link[data-slug="nw2d"][data-volume="524"][data-page="418"]', { hasText: /^Id\./ });
  await expect(ids).toHaveCount(3);
  await expect(ids.last()).toHaveAttribute('title', 'Refers to 524 N.W.2d 418, at 421');
  // An Id. citare can't tie to a citation says so, and isn't "Not yet indexed".
  await expect(page.locator('#reader .cite-no-antecedent').first())
    .toHaveAttribute('title', "Refers to an earlier citation that couldn't be identified");
});

test('a pin cite opens the cited case at the pin page (#124)', async ({ page }) => {
  // In McCallister v. State, "997 P.2d at 1023" refers to Roe v. Board of
  // County Commissioners, 997 P.2d 1021; the link opens Roe at page 1023.
  await page.goto('/#p3d/440/1078-01');
  await expect(page.locator('#sidebar [role="status"]')).toHaveText(/^\d+ citations? found$/);
  const roe = page.locator('#reader a.cite-link', { hasText: '997 P.2d at 1023' });
  const [popup] = await Promise.all([page.waitForEvent('popup'), roe.click()]);

  await expect(popup.locator('#topbar-case')).toHaveText('Roe v. Board of County Commissioners');
  await expect(popup).toHaveURL(/#p2d\/997\/1021-01@1023$/);
  const marker = popup.locator('#reader #page-1023');
  await expect(marker).toHaveText('[*1023]');
  await expect(marker).toBeInViewport();
  await expect(marker).toHaveClass(/\bpage-target\b/);
  // The highlight fades after a moment; the marker stays where it was.
  await expect(marker).not.toHaveClass(/\bpage-target\b/, { timeout: 10_000 });
  await expect(marker).toBeInViewport();

  // Another page of the same case scrolls without reloading it, and back
  // and forward move between the two.
  await popup.evaluate(() => { window.location.hash = '#p2d/997/1021-01@1022'; });
  await expect(popup.locator('#reader #page-1022')).toBeInViewport();
  await expect(popup.locator('#reader #page-1022')).toHaveClass(/\bpage-target\b/);
  await popup.goBack();
  await expect(popup).toHaveURL(/@1023$/);
  await expect(marker).toBeInViewport();
  await popup.goForward();
  await expect(popup.locator('#reader #page-1022')).toBeInViewport();
});

test('a pin page the case does not have opens it at the top, with no error', async ({ page }) => {
  await page.goto('/#p2d/997/1021-01@1099');
  await expect(page.locator('#topbar-case')).toHaveText('Roe v. Board of County Commissioners');
  await expect(page.locator('#reader .reader-title')).toBeInViewport();
  await expect(page.locator('#reader #page-1023')).toHaveCount(1);
  await expect(page.locator('#reader .page-target')).toHaveCount(0);
  await expect(page.locator('#status-bar')).toBeHidden();
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

  // The URL is set once the case is found: it names the folder the case is in.
  await expect(page).toHaveURL(/#a3d\/138-2\/1012-01$/);
  await expect(page.locator('#resolved')).toBeVisible();
  await expect(page.locator('#topbar-case')).toHaveText('Brooks v. Powers');
  await expect(page.locator('#reader .reader-text p').first()).not.toBeEmpty();
});

test.describe('/data before the first index report', () => {
  // Today idx.stare.pub answers reports/index.json with a 404. The route stubs that
  // 404 so the case keeps testing the empty state after the first rebuild publishes
  // the file; Chromium still logs the 404, which `expectedMissing` lets through.
  const REPORTS = 'https://idx.stare.pub/reports/index.json';
  test.use({ expectedMissing: [REPORTS] });

  test('/data shows the empty state until the first report', async ({ page }) => {
    await page.route(REPORTS, (route) => route.fulfill({
      status: 404,
      headers: { 'access-control-allow-origin': '*' },
      body: 'Not Found',
    }));
    const reports = page.waitForResponse((r) => r.url() === REPORTS);
    const response = await page.goto('/data');
    expect(response.status()).toBe(200);
    await expect(page).toHaveTitle('Index data · stare.pub');
    expect((await reports).status()).toBe(404);
    await expect(page.locator('#data-root')).toContainText('Index reports start with the next rebuild.');
    // The footer's "Index v…" line links here; it stays hidden if the manifest can't be read.
    await expect(page.locator('footer [data-site-data-line]')).toHaveAttribute('href', '/data');
  });
});
