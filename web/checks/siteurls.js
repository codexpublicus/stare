// Every URL stare.pub serves or fetches, with the request types a browser would make for
// it, for the filter-list check (#265): each file in the build (web/dist), and the index
// and data hosts' files in each of their path patterns, for every reporter in
// /reporters.json (reporter slugs are path segments a rule could match).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import {
  PDF_URL, clRecordUrl, idxPath, indexUrl, pdfManifestUrl, pdfUrl, tarCsvUrl, tarUrl, zipUrl,
} from '../public/js/sources.js';

export const SITE = 'https://stare.pub/';

// Files the build writes that the Worker reads as configuration and never serves.
const NOT_SERVED = new Set(['_headers', '_redirects', '_routes.json']);

// How a browser asks for a file, by extension. A script is also fetched (the WASM loader
// imports its glue; tooling and preloads fetch), and anything else may be fetched by
// the site, opened as a page, or requested by something else.
const TYPES = {
  '.js': ['script', 'xmlhttprequest'],
  '.mjs': ['script', 'xmlhttprequest'],
  '.css': ['stylesheet'],
  '.woff2': ['font'],
  '.woff': ['font'],
  '.png': ['image'],
  '.jpg': ['image'],
  '.webp': ['image'],
  '.svg': ['image', 'main_frame'],
  '.ico': ['image'],
  '.html': ['main_frame'],
};
const OTHER = ['xmlhttprequest', 'main_frame', 'other'];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** `{ url, type, from }` for every file in the build at `distDir`. */
export function distUrls(distDir) {
  const out = [];
  for (const file of walk(distDir)) {
    const rel = relative(distDir, file).split(sep).join('/');
    if (NOT_SERVED.has(rel)) continue;
    const ext = rel.includes('.') ? rel.slice(rel.lastIndexOf('.')) : '';
    const types = TYPES[ext] || OTHER;
    const urls = [SITE + rel];
    // A page is served at its directory, with and without the slash.
    if (rel === 'index.html') urls.push(SITE);
    else if (rel.endsWith('/index.html')) urls.push(SITE + rel.slice(0, -'index.html'.length), SITE + rel.slice(0, -'/index.html'.length));
    for (const url of urls) for (const type of types) out.push({ url, type, from: `dist/${rel}` });
  }
  return out;
}

// A build's prefix on the index host; the version is a date, like any build's.
const BASE = 'v/v2026.10.26/';
// A CourtListener record (data.stare.pub/cl), as the index names them.
const CL_RECORD = [4893133, '62f253f296600fb7'];

/**
 * `{ url, type, from }` for the index host's and data hosts' files: the manifest and
 * reports, the search tree's files, and for every reporter in `reporters` (reporters.json's `reporters`), a
 * volume's index files (unified, split, and the older .bin and .multi), zip, tar and
 * .tar.csv, archival PDF and its manifest.
 */
export function dataUrls(reporters) {
  const out = [];
  const add = (url, types, from) => { for (const type of types) out.push({ url, type, from }); };
  const xhr = ['xmlhttprequest'];
  add(indexUrl('manifest.json'), xhr, 'manifest');
  add(indexUrl('reports/index.json'), xhr, 'reports');
  add(indexUrl(`${BASE}manifest.json`), xhr, 'manifest');
  add(indexUrl(`${BASE}report.json`), xhr, 'reports');
  add(`${PDF_URL}/manifest.json`, xhr, 'pdf manifest');
  add(clRecordUrl(...CL_RECORD), xhr, 'cl record');
  // the full-text search tree the search page reads (the index builder's docs/search-index.md)
  for (const file of ['manifest.json', 'facets.json', 'cards/0.bin', 'low/0.bin', 'low/176.bin', 'indexes/terms/0.eidx',
    'indexes/terms/70658.eidx', 'indexes/jurisdiction/0.eidx', 'indexes/court/0.eidx', 'indexes/year/0.eidx',
    'indexes/reporter/0.eidx', 'indexes/court_year/0.eidx']) {
    add(indexUrl(`${BASE}search/${file}`), xhr, 'search');
  }
  for (const [slug, r] of Object.entries(reporters)) {
    const first = String(r?.volumes?.first ?? '1');
    const volume = /^\d(?:[0-9a-z-]*[0-9a-z])?$/.test(first) ? first : '1';
    const from = `reporter ${slug}`;
    add(indexUrl(`${BASE}${idxPath(slug, volume)}`), xhr, from);
    add(indexUrl(`${BASE}${idxPath(slug, volume, 1)}`), xhr, from);
    add(indexUrl(`${BASE}${slug}/${volume}.bin`), xhr, from);
    add(indexUrl(`${BASE}${slug}/${volume}.multi`), xhr, from);
    add(indexUrl(`${slug}/${volume}.bin`), xhr, from);
    add(zipUrl(slug, volume), xhr, from);
    add(tarUrl(slug, volume), xhr, from);
    add(tarCsvUrl(slug, volume), xhr, from);
    add(pdfUrl(slug, volume), ['xmlhttprequest', 'main_frame'], from);
    add(pdfManifestUrl(slug, volume), xhr, from);
  }
  return out;
}

/** reporters.json's `reporters` from the build at `distDir`. */
export function buildReporters(distDir) {
  return JSON.parse(readFileSync(join(distDir, 'reporters.json'), 'utf8')).reporters;
}
