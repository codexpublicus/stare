// Where the site reads its data. Every URL the site fetches from, or links to, for
// index or corpus files is built here; nothing else names a data host.
//
// MIRROR_URL is a full CAP mirror laid out like static.case.law
// (`<reporter>/<volume>.<ext>`). Each kind of corpus file has its own base, defaulting
// to the mirror, because each moves to our own copy on its own schedule: the zips
// already have (data.stare.pub, codex-data's `cap/`, codexpublicus/stare#42), and the
// PDFs will when the archival PDFs are published (#51), which are different files from
// CAP's. A .tar.csv holds byte offsets into its tar, so the tar it's read against must be
// byte-identical to the one it was made from; sharing one base keeps them paired.

export const INDEX_URL = 'https://idx.stare.pub';
export const MIRROR_URL = 'https://static.case.law';

export const DATA_URL = 'https://data.stare.pub';
export const ZIP_URL = `${DATA_URL}/cap`;
export const TAR_URL = MIRROR_URL; // the .tar and its .tar.csv
export const PDF_URL = MIRROR_URL;

export const indexUrl = (path) => `${INDEX_URL}/${path}`;
export const zipUrl = (reporter, volume) => `${ZIP_URL}/${reporter}/${volume}.zip`;
export const tarUrl = (reporter, volume) => `${TAR_URL}/${reporter}/${volume}.tar`;
export const tarCsvUrl = (reporter, volume) => `${TAR_URL}/${reporter}/${volume}.tar.csv`;
export const pdfUrl = (reporter, volume) => `${PDF_URL}/${reporter}/${volume}.pdf`;

// CourtListener records (docs/plans/courtlistener-mirror.md; crates/stare/src/cl.rs is
// the Rust side). Every CourtListener path the site reads is built here, since the
// storage layout isn't settled: one gzipped record per case under the data bucket's
// `cl/c/<cluster_id>/<hash>.json.gz`, and per volume a `.cl` sidecar next to its .bin,
// under the manifest's `base`, mapping pages to records.
const CL_HASH = /^[0-9a-f]{16}$/;
const CL_SLUG = /^[a-z0-9][a-z0-9-]*$/;

export const isClHash = (s) => typeof s === 'string' && CL_HASH.test(s);

// A volume's sidecar, relative to the index build (pass it through indexPath).
export function clSidecarPath(reporter, volume) {
  if (!CL_SLUG.test(String(reporter)) || !/^\d(?:[0-9a-z-]*[0-9a-z])?$/.test(String(volume))) {
    throw new Error(`Bad CourtListener volume ${reporter}/${volume}`);
  }
  return `${reporter}/${volume}.cl`;
}

// A record's path in the data bucket, which is also its cache key.
export function clRecordPath(clusterId, hash) {
  if (!Number.isSafeInteger(clusterId) || clusterId < 0 || !isClHash(hash)) {
    throw new Error(`Bad CourtListener record ${clusterId}/${hash}`);
  }
  return `cl/c/${clusterId}/${hash}.json.gz`;
}

export const clRecordUrl = (clusterId, hash) => `${DATA_URL}/${clRecordPath(clusterId, hash)}`;
