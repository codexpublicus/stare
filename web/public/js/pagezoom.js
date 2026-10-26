// The page views' plain logic, apart from the DOM (pageview.js uses it, for the Archival
// PDF and the Raw Scans; web/tests/pagezoom.test.js tests it): how big a page is drawn in
// each zoom mode, the zoom steps, rotation, the remembered zoom mode, the page box and the
// printed page labels.

// A page's size at 100% is its printed size, at CSS's 96 pixels to the inch. A PDF page is
// measured in points (72 to the inch); CAP's scans are 300 dpi (a2d/142's page 184 is
// 449.28 x 716.16 pt in the archival PDF and 1872 x 2984 px in the tar: 6.24 in at 300 dpi).
export const CSS_PER_POINT = 96 / 72;
export const SCAN_DPI = 300;
export const CSS_PER_SCAN_PIXEL = 96 / SCAN_DPI;

// Zoom runs from 25% to 400% of the printed size; − and + step through these levels.
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;
export const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

// Fitting never draws a page wider than this many CSS pixels, so a large monitor in fit
// width mode doesn't show a line of text a foot long.
export const FIT_MAX_WIDTH = 1200;

// A view narrower than this many CSS pixels (a phone) defaults to fit width.
export const NARROW_WIDTH = 600;

// The zoom modes: the whole page in view, the page across the view, or a level (`zoom`).
export const MODES = ['page', 'width'];

export const clampZoom = (z) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

/**
 * The scale (CSS pixels per CSS pixel of the page at 100%) for a page `pageW` x `pageH` at
 * 100%, turned `rotation` degrees, in a view `availW` x `availH` with nothing around it.
 * `mode` is 'page' (the whole page in view), 'width' (the page across the view) or a number
 * (that zoom). A view with no size (hidden) gives 1.
 */
export function fitZoom(mode, pageW, pageH, availW, availH, rotation = 0) {
  if (typeof mode === 'number') return clampZoom(mode);
  if (!(pageW > 0) || !(pageH > 0) || !(availW > 0)) return 1;
  const [w, h] = rotation % 180 ? [pageH, pageW] : [pageW, pageH];
  const width = Math.min(availW, FIT_MAX_WIDTH) / w;
  if (mode === 'width' || !(availH > 0)) return clampZoom(width);
  return clampZoom(Math.min(width, availH / h));
}

/** The next zoom level up (`dir` > 0) or down from `zoom`, or the end of the range. */
export function stepZoom(zoom, dir) {
  const eps = 0.005;
  if (dir > 0) return ZOOM_LEVELS.find((z) => z > zoom + eps) ?? ZOOM_MAX;
  return [...ZOOM_LEVELS].reverse().find((z) => z < zoom - eps) ?? ZOOM_MIN;
}

/** `zoom` as a percentage for the toolbar: "87%". */
export const zoomLabel = (zoom) => `${Math.round(zoom * 100)}%`;

/** `rotation` turned another 90° clockwise (or anticlockwise, `dir` < 0), in 0 to 270. */
export const rotate = (rotation, dir = 1) => (((rotation + (dir < 0 ? -90 : 90)) % 360) + 360) % 360;

/** The default zoom mode for a view `width` CSS pixels wide. */
export const defaultMode = (width) => (width > 0 && width < NARROW_WIDTH ? 'width' : 'page');

/** A zoom mode as it's remembered in localStorage: "page", "width" or a level ("1.25"). */
export const storedMode = (mode) => (typeof mode === 'number' ? String(clampZoom(mode)) : mode);

/** A remembered zoom mode, or null for anything else (nothing stored, or junk). */
export function parseStoredMode(value) {
  if (MODES.includes(value)) return value;
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const z = Number(value);
  return z >= ZOOM_MIN && z <= ZOOM_MAX ? z : null;
}

/**
 * The page the page box asks for, as an index into the case's pages (1 to `count`), or
 * null. A plain number is the page's place in the case ("2" of 4); "p. 149" or "p149" is a
 * printed page label from `labels` (the case's pages' labels, in order).
 */
export function parsePageInput(text, count, labels = null) {
  const s = String(text ?? '').trim();
  const label = /^p\.?\s*(.+)$/i.exec(s);
  if (label) {
    const want = label[1].trim().toLowerCase();
    const i = (labels || []).findIndex((l) => l != null && String(l).toLowerCase() === want);
    return i >= 0 ? i + 1 : null;
  }
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= count ? n : null;
}

/**
 * The printed labels of the case's `count` pages, in order, or null where one isn't known.
 * `firstPage` and `lastPage` are the case's first_page and last_page; `breaks` are the
 * page labels CAP's HTML for the case marks (`<a class="page-label" data-label="149">`),
 * one at the top of each page after the first. When those give a label for every page they
 * are used; otherwise numbered pages that run first to last fill them in.
 */
export function caseLabels(count, firstPage, lastPage = null, breaks = []) {
  if (!(count > 0)) return [];
  const first = firstPage == null ? null : String(firstPage);
  const marked = [];
  for (const b of breaks || []) {
    const s = String(b);
    if (s !== first && !marked.includes(s)) marked.push(s);
  }
  if (first != null && marked.length === count - 1) return [first, ...marked];
  const a = Number(first);
  const b = Number(lastPage);
  if (/^\d+$/.test(first ?? '') && Number.isSafeInteger(b) && b - a + 1 === count) {
    return Array.from({ length: count }, (_, i) => String(a + i));
  }
  return Array.from({ length: count }, (_, i) => (i === 0 ? first : null));
}

/**
 * The scroll offsets that keep the point of the page under (`ax`, `ay`) (view coordinates)
 * there after the page, at `before` (its box in view coordinates: left, top, width,
 * height) and scrolled to `scroll` ({ left, top }), is redrawn at `after`.
 */
export function anchoredScroll(scroll, before, after, ax, ay) {
  const fx = before.width > 0 ? (ax - before.left) / before.width : 0.5;
  const fy = before.height > 0 ? (ay - before.top) / before.height : 0.5;
  return {
    left: scroll.left + (after.left + fx * after.width) - ax,
    top: scroll.top + (after.top + fy * after.height) - ay,
  };
}

// A canvas is drawn at no more than this many pixels; past it, the device pixel ratio it's
// drawn at drops, as PDF.js's own viewer does (its maxCanvasPixels), so 400% on a phone
// doesn't take hundreds of megabytes.
export const MAX_CANVAS_PIXELS = 2 ** 24;

/** The pixel ratio to draw a `w` x `h` CSS pixel canvas at, from the device's `ratio`. */
export function canvasRatio(w, h, ratio = 1) {
  const r = ratio > 0 ? ratio : 1;
  const area = w * h * r * r;
  return area > MAX_CANVAS_PIXELS ? r * Math.sqrt(MAX_CANVAS_PIXELS / area) : r;
}
