// Where the site reads its data. Every URL the site fetches from, or links to, for
// index or corpus files is built here; nothing else names a data host.
//
// - INDEX_URL: the citation index (idx.stare.pub, bucket stare-pub-idx).
// - DATA_URL: our own copy of the CAP files, served from codex-data at
//   data.stare.pub. Only the case zips are public there so far (codexpublicus/stare#42).
// - MIRROR_URL: a full CAP mirror, laid out like static.case.law, for everything
//   DATA_URL doesn't serve yet: the tars, their .tar.csv manifests and the volume PDFs.
//   It's static.case.law itself until our own copy serves those files.

export const INDEX_URL = 'https://idx.stare.pub';
export const DATA_URL = 'https://data.stare.pub/cap';
export const MIRROR_URL = 'https://static.case.law';

export const indexUrl = (path) => `${INDEX_URL}/${path}`;
export const caseZipUrl = (reporter, volume) => `${DATA_URL}/${reporter}/${volume}.zip`;
export const mirrorUrl = (reporter, volume, ext) => `${MIRROR_URL}/${reporter}/${volume}.${ext}`;
