import { test } from 'node:test';
import assert from 'node:assert/strict';

import { caseZipUrl, indexUrl, mirrorUrl } from '../public/js/sources.js';

test('case zips come from our own copy', () => {
  assert.equal(caseZipUrl('a2d', '31'), 'https://data.stare.pub/cap/a2d/31.zip');
});

test('tars, their manifests and PDFs come from the mirror', () => {
  assert.equal(mirrorUrl('a2d', '31', 'tar'), 'https://static.case.law/a2d/31.tar');
  assert.equal(mirrorUrl('a2d', '31', 'tar.csv'), 'https://static.case.law/a2d/31.tar.csv');
  assert.equal(mirrorUrl('a2d', '31', 'pdf'), 'https://static.case.law/a2d/31.pdf');
});

test('index files come from the index host', () => {
  assert.equal(indexUrl('a2d/31.bin'), 'https://idx.stare.pub/a2d/31.bin');
  assert.equal(indexUrl('manifest.json'), 'https://idx.stare.pub/manifest.json');
});
