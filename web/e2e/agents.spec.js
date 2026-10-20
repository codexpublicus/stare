// The files stare.pub publishes for agents (#161), checked on the deployed
// site: the build emitted them, they're served as JSON, and the pages carry
// their JSON-LD.
import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

const SCHEMAS = ['reporters.v1.schema.json', 'index-report.v1.schema.json', 'reports-index.v1.schema.json'];

test('/reporters.json maps abbreviations to slugs, with volumes and URL templates', async ({ request }) => {
  const response = await request.get('/reporters.json');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(/^application\/json\b/);
  const map = await response.json();
  expect(map.$schema).toBe('https://stare.pub/schemas/reporters.v1.schema.json');
  expect(map.format).toBe(1);
  expect(map.abbreviations['A.2d']).toEqual(['a2d']);
  expect(map.abbreviations['A. 2d']).toEqual(['a2d']);
  expect(map.reporters.a2d.cap).toBe(true);
  expect(map.reporters.a2d.volumes.first).toBe('31');
  expect(map.urls.index).toBe('https://idx.stare.pub/{base}{slug}/{volume}.idx.gz');
  expect(map.generated_from.index_build.version).toMatch(/^v\d{4}\.\d{2}\.\d{2}/);
  expect(map.generated_from.citare_data).toMatch(/^citare-data-[0-9a-f]{16}\.bin$/);
  expect(map.license.url).toBe('https://creativecommons.org/licenses/by-nc-nd/4.0/');
  expect(map.license.source).toBe('https://stare.pub');
});

test('/openapi.json is the OpenAPI document in the repo', async ({ request }) => {
  const response = await request.get('/openapi.json');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(/^application\/json\b/);
  const local = JSON.parse(readFileSync(new URL('../public/openapi.json', import.meta.url), 'utf8'));
  expect(await response.json()).toEqual(local);
});

test('the JSON Schemas are published at their $id', async ({ request }) => {
  for (const name of SCHEMAS) {
    const response = await request.get(`/schemas/${name}`);
    expect(response.status(), name).toBe(200);
    expect(response.headers()['content-type'], name).toMatch(/^application\/json\b/);
    const schema = await response.json();
    expect(schema.$id).toBe(`https://stare.pub/schemas/${name}`);
    expect(schema['x-license'].url, name).toBe('https://creativecommons.org/licenses/by-nc-nd/4.0/');
  }
});

async function jsonLd(page, path) {
  await page.goto(path);
  const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
  return blocks.map((b) => JSON.parse(b));
}

test('/ has WebSite JSON-LD and /data has Dataset JSON-LD', async ({ page }) => {
  const [site] = await jsonLd(page, '/');
  expect(site['@type']).toBe('WebSite');
  expect(site.url).toBe('https://stare.pub/');
  const [data] = await jsonLd(page, '/data');
  expect(data['@type']).toBe('Dataset');
  const urls = data.distribution.map((d) => d.contentUrl);
  expect(urls).toContain('https://stare.pub/reporters.json');
  expect(urls).toContain('https://idx.stare.pub/manifest.json');
  expect(data.hasPart.map((p) => p.license).sort()).toEqual([
    'https://creativecommons.org/licenses/by-nc-nd/4.0/',
    'https://creativecommons.org/licenses/by-nc-nd/4.0/',
    'https://creativecommons.org/publicdomain/zero/1.0/',
  ]);
});

test('/llms.txt links the agent files', async ({ request }) => {
  const text = await (await request.get('/llms.txt')).text();
  for (const url of ['https://stare.pub/reporters.json', 'https://stare.pub/openapi.json']) {
    expect(text).toContain(url);
  }
});
