// The names of the cases at a page several cases start on (#212), for picking the one the
// citing text names: a CAP case's JSON read out of its volume's zip by range requests
// (the zip's central directory from its tail, then the one entry; a few kilobytes
// instead of the whole zip), or a CourtListener record. The zip parsing is the WASM's
// (`stare::ziprange`, `zip_directory` and `zip_entry`).

import { cacheGet, cacheSet } from './cache.js';
import { fetchClRecord } from './cl.js';
import { zipUrl } from './sources.js';
import { loadWasm } from './wasm.js';

// How many bytes from a zip's end are fetched first (`stare::ziprange::TAIL`).
const TAIL = 64 * 1024;

// Directories and names read this page, by key, in flight or done.
const directories = new Map();
const names = new Map();

/**
 * The bytes of `url` that `range` (a Range header, `bytes=-65536`) asks for, as
 * `{ bytes, start }`, `start` their offset in the file. A server that ignores Range
 * sends the whole file, which starts at 0.
 */
export async function fetchRange(url, range, fetchFn = fetch) {
  const res = await fetchFn(url, { headers: { Range: range } });
  if (res.status === 200) return { bytes: new Uint8Array(await res.arrayBuffer()), start: 0 };
  if (res.status !== 206) throw new Error(`HTTP ${res.status} fetching ${url} (${range})`);
  const m = /^bytes (\d+)-/.exec(res.headers.get('Content-Range') || '');
  if (!m) throw new Error(`No Content-Range fetching ${url}`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), start: parseInt(m[1], 10) };
}

/**
 * A zip's files as `[{ name, start, end }]`, each one's local entry by offset, from its
 * central directory: the zip's tail, and the bytes before it when the directory starts
 * earlier. `deps` ({ fetchRange, wasm }) are injectable for tests; `deps.size`, the
 * zip's size when it's known (a span read's Content-Range, zipspan.js), asks for the
 * tail as an explicit range, `bytes=<size-TAIL>-<size-1>`, which unlike a suffix range
 * is a CORS-safelisted header and needs no preflight.
 */
export async function zipDirectory(url, deps = {}) {
  const read = deps.fetchRange || fetchRange;
  const w = deps.wasm || await loadWasm();
  const size = Number.isSafeInteger(deps.size) && deps.size > 0 ? deps.size : null;
  const tail = await read(url, size ? `bytes=${Math.max(0, size - TAIL)}-${size - 1}` : `bytes=-${TAIL}`);
  let dir = JSON.parse(w.zip_directory(tail.bytes, tail.start));
  if (dir.need != null) {
    // Only the bytes before the tail, joined to it, when the tail came as asked.
    let more;
    if (dir.need < tail.start) {
      const head = await read(url, `bytes=${dir.need}-${tail.start - 1}`);
      more = head.start + head.bytes.length === tail.start
        ? { bytes: concat(head.bytes, tail.bytes), start: head.start }
        : head;
    } else {
      more = await read(url, size ? `bytes=${dir.need}-${size - 1}` : `bytes=${dir.need}-`);
    }
    dir = JSON.parse(w.zip_directory(more.bytes, more.start));
  }
  if (!dir.entries) throw new Error(`No central directory in ${url}`);
  return dir.entries;
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * One file's text out of a zip, by range requests: the directory once per zip, then
 * the file's entry.
 */
export async function zipFileText(url, name, deps = {}) {
  const read = deps.fetchRange || fetchRange;
  const w = deps.wasm || await loadWasm();
  if (!directories.has(url) || deps.fresh) {
    const dir = zipDirectory(url, deps);
    directories.set(url, dir);
    dir.catch(() => directories.delete(url));
  }
  const entry = (await directories.get(url)).find(e => e.name === name);
  if (!entry) throw new Error(`${name} is not in ${url}`);
  const { bytes, start } = await read(url, `bytes=${entry.start}-${entry.end - 1}`);
  return w.zip_entry(bytes, start, JSON.stringify(entry));
}

/**
 * A case's names and decision date, `{ names, date }`, for a case pageCases lists
 * (its `ref`): CAP's `name_abbreviation` and `name` from the case JSON in its
 * volume's zip, or a CourtListener record's. Null for a case with no `ref`.
 */
export async function readCaseNames(pageCase, deps = {}) {
  const ref = pageCase?.ref;
  if (!ref) return null;
  const key = ref.source === 'cl'
    ? `cl/${ref.cluster_id}/${ref.hash}`
    : `${ref.reporter}/${ref.folder}/${ref.caseFile}`;
  if (!names.has(key) || deps.fresh) {
    const read = (async () => {
      const data = ref.source === 'cl'
        ? await (deps.fetchClRecord || fetchClRecord)(ref)
        : JSON.parse(await zipFileText(zipUrl(ref.reporter, ref.folder), `json/${ref.caseFile}.json`, deps));
      return {
        names: [data.name_abbreviation, data.name].filter(n => typeof n === 'string' && n.trim()),
        date: typeof data.decision_date === 'string' && data.decision_date ? data.decision_date : null,
      };
    })();
    names.set(key, read);
    read.catch(() => names.delete(key));
  }
  return names.get(key);
}

// Volumes' case names read this page, by `<reporter>/<folder>`, in flight or done.
const volumeNames = new Map();

/**
 * The short names of the cases in a CAP volume folder, `{ <case file>: <name
 * abbreviation> }` (`0426-01` to `Matter of Smith`), for the search boxes' page
 * suggestions (#248): the zip's `metadata/CasesMetadata.json` read by range requests,
 * the zip's tail and then that one entry (70 to 380 KB in the volumes measured on #248,
 * against 0.4 to 5 MB for the zip). Kept in the cache's `multi` store under
 * `names/<reporter>/<folder>` once read, since CAP's zips never change. `deps.signal`
 * aborts the reads; `deps` ({ fetchRange, wasm, cacheGet, cacheSet }) are injectable
 * for tests.
 */
export async function volumeCaseNames(reporter, folder, deps = {}) {
  const key = `${reporter}/${folder}`;
  if (volumeNames.has(key) && !deps.fresh) return volumeNames.get(key);
  const read = (async () => {
    const get = deps.cacheGet || cacheGet;
    const set = deps.cacheSet || cacheSet;
    const cached = await get('multi', `names/${key}`);
    if (cached) return JSON.parse(cached);
    const signal = deps.signal;
    const rangeDeps = {
      ...deps,
      fresh: false,
      fetchRange: deps.fetchRange
        || ((url, range) => fetchRange(url, range, (u, init) => fetch(u, { ...init, signal }))),
    };
    const text = await zipFileText(zipUrl(reporter, folder), 'metadata/CasesMetadata.json', rangeDeps);
    const out = {};
    for (const c of JSON.parse(text)) {
      if (typeof c?.file_name === 'string' && typeof c.name_abbreviation === 'string') {
        out[c.file_name] = c.name_abbreviation;
      }
    }
    await set('multi', `names/${key}`, JSON.stringify(out));
    return out;
  })();
  volumeNames.set(key, read);
  read.catch(() => volumeNames.delete(key));
  return read;
}

// Volumes' page orders read this page, by `<reporter>/<folder>`, in flight or done.
const volumeOrders = new Map();

/**
 * The METS ORDERs of the cases in a CAP volume folder, `{ <case file>: { first, last } }`,
 * from the zip's `metadata/CasesMetadata.json` by range requests (the WASM's
 * `get_page_orders` reads the same fields out of a whole zip), for the reader's archival
 * PDF link on a case read by its zip span (resolve.js, spanZip). Kept in the cache's
 * `multi` store under `orders/<reporter>/<folder>`, like volumeCaseNames.
 */
export async function volumePageOrders(reporter, folder, deps = {}) {
  const key = `${reporter}/${folder}`;
  if (volumeOrders.has(key) && !deps.fresh) return volumeOrders.get(key);
  const read = (async () => {
    const get = deps.cacheGet || cacheGet;
    const set = deps.cacheSet || cacheSet;
    const cached = await get('multi', `orders/${key}`);
    if (cached) return JSON.parse(cached);
    const text = await zipFileText(zipUrl(reporter, folder), 'metadata/CasesMetadata.json', { ...deps, fresh: false });
    const out = {};
    for (const c of JSON.parse(text)) {
      const first = c?.first_page_order;
      const last = c?.last_page_order;
      if (typeof c?.file_name === 'string' && Number.isSafeInteger(first) && Number.isSafeInteger(last)) {
        out[c.file_name] = { first, last };
      }
    }
    await set('multi', `orders/${key}`, JSON.stringify(out));
    return out;
  })();
  volumeOrders.set(key, read);
  read.catch(() => volumeOrders.delete(key));
  return read;
}
