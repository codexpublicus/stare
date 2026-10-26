// The PDF.js copy the Archival PDF view loads (src/lib/pdfjs-vendor.js): the pinned version
// is the installed one, and the worker patch applies to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PDFJS_BASE, PDFJS_VERSION } from '../public/js/pdfjs-path.js';
import { PATCH_ANCHOR, PATCH_MARKER, patchWorker } from '../src/lib/pdfjs-vendor.js';

const pkg = (path) => new URL(`../node_modules/pdfjs-dist/${path}`, import.meta.url);
const webPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('pdfjs-path.js names the pdfjs-dist version package.json pins exactly', () => {
  assert.equal(webPackage.dependencies['pdfjs-dist'], PDFJS_VERSION);
  assert.match(PDFJS_BASE, new RegExp(`^/vendor/pdfjs-${PDFJS_VERSION.replaceAll('.', '\\.')}-p\\d+/$`));
});

test('the worker patch applies once to the installed PDF.js worker', (t) => {
  let source;
  try {
    source = readFileSync(pkg('legacy/build/pdf.worker.mjs'), 'utf8');
  } catch {
    t.skip('pdfjs-dist is not installed (npm --prefix web ci)');
    return;
  }
  const patched = patchWorker(source);
  assert.ok(patched.includes(PATCH_MARKER));
  assert.ok(!patched.includes(PATCH_ANCHOR));
  // Finding a page in a flat tree fetches that kid alone; the prefetch of every kid is gone.
  assert.ok(!patched.includes('pageDictCache.put(lastKid, xref.fetchAsync(lastKid))'));
  assert.ok(patched.includes('const kid = kids[pageIndex - currentPageIndex];'));
  assert.throws(() => patchWorker(patched), /already patched/);
});

test('the patch refuses a worker it doesn\'t recognise', () => {
  assert.throws(() => patchWorker('class Catalog {}'), /getPageDict .* has changed/);
});
