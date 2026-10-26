// The browser's cache of index and case files, in IndexedDB (an in-memory map where
// IndexedDB isn't available): `bins` and `multi` hold idx.stare.pub's .bin, .idx.gz and
// .multi files (and the scans' tar.csv, and a volume's case names for the search boxes,
// `names/<slug>/<folder>`), `zips` the case zips and CourtListener records.
//
// Index files are keyed by their path on idx.stare.pub, which is under the build's
// versioned prefix (`v/v2026.10.03/a3d/138.bin`) when the manifest has a `base`; see
// manifest.js. A build's files never change, so a new index version is new keys and
// nothing cached goes stale. pruneIndexCache drops other versions' files.

const DB_NAME = 'stare-cache';
const DB_VERSION = 2;
const STORES = ['bins', 'multi', 'zips'];
const INDEX_STORES = ['bins', 'multi'];
const INDEX_FILE = /\.(?:bin|multi|idx\.gz)$/;

let memoryCache = {};

function openDB() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const store of STORES) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (e) {
      resolve(null);
    }
  });
}

// Forget the in-memory cache (tests only).
export function resetMemoryCache() {
  memoryCache = {};
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
    for (const key of Object.keys(memoryCache)) {
      const sep = key.indexOf(':');
      const store = key.slice(0, sep);
      if (INDEX_STORES.includes(store) && isStaleIndexKey(key.slice(sep + 1), base)) {
        delete memoryCache[key];
        n += 1;
      }
    }
    return n;
  }
  return new Promise((resolve) => {
    let n = 0;
    try {
      const tx = db.transaction(INDEX_STORES, 'readwrite');
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
      tx.oncomplete = () => resolve(n);
      tx.onerror = () => resolve(0);
      tx.onabort = () => resolve(0);
    } catch {
      resolve(0);
    }
  });
}

export async function cacheGet(store, key) {
  const db = await openDB();
  if (!db) return memoryCache[`${store}:${key}`] || null;
  return new Promise((resolve) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

export async function cacheSet(store, key, value) {
  const db = await openDB();
  if (!db) { memoryCache[`${store}:${key}`] = value; return; }
  return new Promise((resolve) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function fetchCached(store, key, url) {
  const cached = await cacheGet(store, key);
  if (cached) return cached;
  const resp = await fetch(url);
  if (!resp.ok) {
    if (resp.status === 404) throw new Error(`NOT_FOUND:${url}`);
    throw new Error(`HTTP ${resp.status} fetching ${url}`);
  }
  const data = new Uint8Array(await resp.arrayBuffer());
  await cacheSet(store, key, data);
  return data;
}

export async function fetchCachedText(store, key, url) {
  const cached = await cacheGet(store, key);
  if (cached) return cached;
  const resp = await fetch(url);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  const text = await resp.text();
  await cacheSet(store, key, text);
  return text;
}
