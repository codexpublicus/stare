import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SEARCH_CLIENT_DIRS, searchClientUrl } from '../public/js/searchclient-path.js';
import { clientFilters } from '../public/js/searchquery.js';
import { clientDirNames, clientPins, readPins, verifyVendored } from '../src/lib/searchvendor.js';
import { EXPECTED, TREES, TREE_PATH, treeFetch } from './fixtures/searchtree.js';

// The search page ranks with stare-builder's reference client, vendored unchanged
// (src/lib/searchvendor.js), one copy per search format. These fail when a copy drifts from
// its pin, and run each copy on the fixture tree of its format against what stare-builder's
// own client returned for the same queries at that commit (fixtures/search-expected.json and
// search-expected-format3.json; fixtures/README.md says how they were made).

const VENDOR = fileURLToPath(new URL('../src/vendor/', import.meta.url));
const BASE = `https://idx.test/${TREE_PATH}`;
const PINS = readPins(VENDOR);
// The vendored directory of each format's client: { 2: 'stare-search-format2', 3: 'stare-search' }.
const CLIENT_DIRS = Object.fromEntries(clientPins(PINS).map(([dir, pin]) => [pin.format_version, dir]));

test('the vendored clients are byte for byte the pinned commits', () => {
  assert.deepEqual(verifyVendored(VENDOR), []);
  // every file in the vendored directories is pinned, so nothing unpinned rides along
  for (const [dir, pin] of Object.entries(PINS)) {
    const files = readdirSync(join(VENDOR, dir)).filter((f) => f !== 'README.md').sort();
    assert.deepEqual(files, Object.keys(pin.files).sort(), dir);
  }
});

test('there is a client for formats 2 and 3, and only those', () => {
  assert.deepEqual(Object.keys(CLIENT_DIRS).map(Number).sort(), [2, 3]);
  assert.deepEqual(Object.keys(SEARCH_CLIENT_DIRS).map(Number).sort(), [2, 3]);
});

test('the clients\' URLs name the pinned commits', () => {
  assert.deepEqual(SEARCH_CLIENT_DIRS, clientDirNames(PINS));
  assert.equal(searchClientUrl(2), `/${SEARCH_CLIENT_DIRS[2]}/search.js`);
  assert.equal(searchClientUrl(3), `/${SEARCH_CLIENT_DIRS[3]}/search.js`);
  assert.equal(searchClientUrl(1), null);
  assert.equal(searchClientUrl(4), null);
  assert.equal(searchClientUrl(undefined), null);
  assert.equal(searchClientUrl('toString'), null);
});

// A vendored search.mjs imports '@roaringbuckets/client'; lay the copies out so Node
// resolves it, as stare-builder's own test does with a checkout.
async function loadClient(dirName) {
  const dir = mkdtempSync(join(tmpdir(), 'stare-search-'));
  cpSync(join(VENDOR, dirName), join(dir, 'client'), { recursive: true });
  const pkg = join(dir, 'client', 'node_modules', '@roaringbuckets', 'client');
  mkdirSync(pkg, { recursive: true });
  cpSync(join(VENDOR, 'roaringbuckets-client'), pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@roaringbuckets/client', type: 'module', exports: { '.': './index.js' } }));
  writeFileSync(join(dir, 'client', 'package.json'), JSON.stringify({ type: 'module' }));
  return import(pathToFileURL(join(dir, 'client', 'search.mjs')).href);
}

const clients = { 2: loadClient(CLIENT_DIRS[2]), 3: loadClient(CLIENT_DIRS[3]) };
const clientPromise = clients[2];
const round = (x) => Math.round(x * 1e9) / 1e9;

for (const format of [2, 3]) {
  const { root, expected } = TREES[format];
  for (const want of expected) {
    const label = `${JSON.stringify(want.q)}${want.filters ? ` ${JSON.stringify(want.filters)}` : ''}${want.limit ? ` limit ${want.limit}` : ''}`;
    test(`format ${format}: ranks ${label} as stare-builder's client does`, async () => {
      const client = await clients[format];
      const s = await client.openSearch(BASE, { fetch: treeFetch(undefined, root) });
      const r = await client.search(s, want.q, { filters: want.filters ?? {}, limit: want.limit ?? 20 });
      assert.deepEqual(
        { total: r.total, exact: r.exact, stage: r.stage, relaxed: r.relaxed, tokens: r.tokens },
        { total: want.total, exact: want.exact, stage: want.stage, relaxed: want.relaxed, tokens: want.tokens },
      );
      assert.deepEqual((r.ranked ?? []).map((h) => [h.id, round(h.score)]), want.ranked);
      assert.deepEqual(r.hits.slice(0, 20).map((h) => h.card), want.cards);
    });
  }
}

test('each client opens only its own format\'s tree', async () => {
  for (const [mine, other] of [[2, 3], [3, 2]]) {
    const client = await clients[mine];
    const s = await client.openSearch(BASE, { fetch: treeFetch(undefined, TREES[mine].root) });
    assert.equal(s.meta.format_version, mine);
    await assert.rejects(
      client.openSearch(BASE, { fetch: treeFetch(undefined, TREES[other].root) }),
      new RegExp(`unsupported search format stare-search ${other}`),
    );
  }
});

// Format 3 ranks by citation counts. In the made-up corpus ny/1/13-02, Palsgraf v. Elevator
// Co., is cited 5,000 times through the crosswalk (stare-builder's tests/fixture.py), and
// the other Palsgraf cases far less or not at all.
const firstCards = async (format, q, n = 5) => {
  const client = await clients[format];
  const s = await client.openSearch(BASE, { fetch: treeFetch(undefined, TREES[format].root) });
  return (await client.search(s, q, { limit: n })).hits.map((h) => h.card);
};

test('format 3: a party name ranks the most cited case of that name first', async () => {
  for (const q of ['palsgraf elevator', 'Palsgraf v. Elevator Co.', 'palsgraf']) {
    const cards = await firstCards(3, q);
    assert.equal(cards[0].r, 'ny/1/13-02', q);
    assert.equal(cards[0].n, 'Palsgraf v. Elevator Co.', q);
  }
  // format 2 had no citation counts from CourtListener, and ranks it elsewhere
  assert.notEqual((await firstCards(2, 'palsgraf'))[0].r, 'ny/1/13-02');
});

test('format 3: every token of a party name counts at the top level, so cases of that name tie but for their citations', async () => {
  const client = await clients[3];
  const s = await client.openSearch(BASE, { fetch: treeFetch(undefined, TREES[3].root) });
  const r = await client.search(s, 'palsgraf elevator', { limit: 20 });
  const named = r.hits.filter((h) => h.card.n === 'Palsgraf v. Elevator Co.');
  assert.ok(named.length >= 3);
  // the cases named Palsgraf v. Elevator Co. come before any that aren't
  assert.deepEqual(r.hits.slice(0, named.length).map((h) => h.card.n), named.map(() => 'Palsgraf v. Elevator Co.'));
  // and the uncited ones among them score the same, whatever their texts say
  const scores = new Map(r.ranked.map((h) => [h.id, h.score]));
  const rest = named.slice(1).map((h) => round(scores.get(h.id)));
  assert.equal(new Set(rest).size, 1, `uncited Palsgraf v. Elevator Co. scores: ${rest}`);
  assert.ok(round(scores.get(named[0].id)) > rest[0]);
});

const FACETS = JSON.parse((await import('node:fs')).readFileSync(new URL('./fixtures/search-tree/v/v2026.10.26/search/facets.json', import.meta.url), 'utf8'));

async function rangeSearch(q, state, limit = 20) {
  const client = await clientPromise;
  const s = await client.openSearch(BASE, { fetch: treeFetch() });
  return client.search(s, q, { filters: clientFilters(state, FACETS), limit });
}

async function cardYears(ids) {
  const client = await clientPromise;
  const s = await client.openSearch(BASE, { fetch: treeFetch() });
  const cards = s.meta.files.cards;
  const { stride } = cards;
  const get = await client.readRanges(s, cards, ids.map((id) => ({ start: id * stride, end: (id + 1) * stride })));
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
