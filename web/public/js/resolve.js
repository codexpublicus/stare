import { fetchCached, fetchCachedText } from './cache.js';

const INDEX_URL = 'https://idx.stare.pub';
const ZIP_URL = 'https://static.case.law';

let wasm = null;

/**
 * Parse citation input. Tries multiple formats:
 *   "31 A.2d 647"       → citare parses, gets harvard_slug
 *   "a2d 31 647"        → slug format (legacy/direct)
 *   "a2d/31/647"        → URL format
 *   "a2d 31 647-02"     → with sequence
 */
export async function parseInput(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // First try slug format: "a2d 31 647" or "a2d/31/647-02"
  const slugResult = parseSlugFormat(trimmed);
  if (slugResult) return slugResult;

  // Then try citare: "31 A.2d 647"
  try {
    await ensureWasm();
    const json = wasm.detect_citations(trimmed);
    const cites = JSON.parse(json);
    if (cites.length > 0) {
      const c = cites[0];
      if (c.harvard_slug && c.volume && c.page) {
        return {
          reporter: c.harvard_slug,
          volume: parseInt(c.volume, 10),
          page: parseInt(c.page, 10),
          seq: null,
        };
      }
    }
  } catch (e) {
    // citare failed, fall through
  }

  return null;
}

function parseSlugFormat(raw) {
  const parts = raw.replace(/\//g, ' ').split(/\s+/);
  if (parts.length !== 3) return null;
  const [reporter, volStr, pageStr] = parts;
  const volume = parseInt(volStr, 10);
  if (isNaN(volume)) return null;

  const pageMatch = pageStr.match(/^(\d+)(?:-(\d+))?$/);
  if (!pageMatch) return null;
  const page = parseInt(pageMatch[1], 10);
  const seq = pageMatch[2] ? parseInt(pageMatch[2], 10) : null;

  return { reporter: reporter.toLowerCase(), volume, page, seq };
}

async function ensureWasm() {
  if (!wasm) {
    const mod = await import('/wasm/stare_wasm.js');
    await mod.default();
    wasm = mod;
  }
}

export async function resolve(reporter, volume, page, onStatus, seq = null) {
  onStatus('Loading...');
  await ensureWasm();

  const binKey = `${reporter}/${volume}.bin`;
  onStatus('Fetching index...');
  let binData;
  try {
    binData = await fetchCached('bins', binKey, `${INDEX_URL}/${reporter}/${volume}.bin`);
  } catch (e) {
    if (e.message.startsWith('NOT_FOUND'))
      throw new Error(`This volume hasn't been indexed yet. We're still building the index — check back soon.`);
    throw new Error(`Couldn't reach the server. Check your connection and try again.`);
  }

  const multiKey = `${reporter}/${volume}.multi`;
  const multiData = await fetchCachedText('multi', multiKey, `${INDEX_URL}/${reporter}/${volume}.multi`);

  onStatus('Looking up page...');
  const caseFile = wasm.lookup_page(binData, page);
  if (!caseFile) {
    throw new Error(`No case starts at page ${page} in ${reporter} vol. ${volume}.`);
  }

  let allCases = [caseFile];
  if (multiData) {
    const allJson = wasm.lookup_page_all(binData, multiData, page);
    allCases = JSON.parse(allJson);
  }

  const zipKey = `${reporter}/${volume}.zip`;
  onStatus('Fetching case data...');
  let zipData;
  try {
    zipData = await fetchCached('zips', zipKey, `${ZIP_URL}/${reporter}/${volume}.zip`);
  } catch (e) {
    throw new Error(`Couldn't reach the server. Check your connection and try again.`);
  }

  // If seq specified, pick that specific case; otherwise default to -01 (first)
  let activeCaseFile = caseFile;
  let activeSeq = 1;
  if (seq !== null && seq > 0) {
    const target = allCases.find(f => {
      const s = parseInt(f.split('-')[1], 10);
      return s === seq;
    });
    if (target) {
      activeCaseFile = target;
      activeSeq = seq;
    }
  } else {
    // Default to first case (-01), extract seq from filename
    activeSeq = parseInt(activeCaseFile.split('-')[1], 10) || 1;
  }

  onStatus('Extracting case...');
  const caseJsonStr = wasm.extract_case(zipData, activeCaseFile);
  const caseData = JSON.parse(caseJsonStr);

  // Get sorted list of all cases in this volume for prev/next navigation
  const volumeCasesJson = wasm.list_cases(zipData);
  const volumeCases = JSON.parse(volumeCasesJson).sort();

  return { reporter, volume, page, caseFile: activeCaseFile, seq: activeSeq, allCases, caseData, zipData, volumeCases };
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
