// Cache-Control per file class on a deployed stare.pub (#266; web/public/_headers and
// src/lib/assetcache.js). A file is immutable only when its URL changes with its content;
// everything else is revalidated on every load.
import { createHash } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { PDFJS_BASE } from '../public/js/pdfjs-path.js';

const IMMUTABLE = 'public, max-age=31536000, immutable';

async function cacheControl(request, path) {
  const response = await request.get(path);
  expect(response.status(), path).toBe(200);
  return { response, cc: response.headers()['cache-control'] ?? '' };
}

async function expectImmutable(request, path) {
  const { response, cc } = await cacheControl(request, path);
  expect(cc, path).toBe(IMMUTABLE);
  return response;
}

async function expectRevalidated(request, path) {
  const { response, cc } = await cacheControl(request, path);
  expect(cc, path).not.toContain('immutable');
  expect(cc, path).toMatch(/\bmax-age=0\b/);
  return response;
}

// What the built loader names (the build rewrites these two literals in js/wasm.js).
async function hashedWasmUrls(request) {
  const loader = await (await request.get('/js/wasm.js')).text();
  const glue = loader.match(/const GLUE_URL = '([^']+)'/)?.[1];
  const wasm = loader.match(/const WASM_URL = '([^']+)'/)?.[1];
  expect(glue).toMatch(/^\/wasm\/stare_wasm\.[0-9a-f]{16}\.js$/);
  expect(wasm).toMatch(/^\/wasm\/stare_wasm_bg\.[0-9a-f]{16}\.wasm$/);
  return { glue, wasm };
}

const sha16 = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

test('pages are revalidated', async ({ request }) => {
  for (const path of ['/', '/about/', '/check/', '/data/', '/updates/']) {
    await expectRevalidated(request, path);
  }
});

test('Astro\'s hashed CSS is immutable', async ({ request }) => {
  const html = await (await request.get('/')).text();
  const css = [...html.matchAll(/href="(\/_astro\/[^"]+\.css)"/g)].map((m) => m[1]);
  expect(css.length).toBeGreaterThan(0);
  for (const path of css) {
    expect(path).toMatch(/\.[A-Za-z0-9_-]{8}\.css$/);
    await expectImmutable(request, path);
  }
});

test('the plain-named /js/ modules are revalidated, and / preloads its import graph', async ({ request }) => {
  const html = await (await request.get('/')).text();
  const preloads = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]);
  expect(preloads).toContain('/js/main.js');
  expect(preloads).toContain('/js/wasm.js');
  for (const path of preloads) {
    expect(path).toMatch(/^\/js\/[a-z0-9-]+\.js$/);
    await expectRevalidated(request, path);
  }
});

test('the WASM module and glue are immutable under their content hashes, revalidated under their plain names', async ({ request }) => {
  const { glue, wasm } = await hashedWasmUrls(request);
  for (const [hashed, plain] of [[glue, '/wasm/stare_wasm.js'], [wasm, '/wasm/stare_wasm_bg.wasm']]) {
    const body = await (await expectImmutable(request, hashed)).body();
    expect(hashed).toContain(`.${sha16(body)}.`);
    const plainBody = await (await expectRevalidated(request, plain)).body();
    expect(sha16(plainBody)).toBe(sha16(body));
  }
  await expectRevalidated(request, '/wasm/stare_wasm_bg.json');
});

test('citare\'s data bundle and the versioned PDF.js are immutable', async ({ request }) => {
  const { data } = await (await request.get('/wasm/stare_wasm_bg.json')).json();
  await expectImmutable(request, data.url);
  await expectImmutable(request, `${PDFJS_BASE}pdf.min.mjs`);
});

test('fonts, reporters.json and the crawler files are revalidated', async ({ request }) => {
  const html = await (await request.get('/')).text();
  let font;
  for (const [, path] of html.matchAll(/href="(\/_astro\/[^"]+\.css)"/g)) {
    const css = await (await request.get(path)).text();
    font ??= css.match(/url\((['"]?)(\/fonts\/[^'")]+\.woff2)\1\)/)?.[2];
  }
  expect(font).toBeTruthy();
  for (const path of [font, '/reporters.json', '/robots.txt', '/llms.txt', '/sitemap.xml']) {
    await expectRevalidated(request, path);
  }
});
