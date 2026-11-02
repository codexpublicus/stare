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
import { BSD_2_CLAUSE, CC0, CC_BY_NC_ND, LICENSE_URLS, PUBLIC_DOMAIN_MARK } from '../src/lib/license.js';

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
    assert.match(d.temporalCoverage, /^1658\/20\d\d$/);
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
    assert.ok(Array.isArray(d.hasPart) && d.hasPart.length === 5);
    const byId = Object.fromEntries(d.hasPart.map((p) => [p['@id'], p]));
    const cap = byId['https://stare.pub/data/#cap-case-files'];
    const index = byId['https://stare.pub/data/#citation-index'];
    const reporters = byId['https://stare.pub/data/#reporter-map'];
    const citare = byId['https://stare.pub/data/#citare-data'];
    const cl = byId['https://stare.pub/data/#courtlistener-records'];
    assert.equal(cap.license, CC0.url);
    // The CourtListener records state the Public Domain Mark in `license` and credit
    // CourtListener (Free Law Project) in `attribution`; the part says the same.
    assert.equal(cl.license, PUBLIC_DOMAIN_MARK.url);
    assert.equal(cl.creditText, 'CourtListener (Free Law Project)');
    assert.equal(cl.isBasedOn.url, 'https://www.courtlistener.com/help/api/bulk-data/');
    assert.equal(cl.isBasedOn.creator.name, 'Free Law Project');
    assert.match(cl.description, new RegExp(collection.courtlistener.export));
    for (const dist of cl.distribution) {
      assert.match(dist.contentUrl, /^https:\/\/data\.stare\.pub\/cl\/c\/\d+\/[0-9a-f]{16}\.json\.gz$/);
    }
    assert.equal(cap.isBasedOn.url, 'https://case.law/');
    assert.equal(index.license, CC_BY_NC_ND.url);
    assert.equal(reporters.license, CC_BY_NC_ND.url);
    assert.equal(citare.license, CC_BY_NC_ND.url);
    for (const part of [index, reporters, citare]) {
      assert.equal(part.creditText, 'stare.pub (https://stare.pub)');
    }
    // The reporter map is based on reporters-db, the citare bundle on reporters-db
    // and courts-db, each with its BSD 2-Clause licence and copyright notice (D65),
    // and both on citare's own supplements, under CC BY-NC-ND (D67).
    const upstreams = (part) => part.isBasedOn.map((u) => [u.url, u.license, u.copyrightNotice, u.creator.name]);
    const supplements = ['https://github.com/codexpublicus/citare', CC_BY_NC_ND.url, undefined, 'Codex Publicus'];
    assert.deepEqual(upstreams(reporters), [
      ['https://github.com/freelawproject/reporters-db', BSD_2_CLAUSE.url, 'Copyright (c) 2014, Free Law Project', 'Free Law Project'],
      supplements,
    ]);
    assert.deepEqual(upstreams(citare), [
      ['https://github.com/freelawproject/reporters-db', BSD_2_CLAUSE.url, 'Copyright (c) 2014, Free Law Project', 'Free Law Project'],
      ['https://github.com/freelawproject/courts-db', BSD_2_CLAUSE.url, 'Copyright (c) 2020, Free Law Project', 'Free Law Project'],
      supplements,
    ]);
    assert.equal(reporters.isBasedOn[1].creditText, 'stare.pub (https://stare.pub)');
    // The bundle's name changes with its content, so its part has no fixed download.
    assert.equal(citare.distribution, undefined);
    assert.match(citare.description, /citare-data-<hash>\.json/);
    for (const part of d.hasPart.filter((p) => p !== citare)) {
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
    assert.deepEqual(d.distribution, d.hasPart.flatMap((p) => p.distribution ?? []));
    for (const dist of d.distribution) assert.ok([...LICENSE_URLS, PUBLIC_DOMAIN_MARK.url].includes(dist.license));
    // isBasedOn names CAP with its CC0, and CourtListener's bulk data with the Public
    // Domain Mark CourtListener puts on it. Only the CourtListener part points at
    // data.stare.pub/cl/, and nothing points at the unserved exports.
    const capSource = d.isBasedOn.find((x) => x.url === 'https://case.law/');
    assert.equal(capSource.license, CC0.url);
    const clSource = d.isBasedOn.find((x) => x.url.includes('courtlistener'));
    assert.equal(clSource.license, PUBLIC_DOMAIN_MARK.url);
    assert.equal(clSource.creator.name, 'Free Law Project');
    assert.deepEqual(d.hasPart.filter((p) => JSON.stringify(p).includes('data.stare.pub/cl')), [cl]);
    assert.ok(!JSON.stringify(d).includes('/cl/exports'));
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

  test('llms.txt and /data name reporters-db, courts-db, citare and the Public Domain Mark for the CourtListener records', () => {
    for (const text of [read('../public/llms.txt'), read('../src/pages/data.astro')]) {
      for (const url of [
        'https://github.com/freelawproject/reporters-db',
        'https://github.com/freelawproject/courts-db',
        'https://github.com/codexpublicus/citare',
        BSD_2_CLAUSE.url,
        PUBLIC_DOMAIN_MARK.url,
        'citare-data-',
      ]) {
        assert.ok(text.includes(url), url);
      }
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
