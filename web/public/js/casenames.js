// The names of the cases at a page several cases start on (#212), for picking the one the
// citing text names: a CAP case's JSON read out of its volume's zip by range requests
// (the zip's central directory from its tail, then the one entry; a few kilobytes
// instead of the whole zip), or a CourtListener record. The zip parsing is the WASM's
// (`stare::ziprange`, `zip_directory` and `zip_entry`).

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
