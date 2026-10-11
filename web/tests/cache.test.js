import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cacheGet, cacheSet, fetchCached, isStaleIndexKey, pruneIndexCache, resetMemoryCache,
} from '../public/js/cache.js';
import { indexPath } from '../public/js/manifest.js';
import { indexUrl } from '../public/js/sources.js';

// Just enough IndexedDB for cache.js: versioned databases with an upgrade step, object
// stores with get/put/clear, and transactions that complete after their requests.
// Databases outlive connections, as they do in a browser across page loads.
class FakeIndexedDB {
  constructor() {
    this.databases = new Map();
  }

  // A database as an earlier schema left it: `stores` maps store name → entries.
  seed(name, version, stores) {
    const data = new Map();
    for (const [store, entries] of Object.entries(stores)) data.set(store, new Map(Object.entries(entries)));
    this.databases.set(name, { version, data });
  }

  open(name, version) {
    const req = {};
    setTimeout(() => {
      let entry = this.databases.get(name);
      if (!entry) {
        entry = { version: 0, data: new Map() };
        this.databases.set(name, entry);
      }
      const db = new FakeDB(entry);
      req.result = db;
      if (version > entry.version) {
        entry.version = version;
        req.onupgradeneeded?.();
      }
      req.onsuccess?.();
    });
    return req;
  }
}

class FakeDB {
  constructor(entry) {
    this.entry = entry;
    this.objectStoreNames = { contains: (s) => entry.data.has(s) };
  }

  createObjectStore(name) {
    this.entry.data.set(name, new Map());
  }

  close() {}

  transaction(stores, _mode) {
    const names = Array.isArray(stores) ? stores : [stores];
    for (const s of names) if (!this.entry.data.has(s)) throw new Error(`NotFoundError: ${s}`);
    const tx = { pending: 0 };
    const settle = () => {
      tx.pending -= 1;
      if (tx.pending === 0) setTimeout(() => { if (tx.pending === 0) tx.oncomplete?.(); });
    };
    const request = (fn) => {
      tx.pending += 1;
      const req = {};
      setTimeout(() => {
        req.result = fn();
        req.onsuccess?.();
        settle();
      });
      return req;
    };
    tx.objectStore = (name) => {
      const map = this.entry.data.get(name);
      return {
        get: (key) => request(() => map.get(key)),
        put: (value, key) => request(() => { map.set(key, value); return key; }),
        clear: () => request(() => { map.clear(); }),
        delete: (key) => request(() => { map.delete(key); }),
        getAllKeys: () => request(() => [...map.keys()]),
      };
    };
    return tx;
  }
}

const V1 = 'v/v2026.10.03/';
const V2 = 'v/v2026.11.01/';

describe('isStaleIndexKey', () => {
  test('under a base, every other build and the root are stale', () => {
    assert.equal(isStaleIndexKey(`${V2}a3d/138.bin`, V2), false);
    assert.equal(isStaleIndexKey(`${V2}a3d/138.multi`, V2), false);
    assert.equal(isStaleIndexKey(`${V1}a3d/138.bin`, V2), true);
    assert.equal(isStaleIndexKey('a3d/138.multi', V2), true);
    // CourtListener sidecars belong to their build too; their records don't.
    assert.equal(isStaleIndexKey(`${V2}a3d/250.cl`, V2), false);
    assert.equal(isStaleIndexKey(`${V1}a3d/250.cl`, V2), true);
    assert.equal(isStaleIndexKey('cl/c/9876543/0f3a9c2e7b1d4a65.json.gz', V2), false);
  });

  test('without a base, only versioned files are stale', () => {
    assert.equal(isStaleIndexKey('a3d/138.bin', ''), false);
    assert.equal(isStaleIndexKey(`${V1}a3d/138.bin`, ''), true);
  });

  test('anything that is not an index file is kept', () => {
    assert.equal(isStaleIndexKey('a3d/138.tar.csv', V2), false);
    assert.equal(isStaleIndexKey('a3d/138.zip', V2), false);
    assert.equal(isStaleIndexKey(42, V2), false);
  });
});

describe('pruneIndexCache', () => {
  let idb;

  beforeEach(() => {
    idb = new FakeIndexedDB();
    globalThis.indexedDB = idb;
  });

  afterEach(() => {
    delete globalThis.indexedDB;
  });

  const seed = () => idb.seed('stare-cache', 2, {
    bins: { 'a3d/138.bin': 'root', [`${V1}a3d/138.bin`]: 'v1', [`${V2}a3d/138.bin`]: 'v2' },
    multi: { 'a3d/138.multi': 'root', [`${V1}a3d/138.multi`]: 'v1', 'a3d/138.tar.csv': 'csv' },
    zips: { 'a3d/138.zip': 'case data' },
  });
  const keys = (store) => [...idb.databases.get('stare-cache').data.get(store).keys()].sort();

  test('drops the root and other builds, keeps this build, tar.csv and zips', async () => {
    seed();
    assert.equal(await pruneIndexCache(V2), 4);
    assert.deepEqual(keys('bins'), [`${V2}a3d/138.bin`]);
    assert.deepEqual(keys('multi'), ['a3d/138.tar.csv']);
    assert.deepEqual(keys('zips'), ['a3d/138.zip']);
  });

  test('without a base, drops only versioned builds', async () => {
    seed();
    assert.equal(await pruneIndexCache(''), 3);
    assert.deepEqual(keys('bins'), ['a3d/138.bin']);
    assert.deepEqual(keys('multi'), ['a3d/138.multi', 'a3d/138.tar.csv']);
  });

  test('works on the in-memory fallback too', async () => {
    delete globalThis.indexedDB;
    resetMemoryCache();
    await cacheSet('bins', `${V1}a3d/138.bin`, 'v1');
    await cacheSet('bins', `${V2}a3d/138.bin`, 'v2');
    await cacheSet('multi', 'a3d/138.tar.csv', 'csv');
    assert.equal(await pruneIndexCache(V2), 1);
    assert.equal(await cacheGet('bins', `${V1}a3d/138.bin`), null);
    assert.equal(await cacheGet('bins', `${V2}a3d/138.bin`), 'v2');
    assert.equal(await cacheGet('multi', 'a3d/138.tar.csv'), 'csv');
  });
});

describe('indexPath', () => {
  const manifest = (fields) => async () => ({ legacy: false, version: null, base: '', reporters: {}, parts: {}, ...fields });

  test('puts index files under the manifest base, and the root without one', async () => {
    assert.equal(await indexPath('a3d/138.bin', manifest({ base: V1, unreachable: true })), `${V1}a3d/138.bin`);
    assert.equal(await indexPath('a3d/138.bin', manifest({ unreachable: true })), 'a3d/138.bin');
    assert.equal(indexUrl(await indexPath('a3d/138.multi', manifest({ base: V1, unreachable: true }))),
      `https://idx.stare.pub/${V1}a3d/138.multi`);
  });

  test('a new version is new cache keys, so nothing cached for the old one is read', async () => {
    delete globalThis.indexedDB;
    resetMemoryCache();
    const realFetch = globalThis.fetch;
    const fetched = [];
    globalThis.fetch = async (url) => {
      fetched.push(url);
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(url).buffer };
    };
    try {
      const read = async (base) => {
        const key = await indexPath('a3d/138.bin', manifest({ base, unreachable: true }));
        return new TextDecoder().decode(await fetchCached('bins', key, indexUrl(key)));
      };
      assert.equal(await read(V1), `https://idx.stare.pub/${V1}a3d/138.bin`);
      assert.equal(await read(V1), `https://idx.stare.pub/${V1}a3d/138.bin`);
      assert.equal(await read(V2), `https://idx.stare.pub/${V2}a3d/138.bin`);
      assert.deepEqual(fetched, [
        `https://idx.stare.pub/${V1}a3d/138.bin`,
        `https://idx.stare.pub/${V2}a3d/138.bin`,
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('the first readable manifest prunes other builds in the background', async () => {
    delete globalThis.indexedDB;
    resetMemoryCache();
    await cacheSet('bins', `${V1}a3d/138.bin`, 'v1');
    await cacheSet('bins', `${V2}a3d/138.bin`, 'v2');
    assert.equal(await indexPath('a3d/138.bin', manifest({ base: V2 })), `${V2}a3d/138.bin`);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(await cacheGet('bins', `${V1}a3d/138.bin`), null);
    assert.equal(await cacheGet('bins', `${V2}a3d/138.bin`), 'v2');
  });
});
