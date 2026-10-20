// The agent-facing files (#161): the JSON-LD the pages embed, and llms.txt
// pointing at reporters.json, openapi.json and the schemas. The Rust tests in
// crates/stare-site/tests/agent_files.rs validate reporters.json and
// openapi.json against their schemas; web/e2e/agents.spec.js checks the
// deployed site serves them.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collection } from '../src/lib/collection.js';
import { dataset, serialize, webSite } from '../src/lib/jsonld.js';
import { CC0, CC_BY_NC_ND, LICENSE_URLS } from '../src/lib/license.js';

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

  test('/data attaches each licence to the part of the dataset it covers', () => {
    const d = dataset();
    assert.ok(Array.isArray(d.hasPart) && d.hasPart.length === 3);
    const byId = Object.fromEntries(d.hasPart.map((p) => [p['@id'], p]));
    const cap = byId['https://stare.pub/data/#cap-case-files'];
    const index = byId['https://stare.pub/data/#citation-index'];
    const reporters = byId['https://stare.pub/data/#reporter-map'];
    assert.equal(cap.license, CC0.url);
    assert.equal(cap.isBasedOn.url, 'https://case.law/');
    assert.equal(index.license, CC_BY_NC_ND.url);
    assert.equal(reporters.license, CC_BY_NC_ND.url);
    for (const part of [index, reporters]) {
      assert.equal(part.creditText, 'stare.pub (https://stare.pub)');
    }
    for (const part of d.hasPart) {
      assert.equal(part['@type'], 'Dataset');
      assert.ok(part.name && part.description && part.url && part.publisher);
      assert.ok(part.distribution.length > 0);
      // Each download carries its part's licence.
      for (const dist of part.distribution) {
        assert.equal(dist['@type'], 'DataDownload');
        assert.equal(dist.license, part.license);
      }
    }
    // The CAP files are CAP's: data.stare.pub/cap/ and nothing else.
    for (const dist of cap.distribution) {
      assert.match(dist.contentUrl, /^https:\/\/data\.stare\.pub\/cap\//);
    }
    // The top-level distribution is the parts' downloads, so every one has a licence.
    assert.deepEqual(d.distribution, d.hasPart.flatMap((p) => p.distribution));
    for (const dist of d.distribution) assert.ok(LICENSE_URLS.includes(dist.license));
    // isBasedOn names CAP with its CC0; CourtListener's records aren't published
    // and carry no licence here.
    const capSource = d.isBasedOn.find((x) => x.url === 'https://case.law/');
    assert.equal(capSource.license, CC0.url);
    const cl = d.isBasedOn.find((x) => x.url.includes('courtlistener'));
    assert.equal(cl.license, undefined);
    assert.equal(d.url, 'https://stare.pub/data/');
    // The JSON-LD survives serialization as valid JSON with the parts intact.
    assert.deepEqual(JSON.parse(serialize(d)).hasPart.map((p) => p.license), d.hasPart.map((p) => p.license));
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

describe('licences', () => {
  // Every JSON file the site serves from web/public, and every schema, states one
  // of the two licences. reporters.json is generated; the Rust tests in
  // crates/stare-site/tests/agent_files.rs check the exported file. wasm/ is
  // wasm-pack's output, the stare code's package, which the code licence covers.
  const root = new URL('../../', import.meta.url);
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const path = join(dir, e.name);
      return e.isDirectory() ? walk(path) : [path];
    });
  const stated = (doc) => doc.license?.url ?? doc.info?.license?.url ?? doc['x-license']?.url;

  test('every published JSON file states a licence', () => {
    const files = [...walk(fileURLToPath(new URL('web/public', root))), ...walk(fileURLToPath(new URL('schemas', root)))]
      .filter((f) => f.endsWith('.json') && !f.endsWith('/web/public/reporters.json') && !f.includes('/web/public/wasm/'));
    assert.ok(files.length >= 5, files.join(', '));
    for (const file of files) {
      const url = stated(JSON.parse(readFileSync(file, 'utf8')));
      assert.ok(LICENSE_URLS.includes(url), `${file}: ${url}`);
    }
  });

  test('llms.txt and /data name both licences and stare.pub as the source', () => {
    const page = read('../src/pages/data.astro');
    for (const text of [read('../public/llms.txt'), page]) {
      assert.ok(text.includes(CC0.url));
      assert.ok(text.includes(CC_BY_NC_ND.url));
      assert.ok(text.includes('https://stare.pub)'));
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

  test('states its own licence, CC BY-NC-ND', () => {
    assert.equal(doc.info.license.url, CC_BY_NC_ND.url);
    assert.ok(doc.info.description.includes(CC0.url));
  });
});
