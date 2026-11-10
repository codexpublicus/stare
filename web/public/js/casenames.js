// The names of the cases at a page several cases start on (#212), for picking the one the
// citing text names: a CAP case's JSON read out of its volume's zip by range requests
// (the zip's central directory from its tail, then the one entry; a few kilobytes
// instead of the whole zip), or a CourtListener record. The zip parsing is the WASM's
// (`stare::ziprange`, `zip_directory` and `zip_entry`).

import { cacheGet, cacheSet } from './cache.js';
import { fetchClRecord } from './cl.js';
import { hasFeature, zipUrl } from './sources.js';
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
 * earlier. `deps` ({ fetchRange, wasm }) are injectable for tests.
 */
export async function zipDirectory(url, deps = {}) {
  const read = deps.fetchRange || fetchRange;
  const w = deps.wasm || await loadWasm();
  const tail = await read(url, `bytes=-${TAIL}`);
  let dir = JSON.parse(w.zip_directory(tail.bytes, tail.start));
  if (dir.need != null) {
    const more = await read(url, `bytes=${dir.need}-`);
    dir = JSON.parse(w.zip_directory(more.bytes, more.start));
  }
  if (!dir.entries) throw new Error(`No central directory in ${url}`);
  return dir.entries;
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
      // A copy of stare.pub without the case text has no names to read.
      if (!hasFeature('text')) throw new Error('Text not in this copy');
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
    if (!hasFeature('text')) throw new Error('Text not in this copy');
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
