// Smoke checks for a deployed stare.pub (issue #81). The automated form of
// the manual preview checks in
// docs/superpowers/plans/2026-09-27-stare-infra-and-workers.md (Task 6,
// step 5), plus /check exercising citare through the WASM.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

import { test as base, expect } from '@playwright/test';

import { casesLabel, yearRange } from '../src/lib/collection.js';

const WASM_PATH = '/wasm/stare_wasm_bg.wasm';
const WASM_SIZE_PATH = '/wasm/stare_wasm_bg.json';
const BUNDLE_DIR = '/data/citare/v1/';

// Every test fails on a console error or warning, or an uncaught exception.
// `expectedMissing` lists URLs a test expects to 404: Chromium logs every failed
// fetch as a console error, and only that exact message for that exact URL is let
// through. `expectedFailing` lists URL endings a test makes fail on purpose (a 5xx
// from a route), whose failed-load message is let through the same way.
const test = base.extend({
  expectedMissing: [[], { option: true }],
  expectedFailing: [[], { option: true }],
  page: async ({ page, expectedMissing, expectedFailing }, use) => {
    const problems = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        const url = msg.location().url;
        const missing = expectedMissing.includes(url)
          && /^Failed to load resource: the server responded with a status of 404\b/.test(msg.text());
        const failing = expectedFailing.some((end) => url?.endsWith(end))
          && /^Failed to load resource: the server responded with a status of 5\d\d\b/.test(msg.text());
        if (!missing && !failing) problems.push(`console.${msg.type()}: ${msg.text()}`);
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
  await expect(page.locator('#check-summary')).toHaveText('1 case citation found (1 resolvable)');

  // On the next visit the bundle comes from the browser's cache: no bytes
  // transferred and no revalidation.
  await page.reload();
  await page.fill('#check-input', 'See Barney v. Oelrichs, 138 U.S. 529 (1891).');
  await page.click('#check-btn');
  await expect(page.locator('#check-summary')).toHaveText('1 case citation found (1 resolvable)');
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
  await expect(page.locator('#check-summary')).toHaveText('1 case citation found (1 resolvable)');
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
  await expect(page.locator('#check-summary')).toHaveText('1 case citation found (1 resolvable)');
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
  await expect(page.locator('#check-summary')).toHaveText('1 case citation found (1 resolvable)');
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
  // are both indexed. The statute is counted apart from the cases.
  await expect(page.locator('#check-summary')).toHaveText('3 case citations found (3 resolvable), 1 statute');
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
  await expect(page.locator('#check-summary')).toHaveText('2 case citations found (0 resolvable), 1 statute');
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

test('/check tells statutes from cases, and leaves bare section references alone', async ({ page }) => {
  // "§ 12 of the Act" names no code: a bare section reference. citare
  // reads Connecticut's own "General Statutes § 52-584" as Conn. Gen. Stat.
  // (citare#69), which has no per-section URL; North Carolina's links to
  // the legislature, cited in its own form too.
  const text = 'Under § 12 of the Act, see General Statutes § 52-584 and N.C.G.S. § 1-289.';

  const outside = [];
  page.on('request', (req) => {
    if (/ncleg|cga\.ct/.test(new URL(req.url()).hostname)) outside.push(req.url());
  });

  await page.goto('/check');
  await page.fill('#check-input', text);
  await page.click('#check-btn');

  await expect(page.locator('#check-results')).toHaveClass(/\bvisible\b/);
  await expect(page.locator('#check-summary')).toHaveText('0 case citations found (0 resolvable), 2 statutes');
  await expect(page.locator('#check-cite-list .cited-case')).toHaveText([
    '↗ N.C.G.S. § 1-289',
    '§ General Statutes § 52-584 Statute; no free source linked yet',
  ]);
  await expect(page.locator('#check-cite-list a.cited-case-link'))
    .toHaveAttribute('href', 'https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/BySection/Chapter_1/GS_1-289.html');
  await expect(page.locator('#check-rendered .cite-statute')).toHaveText('General Statutes § 52-584');
  await expect(page.locator('#check-rendered .cite-statute')).toHaveAttribute('title', 'Statute; no free source linked yet');
  await expect(page.locator('#check-rendered .cite-section')).toHaveText('§');
  await expect(page.locator('#check-rendered .cite-section')).toHaveAttribute('title', 'Section reference');
  await expect(page.locator('#check-rendered [title="Not yet indexed"]')).toHaveCount(0);

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
  await expect(page.locator('#check-summary')).toHaveText(/^1 case citation found/);
  await expect(page.locator('#check-rendered').locator('.cite-link, .cite-unresolved')).toHaveText([
    '547 So.2d 1034',
  ]);
});

test('/#a2d/31/647-01 resolves through idx.stare.pub and renders the case', async ({ page }) => {
  // The live manifest has no `idx` yet: the case comes from the .bin, and nothing asks
  // for a unified index file.
  const idx = [];
  const bins = [];
  page.on('request', (req) => {
    if (req.url().endsWith('.idx.gz')) idx.push(req.url());
    if (req.url().endsWith('/a2d/31.bin')) bins.push(req.url());
  });
  const wasm = page.waitForResponse(isWasm);
  await page.goto('/#a2d/31/647-01');
  await expectWasmResponse(await wasm);

  await expect(page.locator('#resolved')).toBeVisible();
  await expect(page.locator('#topbar-case')).toHaveText("D'Elia & Marks Co. v. Lyon");
  await expect(page.locator('#reader .reader-title')).toHaveText("D'Elia & Marks Co. v. Lyon");
  await expect(page.locator('#reader .reader-text p').first()).not.toBeEmpty();
  // The sidebar's citation pass finished without its error state.
  await expect(page.locator('#sidebar [role="status"]')).toHaveText(/^\d+ case citations? found \(\d+ resolvable\)(, \d+ statutes?)?(, \d+ other)?$/);
  const manifest = await (await page.request.get('https://idx.stare.pub/manifest.json')).json();
  if (manifest.idx !== 1) {
    expect(bins.length).toBeGreaterThan(0);
    expect(idx).toEqual([]);
  }
});

test('short cites and Id.s in a case link to their antecedent\'s case (#120)', async ({ page }) => {
  // McCallister v. State, 2019 WY 47, cites Roe v. Board of County
  // Commissioners, 997 P.2d 1021, then "997 P.2d at 1023". Burnett v.
  // State starts at page 1023, where the short cite used to link.
  await page.goto('/#p3d/440/1078-01');
  await expect(page.locator('#reader .reader-title')).toContainText('McCallister');
  await expect(page.locator('#sidebar [role="status"]')).toHaveText(/^\d+ case citations? found \(\d+ resolvable\)(, \d+ statutes?)?(, \d+ other)?$/);

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
  await expect(page.locator('#sidebar [role="status"]')).toHaveText(/^\d+ case citations? found \(\d+ resolvable\)(, \d+ statutes?)?(, \d+ other)?$/);
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

test.describe('an index file that fails to load (#144)', () => {
  // The live manifest without `idx`, so the page checks read the .bin files whatever
  // the published build is; the route answers one volume's .bin with a 503, twice, so
  // the retry fails too.
  test.use({ expectedFailing: ['/a3d/101.bin', '/a2d/31.bin'] });
  const UNKNOWN = (r, v) => `Couldn't reach the index for ${r} vol. ${v}; reload to try again`;

  async function failBin(page, path) {
    await page.route('https://idx.stare.pub/manifest.json', async (route) => {
      const manifest = await (await route.fetch()).json();
      delete manifest.idx;
      await route.fulfill({
        headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-cache' },
        contentType: 'application/json',
        body: JSON.stringify(manifest),
      });
    });
    const tries = [];
    await page.route(`https://idx.stare.pub/**${path}`, (route) => {
      tries.push(route.request().url());
      return route.fulfill({ status: 503, headers: { 'access-control-allow-origin': '*' }, body: '' });
    });
    return tries;
  }

  test('the reader and sidebar show a citation into it as unchecked, with no link', async ({ page }) => {
    // Brooks v. Powers cites 101 A.3d 249 throughout; with a3d/101.bin failing, none
    // of them may link.
    const tries = await failBin(page, '/a3d/101.bin');
    await page.goto('/#a3d/138-2/1012-01');
    await expect(page.locator('#topbar-case')).toHaveText('Brooks v. Powers');
    await expect(page.locator('#sidebar [role="status"]')).toHaveText(/^\d+ case citations? found/);

    // Its three Id.s refer to it, and are unchecked with it.
    const entries = page.locator('#sidebar .cited-case', { hasText: '101 A.3d 249' });
    await expect(entries).toHaveCount(4);
    await expect(entries.first()).toHaveText(`? 101 A.3d 249 ${UNKNOWN('A.3d', 101)}`);
    expect(await entries.locator('.cited-status').allTextContents()).toEqual(
      Array(await entries.count()).fill('?'));
    await expect(entries.locator('a')).toHaveCount(0);
    await expect(page.locator('#reader .cite-unknown', { hasText: '101 A.3d 249' }).first())
      .toHaveAttribute('title', UNKNOWN('A.3d', 101));
    await expect(page.locator('#reader a', { hasText: '101 A.3d 249' })).toHaveCount(0);
    expect(tries.length).toBeGreaterThanOrEqual(2);
  });

  test('/check shows it as unchecked, not as a hit or a miss, and links nothing out', async ({ page }) => {
    await failBin(page, '/a2d/31.bin');
    const outside = [];
    page.on('request', (req) => {
      if (/courtlistener|google/.test(new URL(req.url()).hostname)) outside.push(req.url());
    });
    await page.goto('/check');
    await page.fill('#check-input', "See D'Elia & Marks Co. v. Lyon, 31 A.2d 647 (1943).");
    await page.click('#check-btn');

    await expect(page.locator('#check-summary')).toHaveText('1 case citation found (0 resolvable)');
    await expect(page.locator('#check-cite-list .cited-case')).toHaveText([`? 31 A.2d 647 ${UNKNOWN('A.2d', 31)}`]);
    await expect(page.locator('#check-cite-list a')).toHaveCount(0);
    await expect(page.locator('#check-rendered .cite-unknown')).toHaveAttribute('title', UNKNOWN('A.2d', 31));
    await expect(page.locator('#check-rendered a')).toHaveCount(0);
    expect(outside).toEqual([]);
  });
});

test.describe('the unified per-volume index', () => {
  // Nothing in the unified index is published yet. The routes add `idx: 1` (and a3d
  // 250, a volume only CourtListener has) to the live manifest, and answer every
  // `.idx.gz` from the live build's .bin and .multi files, converted the way
  // stare-admin writes them: a split volume's later folders folded into its number's
  // file with a `<folder>/` ref, and a3d 138 split into two parts at page 1000.
  // a2d 31 page 647 gets a CourtListener alias line after CAP's, and a3d 250 one
  // record, the hand-made one the Rust tests read (docs/plans/courtlistener-mirror.md).
  const RECORD = readFileSync(new URL('../../crates/stare/tests/fixtures/cl-record.json', import.meta.url));
  const HASH = '0f3a9c2e7b1d4a65';
  const RECORD_URL = `https://data.stare.pub/cl/c/9876543/${HASH}.json.gz`;
  const CORS = { 'access-control-allow-origin': '*' };

  const pageKey = (p) => (/^\d+$/.test(p) ? [0, Number(p), ''] : [1, 0, p]);
  const byPage = (a, b) => {
    const [x, y] = [pageKey(a[0]), pageKey(b[0])];
    return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0);
  };

  // A CAP folder's lines from its .bin and .multi: [page, ref].
  async function folderLines(route, url, prefix) {
    const bin = await route.fetch({ url: `${url}.bin` });
    if (!bin.ok()) return null;
    const body = await bin.body();
    const lines = [];
    for (let page = 0; page * 8 < body.length; page += 1) {
      const name = body.subarray(page * 8, page * 8 + 8).toString('utf8').replace(/\0+$/, '');
      if (name && name !== '*' && !name.includes('\0')) lines.push([String(page), prefix + name]);
    }
    const multi = await route.fetch({ url: `${url}.multi` });
    if (multi.ok()) {
      for (const line of (await multi.text()).split('\n')) {
        const i = line.indexOf(',');
        if (i > 0) lines.push([line.slice(0, i), prefix + line.slice(i + 1)]);
      }
    }
    return lines;
  }

  // Returns the CAP .bin/.multi requests the page made itself, and its .idx.gz ones.
  async function routeIdx(page) {
    let parts = {};
    await page.route('https://idx.stare.pub/manifest.json', async (route) => {
      const manifest = await (await route.fetch()).json();
      manifest.idx = 1;
      manifest.reporters.a3d = [...manifest.reporters.a3d, '250'];
      parts = manifest.parts || {};
      await route.fulfill({
        headers: { ...CORS, 'cache-control': 'no-cache' },
        contentType: 'application/json',
        body: JSON.stringify(manifest),
      });
    });
    // A handler still converting when the test ends (the sidebar checks citations in
    // the background) has its fetch cut off; that's not a failure.
    await page.route(/^https:\/\/idx\.stare\.pub\/.*\.idx\.gz$/, (route) => serveIdx(route).catch(() => {}));
    async function serveIdx(route) {
      const url = route.request().url();
      const m = url.match(/^(.*\/)([a-z0-9-]+)\/([0-9a-z-]+?)(?:\.(\d+))?\.idx\.gz$/);
      const [, base, slug, volume, partStr] = m;
      const part = Number(partStr || 0);
      let lines = [];
      if (slug === 'a3d' && volume === '250') {
        lines = [['100', `cl,9876543/${HASH}`]];
      } else {
        const folders = parts[slug]?.[volume]?.map((p) => p.volume) || [volume];
        for (const folder of folders) {
          const got = await folderLines(route, `${base}${slug}/${folder}`, folder === volume ? '' : `${folder}/`);
          if (got) lines.push(...got.map(([p, ref]) => [p, `cap,${ref}`]));
        }
        if (slug === 'a2d' && volume === '31') lines.push(['647', `cl,1/${HASH}`]);
      }
      lines.sort(byPage);
      let text = lines.map(([p, rest]) => `${p},${rest}\n`).join('');
      if (slug === 'a3d' && volume === '138') {
        const head = lines.filter(([p]) => pageKey(p)[0] === 0 && Number(p) < 1000);
        const tail = lines.filter((l) => !head.includes(l));
        const body = (ls) => ls.map(([p, rest]) => `${p},${rest}\n`).join('');
        text = part === 0 ? `#parts,1000\n${body(head)}` : body(tail);
      }
      await route.fulfill({ headers: CORS, contentType: 'application/gzip', body: gzipSync(text) });
    }
    await page.route(RECORD_URL, (route) => route.fulfill({
      headers: CORS, contentType: 'application/gzip', body: gzipSync(RECORD),
    }));
    const seen = { bins: [], idx: [] };
    page.on('request', (req) => {
      if (/\.(?:bin|multi)$/.test(req.url()) && req.url().startsWith('https://idx.stare.pub/')) seen.bins.push(req.url());
      if (/\.idx\.gz$/.test(req.url())) seen.idx.push(req.url());
    });
    return seen;
  }

  test('a CAP page with a CourtListener alias line shows the CAP case, from one .idx.gz', async ({ page }) => {
    const seen = await routeIdx(page);
    await page.goto('/#a2d/31/647-01');
    await expect(page.locator('#topbar-case')).toHaveText("D'Elia & Marks Co. v. Lyon");
    await expect(page.locator('#reader .reader-source')).toHaveCount(0);
    await expect(page.locator('#sidebar [role="status"]')).toHaveText(/^\d+ case citations? found \(\d+ resolvable\)/);
    expect(seen.idx.some((u) => u.endsWith('/a2d/31.idx.gz'))).toBe(true);
    expect(seen.bins).toEqual([]);
  });

  test('250 A.3d 100 renders from its CourtListener record, with the source line', async ({ page }) => {
    const seen = await routeIdx(page);
    await page.goto('/');
    await page.fill('#landing-input', '250 A.3d 100');
    await page.click('#landing-btn');

    await expect(page).toHaveURL(/#a3d\/250\/100-01$/);
    await expect(page.locator('#topbar-case')).toHaveText('Smith v. Jones');
    await expect(page.locator('#reader .reader-meta')).toHaveText('250 A.3d 100 — Supreme Court of Pennsylvania — 2021-04-02');
    const source = page.locator('#reader .reader-source');
    await expect(source).toHaveText("From CourtListener's bulk data, export 2026-09-30 · Docket J-12-2021 · Published");
    await expect(source.locator('a')).toHaveAttribute('href', 'https://www.courtlistener.com/opinion/9876543/smith-v-jones/');
    await expect(source.locator('a')).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(page.locator('#reader .reader-author')).toHaveText(['Saylor', 'Wecht']);
    // Its citations are found and linked like a CAP case's.
    await expect(page.locator('#sidebar [role="status"]')).toHaveText('1 case citation found (1 resolvable)');
    await expect(page.locator('#reader a.cite-link', { hasText: '31 A.2d 647' })).toHaveAttribute('href', '#a2d/31/647');
    // No scans and no volume PDF for a record.
    await expect(page.locator('#tab-pages')).toBeHidden();
    await expect(page.locator('#sidebar', { hasText: 'View original PDF' })).toHaveCount(0);
    await expect(page.locator('#sidebar .sidebar-meta').first()).toContainText('Docket: J-12-2021');
    await expect(page.locator('#sidebar .sidebar-source')).toHaveText("From CourtListener's bulk data, export 2026-09-30 · Published");
    expect(seen.bins).toEqual([]);
  });

  test('a pin cite into a record opens the case at the top', async ({ page }) => {
    await routeIdx(page);
    await page.goto('/#a3d/250/100-01@103');
    await expect(page.locator('#topbar-case')).toHaveText('Smith v. Jones');
    await expect(page.locator('#reader .reader-title')).toBeInViewport();
    await expect(page.locator('#reader .page-target')).toHaveCount(0);
    await expect(page.locator('#status-bar')).toBeHidden();
  });

  test('138 A.3d 1012 comes from the later part of a split volume, in folder 138-2', async ({ page }) => {
    const seen = await routeIdx(page);
    await page.goto('/');
    await page.fill('#landing-input', '138 A.3d 1012');
    await page.click('#landing-btn');

    await expect(page).toHaveURL(/#a3d\/138-2\/1012-01$/);
    await expect(page.locator('#topbar-case')).toHaveText('Brooks v. Powers');
    await expect(page.locator('#reader .reader-text p').first()).not.toBeEmpty();
    expect(seen.idx.some((u) => u.endsWith('/a3d/138.1.idx.gz'))).toBe(true);
    expect(seen.idx.some((u) => u.endsWith('/a3d/138-2.idx.gz'))).toBe(false);
    expect(seen.bins).toEqual([]);
  });

  test.describe('with one volume\'s .idx.gz failing (#144)', () => {
    test.use({ expectedFailing: ['/a2d/31.idx.gz', '/a3d/250.idx.gz'] });
    const fail = (page, path) => page.route(`https://idx.stare.pub/**${path}`, (route) =>
      route.fulfill({ status: 503, headers: CORS, body: '' }));

    test('the reader and sidebar show a citation into it as unchecked, with no link', async ({ page }) => {
      await routeIdx(page);
      await fail(page, '/a2d/31.idx.gz');
      await page.goto('/#a3d/250/100-01');
      await expect(page.locator('#topbar-case')).toHaveText('Smith v. Jones');
      await expect(page.locator('#sidebar [role="status"]')).toHaveText('1 case citation found (0 resolvable)');
      await expect(page.locator('#sidebar .cited-case')).toHaveText(
        ["? 31 A.2d 647 Couldn't reach the index for A.2d vol. 31; reload to try again"]);
      await expect(page.locator('#sidebar .cited-case a')).toHaveCount(0);
      await expect(page.locator('#reader .cite-unknown', { hasText: '31 A.2d 647' }))
        .toHaveAttribute('title', "Couldn't reach the index for A.2d vol. 31; reload to try again");
      await expect(page.locator('#reader a', { hasText: '31 A.2d 647' })).toHaveCount(0);
    });

    test('/check shows a citation into it as unchecked, and links nothing out', async ({ page }) => {
      await routeIdx(page);
      await fail(page, '/a3d/250.idx.gz');
      await page.goto('/check');
      await page.fill('#check-input', 'See Smith v. Jones, 250 A.3d 100 (Pa. 2021).');
      await page.click('#check-btn');

      await expect(page.locator('#check-summary')).toHaveText('1 case citation found (0 resolvable)');
      await expect(page.locator('#check-cite-list .cited-case')).toHaveText(
        ["? 250 A.3d 100 Couldn't reach the index for A.3d vol. 250; reload to try again"]);
      await expect(page.locator('#check-cite-list a')).toHaveCount(0);
      await expect(page.locator('#check-rendered a')).toHaveCount(0);
    });
  });

  test('/check resolves a CourtListener hit here and links nothing out for a miss', async ({ page }) => {
    await routeIdx(page);
    await page.goto('/check');
    await page.fill('#check-input', 'See Smith v. Jones, 250 A.3d 100 (Pa. 2021); Doe v. Roe, 250 A.3d 101 (Pa. 2021).');
    await page.click('#check-btn');

    await expect(page.locator('#check-summary')).toHaveText('2 case citations found (1 resolvable)');
    await expect(page.locator('#check-cite-list .cited-case')).toHaveText([
      '✓ 250 A.3d 100',
      '✗ 250 A.3d 101 No case found at this page in A.3d vol. 250',
    ]);
    await expect(page.locator('#check-cite-list a.cited-case-link')).toHaveAttribute('href', '/#a3d/250/100-01');
    await expect(page.locator('#check-cite-list .cited-case', { hasText: '250 A.3d 101' }).locator('a')).toHaveCount(0);
  });
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
