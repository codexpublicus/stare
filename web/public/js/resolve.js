import { cacheGet, cacheSet, fetchCached, fetchCachedText } from './cache.js';
import { indexUrl, zipUrl } from './sources.js';
import { hasFeature, requireFeature } from './mirror.js';
import { ClRecordError, fetchClRecord } from './cl.js';
import { idxEntries, idxZipHint, readIdx, volumeCaseFiles } from './idx.js';
import {
  citedSlug, foldedInto, hasIdx, indexPath, isVolumeKey, loadManifest, volumeCandidates,
} from './manifest.js';
import { loadWasm, WasmLoadError } from './wasm.js';
import { citedPage, filePage, labelCases, pageKey } from './pagekey.js';
import { parseSpan, readSpanText, spanKey, SpanError } from './zipspan.js';

let wasm = null;

/**
 * Parse citation input. Tries multiple formats:
 *   "31 A.2d 647"       → citare parses, gets the edition's slug (citedSlug)
 *   "a2d 31 647"        → slug format (legacy/direct)
 *   "a2d/31/647"        → URL format
 *   "a2d 31 647-02"     → with sequence
 *   "a3d 138-2 1012"    → naming a CAP volume folder
 *   "cai-cas 1 xxix"    → a labelled page (front matter), slug format
 *   "cal-app-4th 15 Supp. 1-01" → likewise, a supplement's page, with sequence
 *   "1 Cai. Cas. xxix"  → citare, with a labelled page
 *
 * `volume` is a string: the number as cited, or a CAP folder name (see manifest.js).
 * `page` is a number, or a label lowercased (pagekey.js).
 */
export async function parseInput(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // First try slug format: "a2d 31 647" or "a2d/31/647-02"
  const slugResult = parseSlugFormat(trimmed);
  if (slugResult) return slugResult;

  // Then try citare: "31 A.2d 647". A WASM load failure propagates, so
  // the caller reports it instead of calling the input unparseable.
  await ensureWasm();
  try {
    return inputFromCitations(JSON.parse(wasm.detect_citations(trimmed)));
  } catch (e) {
    // citare found nothing usable, fall through
  }

  return null;
}

/**
 * What the WASM's `detect_citations` output (parsed) says to look up: the first
 * citation's slug (citedSlug), volume and page, or null when it can't be looked up.
 */
export function inputFromCitations(cites) {
  const c = cites[0];
  const slug = citedSlug(c);
  const page = citedPage(c.page);
  if (!slug || !c.volume || page === null) return null;
  return {
    reporter: slug,
    volume: String(parseInt(c.volume, 10)),
    page,
    seq: null,
  };
}

// "<slug> <volume> <page>[-<seq>]", spaces or slashes between. The page is a number,
// or a label, which can hold spaces ("Supp. 1"); the last "-<digits>" is the sequence.
function parseSlugFormat(raw) {
  const m = raw.match(/^([a-z0-9-]+)[/\s]+([^/\s]+)[/\s]+(.+)$/i);
  if (!m) return null;
  const [, reporter, volume, pageStr] = m;
  if (!isVolumeKey(volume)) return null;

  const pageMatch = pageStr.trim().match(/^([^/]+?)(?:-(\d+))?$/);
  if (!pageMatch) return null;
  const page = pageKey(pageMatch[1]);
  if (page === null) return null;
  const seq = pageMatch[2] ? parseInt(pageMatch[2], 10) : null;

  return { reporter: reporter.toLowerCase(), volume, page, seq };
}

async function ensureWasm() {
  if (!wasm) wasm = await loadWasm();
  return wasm;
}

// The volume zip being fetched, or the last one fetched: resolve() guesses the zip from
// the volume's index (idxZipHint) and starts it before the WASM has loaded (#262), and
// resolveCap takes it up when it's the zip the lookup settles on, or starts it itself
// when the guess came later or not at all, so neither fetches it twice. One at a time.
let zipFetch = null;

function fetchZip(reporter, volume) {
  const key = `${reporter}/${volume}.zip`;
  if (zipFetch?.key !== key) {
    const promise = fetchCached('zips', key, zipUrl(reporter, volume));
    zipFetch = { key, promise };
    // A failure is thrown to whoever awaits it, and a later fetch starts afresh.
    promise.catch(() => { if (zipFetch?.promise === promise) zipFetch = null; });
  }
  return zipFetch.promise;
}

// The case being read by its zip span (D180, zipspan.js), or the last one read: resolve()
// starts it from idxZipHint before the WASM is in, as it starts a zip, and resolveCap
// takes it up when it's the case the lookup settles on. One at a time.
let spanFetch = null;

async function spanCacheKey(reporter, folder, span) {
  return spanKey((await loadManifest()).base, reporter, folder, span);
}

// `{ text, raw, total }` for the case JSON at `span` of `<reporter>/<folder>.zip`, or
// `{ whole }` (the zip, from a server that ignored the Range); see readSpanText.
function fetchSpanText(reporter, folder, span) {
  const key = `${reporter}/${folder}.zip@${span.offset}:${span.length}:${span.method}`;
  if (spanFetch?.key !== key) {
    const promise = (async () => readSpanText(zipUrl(reporter, folder), span, {
      key: await spanCacheKey(reporter, folder, span),
    }))();
    spanFetch = { key, promise };
    // A network error is worth another try; an answer that wasn't the span isn't.
    promise.catch((e) => { if (!(e instanceof SpanError) && spanFetch?.promise === promise) spanFetch = null; });
  }
  return spanFetch.promise;
}

// A volume folder's .bin, or null if it isn't indexed.
async function fetchBin(reporter, volume) {
  const key = await indexPath(`${reporter}/${volume}.bin`);
  try {
    return await fetchCached('bins', key, indexUrl(key));
  } catch (e) {
    if (e.message.startsWith('NOT_FOUND')) return null;
    throw new Error(`Couldn't reach the server. Check your connection and try again.`);
  }
}

// Find the volume folder with a case at `page` for a citation to `volume`. The folder
// named as cited is tried first; only on a miss are the manifest's other parts of a
// volume CAP split over several folders (a3d 138 and 138-2) tried. (The manifest is
// already loaded by then: every index file's path is under its `base`.)
async function locate(reporter, volume, page, onStatus) {
  onStatus('Fetching index...');
  if (typeof page === 'string') return locateLabel(reporter, volume, page);
  const binData = await fetchBin(reporter, volume);
  onStatus('Looking up page...');
  await ensureWasm();
  let caseFile = binData && wasm.lookup_page(binData, page);
  if (caseFile) return { volume, binData, caseFile };

  const manifest = await loadManifest();
  for (const other of volumeCandidates(manifest, reporter, volume, page)) {
    if (other === volume) continue;
    const otherBin = await fetchBin(reporter, other);
    caseFile = otherBin && wasm.lookup_page(otherBin, page);
    if (caseFile) return { volume: other, binData: otherBin, caseFile };
  }
  if (!binData)
    throw new Error(`This volume hasn't been indexed yet. We're still building the index — check back soon.`);
  throw new Error(`No case starts at page ${page} in ${reporter} vol. ${volume}.`);
}

// The cases on a labelled page, from the `.multi` of the folder named, where the .bin
// files keep them. A split volume's other folders aren't tried: their page ranges
// are numbers.
async function locateLabel(reporter, volume, label) {
  const key = await indexPath(`${reporter}/${volume}.multi`);
  let multi;
  try {
    multi = await fetchCachedText('multi', key, indexUrl(key));
  } catch (e) {
    throw new Error(`Couldn't reach the server. Check your connection and try again.`);
  }
  const allCases = labelCases(multi, label);
  if (allCases.length === 0) {
    if (multi === null && !(await fetchBin(reporter, volume)))
      throw new Error(`This volume hasn't been indexed yet. We're still building the index — check back soon.`);
    throw new Error(`No case starts at page ${label} in ${reporter} vol. ${volume}.`);
  }
  return { volume, allCases };
}

// `volume` is as cited or a folder name; the result's `volume` is the folder the case
// is in, which the zip, the scans and the page's URL all use.
//
// When the manifest has the unified index (`idx`), the volume's `.idx.gz` answers for
// every source in one fetch (plus a later part of a split volume): CAP's case at the
// page if there is one, else the first CourtListener record. A CAP folder folded into
// another volume's file ("a3d 138-2", in a3d/138.idx.gz) is looked up there, keeping
// that folder's cases. A volume with no `.idx.gz`, or a manifest without `idx`, reads
// the .bin and .multi files as before. A miss in a volume the index holds is a miss; it
// never becomes another source's case or a link out.
//
// Nothing here waits for the WASM until it's used (#262): the manifest, the index file
// and the zip the index points to (idxZipHint, a guess the WASM's lookup then confirms)
// are fetched while it downloads, so on a slow connection they're in by the time it is.
export async function resolve(reporter, citedVolume, page, onStatus, seq = null) {
  onStatus('Loading...');
  // Started now; a failure is thrown where the WASM is first awaited.
  ensureWasm().catch(() => {});

  const cited = String(citedVolume);
  const manifest = await loadManifest();
  if (hasIdx(manifest)) {
    onStatus('Fetching index...');
    const number = foldedInto(manifest, reporter, cited);
    // The case's span when its line has one (one Range request), else its whole zip.
    readIdx(reporter, number || cited, 0)
      .then((bytes) => idxZipHint(bytes, page, number ? cited : null))
      .then((hint) => {
        if (!hint || !hasFeature('text')) return;
        const span = seq === null || seq === 1 ? parseSpan(hint.zip) : null;
        if (span) fetchSpanText(hint.reporter || reporter, hint.folder || cited, span).catch(() => {});
        else if (!hint.zip) fetchZip(hint.reporter || reporter, hint.folder || cited);
      })
      .catch(() => {});
    let entries;
    try {
      entries = await idxEntries(reporter, number || cited, page);
    } catch (e) {
      // The lookup is where the WASM is first awaited; its failure is the loading bar's
      // to report, with a Retry button (main.js), not a network error.
      if (e instanceof WasmLoadError) throw e;
      throw new Error(`Couldn't reach the server. Check your connection and try again.`);
    }
    if (entries && number) {
      entries = entries.filter((e) => e.source === 'cap' && !e.reporter && e.folder === cited);
    }
    if (entries) return resolveEntries(reporter, cited, page, entries, onStatus, seq);
  }

  const located = await locate(reporter, cited, page, onStatus);
  if (located.allCases) {
    return resolveCap(reporter, located.volume, page, located.allCases, onStatus, seq);
  }
  const { volume, binData, caseFile } = located;
  const multiKey = await indexPath(`${reporter}/${volume}.multi`);
  const multiData = await fetchCachedText('multi', multiKey, indexUrl(multiKey));
  await ensureWasm();

  // The .bin's entry, then any more cases at the page from the .multi. A page whose
  // first case's name is too long for the .bin has a "*" there, and all its cases in
  // the .multi (lookup_page_all leaves the "*" out).
  let allCases = caseFile === '*' ? [] : [caseFile];
  if (multiData) {
    const allJson = wasm.lookup_page_all(binData, multiData, page);
    allCases = JSON.parse(allJson);
  }
  if (allCases.length === 0) {
    throw new Error(`No case starts at page ${page} in ${reporter} vol. ${volume}.`);
  }
  return resolveCap(reporter, volume, page, allCases, onStatus, seq);
}

// The case at a page from the unified index's entries there (the volume's own CAP
// cases, then aliases, then CourtListener's records): the first entry decides. CAP's
// cases at the page in the first entry's folder are its `allCases`; an alias (#151)
// resolves to the case it names, in its own reporter and folder, with `alias` on the
// result saying what was cited and where the alias came from; CourtListener's records,
// when neither is there.
async function resolveEntries(reporter, cited, page, entries, onStatus, seq) {
  if (entries.length === 0) {
    throw new Error(`No case starts at page ${page} in ${reporter} vol. ${cited}.`);
  }
  const first = entries[0];
  if (first.source === 'cap' && first.reporter) {
    const targetPage = filePage(first.case_file);
    const result = await resolveCap(
      first.reporter, first.folder, targetPage === null ? page : targetPage,
      [first.case_file], onStatus, null, new Map([[first.case_file, first.zip]]),
    );
    return { ...result, alias: { via: first.via || null, reporter, volume: cited, page } };
  }
  if (first.source === 'cap') {
    const folder = first.folder || null;
    const own = entries.filter((e) => e.source === 'cap' && !e.reporter && (e.folder || null) === folder);
    const allCases = own.map((e) => e.case_file);
    const spans = new Map(own.map((e) => [e.case_file, e.zip]));
    return resolveCap(reporter, folder || cited, page, allCases, onStatus, seq, spans);
  }
  return resolveCl(reporter, cited, page, entries.filter((e) => e.source === 'cl'), onStatus, seq);
}

// A CAP case: the `seq`th of `allCases` (the page's case files), or the first. `spans`
// maps the case files to their lines' zip spans (D180), where the index has them; with
// one, the case is read with one Range request (zipspan.js) and the result has no
// `zipData` but `zip`, which reads the rest of the zip by range when it's wanted
// (spanZip). Without a span, or when the span read fails or the server answers it with
// something other than those bytes, the whole zip is fetched as before (a 200 with the
// whole zip is taken as that).
async function resolveCap(reporter, volume, page, allCases, onStatus, seq, spans = null) {
  // A copy of stare.pub without the case text (tier 1) says so in place (main.js).
  requireFeature('text');
  onStatus('Fetching case data...');

  // If seq specified, pick that specific case; otherwise default to -01 (first).
  // The sequence number is after the file name's last hyphen ("1114-1140-02").
  const seqOf = (f) => parseInt(f.slice(f.lastIndexOf('-') + 1), 10);
  let activeCaseFile = allCases[0];
  let activeSeq = 1;
  if (seq !== null && seq > 0) {
    const target = allCases.find(f => seqOf(f) === seq);
    if (target) {
      activeCaseFile = target;
      activeSeq = seq;
    }
  } else {
    // Default to first case (-01), extract seq from filename
    activeSeq = seqOf(activeCaseFile) || 1;
  }

  const base = { reporter, volume, page, caseFile: activeCaseFile, seq: activeSeq, allCases };
  let zipData = null;
  // A zip already in memory (a prefetch for a line with no span, a page view's) has it.
  if (zipFetch?.key !== `${reporter}/${volume}.zip`) {
    // The index file a folder's lines are in: its own, or the number a split folder is
    // folded into (`138` for `138-2`).
    const fileVolume = spans ? foldedInto(await loadManifest(), reporter, volume) : null;
    const got = await readBySpan(reporter, volume, activeCaseFile, spans, fileVolume, {
      onStatus, wasm: async () => ensureWasm(),
    });
    if (got?.whole) zipData = got.whole;
    else if (got) return { ...base, ...got };
  }

  if (!zipData) {
    try {
      zipData = await fetchZip(reporter, volume);
    } catch (e) {
      throw new Error(`Couldn't reach the server. Check your connection and try again.`);
    }
  }

  await ensureWasm();
  onStatus('Extracting case...');
  const caseJsonStr = wasm.extract_case(zipData, activeCaseFile);
  const caseData = JSON.parse(caseJsonStr);

  // Get sorted list of all cases in this volume for prev/next navigation
  const volumeCasesJson = wasm.list_cases(zipData);
  const volumeCases = JSON.parse(volumeCasesJson).sort();

  return { ...base, caseData, zipData, volumeCases };
}

/**
 * A CAP case read by its line's zip span (D180): `{ caseData, zipData: null, zip,
 * volumeCases }` (`zip` is spanZip's, `volumeCases` the folder's case files from its
 * index, for the previous and next buttons), or `{ whole }`, the zip, when the server
 * answered the range with all of it, or null when there's no span for `caseFile` in
 * `spans` or it couldn't be read (a network error, a 206 for other bytes, bytes that
 * don't inflate or parse), which leaves the case to the whole zip, as before. A WASM
 * that won't load is thrown, for the loading bar's Retry.
 *
 * `deps`: `wasm` (an async function giving the module), `onStatus`, and, for tests,
 * `readSpan` (fetchSpanText's shape), `volumeCaseFiles` and `cacheSet`.
 */
export async function readBySpan(reporter, folder, caseFile, spans, fileVolume = null, deps = {}) {
  const span = parseSpan(spans?.get(caseFile));
  if (!span) return null;
  const listCases = deps.volumeCaseFiles || volumeCaseFiles;
  // The previous and next cases, from the volume's index, alongside the case.
  const listing = Promise.resolve()
    .then(() => listCases(reporter, fileVolume || folder, folder))
    .catch(() => []);
  let got;
  try {
    got = await (deps.readSpan || fetchSpanText)(reporter, folder, span);
  } catch {
    return null;
  }
  if (got.whole) {
    (deps.cacheSet || cacheSet)('zips', `${reporter}/${folder}.zip`, got.whole);
    return { whole: got.whole };
  }
  const w = await deps.wasm();
  deps.onStatus?.('Extracting case...');
  let caseData;
  try {
    caseData = JSON.parse(w.parse_case_json(got.raw));
  } catch {
    return null;
  }
  const zip = spanZip(reporter, folder, spans, got.total, { wasm: w, ...(deps.readSpan ? { readSpan: deps.readSpan } : {}) });
  return { caseData, zipData: null, zip, volumeCases: await listing };
}

/**
 * The rest of a zip a case was read out of by its span (D180), for the reader: what it
 * needs besides the case JSON, read by range requests and kept, so nothing fetches the
 * whole zip until a page view asks for it.
 *
 * - `caseData(caseFile)`: another case of the page (the multi-case notice's switch), by
 *   its own span, else out of the zip by range (casenames.js's zipFileText).
 * - `html(caseFile)`: the case's CAP HTML (`html/<case>.html`), for the reader's page
 *   markers and footnotes: the zip's central directory from its tail (once a page per
 *   zip), then the entry. `total`, the zip's size from the span's Content-Range, makes
 *   the tail an explicit range, which needs no CORS preflight. Kept in the cache beside
 *   the case's span.
 * - `pageOrders(caseFile)`: the case's METS ORDERs, `{ first, last }`, from the zip's
 *   `metadata/CasesMetadata.json` (casenames.js's volumePageOrders), for the sidebar's
 *   archival PDF link, only once the link is about to be used.
 * - `loadZip()`: the whole zip, fetched (and cached) as before, for the page views.
 *
 * `spans` maps case files to spans; `total` may be null (the span came from the cache).
 * `deps` ({ zipFileText, volumePageOrders, readSpan, cacheGet, cacheSet, fetchZip, wasm,
 * base }) are injectable for tests.
 */
export function spanZip(reporter, folder, spans, total, deps = {}) {
  const url = zipUrl(reporter, folder);
  const get = deps.cacheGet || cacheGet;
  const set = deps.cacheSet || cacheSet;
  const names = () => (deps.zipFileText ? deps : import('./casenames.js'));
  const htmls = new Map();
  const rangeDeps = () => ({ ...(total ? { size: total } : {}), ...(deps.wasm ? { wasm: deps.wasm } : {}), ...(deps.fetchRange ? { fetchRange: deps.fetchRange } : {}) });
  const zip = {
    async caseData(caseFile) {
      const span = parseSpan(spans?.get(caseFile));
      const w = deps.wasm || await ensureWasm();
      if (span) {
        try {
          const got = await (deps.readSpan || fetchSpanText)(reporter, folder, span);
          if (!got.whole) return JSON.parse(w.parse_case_json(got.raw));
        } catch {
          // Read out of the zip by range instead, below.
        }
      }
      const text = await (await names()).zipFileText(url, `json/${caseFile}.json`, rangeDeps());
      return JSON.parse(w.parse_case_json(new TextEncoder().encode(text)));
    },
    html(caseFile) {
      if (!htmls.has(caseFile)) {
        const read = (async () => {
          const span = parseSpan(spans?.get(caseFile));
          const key = span
            ? `${spanKey(deps.base ?? (await loadManifest()).base, reporter, folder, span)}#html` : null;
          const hit = key ? await get('zips', key).catch(() => null) : null;
          if (hit) return new TextDecoder().decode(hit);
          const text = await (await names()).zipFileText(url, `html/${caseFile}.html`, rangeDeps());
          if (key) await set('zips', key, new TextEncoder().encode(text)).catch(() => {});
          return text;
        })();
        htmls.set(caseFile, read);
        read.catch(() => htmls.delete(caseFile));
      }
      return htmls.get(caseFile);
    },
    async pageOrders(caseFile) {
      const orders = await (await names()).volumePageOrders(reporter, folder, rangeDeps());
      return orders[caseFile] || null;
    },
    async loadZip() {
      return (deps.fetchZip || fetchZip)(reporter, folder);
    },
  };
  return zip;
}

// The CourtListener record at `page` of `volume` (the `seq`th when several start
// there). The result has the CAP result's fields, with no zip: `caseFile` is
// `cl/<cluster_id>`, `allCases` every record at the page.
async function resolveCl(reporter, volume, page, entries, onStatus, seq) {
  const n = seq !== null && seq > 0 && seq <= entries.length ? seq : 1;
  requireFeature('text');
  onStatus('Fetching case data...');
  let caseData;
  try {
    caseData = await fetchClRecord(entries[n - 1]);
  } catch (e) {
    if (e instanceof WasmLoadError) throw e;
    if (e instanceof ClRecordError) throw new Error(`Couldn't read the CourtListener record for this case.`);
    throw new Error(`Couldn't reach the server. Check your connection and try again.`);
  }
  const allCases = entries.map((e) => `cl/${e.cluster_id}`);
  return {
    reporter, volume, page, caseFile: allCases[n - 1], seq: n, allCases, caseData,
    zipData: null, volumeCases: [], source: 'courtlistener',
  };
}

export function extractCase(zipData, caseFile) {
  if (!wasm) throw new Error('WASM not initialized');
  const caseJsonStr = wasm.extract_case(zipData, caseFile);
  return JSON.parse(caseJsonStr);
}

export function getPageOrders(zipData, caseFile) {
  if (!wasm) throw new Error('WASM not initialized');
  const result = wasm.get_page_orders(zipData, caseFile);
  return JSON.parse(result);
}

export function extractFile(zipData, path) {
  if (!wasm) throw new Error('WASM not initialized');
  return wasm.extract_file(zipData, path);
}
