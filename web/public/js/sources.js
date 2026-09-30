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

export const ZIP_URL = 'https://data.stare.pub/cap';
export const TAR_URL = MIRROR_URL; // the .tar and its .tar.csv
export const PDF_URL = MIRROR_URL;

export const indexUrl = (path) => `${INDEX_URL}/${path}`;
export const zipUrl = (reporter, volume) => `${ZIP_URL}/${reporter}/${volume}.zip`;
export const tarUrl = (reporter, volume) => `${TAR_URL}/${reporter}/${volume}.tar`;
export const tarCsvUrl = (reporter, volume) => `${TAR_URL}/${reporter}/${volume}.tar.csv`;
export const pdfUrl = (reporter, volume) => `${PDF_URL}/${reporter}/${volume}.pdf`;
