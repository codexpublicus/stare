import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CSS_PER_POINT, CSS_PER_SCAN_PIXEL, FIT_MAX_WIDTH, MAX_CANVAS_PIXELS, ZOOM_LEVELS, ZOOM_MAX,
  ZOOM_MIN, anchoredScroll, canvasRatio, caseLabels, defaultMode, fitZoom, parsePageInput,
  parseStoredMode, rotate, stepZoom, storedMode, zoomLabel,
} from '../public/js/pagezoom.js';

// a2d/142's page 184 at 100%: 449.28 x 716.16 pt in the PDF, 1872 x 2984 px scanned.
const PAGE_W = 449.28 * CSS_PER_POINT;
const PAGE_H = 716.16 * CSS_PER_POINT;

describe('the printed size', () => {
  test('the PDF page and its scan are the same size at 100%', () => {
    assert.ok(Math.abs(PAGE_W - 1872 * CSS_PER_SCAN_PIXEL) < 0.01);
    assert.ok(Math.abs(PAGE_H - 2984 * CSS_PER_SCAN_PIXEL) < 0.01);
  });
});

describe('fitZoom', () => {
  test('fit page fits the height on a laptop', () => {
    const z = fitZoom('page', PAGE_W, PAGE_H, 1000, 600);
    assert.ok(Math.abs(PAGE_H * z - 600) < 1e-9);
    assert.ok(PAGE_W * z <= 1000);
  });

  test('fit page fits the width when the view is tall and narrow', () => {
    const z = fitZoom('page', PAGE_W, PAGE_H, 300, 2000);
    assert.ok(Math.abs(PAGE_W * z - 300) < 1e-9);
  });

  test('fit width fills the width and ignores the height', () => {
    const z = fitZoom('width', PAGE_W, PAGE_H, 800, 300);
    assert.ok(Math.abs(PAGE_W * z - 800) < 1e-9);
  });

  test('fitting never goes past the maximum width', () => {
    const z = fitZoom('width', PAGE_W, PAGE_H, 3000, 1400);
    assert.ok(Math.abs(PAGE_W * z - FIT_MAX_WIDTH) < 1e-9);
    assert.ok(PAGE_W * fitZoom('page', PAGE_W, PAGE_H, 3000, 99999) <= FIT_MAX_WIDTH + 1e-9);
  });

  test('a quarter turn swaps the page\'s sides', () => {
    const z = fitZoom('page', PAGE_W, PAGE_H, 1000, 600, 90);
    // Turned, the page is PAGE_H wide and PAGE_W tall.
    assert.ok(Math.abs(Math.min(1000 / PAGE_H, 600 / PAGE_W) - z) < 1e-9);
    assert.equal(fitZoom('page', PAGE_W, PAGE_H, 1000, 600, 180), fitZoom('page', PAGE_W, PAGE_H, 1000, 600));
  });

  test('a level is that level, kept in range', () => {
    assert.equal(fitZoom(1.5, PAGE_W, PAGE_H, 100, 100), 1.5);
    assert.equal(fitZoom(9, PAGE_W, PAGE_H, 100, 100), ZOOM_MAX);
    assert.equal(fitZoom(0.01, PAGE_W, PAGE_H, 100, 100), ZOOM_MIN);
  });

  test('a hidden view, or no page yet, gives 100%', () => {
    assert.equal(fitZoom('page', PAGE_W, PAGE_H, 0, 0), 1);
    assert.equal(fitZoom('width', 0, 0, 800, 600), 1);
  });

  test('with no height to go on, fit page fits the width', () => {
    assert.equal(fitZoom('page', PAGE_W, PAGE_H, 800, 0), fitZoom('width', PAGE_W, PAGE_H, 800, 0));
  });
});

describe('stepZoom', () => {
  test('steps through the levels', () => {
    assert.equal(stepZoom(1, 1), 1.1);
    assert.equal(stepZoom(1, -1), 0.9);
    assert.equal(stepZoom(1.25, 1), 1.5);
  });

  test('steps from a fitted level to the next level either side', () => {
    assert.equal(stepZoom(0.87, 1), 0.9);
    assert.equal(stepZoom(0.87, -1), 0.75);
  });

  test('stops at the ends', () => {
    assert.equal(stepZoom(ZOOM_MAX, 1), ZOOM_MAX);
    assert.equal(stepZoom(ZOOM_MIN, -1), ZOOM_MIN);
    assert.equal(ZOOM_LEVELS[0], ZOOM_MIN);
    assert.equal(ZOOM_LEVELS.at(-1), ZOOM_MAX);
  });
});

test('zoomLabel rounds to a whole percent', () => {
  assert.equal(zoomLabel(1), '100%');
  assert.equal(zoomLabel(0.8666), '87%');
});

test('rotate turns in quarter turns, both ways', () => {
  assert.equal(rotate(0), 90);
  assert.equal(rotate(270), 0);
  assert.equal(rotate(0, -1), 270);
  assert.equal(rotate(90, -1), 0);
});

test('defaultMode fits the width on a phone and the page otherwise', () => {
  assert.equal(defaultMode(374), 'width');
  assert.equal(defaultMode(1000), 'page');
  assert.equal(defaultMode(0), 'page');
});

describe('the remembered zoom mode', () => {
  test('round-trips', () => {
    for (const m of ['page', 'width', 1, 1.25, 0.25, 4]) assert.equal(parseStoredMode(storedMode(m)), m);
  });

  test('ignores nothing stored and junk', () => {
    for (const v of [null, undefined, '', 'fit', '0', '9', '-1', 'NaN', '1e3', ' page']) {
      assert.equal(parseStoredMode(v), null, String(v));
    }
  });
});

describe('parsePageInput', () => {
  const labels = ['148', '149', '150', '151'];
  test('a number is the page\'s place in the case', () => {
    assert.equal(parsePageInput('2', 4, labels), 2);
    assert.equal(parsePageInput(' 4 ', 4, labels), 4);
  });

  test('p. and a label is the printed page', () => {
    assert.equal(parsePageInput('p. 149', 4, labels), 2);
    assert.equal(parsePageInput('p151', 4, labels), 4);
    assert.equal(parsePageInput('P. xxix', 2, ['xxviii', 'xxix']), 2);
  });

  test('anything else is nothing', () => {
    for (const s of ['0', '5', '149', 'p. 152', '', 'x', '1.5', '-1']) assert.equal(parsePageInput(s, 4, labels), null, s);
    assert.equal(parsePageInput('p. 149', 4, null), null);
  });
});

describe('caseLabels', () => {
  test('takes the page breaks CAP\'s HTML marks after the first page', () => {
    assert.deepEqual(caseLabels(4, '148', '151', ['149', '150', '151']), ['148', '149', '150', '151']);
  });

  test('ignores the first page and repeats among the breaks', () => {
    assert.deepEqual(caseLabels(3, '148', '150', ['148', '149', '149', '150']), ['148', '149', '150']);
  });

  test('counts from the first page when the breaks don\'t cover the pages', () => {
    assert.deepEqual(caseLabels(3, '148', '150', []), ['148', '149', '150']);
    assert.deepEqual(caseLabels(3, '148', '150', ['149']), ['148', '149', '150']);
  });

  test('keeps labelled pages from the breaks', () => {
    assert.deepEqual(caseLabels(3, 'xxviii', 'xxx', ['xxix', 'xxx']), ['xxviii', 'xxix', 'xxx']);
  });

  test('knows only the first page when nothing else fits', () => {
    assert.deepEqual(caseLabels(3, 'xxviii', 'xxx', []), ['xxviii', null, null]);
    assert.deepEqual(caseLabels(2, '148', '150', []), ['148', null]);
    assert.deepEqual(caseLabels(2, null, null, []), [null, null]);
    assert.deepEqual(caseLabels(0, '1', '1', []), []);
  });
});

describe('anchoredScroll', () => {
  test('keeps the point under the pointer in place when zooming in', () => {
    // A 100 px page at (50, 0), scrolled to the top; the pointer at its middle (100, 50).
    const before = { left: 50, top: 0, width: 100, height: 100 };
    // Twice the size, drawn from the area's corner.
    const after = { left: 0, top: 0, width: 200, height: 200 };
    assert.deepEqual(anchoredScroll({ left: 0, top: 0 }, before, after, 100, 50), { left: 0, top: 50 });
  });

  test('adds the scroll already made', () => {
    const box = { left: 0, top: 0, width: 100, height: 100 };
    assert.deepEqual(anchoredScroll({ left: 10, top: 20 }, box, box, 30, 30), { left: 10, top: 20 });
  });
});

test('canvasRatio keeps the device ratio until the canvas gets too big', () => {
  assert.equal(canvasRatio(600, 900, 2), 2);
  const r = canvasRatio(4000, 6000, 3);
  assert.ok(r < 3);
  assert.ok(Math.abs(4000 * 6000 * r * r - MAX_CANVAS_PIXELS) < 1);
  assert.equal(canvasRatio(10, 10, 0), 1);
});
