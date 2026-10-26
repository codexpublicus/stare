// Copies PDF.js out of node_modules into public/vendor/ for the Archival PDF view
// (public/js/pdfviewer.js), patching its worker on the way.
//
// The patch: PDF.js finds page N by walking the page tree, and on reaching the root's Kids
// it starts fetching every kid's dictionary at once (Catalog.getPageDict's pageDictCache
// prefetch). Our archival PDFs are linearized by qpdf, which leaves the tree flat (one
// /Pages root whose Kids are the volume's 300 to 2,000 pages) and puts each page's
// dictionary next to its image. Opening any page, and the last-page check PDF.js runs on
// every load, so requested a range in every page's section of the file: the whole volume,
// up to 84 MB, before the first page showed. Patched, a node whose /Count equals its
// number of Kids, all of them references, is read as flat: the kid at the page's position
// is fetched alone, and used if it is a page. Anything else, or a kid that turns out not
// to be a page, falls back to PDF.js's own walk, without the prefetch. (A tree whose Count
// equals its Kids' length only by holding an empty /Pages node beside one with two pages
// would be misread; no writer we use makes one.)
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PATCH_MARKER = 'stare.pub patch: flat page trees';

export const PATCH_ANCHOR = `      for (let last = kids.length - 1; last >= 0; last--) {
        const lastKid = kids[last];
        nodesToVisit.push(lastKid);
        if (currentNode === this.toplevelPagesDict && lastKid instanceof Ref && !pageDictCache.has(lastKid)) {
          pageDictCache.put(lastKid, xref.fetchAsync(lastKid));
        }
      }`;

const PATCH_REPLACEMENT = `      /*! ${PATCH_MARKER} (web/src/lib/pdfjs-vendor.js) */
      if (count === kids.length && kids.every(kid => kid instanceof Ref)) {
        const kid = kids[pageIndex - currentPageIndex];
        const kidObj = await (pageDictCache.get(kid) || xref.fetchAsync(kid));
        if (kidObj instanceof Dict) {
          let kidType = kidObj.getRaw("Type");
          if (kidType instanceof Ref) {
            kidType = await xref.fetchAsync(kidType);
          }
          if (isName(kidType, "Page") || !kidObj.has("Kids")) {
            if (!pageKidsCountCache.has(kid)) {
              pageKidsCountCache.put(kid, 1);
            }
            if (!pageIndexCache.has(kid)) {
              pageIndexCache.put(kid, pageIndex);
            }
            return [kidObj, kid];
          }
        }
      }
      for (let last = kids.length - 1; last >= 0; last--) {
        nodesToVisit.push(kids[last]);
      }`;

/** The PDF.js worker source with the flat-page-tree patch applied; throws if it can't be. */
export function patchWorker(source) {
  if (source.includes(PATCH_MARKER)) throw new Error('the PDF.js worker is already patched');
  const at = source.indexOf(PATCH_ANCHOR);
  if (at < 0 || source.indexOf(PATCH_ANCHOR, at + 1) >= 0) {
    throw new Error('Catalog.getPageDict in the PDF.js worker has changed; update the patch in web/src/lib/pdfjs-vendor.js');
  }
  return source.slice(0, at) + PATCH_REPLACEMENT + source.slice(at + PATCH_ANCHOR.length);
}

// The files the view loads, from pdfjs-dist's legacy build, and the licences that go with
// them. jbig2.wasm is PDF.js's JBIG2 decoder (pdfjs-dist 6 decodes JBIG2 in WebAssembly);
// the archival PDFs' page images are JBIG2.
const COPIED = [
  ['legacy/build/pdf.min.mjs', 'pdf.min.mjs'],
  ['wasm/jbig2.wasm', 'jbig2.wasm'],
  ['LICENSE', 'LICENSE'],
  ['wasm/LICENSE_JBIG2', 'LICENSE_JBIG2'],
  ['wasm/LICENSE_PDFJS_JBIG2', 'LICENSE_PDFJS_JBIG2'],
];

const stripSourceMap = (code) => code.replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n');

/**
 * Write PDF.js into `outDir` (public/vendor/pdfjs-<version>-p<patch>/): the legacy build's
 * pdf.min.mjs as it ships, its worker patched and minified with `minify` (esbuild's
 * transform), jbig2.wasm and the licences. Checks the installed version is `version`.
 */
export async function vendorPdfjs({ pkgDir, outDir, version, minify }) {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  if (pkg.version !== version) {
    throw new Error(`pdfjs-dist ${pkg.version} is installed; public/js/pdfjs-path.js expects ${version}`);
  }
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const [from, to] of COPIED) {
    if (to.endsWith('.mjs')) {
      writeFileSync(join(outDir, to), stripSourceMap(readFileSync(join(pkgDir, from), 'utf8')));
    } else {
      copyFileSync(join(pkgDir, from), join(outDir, to));
    }
  }
  const worker = patchWorker(readFileSync(join(pkgDir, 'legacy/build/pdf.worker.mjs'), 'utf8'));
  writeFileSync(join(outDir, 'pdf.worker.min.mjs'), await minify(stripSourceMap(worker)));
}
