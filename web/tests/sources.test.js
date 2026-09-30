import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  indexUrl, MIRROR_URL, PDF_URL, pdfUrl, TAR_URL, tarCsvUrl, tarUrl, zipUrl,
} from '../public/js/sources.js';

test('case zips come from our own copy', () => {
  assert.equal(zipUrl('a2d', '31'), 'https://data.stare.pub/cap/a2d/31.zip');
});

test('tars and PDFs still come from the mirror', () => {
  assert.equal(MIRROR_URL, 'https://static.case.law');
  assert.equal(tarUrl('a2d', '31'), 'https://static.case.law/a2d/31.tar');
  assert.equal(pdfUrl('a2d', '31'), 'https://static.case.law/a2d/31.pdf');
  assert.equal(PDF_URL, MIRROR_URL);
});

test("a tar's .tar.csv comes from the same place as the tar", () => {
  assert.equal(tarCsvUrl('a2d', '31'), `${TAR_URL}/a2d/31.tar.csv`);
  assert.equal(tarCsvUrl('a2d', '31'), `${tarUrl('a2d', '31')}.csv`);
});

test('index files come from the index host', () => {
  assert.equal(indexUrl('a2d/31.bin'), 'https://idx.stare.pub/a2d/31.bin');
  assert.equal(indexUrl('manifest.json'), 'https://idx.stare.pub/manifest.json');
});
