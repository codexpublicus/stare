import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expandIncludes, loadFilterLists, looksLikeFilterList } from '../checks/filterlists.js';
import { SITE, dataUrls } from '../checks/siteurls.js';

// The filter-list check's plumbing (web/checks/, #265), without the network.
const LIST = `[Adblock Plus 2.0]\n${Array.from({ length: 200 }, (_, i) => `/rule${i}.js`).join('\n')}\n`;
const LISTS = [{ name: 'one', urls: ['https://a.example/one.txt', 'https://b.example/one.txt'] }];

test('a filter list is told from an error page', () => {
  assert.equal(looksLikeFilterList(LIST), true);
  assert.equal(looksLikeFilterList(`<!DOCTYPE html>\n${LIST}`), false);
  assert.equal(looksLikeFilterList('<link rel=alternate>\n' + LIST), false);
  assert.equal(looksLikeFilterList('! Title: short\n/x.js\n'), false);
});

test('!#include lines are replaced by the file, from the list\'s directory only', async () => {
  const fetched = [];
  const text = await expandIncludes('a\n!#include part-2.txt\n!#include ../other.txt\nb', 'https://x.example/filters/filters.txt',
    async (url) => { fetched.push(url); return 'included'; });
  assert.equal(text, 'a\nincluded\n!#include ../other.txt\nb');
  assert.deepEqual(fetched, ['https://x.example/filters/part-2.txt']);
});

function withCache(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'stare-filterlists-'));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('a list is fetched, cached, and read from the cache for a day', () => withCache(async (dir) => {
  const urls = [];
  const fetcher = async (url) => { urls.push(url); return LIST; };
  const [first] = await loadFilterLists({ cacheDir: dir, lists: LISTS, fetcher });
  assert.equal(first.source, 'https://a.example/one.txt');
  const [again] = await loadFilterLists({ cacheDir: dir, lists: LISTS, fetcher });
  assert.equal(again.source, join(dir, 'one.txt'));
  assert.equal(again.text, LIST);
  assert.equal(urls.length, 1);
}));

test('a failing URL falls back to the next, then to a copy under two weeks old, then fails', () => withCache(async (dir) => {
  const down = async () => { throw new Error('down'); };
  const [mirror] = await loadFilterLists({
    cacheDir: dir, lists: LISTS, fetcher: async (url) => { if (url.startsWith('https://a.')) throw new Error('down'); return LIST; },
  });
  assert.equal(mirror.source, 'https://b.example/one.txt');

  const file = join(dir, 'one.txt');
  const daysAgo = (n) => (Date.now() - n * 86_400_000) / 1000;
  utimesSync(file, daysAgo(3), daysAgo(3));
  const warnings = [];
  const [stale] = await loadFilterLists({ cacheDir: dir, lists: LISTS, fetcher: down, warn: (w) => warnings.push(w) });
  assert.equal(stale.text, LIST);
  assert.match(warnings[0], /^one: using the cached copy from 7\d hours ago; down; down$/);

  utimesSync(file, daysAgo(15), daysAgo(15));
  await assert.rejects(loadFilterLists({ cacheDir: dir, lists: LISTS, fetcher: down }), /one: couldn't fetch it/);

  // An error page is never cached.
  writeFileSync(file, LIST);
  utimesSync(file, daysAgo(15), daysAgo(15));
  await assert.rejects(loadFilterLists({ cacheDir: dir, lists: LISTS, fetcher: async () => '<html>' }), /not a filter list/);
}));

test('the data hosts\' URLs cover every pattern, for each reporter', () => {
  const urls = dataUrls({ a2d: { volumes: { first: '1' } }, 'am-samoa': {}, a3d: { volumes: { first: '138-2' } } }).map((e) => e.url);
  for (const u of [
    'https://idx.stare.pub/manifest.json',
    'https://idx.stare.pub/v/v2026.10.26/a2d/1.idx.gz',
    'https://idx.stare.pub/v/v2026.10.26/a2d/1.1.idx.gz',
    'https://idx.stare.pub/a2d/1.bin',
    'https://data.stare.pub/cap/a3d/138-2.zip',
    'https://static.case.law/a2d/1.tar.csv',
    'https://data.stare.pub/pdf/as/am-samoa/1.pdf',
    'https://data.stare.pub/pdf/us/a2d/1.json',
    'https://data.stare.pub/cl/c/4893133/62f253f296600fb7.json.gz',
  ]) assert.ok(urls.includes(u), u);
  assert.equal(SITE, 'https://stare.pub/');
});
