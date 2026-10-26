// The page views' text selection, painted once (#247). Both views put OCR text over the page
// as positioned boxes (PDF.js's spans in the Archival PDF, one div per ALTO line in the Raw
// Scans), and the browser paints `::selection`'s translucent colour on each box separately,
// so where two boxes overlap the colour goes on twice and that patch comes out darker. The
// page views make `::selection` transparent on their text (reader.css) and this module draws
// the highlight instead: on each selection change it takes the selected text's rects, turns
// them into the page's own coordinates, merges those on one line into one rect, and draws
// them in a layer of the page (between the image and the text) as solid boxes whose layer
// is made translucent as a whole, so nothing is painted twice. The text and what's copied
// are the browser's own, as before; only the painting changes.
//
// pageshell.js watches each view's area (watchSelection); a view puts selectionLayer()'s
// element in its page where the highlight goes. The plain geometry (toLocal, mergeRects) is
// tested in web/tests/selectionpaint.test.js.

/**
 * A rect given by its edges, or null when it has no area. Accepts `{ left, top, right,
 * bottom }` or `{ x, y, width, height }` (a DOMRect has both).
 */
function edges(r) {
  if (!r) return null;
  const left = r.left ?? r.x;
  const top = r.top ?? r.y;
  const right = r.right ?? left + r.width;
  const bottom = r.bottom ?? top + r.height;
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  if (!(right > left) || !(bottom > top)) return null;
  return { left, top, right, bottom };
}

/**
 * Client rect `r` in a layer's own coordinates, where `frame` says where the layer is on
 * screen: `origin`, the client point of its top left corner, and `ux` and `uy`, the client
 * vectors of one of its pixels along its x and y axes (a turned or scaled layer has turned
 * or scaled vectors). The result is the bounding box of the rect's four corners, exact for
 * the quarter turns the views use. Null for an empty rect or a degenerate frame.
 */
export function toLocal(r, frame) {
  const e = edges(r);
  if (!e) return null;
  const { origin: o, ux, uy } = frame;
  const det = ux.x * uy.y - ux.y * uy.x;
  if (!det || !Number.isFinite(det)) return null;
  let left = Infinity; let top = Infinity; let right = -Infinity; let bottom = -Infinity;
  for (const [cx, cy] of [[e.left, e.top], [e.right, e.top], [e.left, e.bottom], [e.right, e.bottom]]) {
    const dx = cx - o.x;
    const dy = cy - o.y;
    const a = (dx * uy.y - dy * uy.x) / det;
    const b = (ux.x * dy - ux.y * dx) / det;
    left = Math.min(left, a); right = Math.max(right, a);
    top = Math.min(top, b); bottom = Math.max(bottom, b);
  }
  return { left, top, right, bottom };
}

// Two rects are on one line when they overlap vertically by at least this share of the
// shorter one's height. Adjacent lines of OCR text overlap a little (descenders over the
// next line's ascenders), well under half.
const SAME_LINE = 0.5;

/**
 * Merge rects that overlap or touch on the same line into one, dropping rects with no area.
 * Rects go on a line when they overlap vertically by half the shorter's height; along a
 * line, sorted left to right, a rect joins the one before when the space between them is at
 * most `gap` times the line's height (0: only overlapping or touching rects). Returns `{
 * left, top, right, bottom }` rects, top to bottom and left to right. Turned text must come
 * in already turned upright (toLocal), so its lines run across.
 */
export function mergeRects(rects, { gap = 0 } = {}) {
  const boxes = (rects || []).map(edges).filter(Boolean)
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const lines = [];
  for (const r of boxes) {
    const h = r.bottom - r.top;
    const line = lines.find((l) => {
      const overlap = Math.min(l.bottom, r.bottom) - Math.max(l.top, r.top);
      return overlap >= SAME_LINE * Math.min(h, l.bottom - l.top);
    });
    if (line) {
      line.rects.push(r);
      line.top = Math.min(line.top, r.top);
      line.bottom = Math.max(line.bottom, r.bottom);
    } else {
      lines.push({ top: r.top, bottom: r.bottom, rects: [r] });
    }
  }
  const out = [];
  for (const line of lines.sort((a, b) => a.top - b.top)) {
    const slack = gap * (line.bottom - line.top);
    let cur = null;
    for (const r of line.rects.sort((a, b) => a.left - b.left)) {
      if (cur && r.left <= cur.right + slack) {
        cur.right = Math.max(cur.right, r.right);
        cur.top = Math.min(cur.top, r.top);
        cur.bottom = Math.max(cur.bottom, r.bottom);
      } else {
        cur = { ...r };
        out.push(cur);
      }
    }
  }
  return out;
}

/** Rect `r` cut to the box 0..w x 0..h, or null when nothing of it is inside. */
export function clipRect(r, w, h) {
  const c = {
    left: Math.max(0, r.left), top: Math.max(0, r.top),
    right: Math.min(w, r.right), bottom: Math.min(h, r.bottom),
  };
  return c.right > c.left && c.bottom > c.top ? c : null;
}

// Fill the space between words on a line (up to this many line heights), so a selected line
// is one bar, as in a text editor. A column gap is much wider than this.
export const WORD_GAP = 0.6;

/**
 * The element a view puts in its page, between the image and the text, for the highlight:
 * three points that say where it is on screen (see frameOf) and the highlight's boxes.
 */
export function selectionLayer() {
  const layer = document.createElement('div');
  layer.className = 'pv-selection';
  layer.setAttribute('aria-hidden', 'true');
  layer.innerHTML = '<i class="pv-sel-probe" data-at="o"></i><i class="pv-sel-probe" data-at="x"></i>'
    + '<i class="pv-sel-probe" data-at="y"></i><div class="pv-sel-fill"></div>';
  return layer;
}

// Where `layer` is on screen, from its corner points (zero-size elements at its top left,
// top right and bottom left), whatever turns and scales are on it or its parents.
function frameOf(layer) {
  const w = layer.offsetWidth;
  const h = layer.offsetHeight;
  if (!(w > 0) || !(h > 0)) return null;
  const at = (k) => layer.querySelector(`.pv-sel-probe[data-at="${k}"]`).getBoundingClientRect();
  const o = at('o');
  const x = at('x');
  const y = at('y');
  return {
    w, h,
    origin: { x: o.left, y: o.top },
    ux: { x: (x.left - o.left) / w, y: (x.top - o.top) / w },
    uy: { x: (y.left - o.left) / h, y: (y.top - o.top) / h },
  };
}

// The client rects of the selected text in `root`, from each text node the selection's
// ranges reach (not the ranges' own rects, which include whole elements' boxes, such as the
// text layer's when everything is selected).
function selectedTextRects(sel, root) {
  const rects = [];
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    if (range.collapsed || !range.intersectsNode(root)) continue;
    const common = range.commonAncestorContainer;
    const start = root.contains(common) ? common : root;
    if (start.nodeType === Node.TEXT_NODE) {
      rects.push(...range.getClientRects());
      continue;
    }
    const walker = document.createTreeWalker(start, NodeFilter.SHOW_TEXT);
    const part = document.createRange();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.data || !range.intersectsNode(n)) continue;
      part.selectNodeContents(n);
      if (n === range.startContainer) part.setStart(n, range.startOffset);
      if (n === range.endContainer) part.setEnd(n, range.endOffset);
      if (!part.collapsed) rects.push(...part.getClientRects());
    }
  }
  return rects;
}

// Draw `rects` (the layer's own coordinates, `w` x `h`) as boxes placed in percentages of
// the layer, so they stay right as the page is zoomed or resized without being drawn again.
function paint(layer, rects, w, h) {
  const fill = layer.querySelector('.pv-sel-fill');
  const pct = (v, of) => `${(v / of) * 100}%`;
  fill.replaceChildren(...rects.map((r) => {
    const box = document.createElement('div');
    box.style.left = pct(r.left, w);
    box.style.top = pct(r.top, h);
    box.style.width = pct(r.right - r.left, w);
    box.style.height = pct(r.bottom - r.top, h);
    return box;
  }));
}

function clear(layer) {
  const fill = layer?.querySelector('.pv-sel-fill');
  if (fill?.firstChild) fill.replaceChildren();
}

// The areas watched, and one selectionchange listener for them all, run at most once a frame.
const watched = new Set();
let frame = 0;

function update() {
  frame = 0;
  const sel = document.getSelection();
  for (const w of watched) w.update(sel);
}

function onSelectionChange() {
  if (!frame) frame = requestAnimationFrame(update);
}

/**
 * Paint the selection in `area` (a page view's page area) in the layer `layer()` gives (the
 * page's current .pv-selection, or null). Returns `{ update, destroy }`; `update()` paints
 * again now (after the page is redrawn).
 */
export function watchSelection(area, layer = () => area.querySelector('.pv-selection')) {
  let painted = null;
  const w = {
    update(sel = document.getSelection()) {
      const el = layer();
      if (painted && painted !== el) clear(painted);
      painted = el;
      if (!el) return;
      const live = sel && sel.rangeCount > 0 && !sel.isCollapsed;
      if (!live || ![...Array(sel.rangeCount).keys()].some((i) => sel.getRangeAt(i).intersectsNode(area))) {
        clear(el);
        return;
      }
      const f = frameOf(el);
      if (!f) {
        clear(el);
        return;
      }
      const local = selectedTextRects(sel, area)
        .map((r) => toLocal(r, f))
        .filter(Boolean)
        .map((r) => clipRect(r, f.w, f.h))
        .filter(Boolean);
      paint(el, mergeRects(local, { gap: WORD_GAP }), f.w, f.h);
    },
    destroy() {
      watched.delete(w);
      clear(painted);
      if (!watched.size) document.removeEventListener('selectionchange', onSelectionChange);
    },
  };
  if (!watched.size) document.addEventListener('selectionchange', onSelectionChange);
  watched.add(w);
  area.classList.add('pv-paint-selection');
  return w;
}
