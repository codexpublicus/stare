// Smoke checks for a deployed stare.pub (issue #81). The automated form of
// the manual preview checks in
// docs/superpowers/plans/2026-09-27-stare-infra-and-workers.md (Task 6,
// step 5), plus /check exercising citare through the WASM.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

import { test as base, expect } from '@playwright/test';

import { casesLabel, courtListener, yearRange } from '../src/lib/collection.js';
import { isAllowed, parseLlmsTxt, parseRobots } from '../src/lib/crawlfiles.js';
import { PATCH_MARKER } from '../src/lib/pdfjs-vendor.js';
import { PDFJS_BASE } from '../public/js/pdfjs-path.js';
import { parseSitemap } from '../src/lib/sitemap.js';

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
  await expect(page.locator('#check-summary')).toHaveText('1 cited case found (1 resolvable)');

  // On the next visit the bundle comes from the browser's cache: no bytes
  // transferred and no revalidation.
  await page.reload();
  await page.fill('#check-input', 'See Barney v. Oelrichs, 138 U.S. 529 (1891).');
  await page.click('#check-btn');
  await expect(page.locator('#check-summary')).toHaveText('1 cited case found (1 resolvable)');
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
  await expect(page.locator('#check-summary')).toHaveText('1 cited case found (1 resolvable)');
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
  await expect(page.locator('#check-summary')).toHaveText('1 cited case found (1 resolvable)');
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

// Notes whether #landing is rendered in any frame, from the first: the probe runs
// in requestAnimationFrame, which comes before every paint, and at
// DOMContentLoaded. `window.__landingSeen` says whether it ever was.
async function watchLanding(page) {
  await page.addInitScript(() => {
    window.__landingSeen = false;
    const probe = () => {
      const el = document.getElementById('landing');
      if (el && el.checkVisibility()) window.__landingSeen = true;
    };
    const frame = () => {
      probe();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    document.addEventListener('DOMContentLoaded', probe);
  });
}

test('a case in the hash never shows the landing, only the reader loading it', async ({ page }) => {
  await watchLanding(page);
  // Held, the WASM keeps the page loading for as long as the landing used to show.
  const release = await holdWasm(page);
  await page.goto('/#a2d/31/647-01');

  await expect(page.locator('#resolved')).toBeVisible();
  await expect(page.getByRole('progressbar', { name: /^Loading the citation parser/ })).toBeVisible();
  release();
  await expect(page.locator('#topbar-case')).toHaveText("D'Elia & Marks Co. v. Lyon");
  expect(await page.evaluate(() => window.__landingSeen)).toBe(false);
  await expect(page.locator('html')).not.toHaveAttribute('data-route');
});

test('a pin cite in the hash never shows the landing either', async ({ page }) => {
  await watchLanding(page);
  await page.goto('/#a2d/31/647-01@648');
  await expect(page.locator('#topbar-case')).toHaveText("D'Elia & Marks Co. v. Lyon");
  expect(await page.evaluate(() => window.__landingSeen)).toBe(false);
});

for (const path of ['/', '/#', '/#about']) {
  test(`${path} shows the landing straight away`, async ({ page }) => {
    await page.goto(path, { waitUntil: 'commit' });
    // Before main.js has run: the <head> script alone decides.
    await page.waitForSelector('#landing', { state: 'attached' });
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-route'))).toBeNull();
    await expect(page.locator('#landing')).toBeVisible();
    await expect(page.locator('#resolved')).toBeHidden();
  });
}

test('a case hash that does not resolve ends on the landing with the error', async ({ page }) => {
  await page.goto('/#a2d/31/99999-01');
  await expect(page.locator('#landing-status')).toHaveText(/^No case starts at page 99999\b/);
  await expect(page.locator('#landing')).toBeVisible();
  await expect(page.locator('#resolved')).toBeHidden();
  await expect(page.locator('html')).not.toHaveAttribute('data-route');
});

// A plain test: the failed loads log console errors on purpose.
base('a case hash whose WASM fails to load keeps the reader, with Retry, and opens the case on it', async ({ page }) => {
  let failing = true;
  await page.route(`**${WASM_PATH}`, (route) => (failing ? route.abort() : route.continue()));
  await page.goto('/#a2d/31/647-01');

  const alert = page.getByRole('alert');
  await expect(alert).toHaveText("Couldn't load the citation parser. Retry");
  await expect(page.locator('#resolved')).toBeVisible();
  await expect(page.locator('#landing')).toBeHidden();

  failing = false;
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('#topbar-case')).toHaveText("D'Elia & Marks Co. v. Lyon");
});

test('going back from a case to the bare URL shows the landing', async ({ page }) => {
  await page.goto('/');
  await page.click('.landing-example >> nth=0');
  await expect(page.locator('#topbar-case')).toHaveText("D'Elia & Marks Co. v. Lyon");
  await page.goBack();
  await expect(page.locator('#landing')).toBeVisible();
  await expect(page.locator('#resolved')).toBeHidden();
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
  await expect(page.locator('#check-summary')).toHaveText('1 cited case found (1 resolvable)');
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
  await expect(page.locator('#check-summary')).toHaveText('2 cited cases found (2 resolvable), 1 statute');
  // Resolvable citations first, as links to the case viewer; then the
  // statute, linked to its text. "Id." resolves through Barney, the
  // citation before it (#120), and is listed with it, one entry per
  // cited case (#159). Cited in two forms, each has its own count (D72).
  await expect(page.locator('#check-cite-list .cited-case')).toHaveText([
    '✓ 31 A.2d 647',
    '✓ 138 U.S. 529 (1×)',
    '↗ 42 U.S.C. § 1983',
  ]);
  const links = page.locator('#check-cite-list a.cited-case-link');
  await expect(links.nth(0)).toHaveAttribute('href', '/#a2d/31/647-01');
  await expect(links.nth(1)).toHaveAttribute('href', '/#us/138/529-01');
  await expect(links.nth(2)).toHaveAttribute('href', 'https://www.law.cornell.edu/uscode/text/42/1983');
  await expect(page.locator('#check-cite-list .cited-entry', { hasText: '138 U.S. 529' }).locator('.cited-count')).toHaveText('2×');
  await expect(page.locator('#check-cite-list .cited-also')).toHaveText('Also cited as Id. (1×)');
  await expect(page.locator('#check-rendered a.cite-link', { hasText: 'Id.' }))
    .toHaveAttribute('title', 'Refers to 138 U.S. 529, at 533');
});

test('/check links out only for volumes and statutes stare.pub does not hold', async ({ page }) => {
  // U.S. Reports volume 999 is decades past any printed, so no source the index
  // takes can hold it (598 U.S. 175 was the example until CourtListener's
  // volumes reached the index); the Minnesota statute links to the revisor. A.2d
  // 31 is indexed and its last case starts at page 894, so 31 A.2d 950 is a
  // miss in a held volume: a neutral note, and no outside link.
  const text = 'See Doe v. Roe, 999 U.S. 175 (2099); Minn. Stat. § 609.185; Doe v. Roe, 31 A.2d 950 (1943).';

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
  await expect(page.locator('#check-summary')).toHaveText('2 cited cases found (0 resolvable), 1 statute');
  await expect(page.locator('#check-cite-list .cited-case')).toHaveText([
    '↗ Minn. Stat. § 609.185',
    '↗ 999 U.S. 175 Not in stare.pub: may be at CourtListener or Google Scholar',
    '✗ 31 A.2d 950 No case found at this page in A.2d vol. 31',
  ]);
  await expect(page.locator('#check-cite-list .cited-case', { hasText: '31 A.2d 950' }).locator('a')).toHaveCount(0);
  await expect(page.locator('#check-rendered .cite-unresolved', { hasText: '31 A.2d 950' }))
    .toHaveAttribute('title', 'No case found at this page in A.2d vol. 31');

  const statute = page.locator('#check-cite-list a.cited-case-link');
  await expect(statute).toHaveAttribute('href', 'https://www.revisor.mn.gov/statutes/cite/609.185');
  await expect(statute).toHaveAttribute('rel', 'noopener noreferrer');

  const courtListener = page.getByRole('link', { name: 'Not in stare.pub: may be at CourtListener' });
  await expect(courtListener).toHaveAttribute('href', 'https://www.courtlistener.com/c/U.S./999/175/');
  await expect(courtListener).toHaveAttribute('target', '_blank');
  await expect(courtListener).toHaveAttribute('rel', 'noopener noreferrer');

  // In the text, the citation itself links out, styled apart from stare.pub's own links.
  const inline = page.locator('#check-rendered a.cite-lookup');
  await expect(inline).toHaveText('999 U.S. 175');
  await expect(inline).toHaveAttribute('href', 'https://www.courtlistener.com/c/U.S./999/175/');
  await expect(page.locator('#check-rendered a.cite-link', { hasText: '999 U.S. 175' })).toHaveCount(0);

  expect(outside).toEqual([]);
});

test('a U.S. Reports volume past CAP\'s resolves through CourtListener: 598 U.S. 175 opens Axon', async ({ page }) => {
  await page.goto('/check');
  await page.fill('#check-input', 'See Axon Enterprise, Inc. v. FTC, 598 U.S. 175 (2023).');
  await page.click('#check-btn');

  await expect(page.locator('#check-cite-list .cited-case')).toHaveText('✓ 598 U.S. 175');
  await expect(page.locator('#check-rendered a.cite-lookup')).toHaveCount(0);
  const link = page.locator('#check-cite-list a.cited-case-link');
  await expect(link).toHaveAttribute('href', /^\/#us\/598\/175(?:-\d+)?$/);
  await page.goto(await link.getAttribute('href'));
  await expect(page.locator('#topbar-case')).toHaveText('Axon Enterprise, Inc. v. FTC');
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
  await expect(page.locator('#check-summary')).toHaveText('0 cited cases found (0 resolvable), 2 statutes');
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
  await expect(page.locator('#check-summary')).toHaveText(/^1 cited case found/);
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
  await expect(page.locator('#sidebar [role="status"]')).toHaveText(/^\d+ cited cases? found \(\d+ resolvable\)(, \d+ statutes?)?(, \d+ other)?(, \d+ needs? review)?$/);
  const manifest = await (await page.request.get('https://idx.stare.pub/manifest.json')).json();
  if (manifest.idx !== 1) {
    expect(bins.length).toBeGreaterThan(0);
    expect(idx).toEqual([]);
  }
});

// The archival PDFs (D120, D122): the case's link opens our PDF of its volume at the
// case's first page, which is its METS ORDER (a2d/31's 647-01 is ORDER 695, where the PDF's
// bookmark for it points). Only the link is checked; nothing here fetches the PDF.
test('/#a2d/31/647-01 links the archival PDF at the case\'s page', async ({ page }) => {
  await page.goto('/#a2d/31/647-01');
  await expect(page.locator('#reader .reader-title')).toHaveText("D'Elia & Marks Co. v. Lyon");
  const link = page.locator('#sidebar #pdf-link');
  await expect(link).toHaveText(/Download archival PDF/);
  await expect(link).toHaveAttribute('href', 'https://data.stare.pub/pdf/us/a2d/31.pdf#page=695');
  await expect(page.locator('.view-tab:visible')).toHaveText(['Reader', 'Archival PDF', 'Raw Scans']);
  await expect(page.locator('#tab-reader')).toHaveClass(/active/);
  await expect(page.locator('#tab-pages')).toBeVisible();
});

// The Archival PDF view draws the case's pages of the volume's archival PDF with PDF.js,
// fetching only what they need by range request. Each response for the PDF is a 206; their
// bodies, summed from Content-Range, are what opening the case cost.
function pdfRanges(page, path) {
  const ranges = [];
  page.on('response', (r) => {
    if (r.url() !== `https://data.stare.pub/pdf/${path}`) return;
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(r.headers()['content-range'] || '');
    ranges.push({ status: r.status(), bytes: m ? Number(m[2]) - Number(m[1]) + 1 : null, total: m ? Number(m[3]) : null });
  });
  return ranges;
}

async function openArchivalPdf(page, hash, title) {
  await page.goto(`/${hash}`);
  await expect(page.locator('#reader .reader-title')).toHaveText(title);
  await page.click('#tab-pdf');
  await expect(page.locator('#tab-pdf')).toHaveClass(/active/);
  await expect(page.locator('#pdf-viewer')).toBeVisible();
  await expect(page.locator('#reader')).toBeHidden();
}

test('the Archival PDF view draws the case\'s pages with a selectable text layer, by range requests', async ({ page }) => {
  // a2d/142 148-01 (Renaire Corp. v. Vaughn) is the volume PDF's pages 184 to 187.
  const ranges = pdfRanges(page, 'us/a2d/142.pdf');
  await openArchivalPdf(page, '#a2d/142/148-01', 'Renaire Corp. v. Vaughn');
  const viewer = page.locator('#pdf-viewer');
  await expect(viewer.locator('.pdf-page')).toHaveAttribute('data-rendered', '184', { timeout: 30_000 });
  await expect(viewer.locator('#ap-page')).toHaveValue('1');
  await expect(viewer.locator('#ap-count')).toHaveText('of 4');
  await expect(viewer.locator('#ap-label')).toHaveText('p. 148');
  await expect(viewer.locator('#ap-prev')).toBeDisabled();
  const canvas = viewer.locator('canvas.pdf-page-canvas');
  const size = await canvas.evaluate((c) => ({ w: c.width, h: c.height, css: c.getBoundingClientRect().width, ratio: devicePixelRatio }));
  expect(size.w).toBeGreaterThan(300);
  expect(size.h).toBeGreaterThan(size.w);
  expect(size.w).toBe(Math.floor(size.css * size.ratio));
  // The PDF's own invisible OCR text, positioned over the image.
  const text = viewer.locator('.textLayer span');
  expect(await text.count()).toBeGreaterThan(20);
  await expect(viewer.locator('.textLayer')).toContainText('RENAIRE');

  // The keyboard steps through the case's pages and zooms.
  await page.keyboard.press('ArrowRight');
  await expect(viewer.locator('#ap-page')).toHaveValue('2');
  await expect(viewer.locator('#ap-label')).toHaveText('p. 149');
  await expect(viewer.locator('.pdf-page')).toHaveAttribute('data-rendered', '185', { timeout: 30_000 });
  await page.keyboard.press('0');
  await expect(viewer.locator('#ap-zoom')).toHaveText('100%');
  await expect(viewer.locator('#ap-actual')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('+');
  await expect(viewer.locator('#ap-zoom')).toHaveText('110%');

  // Range requests only, and a small part of the 3.3 MB file.
  expect(ranges.length).toBeGreaterThan(0);
  expect(ranges.every((r) => r.status === 206)).toBe(true);
  const fetched = ranges.reduce((n, r) => n + r.bytes, 0);
  expect(fetched).toBeLessThan(ranges[0].total / 4);
});

// The page views (#246): sized to the window, with a toolbar that stays put. a2d/142's
// 148-01 is four pages, the volume PDF's 184 to 187 and the tar's ORDERs 184 to 187,
// printed 148 to 151.
const PAGE_CASE = '#a2d/142/148-01';
const SIZES = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  laptop: { viewport: { width: 1366, height: 768 } },
  large: { viewport: { width: 2560, height: 1440 } },
};

// Open the case's page view (`#tab-pdf` or `#tab-pages`) and wait for its first page.
async function openPageView(page, tab, hash = PAGE_CASE) {
  await page.goto(`/${hash}`);
  await expect(page.locator('#reader .reader-title')).toHaveText('Renaire Corp. v. Vaughn');
  await page.click(tab);
  const el = page.locator(tab === '#tab-pdf' ? '#pdf-viewer .pdf-page' : '#page-viewer .page-wrapper');
  await expect(el).toHaveAttribute('data-rendered', /\d+/, { timeout: 30_000 });
  return el;
}

// The page's box, the page area's and the window's.
function boxes(el) {
  return el.evaluate((p) => {
    const area = p.closest('.page-viewer-image');
    const r = p.getBoundingClientRect();
    return {
      page: { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height },
      area: { width: area.clientWidth, height: area.clientHeight, scrollW: area.scrollWidth, scrollH: area.scrollHeight },
      window: { width: innerWidth, height: innerHeight, scrollY: document.scrollingElement.scrollTop },
    };
  });
}

// Wait until no more of the PDF has been fetched for a while (the next page's prefetch).
async function settle(page, ranges) {
  for (let n = -1; n !== ranges.length;) {
    n = ranges.length;
    await page.waitForTimeout(2000);
  }
}

for (const [size, use] of Object.entries(SIZES)) {
  test.describe(`the page views on a ${size} screen`, () => {
    test.use(use);

    for (const [tab, prefix] of [['#tab-pdf', 'ap'], ['#tab-pages', 'pv']]) {
      test(`${tab === '#tab-pdf' ? 'the Archival PDF' : 'the Raw Scans'} fits the page to the window`, async ({ page }) => {
        const el = await openPageView(page, tab);
        const mode = size === 'phone' ? 'width' : 'page';
        await expect(page.locator(`#${prefix}-fit-${mode}`)).toHaveAttribute('aria-pressed', 'true');
        const b = await boxes(el);
        if (size === 'phone') {
          // Fit width: the page across the view, scrolling down it.
          expect(b.page.width).toBeGreaterThan(b.area.width - 40);
          expect(b.page.right).toBeLessThanOrEqual(b.window.width);
        } else {
          // Fit page: the whole page on screen, nothing to scroll.
          expect(b.page.top).toBeGreaterThanOrEqual(0);
          expect(b.page.bottom).toBeLessThanOrEqual(b.window.height);
          expect(b.page.right).toBeLessThanOrEqual(b.window.width);
          expect(b.area.scrollH).toBeLessThanOrEqual(b.area.height);
          expect(b.area.scrollW).toBeLessThanOrEqual(b.area.width);
          expect(b.page.height).toBeGreaterThan(b.window.height / 2);
          expect(b.window.scrollY).toBe(0);
        }
        if (tab === '#tab-pdf') {
          // The canvas is drawn for the size it's shown at, not stretched.
          const c = await el.locator('canvas').evaluate((x) => ({ w: x.width, css: x.getBoundingClientRect().width, ratio: devicePixelRatio }));
          expect(Math.abs(c.css - b.page.width)).toBeLessThan(1);
          expect(Math.abs(c.w - c.css * c.ratio)).toBeLessThan(c.ratio + 1);
        }
      });
    }

    test('the toolbar stays in view when a zoomed page is scrolled', async ({ page }) => {
      const el = await openPageView(page, '#tab-pdf');
      for (let i = 0; i < 4; i++) await page.click('#ap-zoom-in');
      await expect(el).toHaveAttribute('data-scale', /.+/);
      const area = page.locator('#ap-area');
      await area.evaluate((a) => a.scrollBy(0, 600));
      await page.evaluate(() => window.scrollBy(0, 600));
      await expect(page.locator('#pdf-viewer .page-viewer-toolbar')).toBeInViewport({ ratio: 1 });
      await expect(page.locator('#ap-next')).toBeInViewport();
      expect(await area.evaluate((a) => a.scrollTop)).toBeGreaterThan(0);
    });
  });
}

test.describe('the page views\' toolbar', () => {
  test.use(SIZES.laptop);

  test('the page box goes to a page by its place or its printed number, and puts it in the hash', async ({ page }) => {
    const el = await openPageView(page, '#tab-pdf');
    await page.fill('#ap-page', '3');
    await page.press('#ap-page', 'Enter');
    await expect(el).toHaveAttribute('data-rendered', '186', { timeout: 30_000 });
    await expect(page.locator('#ap-label')).toHaveText('p. 150');
    await expect(page).toHaveURL(/#a2d\/142\/148-01~v=pdf&p=3$/);
    await page.fill('#ap-page', 'p. 149');
    await page.press('#ap-page', 'Enter');
    await expect(el).toHaveAttribute('data-rendered', '185', { timeout: 30_000 });
    await expect(page.locator('#ap-page')).toHaveValue('2');
    await page.fill('#ap-page', '9');
    await page.press('#ap-page', 'Enter');
    await expect(page.locator('#ap-page')).toHaveValue('2');
    // The Reader takes the page view out of the hash.
    await page.click('#tab-reader');
    await expect(page).toHaveURL(/#a2d\/142\/148-01$/);
  });

  test('a link to a page opens that view at that page', async ({ page }) => {
    await page.goto(`/${PAGE_CASE}~v=scans&p=2`);
    await expect(page.locator('#tab-pages')).toHaveClass(/active/);
    await expect(page.locator('#page-viewer .page-wrapper')).toHaveAttribute('data-rendered', '185', { timeout: 30_000 });
    await expect(page.locator('#pv-page')).toHaveValue('2');
    await expect(page.locator('#pv-label')).toHaveText('p. 149');
    // The other view, by the hash, on the case already shown.
    await page.evaluate(() => { location.hash = '#a2d/142/148-01~v=pdf&p=4'; });
    await expect(page.locator('#tab-pdf')).toHaveClass(/active/);
    await expect(page.locator('#pdf-viewer .pdf-page')).toHaveAttribute('data-rendered', '187', { timeout: 30_000 });
  });

  test('rotate turns the page a quarter at a time, in both views', async ({ page }) => {
    for (const [tab, prefix] of [['#tab-pdf', 'ap'], ['#tab-pages', 'pv']]) {
      const el = tab === '#tab-pdf' ? await openPageView(page, tab) : await (async () => {
        await page.click(tab);
        const w = page.locator('#page-viewer .page-wrapper');
        await expect(w).toHaveAttribute('data-rendered', /\d+/, { timeout: 30_000 });
        return w;
      })();
      const upright = await boxes(el);
      expect(upright.page.height).toBeGreaterThan(upright.page.width);
      await page.click(`#${prefix}-rotate`);
      if (tab === '#tab-pdf') await expect(el).toHaveAttribute('data-rotation', '90', { timeout: 30_000 });
      await expect(page.locator(`#${tab === '#tab-pdf' ? 'pdf' : 'page'}-viewer .page-viewer`)).toHaveAttribute('data-rotation', '90');
      const turned = await boxes(el);
      expect(turned.page.width).toBeGreaterThan(turned.page.height);
      // Still fits.
      expect(turned.page.bottom).toBeLessThanOrEqual(turned.window.height);
      await page.keyboard.press('r');
      await page.keyboard.press('r');
      await page.keyboard.press('r');
      await expect(page.locator(`#${tab === '#tab-pdf' ? 'pdf' : 'page'}-viewer .page-viewer`)).toHaveAttribute('data-rotation', '0');
    }
  });

  test('the Text button shows the OCR text, and the help lists the keys', async ({ page }) => {
    await openPageView(page, '#tab-pdf');
    const text = page.locator('#ap-text');
    await expect(text).toHaveAttribute('aria-pressed', 'false');
    const span = page.locator('#pdf-viewer .textLayer span').first();
    expect(await span.evaluate((s) => getComputedStyle(s).color)).toBe('rgba(0, 0, 0, 0)');
    await text.click();
    await expect(text).toHaveAttribute('aria-pressed', 'true');
    expect(await span.evaluate((s) => getComputedStyle(s).color)).not.toBe('rgba(0, 0, 0, 0)');
    await page.keyboard.press('?');
    await expect(page.locator('#ap-keys')).toBeVisible();
    await expect(page.locator('#ap-help')).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(page.locator('#ap-keys')).toBeHidden();
    await expect(page.locator('#ap-pdf')).toHaveAttribute('href', 'https://data.stare.pub/pdf/us/a2d/142.pdf#page=184');
  });

  test('the zoom mode is remembered for each view', async ({ page }) => {
    await openPageView(page, '#tab-pdf');
    await page.click('#ap-fit-width');
    // The link reopens the Archival PDF; it opens in the mode last chosen there.
    await page.reload();
    await expect(page.locator('#pdf-viewer .pdf-page')).toHaveAttribute('data-rendered', '184', { timeout: 30_000 });
    await expect(page.locator('#ap-fit-width')).toHaveAttribute('aria-pressed', 'true');
    await page.click('#tab-pages');
    await expect(page.locator('#pv-fit-page')).toHaveAttribute('aria-pressed', 'true');
  });

  test('the page views work with storage blocked', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
    });
    const el = await openPageView(page, '#tab-pdf');
    await page.click('#ap-fit-width');
    await expect(page.locator('#ap-fit-width')).toHaveAttribute('aria-pressed', 'true');
    await page.click('#ap-next');
    await expect(el).toHaveAttribute('data-rendered', '185', { timeout: 30_000 });
  });
});

// The text selection in the page views (#247): painted once, in one translucent colour,
// however the OCR boxes under it overlap, and copying the same text as before. The page
// is a2d/142's p. 149 (the case's page 2) at 100%; the selection runs from "whether" to
// "place" down the left column's first paragraph, by dragging the mouse.
const SELECTED = {
  pdf: 'whether appellant, the seller under a\nconditional sales contract, committed a\ntrespass in retaking the chattel from the\nhome of appellee, the purchaser. The\nquestion is governed by the law of Virginia\nwhere the purchaser lived and where the\ncontract provided the chattel should be\nkept and where the retaking took place',
  // The ALTO lines are boxes of their own, so the copy has no line breaks (as before #247).
  scans: 'whether appellant, the seller under aconditional sales contract, committed atrespass in retaking the chattel from thehome of appellee, the purchaser. Thequestion is governed by the law of Virginiawhere the purchaser lived and where thecontract provided the chattel should bekept and where the retaking took place',
};

// The client box of the first `word` in `root`'s text.
function wordBox(page, root, word) {
  return page.locator(root).evaluate((el, w) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.data.indexOf(w);
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, i + w.length);
      const b = range.getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
    }
    return null;
  }, word);
}

// The Raw Scans' OCR text is in the serif text face, which the browser fetches only once
// the text is shown; until it arrives the text is in a fallback face of other widths.
const OCR_FACE = '400 16px "Source Serif 4"';

// Open the view at p. 149 at 100%, with the OCR text shown if `text`, and drag across the
// paragraph. The drag goes where the words are once the text's face has loaded, unless
// `waitForFace` is false. Returns the view's page element.
async function selectParagraph(page, view, { text = false, waitForFace = true } = {}) {
  const pdf = view === 'pdf';
  await page.goto(`/${PAGE_CASE}~v=${view}&p=2`);
  const el = page.locator(pdf ? '#pdf-viewer .pdf-page' : '#page-viewer .page-wrapper');
  await expect(el).toHaveAttribute('data-rendered', '185', { timeout: 30_000 });
  const prefix = pdf ? 'ap' : 'pv';
  await page.click(`#${prefix}-actual`);
  if (pdf) await expect.poll(async () => Number(await el.getAttribute('data-scale')), { timeout: 30_000 }).toBeCloseTo(4 / 3, 5);
  if (text) await page.click(`#${prefix}-text`);
  const root = pdf ? '#pdf-viewer .textLayer' : '#page-viewer .alto-overlay';
  await expect(page.locator(`${root} ${pdf ? 'span' : '.alto-line'}`).first()).toBeAttached({ timeout: 30_000 });
  if (!pdf && waitForFace) await page.evaluate((face) => document.fonts.load(face, 'whether'), OCR_FACE);
  const from = await wordBox(page, root, 'whether');
  const to = await wordBox(page, root, 'place');
  await page.mouse.move(from.left + 1, (from.top + from.bottom) / 2);
  await page.mouse.down();
  await page.mouse.move(to.right - 1, (to.top + to.bottom) / 2, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator(`#${pdf ? 'pdf' : 'page'}-viewer .pv-sel-fill > div`).first()).toBeAttached();
  return el;
}

// The highlight's boxes on screen.
const paintedBoxes = (page) => page.locator('.pv-sel-fill > div').evaluateAll((d) => d.map((x) => {
  const r = x.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}));

// The colours on screen inside `boxes` (each less a 2 px edge), with the page image and the
// OCR glyphs hidden, so what's left is the page's background and the selection's painting.
async function coloursIn(page, boxes) {
  await page.addStyleTag({
    content: '.page-turn img, .pdf-page-canvas { visibility: hidden !important; } .page-viewer { --pv-ocr-text: transparent !important; }',
  });
  const shot = (await page.screenshot()).toString('base64');
  return page.evaluate(async ({ png, rects }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${png}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const k = img.width / innerWidth;
    const seen = new Set();
    for (const r of rects) {
      const x = Math.ceil((r.left + 2) * k);
      const y = Math.ceil((r.top + 2) * k);
      const w = Math.floor((r.right - 2) * k) - x;
      const h = Math.floor((r.bottom - 2) * k) - y;
      if (w <= 0 || h <= 0) continue;
      const { data } = ctx.getImageData(x, y, w, h);
      for (let i = 0; i < data.length; i += 4) seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    }
    return [...seen];
  }, { png: shot, rects: boxes });
}

// The bounding box of a list of boxes.
const around = (boxes) => boxes.reduce((a, b) => ({
  left: Math.min(a.left, b.left), top: Math.min(a.top, b.top),
  right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom),
}));

// The bounding box of the selected text in `root`, from the browser's own selection (its
// text, not the boxes of the ALTO lines it takes in whole).
const selectedBox = (page, root) => page.locator(root).evaluate((el) => {
  const sel = getSelection().getRangeAt(0);
  const rects = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!sel.intersectsNode(n)) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    if (n === sel.startContainer) range.setStart(n, sel.startOffset);
    if (n === sel.endContainer) range.setEnd(n, sel.endOffset);
    rects.push(...[...range.getClientRects()].filter((r) => r.width && r.height));
  }
  return rects.reduce((a, r) => ({
    left: Math.min(a.left, r.left), top: Math.min(a.top, r.top),
    right: Math.max(a.right, r.right), bottom: Math.max(a.bottom, r.bottom),
  }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
});

test.describe('the page views\' text selection', () => {
  test.use({ viewport: { width: 1366, height: 900 } });

  const cases = [
    ['pdf', 'light', false],
    ['pdf', 'dark', true],
    ['scans', 'light', true],
    ['scans', 'dark', true],
  ];
  for (const [view, theme, text] of cases) {
    test(`the ${view === 'pdf' ? 'Archival PDF' : 'Raw Scans'} paints a selected paragraph in one colour (${theme}, OCR text ${text ? 'shown' : 'hidden'})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await selectParagraph(page, view, { text });
      expect(await page.evaluate(() => getSelection().toString())).toBe(SELECTED[view]);
      const boxes = await paintedBoxes(page);
      // A box a line, the line's words merged: eight lines.
      expect(boxes.length).toBeGreaterThanOrEqual(8);
      expect(boxes.length).toBeLessThanOrEqual(12);
      const colours = await coloursIn(page, boxes);
      expect(colours, 'the colours under the selection').toHaveLength(1);
      // And it is the highlight, not the bare page.
      expect(colours[0]).not.toBe('255,255,255');
    });
  }

  test('the Raw Scans\' highlight stays on the selected text as the page turns and zooms', async ({ page }) => {
    await selectParagraph(page, 'scans', { text: true });
    for (const step of ['#pv-rotate', '#pv-zoom-in']) {
      await page.click(step);
      const painted = around(await paintedBoxes(page));
      const selected = await selectedBox(page, '#page-viewer .alto-overlay');
      for (const side of ['left', 'top', 'right', 'bottom']) {
        expect(Math.abs(painted[side] - selected[side]), `${step}: ${side}`).toBeLessThan(4);
      }
    }
    await expect(page.locator('#page-viewer .page-viewer')).toHaveAttribute('data-rotation', '90');
    expect(await page.evaluate(() => getSelection().toString())).toBe(SELECTED.scans);
  });

  test('the Raw Scans\' highlight moves with the OCR text when its face arrives after the selection', async ({ page }) => {
    // Hold the serif face back until the paragraph is selected in the fallback face.
    const held = [];
    await page.route('**/fonts/source-serif-4/**', (route) => { held.push(route); });
    await selectParagraph(page, 'scans', { text: true, waitForFace: false });
    expect(held.length, 'the face was fetched after the text was shown').toBeGreaterThan(0);
    const before = around(await paintedBoxes(page));
    await Promise.all(held.map((r) => r.continue()));
    await page.unroute('**/fonts/source-serif-4/**');
    await page.evaluate((face) => document.fonts.load(face, 'whether'), OCR_FACE);
    const selected = await selectedBox(page, '#page-viewer .alto-overlay');
    // The face's widths differ from the fallback's, so the text moved.
    expect(Math.abs(selected.right - before.right)).toBeGreaterThan(4);
    await expect.poll(async () => {
      const painted = around(await paintedBoxes(page));
      return Math.max(...['left', 'top', 'right', 'bottom'].map((side) => Math.abs(painted[side] - selected[side])));
    }).toBeLessThan(4);
    expect(await page.evaluate(() => getSelection().toString())).toBe(SELECTED.scans);
  });

  test('a collapsed selection clears the highlight, and forced colours keep the browser\'s own', async ({ page }) => {
    await selectParagraph(page, 'pdf');
    await page.evaluate(() => getSelection().collapseToStart());
    await expect(page.locator('#pdf-viewer .pv-sel-fill > div')).toHaveCount(0);
    await page.emulateMedia({ forcedColors: 'active' });
    await expect(page.locator('#pdf-viewer .pv-selection')).toBeHidden();
    const native = await page.locator('#pdf-viewer .textLayer span').first()
      .evaluate((s) => getComputedStyle(s, '::selection').backgroundColor);
    expect(native).not.toBe('rgba(0, 0, 0, 0)');
  });
});

test('zooming, resizing and rotating the Archival PDF fetch nothing more', async ({ page }) => {
  await page.setViewportSize(SIZES.laptop.viewport);
  const ranges = pdfRanges(page, 'us/a2d/142.pdf');
  const el = await openPageView(page, '#tab-pdf');
  await settle(page, ranges);
  const before = ranges.length;
  const bytes = ranges.reduce((n, r) => n + r.bytes, 0);

  const scale = await el.getAttribute('data-scale');
  await page.click('#ap-zoom-in');
  await expect(el).not.toHaveAttribute('data-scale', scale, { timeout: 30_000 });
  const box = await page.locator('#ap-area').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -300);
  await page.keyboard.up('Control');
  await page.click('#ap-fit-page');
  await page.setViewportSize(SIZES.large.viewport);
  await expect.poll(async () => Number(await el.getAttribute('data-scale')), { timeout: 30_000 }).toBeGreaterThan(Number(scale));
  await page.setViewportSize(SIZES.phone.viewport);
  await page.click('#ap-rotate');
  await expect(el).toHaveAttribute('data-rotation', '90', { timeout: 30_000 });
  await page.waitForTimeout(1000);

  expect(ranges.length, `fetched ${bytes} bytes, then more`).toBe(before);
});

test('PDF.js is served from the site, immutable, with the patched worker', async ({ request }) => {
  for (const name of ['pdf.min.mjs', 'pdf.worker.min.mjs', 'jbig2.wasm', 'LICENSE']) {
    const response = await request.get(`${PDFJS_BASE}${name}`);
    expect(response.status(), name).toBe(200);
    expect(response.headers()['cache-control'], name).toBe('public, max-age=31536000, immutable');
    if (name === 'pdf.worker.min.mjs') expect(await response.text()).toContain(PATCH_MARKER);
    if (name === 'jbig2.wasm') expect(response.headers()['content-type']).toBe('application/wasm');
  }
});

test('the Archival PDF view opens a case in the largest volume without fetching the volume', async ({ page }) => {
  // f2d/500 is the largest archival PDF, about 84 MB.
  const ranges = pdfRanges(page, 'us/f2d/500.pdf');
  await page.goto('/#f2d/500/49-01');
  await expect(page.locator('#reader .reader-title')).not.toBeEmpty();
  await page.click('#tab-pdf');
  const viewer = page.locator('#pdf-viewer');
  await expect(viewer.locator('.pdf-page[data-rendered]')).toBeVisible({ timeout: 30_000 });
  expect(await viewer.locator('.textLayer span').count()).toBeGreaterThan(20);
  expect(ranges.every((r) => r.status === 206)).toBe(true);
  const fetched = ranges.reduce((n, r) => n + r.bytes, 0);
  expect(ranges[0].total).toBeGreaterThan(50_000_000);
  expect(fetched).toBeLessThan(2_000_000);
});

test.describe('a scanned volume without an archival PDF', () => {
  // f-appx/660 has scans, and no PDF yet (stare-builder#24).
  test.use({ expectedMissing: ['https://data.stare.pub/pdf/us/f-appx/660.pdf'] });

  test('the Archival PDF view says so and points at the Raw Scans', async ({ page }) => {
    await page.goto('/#f-appx/660/1-01');
    await expect(page.locator('#reader .reader-title')).not.toBeEmpty();
    await page.click('#tab-pdf');
    const message = page.locator('#pdf-viewer .pdf-view-message');
    await expect(message).toContainText('The archival PDF of this volume isn\'t published yet.');
    await message.getByRole('button', { name: 'Open the Raw Scans' }).click();
    await expect(page.locator('#tab-pages')).toHaveClass(/active/);
    await expect(page.locator('#page-viewer')).toBeVisible();
  });
});

// A volume CAP published without page scans (a3d/200) says so, with no PDF link and no
// Pages tab.
test('/#a3d/200/10-01 says its volume has no page scans', async ({ page }) => {
  await page.goto('/#a3d/200/10-01');
  await expect(page.locator('#resolved')).toBeVisible();
  await expect(page.locator('#reader .reader-title')).not.toBeEmpty();
  await expect(page.locator('#sidebar #no-scans')).toContainText('No page scans exist for this volume');
  await expect(page.locator('#sidebar #pdf-link')).toHaveCount(0);
  await expect(page.locator('#tab-pdf')).toBeHidden();
  await expect(page.locator('#tab-pages')).toBeHidden();
});

// Labelled pages (#154): front matter and supplements, keyed by their label. The live
// manifest has no `idx`, so these come from the volumes' .multi files.
test('/#cai-cas/1/xxix-01 opens the case on front-matter page xxix', async ({ page }) => {
  await page.goto('/#cai-cas/1/xxix-01');
  await expect(page.locator('#topbar-case')).toHaveText('Johnston v. Ludlow');
  await expect(page.locator('#topbar-cite')).toHaveText('1 Cai. Cas. xxix');
});

for (const [input, hash, name] of [
  ['1 Cai. Cas. xxix', '#cai-cas/1/xxix-01', 'Johnston v. Ludlow'],
  ['cal-app-4th 15 Supp. 1', '#cal-app-4th/15/supp.%201-01', 'Pino v. Campo'],
]) {
  test(`"${input}" resolves to its labelled page`, async ({ page }) => {
    await page.goto('/');
    await page.fill('#landing-input', input);
    await page.click('#landing-btn');
    await expect(page.locator('#topbar-case')).toHaveText(name);
    expect(new URL(page.url()).hash).toBe(hash);
  });
}

test('short cites and Id.s in a case link to their antecedent\'s case (#120)', async ({ page }) => {
  // McCallister v. State, 2019 WY 47, cites Roe v. Board of County
  // Commissioners, 997 P.2d 1021, then "997 P.2d at 1023". Burnett v.
  // State starts at page 1023, where the short cite used to link.
  await page.goto('/#p3d/440/1078-01');
  await expect(page.locator('#reader .reader-title')).toContainText('McCallister');
  await expect(page.locator('#sidebar [role="status"]')).toHaveText(/^\d+ cited cases? found \(\d+ resolvable\)(, \d+ statutes?)?(, \d+ other)?(, \d+ needs? review)?$/);

  const roe = page.locator('#reader a.cite-link', { hasText: '997 P.2d at 1023' });
  await expect(roe).toHaveAttribute('href', '#p2d/997/1021@1023');
  await expect(roe).toHaveAttribute('title', 'Refers to 997 P.2d 1021, at 1023');
  await expect(page.locator('#reader a.cite-link[href="#p2d/997/1023"]')).toHaveCount(0);
  // The short cite is one of Roe's places, listed under Roe (#159).
  await expect(page.locator('#sidebar .cited-case', { hasText: '997 P.2d at 1023' })).toHaveCount(0);
  await expect(roe).toHaveAttribute('data-cite-form', 'short');
  const group = await page.locator('#reader a.cite-link', { hasText: /^997 P\.2d 1021$/ }).first().getAttribute('data-cite-group');
  await expect(roe).toHaveAttribute('data-cite-group', group);
  await expect(page.locator(`#sidebar .cited-entry[data-cite-group="${group}"]`)).toContainText('997 P.2d 1021');

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
  await expect(page.locator('#sidebar [role="status"]')).toHaveText(/^\d+ cited cases? found \(\d+ resolvable\)(, \d+ statutes?)?(, \d+ other)?(, \d+ needs? review)?$/);
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
    await expect(page.locator('#sidebar [role="status"]')).toHaveText(/^\d+ cited cases? found/);

    // It is listed under its parallel citation, 314 Conn. 303, which the opinion
    // gives first (#159), with its own note and its own count of places (D72); its Id.s
    // are unchecked with it, and are places of that one entry.
    const entries = page.locator('#sidebar .cited-entry', { hasText: '101 A.3d 249' });
    await expect(entries).toHaveCount(1);
    const form = entries.locator('.cited-also', { hasText: /^Also cited as 101 A\.3d 249 / });
    await expect(form).toHaveCount(1);
    await expect(form.locator('.cited-form-count')).toHaveText(/^\(\d+×\)$/);
    await expect(form.locator('.cited-also-note')).toHaveText(UNKNOWN('A.3d', 101));
    await expect(entries.locator('a', { hasText: '101 A.3d 249' })).toHaveCount(0);
    const group = await entries.getAttribute('data-cite-group');
    const ids = page.locator('#reader .cite-unknown[data-cite-form="short"]');
    expect(await ids.count()).toBeGreaterThanOrEqual(3);
    for (const g of await ids.evaluateAll((els) => els.map((el) => el.dataset.citeGroup))) expect(g).toBe(group);
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

    await expect(page.locator('#check-summary')).toHaveText('1 cited case found (0 resolvable)');
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
  // Parallel-citation aliases (#151): n-w 260, listed under the manifest's `aliases`,
  // has only Pettegrew's (260 N.W. 287 is neb/128/0783-01, from cluster 8077312's
  // citations), and a2d 31 page 648, where CAP has no case, one into a3d/138-2.
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
      manifest.reporters['ny-slip-op'] = ['2021'];
      manifest.aliases = { 'n-w': ['260'] };
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
      } else if (slug === 'ny-slip-op' && volume === '2021') {
        lines = [['1234', `cl,9876543/${HASH}`]];
      } else if (slug === 'n-w' && volume === '260') {
        lines = [['287', 'cap,neb/128/0783-01,via=cl:8077312']];
      } else {
        const folders = parts[slug]?.[volume]?.map((p) => p.volume) || [volume];
        for (const folder of folders) {
          const got = await folderLines(route, `${base}${slug}/${folder}`, folder === volume ? '' : `${folder}/`);
          if (got) lines.push(...got.map(([p, ref]) => [p, `cap,${ref}`]));
        }
        if (slug === 'a2d' && volume === '31') {
          lines.push(['647', `cl,1/${HASH}`], ['648', 'cap,a3d/138-2/1012-01,via=cl:6']);
        }
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
    await expect(page.locator('#sidebar [role="status"]')).toHaveText(/^\d+ cited cases? found \(\d+ resolvable\)/);
    expect(seen.idx.some((u) => u.endsWith('/a2d/31.idx.gz'))).toBe(true);
    expect(seen.bins).toEqual([]);
  });

  test('a labelled page resolves from the .idx.gz, after the numbered pages (#154)', async ({ page }) => {
    const seen = await routeIdx(page);
    await page.goto('/#cai-cas/1/xxix');
    await expect(page.locator('#topbar-case')).toHaveText('Johnston v. Ludlow');
    expect(seen.idx.some((u) => u.endsWith('/cai-cas/1.idx.gz'))).toBe(true);
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
    await expect(page.locator('#sidebar [role="status"]')).toHaveText('1 cited case found (1 resolvable)');
    await expect(page.locator('#reader a.cite-link', { hasText: '31 A.2d 647' })).toHaveAttribute('href', '#a2d/31/647');
    // No scans and no volume PDF for a record.
    await expect(page.locator('#tab-pdf')).toBeHidden();
    await expect(page.locator('#tab-pages')).toBeHidden();
    await expect(page.locator('#sidebar', { hasText: 'Download archival PDF' })).toHaveCount(0);
    await expect(page.locator('#sidebar .sidebar-meta').first()).toContainText('Docket: J-12-2021');
    await expect(page.locator('#sidebar .sidebar-source')).toHaveText("From CourtListener's bulk data, export 2026-09-30 · Published");
    expect(seen.bins).toEqual([]);
  });

  // A reporter CAP never had, under citare's slug for it (#153).
  test('2021 NY Slip Op 01234 resolves by citare\'s slug to its CourtListener record', async ({ page }) => {
    const seen = await routeIdx(page);
    await page.goto('/');
    await page.fill('#landing-input', '2021 NY Slip Op 01234');
    await page.click('#landing-btn');

    await expect(page).toHaveURL(/#ny-slip-op\/2021\/1234-01$/);
    await expect(page.locator('#topbar-case')).toHaveText('Smith v. Jones');
    await expect(page.locator('#reader .reader-source')).toHaveText("From CourtListener's bulk data, export 2026-09-30 · Docket J-12-2021 · Published");
    expect(seen.idx.some((u) => u.endsWith('/ny-slip-op/2021.idx.gz'))).toBe(true);
    expect(seen.bins).toEqual([]);
  });

  // A blocked case (stare-builder#17) renders in full, with a quiet provenance line.
  test('a case CourtListener blocks renders in full, with the blocked line', async ({ page }) => {
    await routeIdx(page);
    const blocked = readFileSync(new URL('../../crates/stare/tests/fixtures/cl-record-blocked.json', import.meta.url));
    await page.route(RECORD_URL, (route) => route.fulfill({
      headers: CORS, contentType: 'application/gzip', body: gzipSync(blocked),
    }));
    await page.goto('/#a3d/250/100-01');
    await expect(page.locator('#topbar-case')).toHaveText('Smith v. Jones');
    const line = 'CourtListener excludes this case from search engines. '
      + '(inferred: a redacted ID number in the text; unpublished within 30 years)';
    await expect(page.locator('#reader .reader-blocked')).toHaveText(line);
    await expect(page.locator('#sidebar .sidebar-blocked')).toHaveText(line);
    await expect(page.locator('#reader .reader-author')).toHaveText(['Saylor', 'Wecht']);
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
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
      await expect(page.locator('#sidebar [role="status"]')).toHaveText('1 cited case found (0 resolvable)');
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

      await expect(page.locator('#check-summary')).toHaveText('1 cited case found (0 resolvable)');
      await expect(page.locator('#check-cite-list .cited-case')).toHaveText(
        ["? 250 A.3d 100 Couldn't reach the index for A.3d vol. 250; reload to try again"]);
      await expect(page.locator('#check-cite-list a')).toHaveCount(0);
      await expect(page.locator('#check-rendered a')).toHaveCount(0);
    });
  });

  test('260 N.W. 287 resolves through its alias to 128 Neb. 783, labelled with its source', async ({ page }) => {
    const seen = await routeIdx(page);
    await page.goto('/');
    await page.fill('#landing-input', '260 N.W. 287');
    await page.click('#landing-btn');

    await expect(page).toHaveURL(/#neb\/128\/783-01$/);
    await expect(page.locator('#topbar-case')).toHaveText(/Pettegrew/);
    await expect(page.locator('#reader .reader-alias')).toHaveText(
      "Cited as n-w 260 287. Resolved through CourtListener's citation metadata (cluster 8077312).");
    await expect(page.locator('#reader .reader-alias')).not.toContainText(/verified/i);
    expect(seen.idx.some((u) => u.endsWith('/n-w/260.idx.gz'))).toBe(true);
    expect(seen.bins).toEqual([]);
  });

  test('/check resolves aliases with their source, and links out a miss in a volume of aliases only', async ({ page }) => {
    await routeIdx(page);
    await page.goto('/check');
    await page.fill('#check-input',
      'Pettegrew v. Pettegrew, 260 N.W. 287 (Neb. 1935); Roe v. Doe, 260 N.W. 288 (Neb. 1935); Brooks v. Powers, 31 A.2d 648.');
    await page.click('#check-btn');

    await expect(page.locator('#check-summary')).toHaveText('3 cited cases found (2 resolvable)');
    const VIA = "Resolved through CourtListener's citation metadata";
    const entry = (raw) => page.locator('#check-cite-list .cited-case', { hasText: raw });
    await expect(entry('260 N.W. 287')).toHaveText(`✓ 260 N.W. 287 ${VIA}`);
    await expect(entry('260 N.W. 287').locator('a.cited-case-link')).toHaveAttribute('href', '/#n-w/260/287-01');
    await expect(entry('31 A.2d 648')).toHaveText(`✓ 31 A.2d 648 ${VIA}`);
    // stare.pub holds nothing of N.W. 260 but the alias: a miss there links out.
    await expect(entry('260 N.W. 288').locator('a.cited-lookup-link').first()).toHaveAttribute('href', /courtlistener\.com/);
    await expect(page.locator('#check-rendered a.cite-link[data-via="cl:8077312"]')).toHaveAttribute('title', `260 N.W. 287. ${VIA}`);
  });

  test('/check resolves a CourtListener hit here and links nothing out for a miss', async ({ page }) => {
    await routeIdx(page);
    await page.goto('/check');
    await page.fill('#check-input', 'See Smith v. Jones, 250 A.3d 100 (Pa. 2021); Doe v. Roe, 250 A.3d 101 (Pa. 2021).');
    await page.click('#check-btn');

    await expect(page.locator('#check-summary')).toHaveText('2 cited cases found (1 resolvable)');
    await expect(page.locator('#check-cite-list .cited-case')).toHaveText([
      '✓ 250 A.3d 100',
      '✗ 250 A.3d 101 No case found at this page in A.3d vol. 250',
    ]);
    await expect(page.locator('#check-cite-list a.cited-case-link')).toHaveAttribute('href', '/#a3d/250/100-01');
    await expect(page.locator('#check-cite-list .cited-case', { hasText: '250 A.3d 101' }).locator('a')).toHaveCount(0);
  });

  test('a parallel run whose printings are both held lists the official one, the alias labelled (#160)', async ({ page }) => {
    await routeIdx(page);
    await page.goto('/check');
    await page.fill('#check-input', 'Pettegrew v. Pettegrew, 260 N.W. 287, 128 Neb. 783 (1935).');
    await page.click('#check-btn');

    await expect(page.locator('#check-summary')).toHaveText('1 cited case found (1 resolvable)');
    await expect(page.locator('#check-cite-list .cited-entry')).toHaveCount(1);
    await expect(page.locator('#check-cite-list .cited-case')).toHaveText('✓ 128 Neb. 783 (1×)');
    await expect(page.locator('#check-cite-list .cited-also')).toHaveText(
      "Also cited as 260 N.W. 287 (1×) Resolved through CourtListener's citation metadata");
    await expect(page.locator('#check-rendered [data-partner]')).toHaveCount(0);
  });
});

// With the live index, whichever links a reprint to its official printing (a
// CourtListener alias since v2026.10.22, or the citing text), the reprint is listed with
// it, cited once in its own form (D72).
const EITHER = (raw, official) => new RegExp(`^Also cited as ${raw.replace(/\./g, '\\.')} \\(1×\\) `
  + `(?:Resolved through CourtListener's citation metadata|Reported at ${official.replace(/\./g, '\\.')}, inferred from the citing text)$`);

test.describe('parallel citations (#160)', () => {
  // Takes `volume` of `slug` out of the live manifest, as if stare.pub held nothing of
  // it, so only the citing text links that printing to its partner. Since v2026.10.22
  // CourtListener's citation metadata links 163 A. 183 and 260 N.W. 287 to their
  // official printings, and that alias wins over the inference (D35 on #160).
  async function withoutVolume(page, slug, volume) {
    await page.route('https://idx.stare.pub/manifest.json', async (route) => {
      const manifest = await (await route.fetch()).json();
      for (const lists of [manifest.reporters, manifest.aliases]) {
        if (lists?.[slug]) lists[slug] = lists[slug].filter((v) => v !== volume);
      }
      await route.fulfill({
        headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-cache' },
        contentType: 'application/json',
        body: JSON.stringify(manifest),
      });
    });
  }

  test('a printing stare.pub doesn\'t hold resolves through the one it does, labelled as inferred', async ({ page }) => {
    await withoutVolume(page, 'a', '163');
    const outside = [];
    page.on('request', (req) => {
      if (/courtlistener|google/.test(new URL(req.url()).hostname)) outside.push(req.url());
    });
    await page.goto('/check');
    await page.fill('#check-input', 'Murray v. Hurst, 163 Md. 481, 163 A. 183 (1932).');
    await page.click('#check-btn');

    await expect(page.locator('#check-summary')).toHaveText('1 cited case found (1 resolvable)');
    await expect(page.locator('#check-cite-list .cited-entry')).toHaveCount(1);
    await expect(page.locator('#check-cite-list .cited-case')).toHaveText('✓ 163 Md. 481 (1×)');
    await expect(page.locator('#check-cite-list .cited-also')).toHaveText(
      'Also cited as 163 A. 183 (1×) Reported at 163 Md. 481, inferred from the citing text');
    const reprint = page.locator('#check-rendered a.cite-link[data-partner="163 Md. 481"]');
    await expect(reprint).toHaveText('163 A. 183');
    await expect(reprint).toHaveAttribute('href', '#md/163/481');
    await expect(reprint).toHaveAttribute('title', '163 A. 183. Reported at 163 Md. 481, inferred from the citing text');
    await expect(page.locator('#check-rendered a.cite-lookup')).toHaveCount(0);
    expect(outside).toEqual([]);
  });

  // The issue's example: Ray v. Bruce cites several decisions in an official
  // reporter stare.pub holds and a regional one it doesn't.
  test('in a case, a reprint links to the printing stare.pub holds', async ({ page }) => {
    await withoutVolume(page, 'n-w', '260');
    await page.goto('/#a2d/31/693-01');
    await expect(page.locator('#sidebar [role="status"]')).toHaveText(/^\d+ cited cases? found/);
    const reprint = page.locator('#reader a.cite-link[data-partner="128 Neb. 783"]');
    await expect(reprint).toHaveText('260 N.W. 287');
    await expect(reprint).toHaveAttribute('href', '#neb/128/783');
    await expect(reprint).toHaveAttribute('title', '260 N.W. 287. Reported at 128 Neb. 783, inferred from the citing text');
    const e = page.locator('#sidebar .cited-entry', { has: page.locator('.cited-case', { hasText: '128 Neb. 783' }) });
    await expect(e.locator('.cited-also')).toHaveText('Also cited as 260 N.W. 287 (1×) Reported at 128 Neb. 783, inferred from the citing text');
    // Cited once, in two printings: one place (#198).
    await expect(e.locator('.cited-count')).toHaveText('1×');
  });

  test('with the live index, both printings of a parallel run open one case', async ({ page }) => {
    await page.goto('/check');
    await page.fill('#check-input', 'Murray v. Hurst, 163 Md. 481, 163 A. 183 (1932).');
    await page.click('#check-btn');

    await expect(page.locator('#check-cite-list .cited-entry')).toHaveCount(1);
    await expect(page.locator('#check-cite-list .cited-case')).toHaveText('✓ 163 Md. 481 (1×)');
    await expect(page.locator('#check-cite-list .cited-also')).toHaveText(EITHER('163 A. 183', '163 Md. 481'));
    await expect(page.locator('#check-rendered a.cite-review')).toHaveCount(0);
    const reprint = page.locator('#check-rendered a.cite-link', { hasText: '163 A. 183' });
    await page.goto(`/${await reprint.getAttribute('href')}`);
    await expect(page).toHaveURL(/#md\/163\/481-01$/);
    await expect(page.locator('#topbar-case')).toHaveText('Murray v. Hurst');
  });

  // #212: 421 U.S. 1002 is an orders page twelve cert. denials start on, with no alias and
  // no parallel citation to say which one; the citing text's name picks Daye v. Bounds,
  // the eleventh, where the page alone opens the first, Lee v. United States.
  test('with the live index, a citation to a shared page opens the case its name names', async ({ page }) => {
    await page.goto('/check');
    await page.fill('#check-input', 'Daye v. Bounds, 509 F.2d 66, 68 (4th Cir.), cert. denied, 421 U.S. 1002 (1975).');
    await page.click('#check-btn');

    const link = page.locator('#check-rendered a.cite-link', { hasText: '421 U.S. 1002' });
    await expect(link).toHaveAttribute('href', '#us/421/1002-11');
    await expect(link).toHaveAttribute('title', '421 U.S. 1002. Matched by case name among the 12 cases on this page');
    const e = page.locator('#check-cite-list .cited-entry', { has: page.locator('.cited-case', { hasText: '421 U.S. 1002' }) });
    await expect(e.locator('.cited-by-name')).toHaveText('Matched by case name among the 12 cases on this page');
    await expect(e.locator('a.cited-case-link')).toHaveAttribute('href', /#us\/421\/1002-11$/);
    // The other citation is at a page one case starts on, and says nothing of names.
    await expect(page.locator('#check-cite-list .cited-by-name')).toHaveCount(1);
    await page.goto(`/${await link.getAttribute('href')}`);
    await expect(page.locator('#topbar-case')).toHaveText('Daye v. Bounds');
  });

  // D90: 455 U.S. 989 has twelve cert. denials, and CourtListener's aliases at 102 S. Ct.
  // 1612 and 71 L. Ed. 2d 848 share three of them, none of them Connecticut v. Gordon, so
  // the run alone opens Gomez v. United States. None of the three fits the name and one
  // case on the U.S. Reports page does, so every printing opens Connecticut v. Gordon.
  test('with the live index, a run whose shared cases miss the name opens the case on the official page', async ({ page }) => {
    await page.goto('/check');
    await page.fill('#check-input',
      'State v. Gordon, 185 Conn. 402, 410-11, 441 A.2d 119 (1981), cert. denied, 455 U.S. 989, 102 S. Ct. 1612, 71 L. Ed. 2d 848 (1982).');
    await page.click('#check-btn');

    const note = "Matched by case name among the 12 cases on the official page, 455 U.S. 989; the cases its parallel citations share don't include it";
    const link = page.locator('#check-rendered a.cite-link', { hasText: '455 U.S. 989' });
    await expect(link).toHaveAttribute('href', '#us/455/989-02');
    await expect(link).toHaveAttribute('title', `455 U.S. 989. ${note}`);
    for (const raw of ['102 S. Ct. 1612', '71 L. Ed. 2d 848']) {
      await expect(page.locator('#check-rendered a.cite-link', { hasText: raw })).toHaveAttribute('href', '#us/455/989-02');
    }
    const e = page.locator('#check-cite-list .cited-entry', { has: page.locator('.cited-case', { hasText: '455 U.S. 989' }) });
    await expect(e.locator('.cited-by-name')).toHaveText(note);
    await page.goto(`/${await link.getAttribute('href')}`);
    await expect(page.locator('#topbar-case')).toHaveText('Connecticut v. Gordon');
  });

  // D98 (1): 525 U.S. 1179 has fifteen cert. denials, and CourtListener gives 143 L. Ed. 2d
  // 111 to Compagnie Euralair's cluster alone, so the run's printings share only Euralair.
  // Its name has no word of State v. Shabazz's, and one case on the U.S. Reports page
  // fits, so every printing opens Shabazz v. Connecticut.
  test('with the live index, a run sharing one case the name clearly isn\'t opens the case on the official page', async ({ page }) => {
    await page.goto('/check');
    await page.fill('#check-input',
      'State v. Shabazz, 246 Conn. 746, 759, 719 A.2d 440 (1998), cert. denied, 525 U.S. 1179, 119 S. Ct. 1116, 143 L. Ed. 2d 111 (1999).');
    await page.click('#check-btn');

    const note = "Matched by case name among the 15 cases on the official page, 525 U.S. 1179; the case its parallel citations share doesn't fit the name";
    const link = page.locator('#check-rendered a.cite-link', { hasText: '525 U.S. 1179' });
    await expect(link).toHaveAttribute('href', '#us/525/1179-03');
    await expect(link).toHaveAttribute('title', `525 U.S. 1179. ${note}`);
    for (const raw of ['119 S. Ct. 1116', '143 L. Ed. 2d 111']) {
      await expect(page.locator('#check-rendered a.cite-link', { hasText: raw })).toHaveAttribute('href', '#us/525/1179-03');
    }
    const e = page.locator('#check-cite-list .cited-entry', { has: page.locator('.cited-case', { hasText: '525 U.S. 1179' }) });
    await expect(e.locator('.cited-by-name')).toHaveText(note);
    await page.goto(`/${await link.getAttribute('href')}`);
    await expect(page.locator('#topbar-case')).toHaveText('Shabazz v. Connecticut');
  });

  test('with the live index, Ray v. Bruce\'s reprint is listed with, and opens, the case it reprints', async ({ page }) => {
    await page.goto('/#a2d/31/693-01');
    await expect(page.locator('#sidebar [role="status"]')).toHaveText(/^\d+ cited cases? found/);
    const e = page.locator('#sidebar .cited-entry', { has: page.locator('.cited-case', { hasText: '128 Neb. 783' }) });
    await expect(e.locator('.cited-also')).toHaveText(EITHER('260 N.W. 287', '128 Neb. 783'));
    await expect(e.locator('.cited-count')).toHaveText('1×');
    // Grouped with 128 Neb. 783 by the case it opens (#208), and opening it on its own.
    const reprint = page.locator('#reader a.cite-link', { hasText: '260 N.W. 287' });
    await expect(reprint).toHaveAttribute('data-cite-group', await e.getAttribute('data-cite-group'));
    const href = await reprint.getAttribute('href');
    await page.goto('/');
    await page.goto(`/${href}`);
    await expect(page).toHaveURL(/#neb\/128\/783-01$/);
    await expect(page.locator('#topbar-case')).toHaveText(/Pettegrew/);
  });

  test('printings that open different cases are both shown, flagged for review', async ({ page }) => {
    await page.goto('/check');
    await page.fill('#check-input', 'Smith v. Jones, 128 Neb. 783, 31 A.2d 647 (1935). See 42 U.S.C. § 1983.');
    await page.click('#check-btn');

    await expect(page.locator('#check-summary')).toHaveText('2 cited cases found (2 resolvable), 1 statute, 1 needs review');
    const NOTE = (other) => `Cited in parallel with ${other}, which opens a different case; needs review`;
    await expect(page.locator('#check-cite-list .cited-case')).toHaveText([
      `✓ 128 Neb. 783 ${NOTE('31 A.2d 647')}`,
      `✓ 31 A.2d 647 ${NOTE('128 Neb. 783')}`,
      '↗ 42 U.S.C. § 1983',
    ]);
    await expect(page.locator('#check-cite-list .cited-entry[data-cite-category="review"]')).toHaveCount(2);
    await expect(page.locator('#check-rendered a.cite-review')).toHaveCount(2);
    await page.getByRole('button', { name: 'Needs review' }).click();
    await expect(page.locator('#check-cite-list .cited-entry:visible .cited-case')).toHaveText([
      `✓ 128 Neb. 783 ${NOTE('31 A.2d 647')}`,
      `✓ 31 A.2d 647 ${NOTE('128 Neb. 783')}`,
    ]);
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

test.describe('from a cited case to where the text cites it (#159)', () => {
  const BROOKS = '/#a3d/138-2/1012-01';
  const done = (page) => expect(page.locator('#sidebar [role="status"]')).toHaveText(/^\d+ cited cases? found/);
  // The sidebar entry whose own citation is `raw`.
  const entry = (page, raw) => page.locator('#sidebar .cited-entry', {
    has: page.locator('.cited-case', { hasText: raw }),
  });
  const places = async (page, e) => page.locator(`#reader [data-cite-group="${await e.getAttribute('data-cite-group')}"]`);
  // The places among a group's citations: a parallel run's printings share one (#198).
  const placeIds = async (all) => [...new Set(await all.evaluateAll((els) => els.map((el) => el.dataset.citePlace)))];
  const live = (page) => page.locator('#sidebar .cited-live[aria-live="polite"]');

  // `cert. denied, 261 Conn. 941, 808 A.2d 1132`: one decision cited once, in two
  // reporters, which citare v0.7.0 reads as one parallel run (citare#84). That is one
  // place in the text (#198).
  test('a case cited once, in two reporters: one place, both printings highlighted', async ({ page }) => {
    await page.goto(BROOKS);
    await done(page);
    const e = entry(page, '261 Conn. 941');
    await expect(e.locator('.cited-count')).toHaveText('1×');
    // Each printing is a form of its own, cited at that one place (D72).
    await expect(e.locator('.cited-case .cited-form-count')).toHaveText('(1×)');
    await expect(e.locator('.cited-also')).toHaveText(EITHER('808 A.2d 1132', '261 Conn. 941'));
    await e.locator('.cited-show').click();
    await expect(page.locator('#reader .cite-place')).toHaveText(['261 Conn. 941', '808 A.2d 1132']);
    const place = page.locator('#reader .cite-place-current');
    await expect(place).toHaveText(['261 Conn. 941', '808 A.2d 1132']);
    await expect(place.first()).toBeInViewport();
    await expect(e.locator('.cited-pos')).toHaveText('1 of 1');
    await expect(live(page)).toHaveText('1 of 1: 261 Conn. 941, 808 A.2d 1132');
    // Opening the cited case stays the entry's main action. Both printings are at pages
    // several cases share, and two of them are at both; the text's name, "Segreto v.
    // Bristol", picks the second at 261 Conn. 941, Segreto v. City of Bristol (#212).
    await expect(e.locator('a.cited-case-link')).toHaveAttribute('href', /#conn\/261\/941-02$/);
    await expect(e.locator('.cited-by-name'))
      .toHaveText('Matched by case name among the 2 cases its parallel citations share');
    await expect(page).toHaveURL(/#a3d\/138-2\/1012-01~c=\d+$/);
    // The reprint is grouped with 261 Conn. 941 by the case it opens (#208), and opens it on its own.
    const reprint = page.locator('#reader a.cite-link', { hasText: '808 A.2d 1132' });
    await expect(reprint).toHaveAttribute('data-cite-group', await e.getAttribute('data-cite-group'));
    const href = await reprint.getAttribute('href');
    await page.goto('/');
    await page.goto(`/${href}`);
    await expect(page).toHaveURL(/#conn\/261\/941-02$/);
    await expect(page.locator('#topbar-case')).toHaveText('Segreto v. City of Bristol');
  });

  test('a case cited several times, with supra, Id. and a footnote: every place, in order', async ({ page }) => {
    await page.goto(BROOKS);
    await done(page);
    const e = entry(page, '303 Conn. 845');
    const all = await places(page, e);
    const ids = await placeIds(all);
    const m = ids.length;
    const at = (n) => all.and(page.locator(`[data-cite-place="${ids[n]}"]`));
    expect(m).toBeGreaterThanOrEqual(5);
    await expect(e.locator('.cited-count')).toHaveText(`${m}×`);
    // Each form counts the places that cite the case in it, a run once (D72).
    const official = await placeIds(all.filter({ hasText: /^303 Conn\. 845$/ }));
    await expect(e.locator('.cited-case .cited-form-count')).toHaveText(`(${official.length}×)`);
    const reprint = await placeIds(all.filter({ hasText: /^37 A\.3d 700$/ }));
    await expect(e.locator('.cited-also', { hasText: /^Also cited as 37 A\.3d 700 / }).locator('.cited-form-count'))
      .toHaveText(`(${reprint.length}×)`);
    // Its short forms are one line for each kind, with the kind's own count (D81).
    await expect(e.locator('.cited-also[data-cite-kind="supra"]')).toHaveText('Also cited as supra (1×)');
    const idPlaces = await placeIds(all.filter({ hasText: /^id\./i }));
    await expect(e.locator('.cited-also[data-cite-kind="id"]')).toHaveText(`Also cited as Id. (${idPlaces.length}×)`);
    // Full citations, a supra and an Id., and some in a footnote.
    await expect(all.filter({ hasText: /^supra/ })).toHaveCount(1);
    await expect(all.filter({ hasText: /^Id\./ })).not.toHaveCount(0);
    for (const short of await all.filter({ hasText: /^(supra|Id\.)/ }).all()) {
      await expect(short).toHaveAttribute('data-cite-form', 'short');
    }
    const inNote = page.locator('#reader .reader-footnote').locator(`[data-cite-group="${await e.getAttribute('data-cite-group')}"]`);
    await expect(inNote).not.toHaveCount(0);

    await e.locator('.cited-show').click();
    // The first place, with all of them highlighted.
    await expect(page.locator('#reader .cite-place')).toHaveCount(await all.count());
    await expect(all.first()).toHaveClass(/\bcite-place-current\b/);
    await expect(e.locator('.cited-pos')).toHaveText(`1 of ${m}`);
    // Next goes to the second; previous from the first wraps to the last,
    // which is in the footnote.
    await e.locator('.cited-next').click();
    await expect(at(1).first()).toHaveClass(/\bcite-place-current\b/);
    await expect(e.locator('.cited-pos')).toHaveText(`2 of ${m}`);
    await e.locator('.cited-prev').click();
    await e.locator('.cited-prev').click();
    const last = at(m - 1);
    await expect(last.first()).toHaveClass(/\bcite-place-current\b/);
    await expect(last.first()).toBeInViewport();
    const note = await last.first().evaluate((el) => el.closest('.reader-footnote').dataset.footnote);
    const cited = (await last.allTextContents()).map((t) => t.trim()).join(', ');
    await expect(live(page)).toHaveText(`${m} of ${m}: ${cited}, in footnote ${note}`);
  });

  // 314 Conn. 303 is cited 85 times, most of them in short forms: a dozen pin cites,
  // Id.s to either printing, and supra. They fold into one line for each kind (D81),
  // and stepping through still goes to every place.
  test('a case cited in many short forms: one line for each kind, every place still stepped through', async ({ page }) => {
    await page.goto(BROOKS);
    await done(page);
    const e = entry(page, '314 Conn. 303');
    const all = await places(page, e);
    const m = (await placeIds(all)).length;
    await expect(e.locator('.cited-count')).toHaveText(`${m}×`);
    const kinds = e.locator('.cited-also[data-cite-kind]');
    await expect(kinds).toHaveCount(3);
    expect(await kinds.evaluateAll((els) => els.map((el) => el.dataset.citeKind))).toEqual(['id', 'supra', 'short']);
    await expect(kinds.nth(0)).toHaveText(/^Also cited as Id\. \(\d+×\)$/);
    await expect(kinds.nth(1)).toHaveText(/^Also cited as supra \(\d+×\)$/);
    await expect(kinds.nth(2)).toHaveText(/^Also cited as a short cite \(\d+×\)$/);
    await expect(kinds.nth(2)).toHaveAttribute('title', /314 Conn\. at 312/);
    // The kinds' counts add up to the places the short forms cite it at.
    const counts = (await kinds.locator('.cited-form-count').allTextContents()).map((t) => Number(t.match(/\d+/)[0]));
    const short = await placeIds(all.and(page.locator('[data-cite-form="short"]')));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(short.length);
    await e.locator('.cited-show').click();
    await expect(e.locator('.cited-pos')).toHaveText(`1 of ${m}`);
    await e.locator('.cited-prev').click();
    await expect(e.locator('.cited-pos')).toHaveText(`${m} of ${m}`);
  });

  test('[ and ] step through the places from the keyboard', async ({ page }) => {
    await page.goto(BROOKS);
    await done(page);
    const e = entry(page, '303 Conn. 845');
    const all = await places(page, e);
    const ids = await placeIds(all);
    const m = ids.length;
    await e.locator('.cited-show').focus();
    await page.keyboard.press(']');
    await expect(all.first()).toHaveClass(/\bcite-place-current\b/);
    await page.keyboard.press(']');
    await expect(e.locator('.cited-pos')).toHaveText(`2 of ${m}`);
    await page.keyboard.press('[');
    await expect(e.locator('.cited-pos')).toHaveText(`1 of ${m}`);
    const first = (await all.and(page.locator(`[data-cite-place="${ids[0]}"]`)).allTextContents()).map((t) => t.trim());
    await expect(live(page)).toHaveText(`1 of ${m}: ${first.join(', ')}`);
    await expect(e.locator('.cited-show')).toBeFocused();
  });

  test('a place has a fragment that opens the case there', async ({ page }) => {
    await page.goto(BROOKS);
    await done(page);
    const e = entry(page, '303 Conn. 845');
    const supra = (await places(page, e)).filter({ hasText: /^supra/ });
    const n = await supra.getAttribute('data-cite-n');

    await page.goto('/');
    await page.goto(`${BROOKS}~c=${n}`);
    await done(page);
    const current = page.locator('#reader .cite-place-current');
    await expect(current).toHaveText(/^supra/);
    await expect(current).toHaveAttribute('data-cite-n', n);
    await expect(current).toBeInViewport();
    await expect(entry(page, '303 Conn. 845')).toHaveClass(/\bcited-entry-active\b/);
    await expect(page).toHaveURL(new RegExp(`~c=${n}$`));

    // Another place, without reloading the case. The text's first citation opens a
    // parallel run, whose printings are one place (#198), current together.
    await page.evaluate(() => { window.location.hash = window.location.hash.replace(/~c=\d+$/, '~c=1'); });
    await expect(page.locator('#reader .cite-place-current').first()).toHaveAttribute('data-cite-n', '1');
  });

  test('hovering or focusing a citation in the text highlights its entry', async ({ page }) => {
    await page.goto(BROOKS);
    await done(page);
    const e = entry(page, '261 Conn. 941');
    await page.locator('#reader a.cite-link', { hasText: '261 Conn. 941' }).hover();
    await expect(e).toHaveClass(/\bcited-entry-hover\b/);
    await page.mouse.move(0, 0);
    await expect(e).not.toHaveClass(/\bcited-entry-hover\b/);
    await page.locator('#reader a.cite-link', { hasText: '261 Conn. 941' }).focus();
    await expect(e).toHaveClass(/\bcited-entry-hover\b/);
  });

  test('/check filters its list as you type, by name, citation or reporter, and by status', async ({ page }) => {
    const text = [
      "The court in D'Elia & Marks Co. v. Lyon, 31 A.2d 647 (D.C. Mun. Ct. App. 1943),",
      'held that residence is the test. See Barney v. Oelrichs, 138 U.S. 529 (1891).',
      'Id. at 533. See also 42 U.S.C. § 1983.',
    ].join(' ');
    await page.goto('/check');
    await page.fill('#check-input', text);
    await page.click('#check-btn');
    await expect(page.locator('#check-summary')).toHaveText('2 cited cases found (2 resolvable), 1 statute');

    const filter = page.getByRole('searchbox', { name: 'Filter cited cases' });
    const shown = page.locator('#check-cite-list .cited-entry:visible .cited-case');
    const count = page.locator('#check-cite-list').locator('xpath=..').locator('.cited-filter-count');
    await filter.fill('a.2d');
    await expect(shown).toHaveText(['✓ 31 A.2d 647']);
    await expect(count).toHaveText('1 of 3');
    await filter.fill('OELRICHS');
    await expect(shown).toHaveText(['✓ 138 U.S. 529 (1×)']);
    await filter.fill('usc 1983');
    await expect(shown).toHaveText(['↗ 42 U.S.C. § 1983']);
    await filter.fill('nothing like it');
    await expect(shown).toHaveCount(0);
    await expect(count).toHaveText('0 of 3');
    await filter.press('Escape');
    await expect(filter).toHaveValue('');
    await expect(shown).toHaveCount(3);
    await expect(count).toBeHidden();

    await page.getByRole('button', { name: 'Statutes' }).click();
    await expect(page.getByRole('button', { name: 'Statutes' })).toHaveAttribute('aria-pressed', 'true');
    await expect(shown).toHaveText(['↗ 42 U.S.C. § 1983']);
    await expect(count).toHaveText('1 of 3');
    await page.getByRole('button', { name: 'In stare.pub' }).click();
    await expect(shown).toHaveCount(3);
  });

  test('/check steps through a case\'s places from the keyboard, Id. marked as a short form', async ({ page }) => {
    await page.goto('/check');
    await page.fill('#check-input', 'See Barney v. Oelrichs, 138 U.S. 529 (1891). Id. at 533.');
    await page.click('#check-btn');
    const e = page.locator('#check-cite-list .cited-entry', { hasText: '138 U.S. 529' });
    await expect(e.locator('.cited-count')).toHaveText('2×');
    await expect(e.locator('.cited-case')).toHaveText('✓ 138 U.S. 529 (1×)');
    await expect(e.locator('.cited-also')).toHaveText('Also cited as Id. (1×)');
    await e.getByRole('button', { name: /^Show where the text cites 138 U\.S\. 529/ }).focus();
    await page.keyboard.press(']');
    await expect(page.locator('#check-rendered .cite-place-current')).toHaveText('138 U.S. 529');
    await page.keyboard.press(']');
    const id = page.locator('#check-rendered .cite-place-current');
    await expect(id).toHaveText('Id. at 533');
    await expect(id).toHaveAttribute('data-cite-form', 'short');
    await expect(page.locator('#check-cite-list ~ .cited-live')).toHaveText('2 of 2: Id. at 533 (short form)');
  });

  test('/check lists an alias-resolved citation under the case it opens, with its label', async ({ page }) => {
    // The unified index isn't published yet: the routes add it for the two volumes
    // the text cites. 260 N.W. 287 is an alias (#151) of 128 Neb. 783; cited apart
    // from it, not as its parallel, it still opens the same case and joins its entry.
    const CORS = { 'access-control-allow-origin': '*' };
    await page.route('https://idx.stare.pub/manifest.json', async (route) => {
      const manifest = await (await route.fetch()).json();
      manifest.idx = 1;
      manifest.aliases = { 'n-w': ['260'] };
      await route.fulfill({ headers: { ...CORS, 'cache-control': 'no-cache' }, contentType: 'application/json', body: JSON.stringify(manifest) });
    });
    const idx = { 'neb/128': '783,cap,0783-01\n', 'n-w/260': '287,cap,neb/128/0783-01,via=cl:8077312\n' };
    await page.route(/^https:\/\/idx\.stare\.pub\/.*\/(neb\/128|n-w\/260)\.idx\.gz$/, (route) => {
      const key = route.request().url().match(/(neb\/128|n-w\/260)\.idx\.gz$/)[1];
      return route.fulfill({ headers: CORS, contentType: 'application/gzip', body: gzipSync(idx[key]) });
    });

    await page.goto('/check');
    await page.fill('#check-input', 'Pettegrew v. Pettegrew, 128 Neb. 783 (1935). See also 260 N.W. 287.');
    await page.click('#check-btn');
    await expect(page.locator('#check-summary')).toHaveText('1 cited case found (1 resolvable)');

    const VIA = "Resolved through CourtListener's citation metadata";
    const e = page.locator('#check-cite-list .cited-entry');
    await expect(e).toHaveCount(1);
    await expect(e.locator('.cited-case')).toHaveText('✓ 128 Neb. 783 (1×)');
    await expect(e.locator('.cited-also')).toHaveText(`Also cited as 260 N.W. 287 (1×) ${VIA}`);
    await expect(e).not.toContainText(/verified/i);
    await expect(e.locator('.cited-count')).toHaveText('2×');
    await e.locator('.cited-show').click();
    await e.locator('.cited-next').click();
    const alias = page.locator('#check-rendered .cite-place-current');
    await expect(alias).toHaveText('260 N.W. 287');
    await expect(alias).toHaveAttribute('title', `260 N.W. 287. ${VIA}`);
  });
});

// The crawler files (#171, #161): served as text and XML, and parsing as they do
// in the build.
test('/robots.txt is served as text, disallows /c/ but the curated cases, and names the sitemap', async ({ request }) => {
  const response = await request.get('/robots.txt');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('text/plain; charset=utf-8');
  const body = await response.body();
  // Google reads the first 500 KiB and drops the rest.
  expect(body.length).toBeLessThanOrEqual(500 * 1024);
  const { groups, sitemaps } = parseRobots(body.toString('utf8'));
  const all = groups.find((g) => g.agents.includes('*'));
  expect(all.signals).toEqual({ search: 'yes', 'ai-input': 'yes' });
  expect(isAllowed(all, '/c/')).toBe(false);
  expect(isAllowed(all, '/c/zz-not-curated/1/1/')).toBe(false);
  expect(isAllowed(all, '/about/')).toBe(true);
  expect(sitemaps).toEqual(['https://stare.pub/sitemap.xml']);
});

test('/sitemap.xml is served as XML, lists the site pages, and its cases are the ones robots.txt allows', async ({ request }) => {
  const response = await request.get('/sitemap.xml');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('application/xml; charset=utf-8');
  const locs = parseSitemap(await response.text()).map((u) => u.loc);
  expect(locs).toEqual(expect.arrayContaining(['https://stare.pub/', 'https://stare.pub/about/', 'https://stare.pub/check/']));
  const all = parseRobots(await (await request.get('/robots.txt')).text()).groups.find((g) => g.agents.includes('*'));
  for (const loc of locs) expect(isAllowed(all, new URL(loc).pathname), loc).toBe(true);
});

test('/llms.txt is served as UTF-8 text in llmstxt.org\'s shape', async ({ request }) => {
  const response = await request.get('/llms.txt');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('text/plain; charset=utf-8');
  const { title, sections } = parseLlmsTxt(await response.text());
  expect(title).toBe('stare.pub');
  expect(sections.map((s) => s.name)).toContain('Resolving a citation');
});

test.describe('CourtListener credited as a source (#206)', () => {
  const PDM = 'https://creativecommons.org/publicdomain/mark/1.0/';

  test('/about names CourtListener beside CAP, with its terms and the export the index uses', async ({ page }) => {
    await page.goto('/about');
    const main = page.locator('.page');
    await expect(main.locator('a[href="https://www.courtlistener.com/"]').first()).toBeVisible();
    await expect(main.locator('a[href="https://www.courtlistener.com/help/api/bulk-data/"]').first()).toBeVisible();
    await expect(main.locator(`a[href="${PDM}"]`).first()).toBeVisible();
    await expect(main).toContainText(`CourtListener's export of ${courtListener.export}`);
    await expect(main).toContainText('static data you can host yourself');
  });

  test('/data describes the CourtListener records, the cl lines and the aliases, and no export files', async ({ page }) => {
    await page.goto('/data');
    await expect(page.locator('#sources')).toBeVisible();
    await expect(page.locator('#files')).toBeVisible();
    const main = page.locator('.page');
    await expect(main).toContainText('1,cl,4893133/62f253f296600fb7');
    await expect(main).toContainText('via=cl:8077312');
    await expect(main).toContainText(`${courtListener.records.toLocaleString('en-US')} of them`);
    await expect(main.locator('a[href^="https://data.stare.pub/cl/c/"]')).toHaveCount(1);
    expect(await page.content()).not.toContain('/cl/exports');
  });

  test('the footer lists the sources the live index manifest names', async ({ page, request }) => {
    const manifest = await (await request.get('https://idx.stare.pub/manifest.json')).json();
    const names = (manifest.based_on ?? []).map((s) => s.name);
    expect(names.some((n) => n.includes('CourtListener'))).toBe(true);
    await page.goto('/about');
    await expect(page.locator('footer [data-site-data-line]')).toHaveText(`Index ${manifest.version} · Sources: ${names.join(', ')}`);
  });

  test('1 F.4th 1, a case only CourtListener has, opens from its live record with the source line', async ({ page }) => {
    const record = page.waitForResponse((r) => r.url() === 'https://data.stare.pub/cl/c/4893133/62f253f296600fb7.json.gz');
    await page.goto('/');
    await page.fill('#landing-input', '1 F.4th 1');
    await page.click('#landing-btn');
    expect((await record).status()).toBe(200);
    await expect(page.locator('#topbar-case')).toHaveText('Alexander Khochinsky v. Republic of Poland');
    const source = page.locator('#reader .reader-source');
    await expect(source).toContainText("From CourtListener's bulk data, export 2026-09-30");
    await expect(source.locator('a')).toHaveAttribute('href', 'https://www.courtlistener.com/opinion/4893133/alexander-khochinsky-v-republic-of-poland/');
  });
});
