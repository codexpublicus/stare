// The agent-facing files (#161): the JSON-LD the pages embed, and llms.txt
// pointing at reporters.json, openapi.json and the schemas. The Rust tests in
// crates/stare-site/tests/agent_files.rs validate reporters.json and
// openapi.json against their schemas; web/e2e/agents.spec.js checks the
// deployed site serves them.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { collection } from '../src/lib/collection.js';
import { dataset, serialize, webSite } from '../src/lib/jsonld.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('JSON-LD', () => {
  test('the home page is a WebSite that points at llms.txt and the OpenAPI document', () => {
    const site = webSite();
    assert.equal(site['@context'], 'https://schema.org');
    assert.equal(site['@type'], 'WebSite');
    assert.equal(site.url, 'https://stare.pub/');
    const urls = site.subjectOf.map((s) => s.url);
    assert.deepEqual(urls, ['https://stare.pub/llms.txt', 'https://stare.pub/openapi.json']);
  });

  test('/data is a Dataset with the static files as its distribution', () => {
    const d = dataset();
    assert.equal(d['@type'], 'Dataset');
    assert.equal(d.isPartOf['@id'], webSite()['@id']);
    assert.equal(d.temporalCoverage, `${collection.first_year}/${collection.last_year}`);
    assert.ok(d.name && d.description && d.url);
    for (const dist of d.distribution) {
      assert.equal(dist['@type'], 'DataDownload');
      assert.match(dist.contentUrl, /^https:\/\/(stare|idx\.stare|data\.stare)\.pub\//);
      assert.match(dist.encodingFormat, /^application\//);
    }
    const urls = d.distribution.map((x) => x.contentUrl);
    assert.ok(urls.includes('https://stare.pub/reporters.json'));
    assert.ok(urls.includes('https://idx.stare.pub/manifest.json'));
  });

  test('serialize keeps a string from closing the script element', () => {
    const out = serialize({ name: '</script><script>alert(1)</script>' });
    assert.ok(!out.includes('<'));
    assert.deepEqual(JSON.parse(out), { name: '</script><script>alert(1)</script>' });
  });
});

describe('llms.txt', () => {
  const llms = read('../public/llms.txt');

  test('links the reporter map, the OpenAPI document and the reporter map\'s schema', () => {
    for (const url of [
      'https://stare.pub/reporters.json',
      'https://stare.pub/openapi.json',
      'https://stare.pub/schemas/reporters.v1.schema.json',
    ]) {
      assert.ok(llms.includes(url), url);
    }
  });
});

describe('openapi.json', () => {
  const doc = JSON.parse(read('../public/openapi.json'));

  test('names the three hosts and describes the recipe\'s three GETs', () => {
    const ids = Object.values(doc.paths).map((p) => p.get?.operationId);
    for (const id of ['getManifest', 'getVolumeIndex', 'getCapVolumeZip', 'getReporterMap']) {
      assert.ok(ids.includes(id), id);
    }
    const hosts = new Set(Object.values(doc.paths).flatMap((p) => (p.servers ?? doc.servers).map((s) => s.url)));
    assert.deepEqual([...hosts].sort(), ['https://data.stare.pub', 'https://idx.stare.pub', 'https://stare.pub']);
  });
});
