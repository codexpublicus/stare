import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cacheGet, cacheSet, fetchCached, isStaleIndexKey, limits, pruneIndexCache, resetMemoryCache,
} from '../public/js/cache.js';
import { indexPath } from '../public/js/manifest.js';
import { indexUrl } from '../public/js/sources.js';

// Just enough IndexedDB for cache.js: versioned databases with an upgrade step, object
// stores with get/put/delete/getAll/getAllKeys/clear, and transactions that commit after
// their requests, all or nothing. Databases outlive connections, as they do in a browser
// across page loads. Options: `quotaBytes`, past which a commit aborts with a
// QuotaExceededError and only `onabort`, as a browser's does; `mode` 'hang' (open never
// answers), 'error' or 'blocked'.
const sizeOf = (v) => v?.byteLength ?? v?.length ?? 0;

class FakeIndexedDB {
  constructor({ quotaBytes = Infinity, mode = 'ok' } = {}) {
    this.databases = new Map();
    this.quotaBytes = quotaBytes;
    this.mode = mode;
    this.opens = 0;
    this.connections = [];
  }

  // A database as an earlier schema left it: `stores` maps store name → entries.
  seed(name, version, stores) {
    const data = new Map();
    for (const [store, entries] of Object.entries(stores)) data.set(store, new Map(Object.entries(entries)));
    this.databases.set(name, { version, data });
  }

  keys(name, store) {
    return [...this.databases.get(name).data.get(store).keys()].sort();
  }

  open(name, version) {
    this.opens += 1;
    const req = {};
    if (this.mode === 'hang') return req;
    setTimeout(() => {
      if (this.mode === 'error') return req.onerror?.();
      if (this.mode === 'blocked') return req.onblocked?.();
      let entry = this.databases.get(name);
      if (!entry) {
        entry = { version: 0, data: new Map() };
        this.databases.set(name, entry);
      }
      const db = new FakeDB(entry, this);
      this.connections.push(db);
      req.result = db;
      if (version > entry.version) {
        const oldVersion = entry.version;
        entry.version = version;
        req.onupgradeneeded?.({ oldVersion });
      }
      req.onsuccess?.();
    });
    return req;
  }
}

class FakeDB {
  constructor(entry, idb) {
    this.entry = entry;
    this.idb = idb;
    this.closed = false;
    this.objectStoreNames = { contains: (s) => entry.data.has(s) };
  }

  createObjectStore(name) {
    this.entry.data.set(name, new Map());
  }

  deleteObjectStore(name) {
    this.entry.data.delete(name);
  }

  close() {
    this.closed = true;
  }

  transaction(stores, _mode) {
    if (this.closed) throw Object.assign(new Error('InvalidStateError'), { name: 'InvalidStateError' });
    const names = Array.isArray(stores) ? stores : [stores];
    for (const s of names) if (!this.entry.data.has(s)) throw new Error(`NotFoundError: ${s}`);
    const tx = { pending: 0, error: null, abort: () => {} };
    const ops = [];
    const commit = () => {
      const next = new Map([...this.entry.data].map(([n, m]) => [n, new Map(m)]));
      for (const op of ops) op(next);
      let total = 0;
      for (const m of next.values()) for (const v of m.values()) total += sizeOf(v);
      if (total > this.idb.quotaBytes) {
        tx.error = Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' });
        tx.onabort?.();
        return;
      }
      for (const [n, m] of next) this.entry.data.set(n, m);
      tx.oncomplete?.();
    };
    const settle = () => {
      tx.pending -= 1;
      if (tx.pending === 0) setTimeout(() => { if (tx.pending === 0) commit(); });
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
      const map = () => this.entry.data.get(name);
      return {
        get: (key) => request(() => map().get(key)),
        getAll: () => request(() => [...map().values()]),
        getAllKeys: () => request(() => [...map().keys()]),
        put: (value, key) => request(() => { ops.push((d) => d.get(name).set(key, value)); return key; }),
        delete: (key) => request(() => { ops.push((d) => d.get(name).delete(key)); }),
        clear: () => request(() => { ops.push((d) => d.get(name).clear()); }),
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
    // Unified index files belong to their build too; CourtListener records don't.
    assert.equal(isStaleIndexKey(`${V2}a3d/250.idx.gz`, V2), false);
    assert.equal(isStaleIndexKey(`${V2}a3d/250.1.idx.gz`, V2), false);
    assert.equal(isStaleIndexKey(`${V1}a3d/250.idx.gz`, V2), true);
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
    resetMemoryCache();
    idb = new FakeIndexedDB();
    globalThis.indexedDB = idb;
  });

  afterEach(() => {
    delete globalThis.indexedDB;
  });

  const seed = () => idb.seed('stare-cache', 3, {
    bins: { 'a3d/138.bin': 'root', [`${V1}a3d/138.bin`]: 'v1', [`${V2}a3d/138.bin`]: 'v2' },
    multi: { 'a3d/138.multi': 'root', [`${V1}a3d/138.multi`]: 'v1', 'a3d/138.tar.csv': 'csv' },
    zips: { 'a3d/138.zip': 'case data' },
    zipmeta: { 'a3d/138.zip': { bytes: 9, used: 1, etag: null } },
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

// #269: the zips are bounded, a full quota or an IndexedDB that fails never stops a case
// from opening, and the page opens one connection.
describe('the zip cache', () => {
  let idb;
  let realFetch;
  const saved = { ...limits };
  const bytes = (n, fill = 1) => new Uint8Array(n).fill(fill);
  const zipKeys = () => idb.keys('stare-cache', 'zips');
  // Fails the test, instead of hanging the suite, when `p` doesn't settle.
  const settles = (p, ms = 500) => Promise.race([
    p, new Promise((_, reject) => setTimeout(() => reject(new Error(`did not settle in ${ms} ms`)), ms)),
  ]);
  const tick = () => new Promise((r) => setTimeout(r, 5));

  beforeEach(() => {
    resetMemoryCache();
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    delete globalThis.indexedDB;
    globalThis.fetch = realFetch;
    Object.assign(limits, saved);
  });

  // A server for `fetch`: each URL's bytes and ETag, counting GETs and HEADs.
  function serve(files) {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push(`${init.method || 'GET'} ${url}`);
      const f = files[url];
      if (!f) return { ok: false, status: 404, headers: new Map() };
      const headers = new Map([['ETag', f.etag]]);
      return { ok: true, status: 200, headers, arrayBuffer: async () => f.body.buffer.slice(0) };
    };
    return calls;
  }

  test('a write the quota refuses makes room from the least recently used zips and is kept', async () => {
    idb = new FakeIndexedDB({ quotaBytes: 250 });
    globalThis.indexedDB = idb;
    await settles(cacheSet('zips', 'a/1.zip', bytes(100)));
    await tick();
    await settles(cacheSet('zips', 'a/2.zip', bytes(100)));
    await tick();
    assert.ok(await cacheGet('zips', 'a/1.zip'));
    await tick();
    // 1 was used after 2 was written, so 2 goes.
    await settles(cacheSet('zips', 'a/3.zip', bytes(100)));
    assert.deepEqual(zipKeys(), ['a/1.zip', 'a/3.zip']);
  });

  test('a file the quota can never hold settles, is a miss, and still opens', async () => {
    idb = new FakeIndexedDB({ quotaBytes: 50 });
    globalThis.indexedDB = idb;
    const calls = serve({ 'https://data/a/1.zip': { body: bytes(100, 7), etag: '"x"' } });
    const data = await settles(fetchCached('zips', 'a/1.zip', 'https://data/a/1.zip'));
    assert.equal(data.length, 100);
    assert.deepEqual(zipKeys(), []);
    await settles(cacheSet('bins', 'a/1.bin', bytes(60)));
    assert.deepEqual(calls, ['GET https://data/a/1.zip']);
  });

  test('the zips are kept under limits.zipBytes, the least recently used going first', async () => {
    idb = new FakeIndexedDB();
    globalThis.indexedDB = idb;
    limits.zipBytes = 30;
    for (const n of [1, 2]) {
      await cacheSet('zips', `a/${n}.zip`, bytes(12));
      await tick();
    }
    await cacheGet('zips', 'a/1.zip');
    await tick();
    await cacheSet('zips', 'a/3.zip', bytes(12));
    assert.deepEqual(zipKeys(), ['a/1.zip', 'a/3.zip']);
    // Index files don't count against it.
    await cacheSet('bins', 'a/1.bin', bytes(100));
    assert.deepEqual(zipKeys(), ['a/1.zip', 'a/3.zip']);
  });

  test('the page opens one connection, and reopens after another tab upgrades the database', async () => {
    idb = new FakeIndexedDB();
    globalThis.indexedDB = idb;
    await cacheSet('bins', 'a/1.bin', 'x');
    await cacheGet('bins', 'a/1.bin');
    await Promise.all([cacheGet('bins', 'a/2.bin'), cacheSet('zips', 'a/1.zip', bytes(3))]);
    assert.equal(idb.opens, 1);
    const [db] = idb.connections;
    db.onversionchange();
    assert.equal(db.closed, true);
    assert.equal(await cacheGet('bins', 'a/1.bin'), 'x');
    assert.equal(idb.opens, 2);
  });

  for (const mode of ['hang', 'error', 'blocked']) {
    test(`an open that ${mode === 'hang' ? 'never answers' : `is ${mode === 'error' ? 'refused' : 'blocked'}`} falls back to memory`, async () => {
      idb = new FakeIndexedDB({ mode });
      globalThis.indexedDB = idb;
      limits.openTimeoutMs = 20;
      await settles(cacheSet('zips', 'a/1.zip', bytes(3)));
      assert.deepEqual(await settles(cacheGet('zips', 'a/1.zip')), bytes(3));
      assert.equal(idb.opens, 1);
    });
  }

  test('a browser that throws on indexedDB itself uses memory', async () => {
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      get() { throw Object.assign(new Error('denied'), { name: 'SecurityError' }); },
    });
    await cacheSet('bins', 'a/1.bin', 'x');
    assert.equal(await cacheGet('bins', 'a/1.bin'), 'x');
  });

  test('the in-memory zips are bounded too', async () => {
    limits.memoryZipBytes = 30;
    for (const n of [1, 2, 3]) await cacheSet('zips', `a/${n}.zip`, bytes(12));
    assert.equal(await cacheGet('zips', 'a/1.zip'), null);
    assert.ok(await cacheGet('zips', 'a/3.zip'));
  });

  test('two fetches of one file at once make one request', async () => {
    idb = new FakeIndexedDB();
    globalThis.indexedDB = idb;
    const calls = serve({ 'https://data/a/1.zip': { body: bytes(5), etag: '"x"' } });
    const [a, b] = await Promise.all([
      fetchCached('zips', 'a/1.zip', 'https://data/a/1.zip'),
      fetchCached('zips', 'a/1.zip', 'https://data/a/1.zip'),
    ]);
    assert.deepEqual(a, b);
    assert.deepEqual(calls, ['GET https://data/a/1.zip']);
  });

  test('a cached zip whose ETag has changed on the server is dropped and fetched again', async () => {
    idb = new FakeIndexedDB();
    globalThis.indexedDB = idb;
    const files = { 'https://data/a/1.zip': { body: bytes(5, 1), etag: '"old"' } };
    const calls = serve(files);
    await fetchCached('zips', 'a/1.zip', 'https://data/a/1.zip');
    files['https://data/a/1.zip'] = { body: bytes(5, 2), etag: '"new"' };
    // The cached copy opens the case; the check after it finds the new file.
    assert.deepEqual(await fetchCached('zips', 'a/1.zip', 'https://data/a/1.zip'), bytes(5, 1));
    await tick();
    await tick();
    assert.deepEqual(zipKeys(), []);
    assert.deepEqual(await fetchCached('zips', 'a/1.zip', 'https://data/a/1.zip'), bytes(5, 2));
    assert.deepEqual(calls, ['GET https://data/a/1.zip', 'HEAD https://data/a/1.zip', 'GET https://data/a/1.zip']);
  });

  test('an unchanged ETag keeps the zip, and is checked once a page', async () => {
    idb = new FakeIndexedDB();
    globalThis.indexedDB = idb;
    const calls = serve({ 'https://data/a/1.zip': { body: bytes(5), etag: '"x"' } });
    for (let i = 0; i < 3; i++) {
      await fetchCached('zips', 'a/1.zip', 'https://data/a/1.zip');
      await tick();
    }
    assert.deepEqual(zipKeys(), ['a/1.zip']);
    assert.deepEqual(calls, ['GET https://data/a/1.zip', 'HEAD https://data/a/1.zip']);
  });

  test('upgrading from version 2 drops the zips cached without a size, keeping the index files', async () => {
    idb = new FakeIndexedDB();
    globalThis.indexedDB = idb;
    idb.seed('stare-cache', 2, {
      bins: { 'a3d/138.bin': 'bin' }, multi: {}, zips: { 'a3d/138.zip': 'old zip' },
    });
    assert.equal(await cacheGet('bins', 'a3d/138.bin'), 'bin');
    assert.equal(await cacheGet('zips', 'a3d/138.zip'), null);
    assert.deepEqual(idb.keys('stare-cache', 'zipmeta'), []);
  });
});
