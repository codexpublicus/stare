// The unified per-volume index (docs/plans/courtlistener-mirror.md, "Index"): one
// gzipped text file per volume, as cited, for every source, with `page,source,ref` lines.
// The parsing is the WASM's (crates/stare/src/idx.rs, `lookup_idx`); this module fetches
// the files and follows a split volume's `#parts` header to the part a page is in.
//
// An entry is `{ page, source, ref }` plus, for `source: 'cap'`, `case_file` and
// `folder` (set when the case is in another CAP folder of a volume CAP split, whose zip
// is `<folder>.zip`), or, for `source: 'cl'`, `cluster_id` and `hash` (the
// CourtListener record). An alias (#151) is a `cap` entry with `reporter` set: the case
// is `case_file` in `<reporter>/<folder>.zip`, another volume's, and `via` says where
// the alias came from (`cl:8077312`, CourtListener's citation metadata). The volume's
// own CAP cases come first, then aliases, then CourtListener's records. A `cap` entry
// whose line has a span (D180) has `zip`, `{ offset, length, method }`: where its case
// JSON is in the zip (zipspan.js).

import { fetchCached, gunzip } from './cache.js';
import { indexPath } from './manifest.js';
import { pageKey } from './pagekey.js';
import { idxPath, indexUrl } from './sources.js';
import { loadWasm } from './wasm.js';
import { parseSpan } from './zipspan.js';

// Reads in flight or done this page, by key, so a brief citing one volume many times
// fetches its index once even when the checks run at the same time.
const reads = new Map();

// One part of a volume's index as bytes, or null when the build has no such file (a
// 404). Cached under its versioned path like the .bin files.
export async function readIdx(reporter, volume, part = 0) {
  const key = await indexPath(idxPath(reporter, String(volume), part));
  if (!reads.has(key)) {
    const read = fetchCached('bins', key, indexUrl(key)).catch((e) => {
      if (e.message.startsWith('NOT_FOUND')) return null;
      reads.delete(key); // a network error is worth retrying
      throw e;
    });
    reads.set(key, read);
  }
  return reads.get(key);
}

async function wasmLookup(bytes, page) {
  const w = await loadWasm();
  return JSON.parse(w.lookup_idx(bytes, String(page)));
}

/**
 * The entries at `page` (a number, or a label like `xxix`) of `volume`, CAP's first,
 * or null when the volume has no `.idx.gz` (so the caller can fall back to the .bin
 * files). Part 0 is read first; when its header puts the page in a later part, that
 * part is read too, and a missing later part is an error, not a miss.
 *
 * `deps` ({ readIdx, lookup }) are injectable for tests, which can't load the WASM or
 * reach idx.stare.pub; `lookup(bytes, page)` returns `{ part, entries }`.
 */
export async function idxEntries(reporter, volume, page, deps = {}) {
  const read = deps.readIdx || readIdx;
  const lookup = deps.lookup || wasmLookup;
  const head = await read(reporter, String(volume), 0);
  if (!head) return null;
  const found = await lookup(head, page);
  if (!found.part) return found.entries;
  const tail = await read(reporter, String(volume), found.part);
  if (!tail) throw new Error(`Missing part ${found.part} of ${reporter} vol. ${volume}'s index`);
  return (await lookup(tail, page)).entries;
}

// A trailing `key=value` field: a lowercase key, a value without whitespace (idx.rs,
// `is_field`).
const FIELD = /^[a-z]+=\S+$/;

/**
 * One line of a volume's index taken apart in JS, the way idx.rs's `parse_line` does:
 * `{ page, source, ref, fields }`, `page` the key as pagekey.js makes it and `fields`
 * the trailing `key=value` pieces, read from the end of the line only, so a case file
 * with a comma (`11, 12-01`) stays whole. Null for a blank, `#` or malformed line.
 */
export function parseIdxLine(raw) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) return null;
  const a = line.indexOf(',');
  const b = a < 0 ? -1 : line.indexOf(',', a + 1);
  if (b < 0) return null;
  const page = pageKey(line.slice(0, a));
  const source = line.slice(a + 1, b).trim();
  if (page === null || !/^[a-z]+$/.test(source)) return null;
  let ref = line.slice(b + 1);
  const fields = {};
  for (;;) {
    const i = ref.lastIndexOf(',');
    if (i < 0) break;
    const tail = ref.slice(i + 1).trim();
    if (!FIELD.test(tail) || !ref.slice(0, i).trim()) break;
    const eq = tail.indexOf('=');
    if (!(tail.slice(0, eq) in fields)) fields[tail.slice(0, eq)] = tail.slice(eq + 1);
    ref = ref.slice(0, i);
  }
  ref = ref.trim();
  return ref ? { page, source, ref, fields } : null;
}

/**
 * A parsed line as the WASM's `lookup_idx` gives an entry: `{ page, source, ref }` plus
 * `reporter`, `folder`, `case_file`, `via` and `zip` (`{ offset, length, method }`) for a
 * `cap` line, or `cluster_id` and `hash` for a `cl` line; null for a source this reader
 * doesn't know or a ref it can't take apart.
 */
export function lineEntry(l) {
  if (!l) return null;
  const page = String(l.page);
  if (l.source === 'cap') {
    const segs = l.ref.split('/');
    if (segs.length > 3 || segs.some((s) => !s)) return null;
    const e = { page, source: 'cap', ref: l.ref, case_file: segs[segs.length - 1] };
    if (segs.length === 3) e.reporter = segs[0];
    if (segs.length >= 2) e.folder = segs[segs.length - 2];
    if (l.fields.via) e.via = l.fields.via;
    const zip = l.fields.zip && parseSpan(l.fields.zip);
    if (zip) e.zip = zip;
    return e;
  }
  if (l.source === 'cl') {
    const m = /^(\d+)\/([0-9a-f]{16})$/.exec(l.ref);
    return m ? { page, source: 'cl', ref: l.ref, cluster_id: Number(m[1]), hash: m[2] } : null;
  }
  return null;
}

// Where an entry goes among a page's: the volume's own CAP cases, aliases, then
// CourtListener's records (idx.rs, `Entry::rank`).
const rank = (e) => (e.source === 'cl' ? 2 : e.reporter ? 1 : 0);

// Pages in index order: numbers numerically, before labels, which sort as strings.
function comparePages(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * One part's text read in JS: `{ parts, lines }`, `parts` part 0's `#parts` header as
 * page keys (empty when the volume isn't split) and `lines` every line that parses.
 */
export function parseIdxText(text) {
  const parts = [];
  const lines = [];
  let first = true;
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (!t) continue;
    const wasFirst = first;
    first = false;
    if (t.startsWith('#parts,') && wasFirst) {
      const pages = t.slice(7).split(',').map(pageKey);
      if (pages.every((p) => p !== null)) parts.push(...pages);
      continue;
    }
    const l = parseIdxLine(t);
    if (l) lines.push(l);
  }
  return { parts, lines };
}

/** Which part `page` is in, given part 0's header (idx.rs, `part_for`). */
export const partFor = (parts, page) => parts.filter((p) => comparePages(p, page) <= 0).length;

async function idxText(bytes) {
  return new TextDecoder().decode(await gunzip(bytes));
}

/**
 * idxEntries without the WASM: the entries at `page`, CAP's own first, then aliases,
 * then CourtListener's records, each with its fields (and its `zip` span) as
 * `lineEntry` gives them; null when the volume has no `.idx.gz`. For the search page's
 * snippets, which would otherwise load the reader's WASM for this alone.
 */
export async function idxEntriesJs(reporter, volume, page, deps = {}) {
  const read = deps.readIdx || readIdx;
  const head = await read(reporter, String(volume), 0);
  if (!head) return null;
  let { parts, lines } = parseIdxText(await idxText(head));
  const part = partFor(parts, page);
  if (part) {
    const tail = await read(reporter, String(volume), part);
    if (!tail) throw new Error(`Missing part ${part} of ${reporter} vol. ${volume}'s index`);
    ({ lines } = parseIdxText(await idxText(tail)));
  }
  return lines
    .filter((l) => l.page === page)
    .map(lineEntry)
    .filter(Boolean)
    .map((e, i) => [e, i])
    .sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1])
    .map(([e]) => e);
}

/**
 * The case files of CAP folder `folder` from its volume's index (`volume` the file it is
 * in: the folder itself, or the number a split folder is folded into), every part of it,
 * sorted and without duplicates: what the zip's own list of cases (the WASM's
 * `list_cases`) gives, for the reader's previous and next buttons, without the zip.
 * Aliases (which name other volumes' cases) and CourtListener's records are left out.
 */
export async function volumeCaseFiles(reporter, volume, folder, deps = {}) {
  const read = deps.readIdx || readIdx;
  const head = await read(reporter, String(volume), 0);
  if (!head) return [];
  const first = parseIdxText(await idxText(head));
  const rest = await Promise.all(first.parts.map(async (_, i) => {
    const bytes = await read(reporter, String(volume), i + 1);
    if (!bytes) throw new Error(`Missing part ${i + 1} of ${reporter} vol. ${volume}'s index`);
    return parseIdxText(await idxText(bytes)).lines;
  }));
  const files = new Set();
  for (const l of [first.lines, ...rest].flat()) {
    const e = l.source === 'cap' ? lineEntry(l) : null;
    if (!e || e.reporter) continue;
    if ((e.folder || String(volume)) === String(folder)) files.add(e.case_file);
  }
  return [...files].sort();
}

/**
 * Which zip the case at `page` is most likely in, read from part 0 of a volume's index
 * (`bytes`, as readIdx gives them) without the WASM, so the case viewer can start
 * fetching the case while the WASM is still on its way (#262). It's a guess for a
 * prefetch only: the WASM's `lookup_idx` (idxEntries) still decides what's shown, and a
 * wrong guess costs a download, never a wrong case.
 *
 * It's the first line at `page` (CAP's lines come first), as `{ reporter, folder,
 * caseFile, zip }`: `reporter` is null for the volume's own reporter and `folder` null for
 * the folder the index is named for; `zip` is the line's span (D180), or null, which
 * says to fetch the whole zip. `folder` set (`cited`, a CAP folder folded into another
 * volume's file) takes the first of that folder's own lines instead, as resolve.js does.
 * Null when that line is a CourtListener record (no zip), when nothing is at the page,
 * and for a split volume (a `#parts` header), whose page may be in another part.
 */
export async function idxZipHint(bytes, page, folder = null) {
  if (!bytes) return null;
  const text = await idxText(bytes);
  const want = pageKey(page);
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#parts')) return null;
    const l = parseIdxLine(line);
    if (!l || l.page !== want) continue;
    if (l.source !== 'cap') {
      if (folder) continue;
      return null;
    }
    const e = lineEntry(l);
    if (!e) continue;
    const hint = { reporter: e.reporter || null, folder: e.folder || null, caseFile: e.case_file, zip: e.zip || null };
    if (folder && (hint.reporter || hint.folder !== folder)) continue;
    return hint;
  }
  return null;
}
