const DB_NAME = 'stare-cache';
const DB_VERSION = 2;
const STORES = ['bins', 'multi', 'zips'];

let memoryCache = {};

function openDB() {
  return new Promise((resolve, reject) => {
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
