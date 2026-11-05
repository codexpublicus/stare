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

export const INDEX_URL = 'https://idx.stare.pub';
export const MIRROR_URL = 'https://static.case.law';

export const DATA_URL = 'https://data.stare.pub';
export const ZIP_URL = `${DATA_URL}/cap`;
export const TAR_URL = MIRROR_URL; // the .tar and its .tar.csv
export const PDF_URL = `${DATA_URL}/pdf`;

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
