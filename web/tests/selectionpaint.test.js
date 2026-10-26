import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { clipRect, mergeRects, toLocal } from '../public/js/selectionpaint.js';

const r = (left, top, right, bottom) => ({ left, top, right, bottom });

describe('mergeRects', () => {
  test('nothing in, nothing out', () => {
    assert.deepEqual(mergeRects([]), []);
    assert.deepEqual(mergeRects(undefined), []);
  });

  test('drops rects with no area', () => {
    assert.deepEqual(mergeRects([r(0, 0, 0, 10), r(5, 5, 20, 5), r(10, 0, 20, 10)]), [r(10, 0, 20, 10)]);
  });

  test('merges overlapping words on a line into one rect', () => {
    // OCR word boxes overlapping by a few pixels, a little ragged top and bottom.
    const words = [r(0, 10, 50, 30), r(45, 11, 90, 31), r(85, 9, 130, 29)];
    assert.deepEqual(mergeRects(words), [r(0, 9, 130, 31)]);
  });

  test('merges rects that only touch', () => {
    assert.deepEqual(mergeRects([r(0, 0, 10, 10), r(10, 0, 20, 10)]), [r(0, 0, 20, 10)]);
  });

  test('keeps rects with a space between them apart, unless the gap allows it', () => {
    const words = [r(0, 0, 40, 20), r(48, 0, 90, 20)];
    assert.deepEqual(mergeRects(words), words);
    // 8 px apart on a 20 px line: within 0.6 of the line's height.
    assert.deepEqual(mergeRects(words, { gap: 0.6 }), [r(0, 0, 90, 20)]);
    // A column gap is not.
    assert.deepEqual(mergeRects([r(0, 0, 40, 20), r(100, 0, 140, 20)], { gap: 0.6 }).length, 2);
  });

  test('keeps separate lines apart, even when they overlap a little', () => {
    // Line two's ascenders reach 3 px into line one.
    const lines = [r(0, 0, 100, 20), r(0, 17, 80, 37), r(0, 34, 60, 54)];
    assert.deepEqual(mergeRects(lines), lines);
  });

  test('sorts lines top to bottom and words left to right, whatever order they came in', () => {
    const got = mergeRects([r(60, 30, 90, 50), r(0, 0, 40, 20), r(0, 30, 50, 50), r(40, 0, 80, 20)]);
    assert.deepEqual(got, [r(0, 0, 80, 20), r(0, 30, 50, 50), r(60, 30, 90, 50)]);
  });

  test('takes DOMRect-like { x, y, width, height }', () => {
    assert.deepEqual(mergeRects([{ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 0, width: 10, height: 10 }]), [r(0, 0, 15, 10)]);
  });
});

describe('toLocal', () => {
  // A 200 x 300 layer at (100, 50) on screen, at 2x: one of its pixels is two on screen.
  const scaled = { origin: { x: 100, y: 50 }, ux: { x: 2, y: 0 }, uy: { x: 0, y: 2 } };

  test('undoes a scale and an offset', () => {
    assert.deepEqual(toLocal(r(120, 70, 140, 90), scaled), r(10, 10, 20, 20));
  });

  test('null for an empty rect or a flat frame', () => {
    assert.equal(toLocal(r(10, 10, 10, 20), scaled), null);
    assert.equal(toLocal(r(0, 0, 10, 10), { origin: { x: 0, y: 0 }, ux: { x: 1, y: 0 }, uy: { x: 2, y: 0 } }), null);
  });

  test('turns a quarter-turned page\'s rects upright, so its lines merge across', () => {
    // A layer turned 90 degrees clockwise: its top left corner is on screen's top right
    // (x = 500), its x axis runs down the screen and its y axis to the left.
    const turned = { origin: { x: 500, y: 0 }, ux: { x: 0, y: 1 }, uy: { x: -1, y: 0 } };
    // Two overlapping words of one line, at local y 10..30, x 0..50 and 45..90: on screen
    // they're a column, at x 470..490, one above the other.
    const screen = [r(470, 0, 490, 50), r(470, 45, 490, 90)];
    const local = screen.map((s) => toLocal(s, turned));
    assert.deepEqual(local, [r(0, 10, 50, 30), r(45, 10, 90, 30)]);
    assert.deepEqual(mergeRects(local), [r(0, 10, 90, 30)]);
  });

  test('keeps a quarter-turned page\'s lines apart, which on screen sit side by side', () => {
    const turned = { origin: { x: 500, y: 0 }, ux: { x: 0, y: 1 }, uy: { x: -1, y: 0 } };
    // Two lines, local y 10..30 and 40..60: on screen two columns 10 px apart.
    const screen = [r(470, 0, 490, 90), r(440, 0, 460, 90)];
    // Merged as they are on screen, they'd be taken for one line and joined.
    assert.equal(mergeRects(screen, { gap: 0.6 }).length, 1);
    const local = mergeRects(screen.map((s) => toLocal(s, turned)), { gap: 0.6 });
    assert.deepEqual(local, [r(0, 10, 90, 30), r(0, 40, 90, 60)]);
  });

  test('a half-turned page', () => {
    const half = { origin: { x: 200, y: 300 }, ux: { x: -1, y: 0 }, uy: { x: 0, y: -1 } };
    assert.deepEqual(toLocal(r(150, 250, 190, 290), half), r(10, 10, 50, 50));
  });
});

describe('clipRect', () => {
  test('cuts a rect to the layer and drops what is outside it', () => {
    assert.deepEqual(clipRect(r(-10, 5, 50, 500), 100, 200), r(0, 5, 50, 200));
    assert.equal(clipRect(r(120, 0, 150, 10), 100, 200), null);
  });
});
