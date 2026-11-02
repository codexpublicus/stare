import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SEARCH_CLIENT_DIR } from '../public/js/searchclient-path.js';
import { clientFilters, encodeRoaring, rangeDataset } from '../public/js/searchquery.js';
import { clientDirName, readPins, verifyVendored } from '../src/lib/searchvendor.js';
import { EXPECTED, TREE_PATH, treeFetch } from './fixtures/searchtree.js';

// The search page ranks with stare-builder's reference client, vendored unchanged
// (src/lib/searchvendor.js). These fail when a copy drifts from its pin, and run the
// copies on the fixture tree against what stare-builder's own client returned for the same
// queries at that commit (fixtures/search-expected.json; fixtures/README.md says how it
// was made).

const VENDOR = fileURLToPath(new URL('../src/vendor/', import.meta.url));
const BASE = `https://idx.test/${TREE_PATH}`;

test('the vendored client is byte for byte the pinned commits', () => {
  assert.deepEqual(verifyVendored(VENDOR), []);
  const pins = readPins(VENDOR);
  // every file in the vendored directories is pinned, so nothing unpinned rides along
  for (const [dir, pin] of Object.entries(pins)) {
    const files = readdirSync(join(VENDOR, dir)).filter((f) => f !== 'README.md').sort();
    assert.deepEqual(files, Object.keys(pin.files).sort(), dir);
  }
});

test('the client\'s URL names the pinned commits', () => {
  assert.equal(SEARCH_CLIENT_DIR, clientDirName(readPins(VENDOR)));
});

// The vendored search.mjs imports '@roaringbuckets/client'; lay the copies out so Node
// resolves it, as stare-builder's own test does with a checkout.
async function loadClient() {
  const dir = mkdtempSync(join(tmpdir(), 'stare-search-'));
  cpSync(join(VENDOR, 'stare-search'), join(dir, 'client'), { recursive: true });
  const pkg = join(dir, 'client', 'node_modules', '@roaringbuckets', 'client');
  mkdirSync(pkg, { recursive: true });
  cpSync(join(VENDOR, 'roaringbuckets-client'), pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@roaringbuckets/client', type: 'module', exports: { '.': './index.js' } }));
  writeFileSync(join(dir, 'client', 'package.json'), JSON.stringify({ type: 'module' }));
  const search = await import(pathToFileURL(join(dir, 'client', 'search.mjs')).href);
  const rb = await import(pathToFileURL(join(pkg, 'index.js')).href);
  return { ...search, decodeRoaring: rb.decodeRoaring };
}

const clientPromise = loadClient();
const round = (x) => Math.round(x * 1e9) / 1e9;

for (const want of EXPECTED) {
  const label = `${JSON.stringify(want.q)}${want.filters ? ` ${JSON.stringify(want.filters)}` : ''}${want.limit ? ` limit ${want.limit}` : ''}`;
  test(`ranks ${label} as stare-builder's client does`, async () => {
    const client = await clientPromise;
    const s = await client.openSearch(BASE, { fetch: treeFetch() });
    const r = await client.search(s, want.q, { filters: want.filters ?? {}, limit: want.limit ?? 20 });
    assert.deepEqual(
      { total: r.total, exact: r.exact, stage: r.stage, relaxed: r.relaxed, tokens: r.tokens },
      { total: want.total, exact: want.exact, stage: want.stage, relaxed: want.relaxed, tokens: want.tokens },
    );
    assert.deepEqual((r.ranked ?? []).map((h) => [h.id, round(h.score)]), want.ranked);
    assert.deepEqual(r.hits.slice(0, 20).map((h) => h.card), want.cards);
  });
}

test('encodeRoaring writes what decodeRoaring reads', async () => {
  const { decodeRoaring } = await clientPromise;
  const cases = [
    [],
    [0],
    [1, 2, 3, 65535, 65536, 70000, 4294967295],
    Array.from({ length: 5000 }, (_, i) => i * 3), // past 4096 in the first container: a bitmap
    Array.from({ length: 9000 }, (_, i) => 131072 + i),
  ];
  for (const values of cases) {
    const u = Uint32Array.from(values);
    assert.deepEqual([...decodeRoaring(encodeRoaring(u))], values);
  }
});

const FACETS = JSON.parse((await import('node:fs')).readFileSync(new URL('./fixtures/search-tree/v/v2026.10.26/search/facets.json', import.meta.url), 'utf8'));

async function rangeSearch(q, state, limit = 20) {
  const client = await clientPromise;
  const s = await client.openSearch(BASE, { fetch: treeFetch() });
  const years = FACETS.years.map((y) => y.key).sort();
  const byKey = new Map(FACETS.courts.map((c) => [c.key, c.years]));
  const ranged = { ...s, ds: rangeDataset(s.ds, { years, courtYears: (k) => byKey.get(k) ?? null, decode: client.decodeRoaring }) };
  return client.search(ranged, q, { filters: clientFilters(state, FACETS), limit });
}

async function cardYears(ids) {
  const client = await clientPromise;
  const s = await client.openSearch(BASE, { fetch: treeFetch() });
  const { path, stride } = s.meta.files.cards;
  const get = await client.readRanges(s, path, ids.map((id) => ({ start: id * stride, end: (id + 1) * stride })));
  const dec = new TextDecoder();
  return new Map(ids.map((id) => [id, JSON.parse(dec.decode(get(id * stride, (id + 1) * stride)).trimEnd())]));
}

test('a year range finds the decisions of those years, and no others', async () => {
  const all = EXPECTED.find((e) => e.q === 'contract' && e.limit === 10000);
  const cards = await cardYears(all.ranked.map(([id]) => id));
  const inRange = all.ranked.map(([id]) => id).filter((id) => {
    const y = cards.get(id).d.slice(0, 4);
    return y >= '1925' && y <= '1934';
  });
  const r = await rangeSearch('contract', { from: '1925', to: '1934' }, 10000);
  assert.equal(r.exact, true);
  assert.deepEqual(r.ranked.map((h) => h.id).sort((a, b) => a - b), inRange.sort((a, b) => a - b));
});

test('a court and a year range read the court\'s years only', async () => {
  const all = EXPECTED.find((e) => e.q === 'contract' && e.limit === 10000);
  const cards = await cardYears(all.ranked.map(([id]) => id));
  const want = all.ranked.map(([id]) => id).filter((id) => {
    const c = cards.get(id);
    return c.r.startsWith('ny/') && c.d.slice(0, 4) >= '1925' && c.d.slice(0, 4) <= '1927';
  });
  const r = await rangeSearch('contract', { court: 'ny', from: '1925', to: '1927' }, 10000);
  assert.deepEqual(r.ranked.map((h) => h.id).sort((a, b) => a - b), want.sort((a, b) => a - b));
});

test('a one-year range is the format\'s own year key', async () => {
  const want = EXPECTED.find((e) => e.q === 'contract' && e.filters?.year === '1925');
  assert.deepEqual(clientFilters({ court: 'ny', from: '1925', to: '1925' }, null), { court: 'ny', year: '1925' });
  const r = await rangeSearch('contract', { court: 'ny', from: '1925', to: '1925' });
  assert.deepEqual(r.ranked.map((h) => [h.id, round(h.score)]), want.ranked);
});
