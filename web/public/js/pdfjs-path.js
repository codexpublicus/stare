// Where the site serves its copy of PDF.js (pdfjs-dist, the legacy build, which carries the
// polyfills Safari and older browsers need). The build copies it out of node_modules into
// public/vendor/ (web/src/lib/pdfjs-vendor.js); nothing is loaded from a CDN.
//
// PDFJS_VERSION must be the exact pdfjs-dist version in web/package.json; the build fails
// otherwise. PDFJS_PATCH counts revisions of our patch to the worker: bump it whenever the
// patch changes, since the directory is served as immutable.
export const PDFJS_VERSION = '6.4.299';
export const PDFJS_PATCH = 1;
export const PDFJS_DIR = `vendor/pdfjs-${PDFJS_VERSION}-p${PDFJS_PATCH}`;
export const PDFJS_BASE = `/${PDFJS_DIR}/`;
