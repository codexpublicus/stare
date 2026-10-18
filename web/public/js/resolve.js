import { fetchCached, fetchCachedText } from './cache.js';
import { indexUrl, zipUrl } from './sources.js';
import { ClRecordError, fetchClRecord } from './cl.js';
import { idxEntries } from './idx.js';
import {
  citedSlug, foldedInto, hasIdx, indexPath, isVolumeKey, loadManifest, volumeCandidates,
} from './manifest.js';
import { loadWasm } from './wasm.js';

let wasm = null;

/**
 * Parse citation input. Tries multiple formats:
 *   "31 A.2d 647"       → citare parses, gets the edition's slug (citedSlug)
 *   "a2d 31 647"        → slug format (legacy/direct)
 *   "a2d/31/647"        → URL format
 *   "a2d 31 647-02"     → with sequence
 *   "a3d 138-2 1012"    → naming a CAP volume folder
 *
 * `volume` is a string: the number as cited, or a CAP folder name (see manifest.js).
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
  if (!slug || !c.volume || !c.page) return null;
  return {
    reporter: slug,
    volume: String(parseInt(c.volume, 10)),
    page: parseInt(c.page, 10),
    seq: null,
  };
}

function parseSlugFormat(raw) {
  const parts = raw.replace(/\//g, ' ').split(/\s+/);
  if (parts.length !== 3) return null;
  const [reporter, volume, pageStr] = parts;
  if (!isVolumeKey(volume)) return null;

  const pageMatch = pageStr.match(/^(\d+)(?:-(\d+))?$/);
  if (!pageMatch) return null;
  const page = parseInt(pageMatch[1], 10);
  const seq = pageMatch[2] ? parseInt(pageMatch[2], 10) : null;

  return { reporter: reporter.toLowerCase(), volume, page, seq };
}

async function ensureWasm() {
  if (!wasm) wasm = await loadWasm();
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
  const binData = await fetchBin(reporter, volume);
  onStatus('Looking up page...');
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
export async function resolve(reporter, citedVolume, page, onStatus, seq = null) {
  onStatus('Loading...');
  await ensureWasm();

  const cited = String(citedVolume);
  const manifest = await loadManifest();
  if (hasIdx(manifest)) {
    onStatus('Fetching index...');
    const number = foldedInto(manifest, reporter, cited);
    let entries;
    try {
      entries = await idxEntries(reporter, number || cited, page);
    } catch (e) {
      throw new Error(`Couldn't reach the server. Check your connection and try again.`);
    }
    if (entries && number) {
      entries = entries.filter((e) => e.source === 'cap' && !e.reporter && e.folder === cited);
    }
    if (entries) return resolveEntries(reporter, cited, page, entries, onStatus, seq);
  }

  const { volume, binData, caseFile } = await locate(reporter, cited, page, onStatus);
  const multiKey = await indexPath(`${reporter}/${volume}.multi`);
  const multiData = await fetchCachedText('multi', multiKey, indexUrl(multiKey));

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
    const targetPage = parseInt(first.case_file.replace(/^\[/, ''), 10);
    const result = await resolveCap(
      first.reporter, first.folder, Number.isNaN(targetPage) ? page : targetPage,
      [first.case_file], onStatus, null,
    );
    return { ...result, alias: { via: first.via || null, reporter, volume: cited, page } };
  }
  if (first.source === 'cap') {
    const folder = first.folder || null;
    const allCases = entries
      .filter((e) => e.source === 'cap' && (e.folder || null) === folder)
      .map((e) => e.case_file);
    return resolveCap(reporter, folder || cited, page, allCases, onStatus, seq);
  }
  return resolveCl(reporter, cited, page, entries.filter((e) => e.source === 'cl'), onStatus, seq);
}

// A CAP case from its folder's zip: the `seq`th of `allCases` (the page's case files),
// or the first.
async function resolveCap(reporter, volume, page, allCases, onStatus, seq) {
  const zipKey = `${reporter}/${volume}.zip`;
  onStatus('Fetching case data...');
  let zipData;
  try {
    zipData = await fetchCached('zips', zipKey, zipUrl(reporter, volume));
  } catch (e) {
    throw new Error(`Couldn't reach the server. Check your connection and try again.`);
  }

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

  onStatus('Extracting case...');
  const caseJsonStr = wasm.extract_case(zipData, activeCaseFile);
  const caseData = JSON.parse(caseJsonStr);

  // Get sorted list of all cases in this volume for prev/next navigation
  const volumeCasesJson = wasm.list_cases(zipData);
  const volumeCases = JSON.parse(volumeCasesJson).sort();

  return { reporter, volume, page, caseFile: activeCaseFile, seq: activeSeq, allCases, caseData, zipData, volumeCases };
}

// The CourtListener record at `page` of `volume` (the `seq`th when several start
// there). The result has the CAP result's fields, with no zip: `caseFile` is
// `cl/<cluster_id>`, `allCases` every record at the page.
async function resolveCl(reporter, volume, page, entries, onStatus, seq) {
  const n = seq !== null && seq > 0 && seq <= entries.length ? seq : 1;
  onStatus('Fetching case data...');
  let caseData;
  try {
    caseData = await fetchClRecord(entries[n - 1]);
  } catch (e) {
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
