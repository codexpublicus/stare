// Where the site reads its data. Every URL the site fetches from, or links to, for
// index or corpus files is built here; nothing else names a data host.
//
// MIRROR_URL is a full CAP mirror laid out like static.case.law
// (`<reporter>/<volume>.<ext>`). Each kind of corpus file has its own base, defaulting
// to the mirror, because each moves to our own copy on its own schedule: the zips
// already have (data.stare.pub, codex-data's `cap/`, codexpublicus/stare#42), and so have
// the PDFs, which are our archival PDFs (#51), not CAP's: one per volume with scans, at
// `pdf/<jurisdiction>/<reporter>/<volume>.pdf` with its manifest beside it as
// `<volume>.json` (D120, D122; the index builder's pdf-publish). The tars stay on the mirror.
// A .tar.csv holds byte offsets into its tar, so the tar it's read against must be
// byte-identical to the one it was made from; sharing one base keeps them paired.

//
// A self-hosted copy of stare.pub (#231, D119) runs this same code. On stare.pub, its
// subdomains and the Workers previews the bases are the hosts below. On any other host the
// module reads /mirror/mirror.json once, before it finishes loading (a top-level await, so
// no module that imports this one runs, and no URL is built, until that has settled), and
// when it's a copy's file the bases move to the copy's /mirror/idx and /mirror/data. The
// bases are `let` bindings for that reason; importers see the settled values.

export const UPSTREAM = 'https://stare.pub';
const UPSTREAM_INDEX = 'https://idx.stare.pub';
const UPSTREAM_DATA = 'https://data.stare.pub';

export let INDEX_URL = UPSTREAM_INDEX;
export const MIRROR_URL = 'https://static.case.law';

export let DATA_URL = UPSTREAM_DATA;
export let ZIP_URL = `${DATA_URL}/cap`;
export let TAR_URL = MIRROR_URL; // the .tar and its .tar.csv
export let PDF_URL = `${DATA_URL}/pdf`;

// stare.pub and its subdomains, and the Workers previews site.yml uploads
// (`main-stare-pub.nick-441.workers.dev`, `<version>-stare-pub.nick-441.workers.dev`).
const UPSTREAM_HOST = /^(?:(?:[a-z0-9-]+\.)*stare\.pub|(?:[a-z0-9-]+-)?stare-pub\.nick-441\.workers\.dev)\.?$/;

/** Whether `hostname` is stare.pub's own, where the data comes from idx. and data.stare.pub. */
export const isUpstreamHost = (hostname) => UPSTREAM_HOST.test(String(hostname || '').toLowerCase());

// mirror.json: what a copy holds (schemas/mirror.v1.schema.json, mirror-kit/README.md).
export const MIRROR_JSON_PATH = '/mirror/mirror.json';
const MIRROR_FORMAT = 'stare-mirror';
const MIRROR_FORMAT_VERSION = /^1\.\d+\.\d+$/;
// How long the reader waits for mirror.json before it gives up and reads stare.pub's hosts;
// well under the boot guard's 10 seconds (src/lib/bootguard.js).
const MIRROR_TIMEOUT_MS = 4000;

/**
 * A parsed mirror.json, or null when `raw` isn't one this reader understands: format
 * `stare-mirror` at a 1.x `format_version`. The result keeps `upstream`, `release`,
 * `data_date`, `tiers` and `components` (`{ id: { version } }`); missing optional fields
 * are null or empty.
 */
export function parseMirror(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.format !== MIRROR_FORMAT || typeof raw.format_version !== 'string'
      || !MIRROR_FORMAT_VERSION.test(raw.format_version)) return null;
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const components = {};
  if (raw.components && typeof raw.components === 'object' && !Array.isArray(raw.components)) {
    for (const [id, c] of Object.entries(raw.components)) {
      components[id] = { version: str(c?.version) };
    }
  }
  return {
    format_version: raw.format_version,
    // A copy names stare.pub as its upstream; the reader links nowhere else.
    upstream: UPSTREAM,
    release: str(raw.release),
    data_date: str(raw.data_date),
    tiers: Array.isArray(raw.tiers) ? raw.tiers.filter((t) => Number.isSafeInteger(t)) : [],
    components,
  };
}

/**
 * Reads `/mirror/mirror.json` from `origin` with `fetchFn` and returns parseMirror's result,
 * or null for anything else: a 404, a network error or timeout, or a body that isn't JSON
 * (a development server's fallback answers HTML with a 200).
 */
export async function detectMirror(origin, fetchFn = globalThis.fetch, timeoutMs = MIRROR_TIMEOUT_MS) {
  if (typeof fetchFn !== 'function') return null;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const resp = await fetchFn(new URL(MIRROR_JSON_PATH, origin).href, {
      cache: 'no-cache', credentials: 'same-origin', signal: ctl?.signal,
    });
    if (!resp || !resp.ok) return null;
    const type = resp.headers?.get?.('content-type') || '';
    if (/text\/html/i.test(type)) return null;
    let raw;
    try {
      raw = JSON.parse(await resp.text());
    } catch {
      return null;
    }
    return parseMirror(raw);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The bases a copy at `origin` reads from: its /mirror/idx and /mirror/data. */
export function mirrorBases(origin) {
  const index = new URL('/mirror/idx', origin).href;
  const data = new URL('/mirror/data', origin).href;
  return {
    INDEX_URL: index,
    DATA_URL: data,
    ZIP_URL: `${data}/cap`,
    // The raw CAP tars sit beside the zips in a copy (D122); only a copy with a `cap-raw/`
    // component has them, and the Raw Scans view says so in place without one
    // (hasFeature('raw-scans')). Never static.case.law from a copy.
    TAR_URL: `${data}/cap`,
    PDF_URL: `${data}/pdf`,
  };
}

/** This copy's mirror.json (parseMirror's shape), or null on stare.pub and anywhere without one. */
export let MIRROR = null;

function useMirror(mirror, origin) {
  if (!mirror) return;
  const b = mirrorBases(origin);
  INDEX_URL = b.INDEX_URL;
  DATA_URL = b.DATA_URL;
  ZIP_URL = b.ZIP_URL;
  TAR_URL = b.TAR_URL;
  PDF_URL = b.PDF_URL;
  MIRROR = mirror;
}

// The detection itself: once, before anything imports a base.
if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol) && !isUpstreamHost(location.hostname)) {
  useMirror(await detectMirror(location.origin), location.origin);
}

// What each feature needs a copy to hold (D119's tiers): case text, CAP's zips (`cap`) or
// CourtListener's records (`cl`); full-text search, the search tree; the archival PDFs, a
// `pdf/<reporter>` component; the raw scans, a `cap-raw/<reporter>` one.
const FEATURES = {
  text: (ids) => ids.includes('cap') || ids.includes('cl'),
  search: (ids) => ids.includes('search'),
  pages: (ids) => ids.some((id) => id.startsWith('pdf/')),
  'raw-scans': (ids) => ids.some((id) => id.startsWith('cap-raw/')),
};

/**
 * Whether `mirror` (a parseMirror result; null is stare.pub) has `feature`: `text`, `search`,
 * `pages` or `raw-scans`. stare.pub has every one.
 */
export function mirrorHasFeature(mirror, feature) {
  if (!mirror) return true;
  const test = FEATURES[feature];
  if (!test) throw new Error(`Unknown feature ${feature}`);
  return test(Object.keys(mirror.components || {}));
}

/** mirrorHasFeature for the copy the page is on. */
export const hasFeature = (feature) => mirrorHasFeature(MIRROR, feature);

/**
 * The same page on stare.pub, for a link out from a copy: `path` is a root-relative path
 * with any query and hash (`/search?q=x`, `/#a2d/31/647-01`).
 */
export function upstreamUrl(path = '/') {
  const p = String(path || '/');
  return UPSTREAM + (p.startsWith('/') ? p : `/${p}`);
}

/**
 * An absolute URL read out of a data file (a ledger's `errata`, any `https://data.stare.pub/...`
 * or `https://idx.stare.pub/...`), as the base it belongs to: on a copy, the copy's file at
 * the same path, so a copy never follows a data file out to stare.pub. Anything else is
 * returned unchanged.
 */
export function localDataUrl(url) {
  const s = String(url || '');
  for (const [upstream, local] of [[UPSTREAM_DATA, DATA_URL], [UPSTREAM_INDEX, INDEX_URL]]) {
    if (s === upstream || s.startsWith(`${upstream}/`)) return local + s.slice(upstream.length);
  }
  return s;
}

// The jurisdiction segment of a reporter's PDF paths: `us`, except the territories' own
// reporters. A copy of the index builder's pipelines/pdf-publish/reporter-jurisdictions.json
// (derived from codexpublicus/exemplar 0.4.0's court registry), which pdf-publish's
// index, data.stare.pub/pdf/manifest.json, repeats under `jurisdictions`. The paths are
// immutable once published, so the two change together or not at all.
export const PDF_JURISDICTIONS = Object.freeze({
  'am-samoa': 'as',
  'am-samoa-2d': 'as',
  'am-samoa-3d': 'as',
  guam: 'gu',
  'n-mar-i': 'mp',
  pr: 'pr',
  'pr-dec': 'pr',
  'pr-sent': 'pr',
  tca: 'pr',
  vi: 'vi',
});
export const pdfJurisdiction = (reporter) => PDF_JURISDICTIONS[reporter] || 'us';

export const indexUrl = (path) => `${INDEX_URL}/${path}`;
export const zipUrl = (reporter, volume) => `${ZIP_URL}/${reporter}/${volume}.zip`;
export const tarUrl = (reporter, volume) => `${TAR_URL}/${reporter}/${volume}.tar`;
export const tarCsvUrl = (reporter, volume) => `${TAR_URL}/${reporter}/${volume}.tar.csv`;
export const pdfPath = (reporter, volume, ext = 'pdf') =>
  `${pdfJurisdiction(reporter)}/${reporter}/${volume}.${ext}`;
// `page` (1-based) opens the PDF there: `#page=N`, which PDF.js and the browsers' own
// viewers follow.
export const pdfUrl = (reporter, volume, page = null) => `${PDF_URL}/${pdfPath(reporter, volume)}`
  + (Number.isSafeInteger(page) && page > 0 ? `#page=${page}` : '');
export const pdfManifestUrl = (reporter, volume) => `${PDF_URL}/${pdfPath(reporter, volume, 'json')}`;

// The unified per-volume index (docs/plans/courtlistener-mirror.md, "Index";
// crates/stare/src/idx.rs is the Rust side): one gzipped text file per volume for every
// source, `<reporter>/<volume>.idx.gz`, and `<reporter>/<volume>.<n>.idx.gz` for the later
// parts of a split volume, relative to the index build (pass it through indexPath).
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const VOLUME = /^\d(?:[0-9a-z-]*[0-9a-z])?$/;

export function idxPath(reporter, volume, part = 0) {
  if (!SLUG.test(String(reporter)) || !VOLUME.test(String(volume))
      || !Number.isSafeInteger(part) || part < 0) {
    throw new Error(`Bad index volume ${reporter}/${volume}`);
  }
  return part === 0 ? `${reporter}/${volume}.idx.gz` : `${reporter}/${volume}.${part}.idx.gz`;
}

// CourtListener records (docs/plans/courtlistener-mirror.md; crates/stare/src/cl.rs is
// the Rust side): one gzipped record per case under the data bucket's
// `cl/c/<cluster_id>/<hash>.json.gz`, which the unified index's `cl` lines name.
const CL_HASH = /^[0-9a-f]{16}$/;

export const isClHash = (s) => typeof s === 'string' && CL_HASH.test(s);

// A record's path in the data bucket, which is also its cache key.
export function clRecordPath(clusterId, hash) {
  if (!Number.isSafeInteger(clusterId) || clusterId < 0 || !isClHash(hash)) {
    throw new Error(`Bad CourtListener record ${clusterId}/${hash}`);
  }
  return `cl/c/${clusterId}/${hash}.json.gz`;
}

export const clRecordUrl = (clusterId, hash) => `${DATA_URL}/${clRecordPath(clusterId, hash)}`;
