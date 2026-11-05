import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  indexUrl, MIRROR_URL, PDF_JURISDICTIONS, PDF_URL, pdfJurisdiction, pdfManifestUrl, pdfUrl,
  TAR_URL, tarCsvUrl, tarUrl, zipUrl,
} from '../public/js/sources.js';

test('case zips come from our own copy', () => {
  assert.equal(zipUrl('a2d', '31'), 'https://data.stare.pub/cap/a2d/31.zip');
});

test('tars still come from the mirror', () => {
  assert.equal(MIRROR_URL, 'https://static.case.law');
  assert.equal(tarUrl('a2d', '31'), 'https://static.case.law/a2d/31.tar');
});

test('PDFs are the archival PDFs on data.stare.pub, under the reporter\'s jurisdiction', () => {
  assert.equal(PDF_URL, 'https://data.stare.pub/pdf');
  assert.equal(pdfUrl('a2d', '31'), 'https://data.stare.pub/pdf/us/a2d/31.pdf');
  assert.equal(pdfUrl('a3d', '138-2'), 'https://data.stare.pub/pdf/us/a3d/138-2.pdf');
  assert.equal(pdfUrl('pr', '1'), 'https://data.stare.pub/pdf/pr/pr/1.pdf');
  assert.equal(pdfUrl('am-samoa-2d', '3'), 'https://data.stare.pub/pdf/as/am-samoa-2d/3.pdf');
  assert.equal(pdfManifestUrl('vi', '54'), 'https://data.stare.pub/pdf/vi/vi/54.json');
});

test('a PDF link can open at a page', () => {
  assert.equal(pdfUrl('a2d', '31', 12), 'https://data.stare.pub/pdf/us/a2d/31.pdf#page=12');
  assert.equal(pdfUrl('a2d', '31', null), 'https://data.stare.pub/pdf/us/a2d/31.pdf');
  assert.equal(pdfUrl('a2d', '31', 0), 'https://data.stare.pub/pdf/us/a2d/31.pdf');
  assert.equal(pdfUrl('a2d', '31', 1.5), 'https://data.stare.pub/pdf/us/a2d/31.pdf');
});

// the index builder's pipelines/pdf-publish/reporter-jurisdictions.json, from exemplar 0.4.0.
// The PDFs' paths are fixed once published, so a change here is a change there first.
test('the reporters outside `us` are the territories\' own', () => {
  assert.deepEqual({ ...PDF_JURISDICTIONS }, {
    'am-samoa': 'as', 'am-samoa-2d': 'as', 'am-samoa-3d': 'as', guam: 'gu', 'n-mar-i': 'mp',
    pr: 'pr', 'pr-dec': 'pr', 'pr-sent': 'pr', tca: 'pr', vi: 'vi',
  });
  assert.equal(pdfJurisdiction('haw'), 'us');
  assert.equal(pdfJurisdiction('f3d'), 'us');
});

test("a tar's .tar.csv shares the tar's base", () => {
  assert.equal(tarCsvUrl('a2d', '31'), `${TAR_URL}/a2d/31.tar.csv`);
  assert.equal(tarCsvUrl('a2d', '31'), `${tarUrl('a2d', '31')}.csv`);
});

test('index files come from the index host', () => {
  assert.equal(indexUrl('a2d/31.bin'), 'https://idx.stare.pub/a2d/31.bin');
  assert.equal(indexUrl('manifest.json'), 'https://idx.stare.pub/manifest.json');
});
