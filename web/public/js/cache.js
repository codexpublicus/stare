// The browser's cache of index and case files, in IndexedDB (an in-memory map where
// IndexedDB isn't available, fails or doesn't answer): `bins` and `multi` hold
// idx.stare.pub's .bin, .idx.gz and .multi files (and the scans' tar.csv, and a volume's
// case names for the search boxes, `names/<slug>/<folder>`), `zips` the case zips and
// CourtListener records, with each one's size, last use and ETag in `zipmeta`.
//
// The cache is never what stops a case opening (#269): every read and write settles,
// whatever IndexedDB does, and one that fails is a miss, so the file comes from the
// network. One connection is opened per page and closed when another tab upgrades the
// database. The zips are kept to `limits.zipBytes` in all, the least recently used going
// first, and a write the browser's quota refuses makes room the same way and tries once
// more. A cached CAP zip is checked against data.stare.pub's ETag once a page (a HEAD
// request, after it's been used), and dropped when the file there has changed, so a
// corrected zip is fetched on the next open.
//
// Index files are keyed by their path on idx.stare.pub, which is under the build's
// versioned prefix (`v/v2026.10.03/a3d/138.bin`) when the manifest has a `base`; see
// manifest.js. A build's files never change, so a new index version is new keys and
// nothing cached goes stale. pruneIndexCache drops other versions' files.

const DB_NAME = 'stare-cache';
// 3 added `zipmeta`; the zips cached before it, with no size or ETag, are dropped.
const DB_VERSION = 3;
const STORES = ['bins', 'multi', 'zips', 'zipmeta'];
const INDEX_STORES = ['bins', 'multi'];
const INDEX_FILE = /\.(?:bin|multi|idx\.gz)$/;
// A CAP volume zip on data.stare.pub, which can be replaced; CourtListener records,
// also in `zips`, are under immutable content-hashed paths.
const CAP_ZIP = /\.zip$/;

// Exported for tests, which shrink them.
export const limits = {
  // The zips' total in IndexedDB: about a hundred volumes at CAP's 2 MB average.
  zipBytes: 200 * 1024 * 1024,
  // The same where IndexedDB isn't available, in memory for the page's life.
  memoryZipBytes: 64 * 1024 * 1024,
  // How long opening the database may take before the page gives up on it: an open
  // blocked by another tab, or a browser that never answers in private mode.
  openTimeoutMs: 3000,
};

// The in-memory fallback, `<store>:<key>` to value, the zips in order of last use.
let memoryCache = new Map();
// The page's one connection: `{ factory, promise }`, the promise resolving to the
// database or to null when it can't be used.
let conn = null;
// fetchCached's fetches under way, by `<store>:<key>`.
const inflight = new Map();
// CAP zips whose ETag was checked this page.
const revalidated = new Set();

function idbFactory() {
  try {
    return globalThis.indexedDB || null;
  } catch {
    // A browser that refuses storage altogether throws on the property itself.
    return null;
  }
}

function openDB() {
  const factory = idbFactory();
  if (!factory) return Promise.resolve(null);
  if (conn?.factory === factory) return conn.promise;
  const promise = new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => done(null), limits.openTimeoutMs);
    function done(db) {
      if (settled) {
        db?.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(db);
    }
    try {
      const req = factory.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        if ((e?.oldVersion ?? 0) < 3 && db.objectStoreNames.contains('zips')) db.deleteObjectStore('zips');
        for (const store of STORES) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another tab opening a newer version waits on this connection until it closes.
        db.onversionchange = () => {
          db.close();
          forget(promise);
        };
        db.onclose = () => forget(promise);
        done(db);
      };
      req.onerror = () => done(null);
      // Another tab holds an older version open; this page uses memory instead.
      req.onblocked = () => done(null);
    } catch {
      done(null);
    }
  });
  conn = { factory, promise };
  return promise;
}

function forget(promise) {
  if (conn?.promise === promise) conn = null;
}

// Forget the in-memory cache and the connection (tests only).
export function resetMemoryCache() {
  memoryCache = new Map();
  conn = null;
  inflight.clear();
  revalidated.clear();
}

// Runs `fn(tx)` in a transaction and settles once it's over, however it ends: `{ ok,
// value }`, `value` what the function `fn` returned gives once the transaction is
// complete, or `{ ok: false, error }` when it couldn't start, failed or was aborted (a
// full quota aborts it, with only `onabort`).
function run(db, stores, mode, fn) {
  return new Promise((resolve) => {
    let tx;
    let read;
    try {
      tx = db.transaction(stores, mode);
      read = fn(tx);
    } catch (error) {
      try { tx?.abort(); } catch { /* already over */ }
      resolve({ ok: false, error });
      return;
    }
    tx.oncomplete = () => resolve({ ok: true, value: read ? read() : undefined });
    tx.onerror = (e) => resolve({ ok: false, error: tx.error || e?.target?.error || null });
    tx.onabort = () => resolve({ ok: false, error: tx.error || null });
  });
}

function isQuotaError(error) {
  return error?.name === 'QuotaExceededError' || error?.code === 22;
}

function sizeOf(value) {
  return value?.byteLength ?? value?.length ?? 0;
}

function memoryGet(store, key) {
  const k = `${store}:${key}`;
  if (!memoryCache.has(k)) return null;
  const value = memoryCache.get(k);
  if (store === 'zips') {
    memoryCache.delete(k);
    memoryCache.set(k, value);
  }
  return value;
}

function memorySet(store, key, value) {
  const k = `${store}:${key}`;
  memoryCache.delete(k);
  memoryCache.set(k, value);
  if (store !== 'zips') return;
  let total = 0;
  for (const [mk, v] of memoryCache) if (mk.startsWith('zips:')) total += sizeOf(v);
  for (const [mk, v] of memoryCache) {
    if (total <= limits.memoryZipBytes) break;
    if (!mk.startsWith('zips:') || mk === k) continue;
    memoryCache.delete(mk);
    total -= sizeOf(v);
  }
}

// Whether a cached index file's key belongs to the build at `base` ('' for the root,
// where the index lived before the versioned layout). Everything else in the stores,
// like the scans' tar.csv, isn't an index file and is never pruned.
export function isStaleIndexKey(key, base) {
  if (typeof key !== 'string' || !INDEX_FILE.test(key)) return false;
  return base ? !key.startsWith(base) : key.startsWith('v/');
}

// Delete cached .bin, .multi and .idx.gz files that aren't the build at `base`. Returns how many
// it deleted. Callers don't wait on it: a stale entry is never read, since its key is
// not the current build's, so this only frees space.
export async function pruneIndexCache(base) {
  const db = await openDB();
  if (!db) {
    let n = 0;
    for (const k of [...memoryCache.keys()]) {
      const sep = k.indexOf(':');
      if (INDEX_STORES.includes(k.slice(0, sep)) && isStaleIndexKey(k.slice(sep + 1), base)) {
        memoryCache.delete(k);
        n += 1;
      }
    }
    return n;
  }
  let n = 0;
  const r = await run(db, INDEX_STORES, 'readwrite', (tx) => {
    for (const name of INDEX_STORES) {
      const store = tx.objectStore(name);
      const req = store.getAllKeys();
      req.onsuccess = () => {
        for (const key of req.result || []) {
          if (isStaleIndexKey(key, base)) {
            store.delete(key);
            n += 1;
          }
        }
      };
    }
  });
  return r.ok ? n : 0;
}

// A cached zip and its ETag, or null; marks it used.
async function zipEntry(db, key) {
  const r = await run(db, ['zips', 'zipmeta'], 'readwrite', (tx) => {
    const data = tx.objectStore('zips').get(key);
    const metaStore = tx.objectStore('zipmeta');
    const meta = metaStore.get(key);
    meta.onsuccess = () => {
      if (meta.result) metaStore.put({ ...meta.result, used: Date.now() }, key);
    };
    return () => (data.result ? { data: data.result, etag: meta.result?.etag || null } : null);
  });
  return r.ok ? r.value : null;
}

export async function cacheGet(store, key) {
  const db = await openDB();
  if (!db) return memoryGet(store, key);
  if (store === 'zips') return (await zipEntry(db, key))?.data || null;
  const r = await run(db, store, 'readonly', (tx) => {
    const req = tx.objectStore(store).get(key);
    return () => req.result || null;
  });
  return r.ok ? r.value : null;
}

// Every cached zip's key and meta, least recently used first.
async function zipMetas(db) {
  const r = await run(db, 'zipmeta', 'readonly', (tx) => {
    const store = tx.objectStore('zipmeta');
    const keys = store.getAllKeys();
    const values = store.getAll();
    return () => (keys.result || []).map((key, i) => ({ key, ...values.result[i] }));
  });
  return r.ok ? r.value.sort((a, b) => (a.used || 0) - (b.used || 0)) : [];
}

// Delete the least recently used zips, other than `keep`, until those left total at
// most `total`. Returns how many bytes it freed.
async function evictZips(db, total, keep = null) {
  const metas = await zipMetas(db);
  let left = metas.reduce((sum, m) => sum + (m.bytes || 0), 0);
  const drop = [];
  for (const m of metas) {
    if (left <= total) break;
    if (m.key === keep) continue;
    drop.push(m.key);
    left -= m.bytes || 0;
  }
  if (drop.length === 0) return 0;
  const r = await run(db, ['zips', 'zipmeta'], 'readwrite', (tx) => {
    for (const key of drop) {
      tx.objectStore('zips').delete(key);
      tx.objectStore('zipmeta').delete(key);
    }
  });
  return r.ok ? drop.length : 0;
}

function putZip(db, key, value, meta) {
  return run(db, ['zips', 'zipmeta'], 'readwrite', (tx) => {
    tx.objectStore('zips').put(value, key);
    tx.objectStore('zipmeta').put(meta, key);
  });
}

// Store `value`; resolves once it's stored or given up on, never rejecting. A write the
// quota refuses frees the least recently used zips, half of them by size at least, and
// is tried once more. `etag` is a zip's, for checking it later.
export async function cacheSet(store, key, value, { etag = null } = {}) {
  const db = await openDB();
  if (!db) {
    memorySet(store, key, value);
    return;
  }
  const write = () => (store === 'zips'
    ? putZip(db, key, value, { bytes: sizeOf(value), used: Date.now(), etag })
    : run(db, store, 'readwrite', (tx) => { tx.objectStore(store).put(value, key); }));
  let r = await write();
  if (!r.ok && isQuotaError(r.error)) {
    const metas = await zipMetas(db);
    const total = metas.reduce((sum, m) => sum + (m.bytes || 0), 0);
    await evictZips(db, Math.max(0, Math.min(total / 2, total - sizeOf(value))), key);
    r = await write();
  }
  if (r.ok && store === 'zips') await evictZips(db, limits.zipBytes, key);
}

async function cacheDelete(store, key) {
  const db = await openDB();
  if (!db) {
    memoryCache.delete(`${store}:${key}`);
    return;
  }
  const stores = store === 'zips' ? ['zips', 'zipmeta'] : [store];
  await run(db, stores, 'readwrite', (tx) => {
    for (const s of stores) tx.objectStore(s).delete(key);
  });
}

// Drop a cached CAP zip whose file on data.stare.pub has changed since it was cached.
// Once a page per zip, after it's been used, and quietly: a HEAD that fails changes
// nothing.
function revalidate(key, url, etag) {
  if (!etag || !CAP_ZIP.test(key) || revalidated.has(key)) return;
  revalidated.add(key);
  fetch(url, { method: 'HEAD', cache: 'no-store' })
    .then((resp) => {
      const now = resp.ok ? resp.headers.get('ETag') : null;
      if (now && now !== etag) return cacheDelete('zips', key);
      return undefined;
    })
    .catch(() => {});
}

// `<store>:<key>`'s value (`kind` saying bytes or text): from the cache, else fetched,
// and cached. Two calls for the same key at once share one fetch.
function once(kind, store, key, load) {
  const k = `${kind}:${store}:${key}`;
  if (!inflight.has(k)) {
    const p = load();
    inflight.set(k, p);
    p.then(() => inflight.delete(k), () => inflight.delete(k));
  }
  return inflight.get(k);
}

async function cachedZip(key, url) {
  const db = await openDB();
  const hit = db ? await zipEntry(db, key) : (() => {
    const data = memoryGet('zips', key);
    return data ? { data, etag: null } : null;
  })();
  if (hit) revalidate(key, url, hit.etag);
  return hit?.data || null;
}

export function fetchCached(store, key, url) {
  return once('bytes', store, key, async () => {
    const cached = store === 'zips' ? await cachedZip(key, url) : await cacheGet(store, key);
    if (cached) return cached;
    const resp = await fetch(url);
    if (!resp.ok) {
      if (resp.status === 404) throw new Error(`NOT_FOUND:${url}`);
      throw new Error(`HTTP ${resp.status} fetching ${url}`);
    }
    const data = new Uint8Array(await resp.arrayBuffer());
    await cacheSet(store, key, data, { etag: resp.headers?.get?.('ETag') || null });
    return data;
  });
}

export function fetchCachedText(store, key, url) {
  return once('text', store, key, async () => {
    const cached = await cacheGet(store, key);
    if (cached) return cached;
    const resp = await fetch(url);
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
    const text = await resp.text();
    await cacheSet(store, key, text);
    return text;
  });
}

// Whether `bytes` start with gzip's magic number.
export function isGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

// `bytes` gunzipped, or as they are when they aren't gzip.
export async function gunzip(bytes) {
  if (!isGzip(bytes)) return bytes;
  const body = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(body).arrayBuffer());
}
