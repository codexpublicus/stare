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
// own CAP cases come first, then aliases, then CourtListener's records.

import { fetchCached, gunzip } from './cache.js';
import { indexPath } from './manifest.js';
import { idxPath, indexUrl } from './sources.js';
import { loadWasm } from './wasm.js';

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

/**
 * Which zip the case at `page` is most likely in, read from part 0 of a volume's index
 * (`bytes`, as readIdx gives them) without the WASM, so the case viewer can start
 * fetching the zip while the WASM is still on its way (#262). It's a guess for a
 * prefetch only: the WASM's `lookup_idx` (idxEntries) still decides what's shown, and a
 * wrong guess costs a download, never a wrong case.
 *
 * It's the first line at `page` (CAP's lines come first), as `{ reporter, folder }`:
 * `reporter` is null for the volume's own reporter and `folder` null for the folder the
 * index is named for. `folder` set (`cited`, a CAP folder folded into another volume's
 * file) takes the first of that folder's own lines instead, as resolve.js does. Null when
 * that line is a CourtListener record (no zip), when nothing is at the page, and for a
 * split volume (a `#parts` header), whose page may be in another part.
 */
export async function idxZipHint(bytes, page, folder = null) {
  if (!bytes) return null;
  const text = new TextDecoder().decode(await gunzip(bytes));
  const want = String(page);
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#parts')) return null;
    if (!line || line.startsWith('#')) continue;
    const [at, source, ref] = line.split(',');
    if (at?.trim().toLowerCase() !== want || !ref) continue;
    if (source !== 'cap') {
      if (folder) continue;
      return null;
    }
    const parts = ref.trim().split('/');
    const hint = parts.length === 3 ? { reporter: parts[0], folder: parts[1] }
      : parts.length === 2 ? { reporter: null, folder: parts[0] }
        : { reporter: null, folder: null };
    if (folder && (hint.reporter || hint.folder !== folder)) continue;
    return hint;
  }
  return null;
}
