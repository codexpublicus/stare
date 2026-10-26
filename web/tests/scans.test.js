import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hasScans, noScansCount, pdfPage } from '../public/js/scans.js';

test('658 volumes have no page scans', () => {
  assert.equal(noScansCount(), 658);
});

test('a volume CAP published without scans has none; its neighbours do', () => {
  assert.equal(hasScans('a3d', '138-2'), false);
  assert.equal(hasScans('a3d', '138'), true);
  assert.equal(hasScans('se2d', '590'), false);
  assert.equal(hasScans('se2d', '589'), true);
  assert.equal(hasScans('a2d', '31'), true);
  assert.equal(hasScans('a2d', 31), true);
});

test('f-appx/660 has scans, though its PDF is still to come', () => {
  assert.equal(hasScans('f-appx', '660'), true);
});

test('a case opens at its first page ORDER', () => {
  assert.equal(pdfPage(1), 1);
  assert.equal(pdfPage(647), 647);
  assert.equal(pdfPage(0), null);
  assert.equal(pdfPage(undefined), null);
  assert.equal(pdfPage('5'), null);
});
