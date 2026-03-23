import { fetchCached, fetchCachedText } from './cache.js';

const INDEX_URL = '/data';
const ZIP_URL = 'https://static.case.law';

let wasm = null;

export function parseInput(raw) {
  const parts = raw.trim().replace(/\//g, ' ').split(/\s+/);
  if (parts.length !== 3) return null;
  const [reporter, volStr, pageStr] = parts;
  const volume = parseInt(volStr, 10);
  const page = parseInt(pageStr, 10);
  if (isNaN(volume) || isNaN(page)) return null;
  return { reporter: reporter.toLowerCase(), volume, page };
}

export async function resolve(reporter, volume, page, onStatus) {
  if (!wasm) {
    onStatus('Loading...');
    const mod = await import('/wasm/stare_wasm.js');
    await mod.default();
    wasm = mod;
  }

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

  onStatus('Extracting case...');
  const caseJsonStr = wasm.extract_case(zipData, caseFile);
  const caseData = JSON.parse(caseJsonStr);

  return { reporter, volume, page, caseFile, allCases, caseData, zipData };
}

export function extractCase(zipData, caseFile) {
  if (!wasm) throw new Error('WASM not initialized');
  const caseJsonStr = wasm.extract_case(zipData, caseFile);
  return JSON.parse(caseJsonStr);
}
