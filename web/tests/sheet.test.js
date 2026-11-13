import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { sheetSummary, snapSize } from '../public/js/sheet.js';

describe('sheetSummary', () => {
  test('says the counts it has, joined by a middle dot', () => {
    assert.equal(sheetSummary({ cited: 12, others: 2 }), '12 cited cases · 2 other printings');
  });

  test('uses the singular for one', () => {
    assert.equal(sheetSummary({ cited: 1, others: 1 }), '1 cited case · 1 other printing');
  });

  test('leaves out a count still being found, or of none', () => {
    assert.equal(sheetSummary({ cited: null, others: 3 }), '3 other printings');
    assert.equal(sheetSummary({ cited: 4, others: null }), '4 cited cases');
    assert.equal(sheetSummary({ cited: 0, others: 2 }), '2 other printings');
    assert.equal(sheetSummary({ cited: 5, others: 0 }), '5 cited cases');
  });

  test('says "Case details" with nothing to count', () => {
    assert.equal(sheetSummary(), 'Case details');
    assert.equal(sheetSummary({}), 'Case details');
    assert.equal(sheetSummary({ cited: null, others: null }), 'Case details');
    assert.equal(sheetSummary({ cited: 0, others: 0 }), 'Case details');
  });
});

describe('snapSize', () => {
  const sizes = { half: 400, full: 800 };

  test('settles at the nearest size when let go slowly', () => {
    assert.equal(snapSize(150, 0, sizes), 'closed');
    assert.equal(snapSize(250, 0, sizes), 'half');
    assert.equal(snapSize(590, 0, sizes), 'half');
    assert.equal(snapSize(610, 0, sizes), 'full');
    assert.equal(snapSize(800, 0, sizes), 'full');
  });

  test('a flick up goes on to the next size up', () => {
    assert.equal(snapSize(60, 1, sizes), 'half');
    assert.equal(snapSize(420, 1, sizes), 'full');
    assert.equal(snapSize(800, 1, sizes), 'full');
  });

  test('a flick down goes on to the next size down', () => {
    assert.equal(snapSize(760, -1, sizes), 'half');
    assert.equal(snapSize(380, -1, sizes), 'closed');
    assert.equal(snapSize(600, -1, sizes), 'half');
  });

  test('with one open size there is only full or closed', () => {
    const one = { half: 330, full: 330 };
    assert.equal(snapSize(300, 0, one), 'full');
    assert.equal(snapSize(100, 0, one), 'closed');
    assert.equal(snapSize(100, 1, one), 'full');
    assert.equal(snapSize(320, -1, one), 'closed');
  });
});
