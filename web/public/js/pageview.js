// What the two page views share (#246): the Archival PDF (pdfviewer.js) and the Raw Scans
// (pageviewer.js) show one page of the case at a time, with the same toolbar, keys and
// gestures. This module draws the toolbar, keeps the page, zoom, rotation and text-layer
// state, sizes the page to the view, and asks the view to draw it; the plain logic is in
// pagezoom.js.
//
// A view hands createPageView its `pages` hooks:
//   load(i)              the case's page i (1-based): resolves to its size at 100%,
//                        { width, height } in CSS pixels, and puts its element in the view.
//   place(zoom, rotation) sizes that element now (CSS only; cheap, run on every gesture step).
//   render(zoom, rotation) draws it properly at that size (the PDF's canvas, at the device
//                        pixel ratio); run once the zoom has settled.
//   printUrl(i)          resolves to a URL of the page's image, to print.
//
// The view puts selectionpaint.js's selectionLayer() in its page, between the image and the
// text; this module paints the text selection there (#247).
import {
  ZOOM_MAX, ZOOM_MIN, anchoredScroll, caseLabels, clampZoom, defaultMode, fitZoom,
  parsePageInput, parseStoredMode, rotate, stepZoom, storedMode, zoomLabel,
} from './pagezoom.js';
import { filePage } from './pagekey.js';
import { watchSelection } from './selectionpaint.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// How long the zoom has to settle before the page is drawn again at its new size.
export const RENDER_DELAY_MS = 150;

const KEYS = [
  ['← →', 'Previous, next page'],
  ['+ −', 'Zoom in, out'],
  ['0', '100%'],
  ['f', 'Fit page, fit width'],
  ['r', 'Rotate (shift+r: back)'],
  ['t', 'Show or hide the OCR text'],
  ['Ctrl + wheel', 'Zoom at the pointer'],
  ['?', 'This help'],
];

// The views on the page; one keyboard handler serves them all, acting on the one showing.
const views = new Set();
let keysWired = false;

function isTyping(target) {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable="true"]');
}

function onKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const v = [...views].find((x) => x.visible());
  if (!v) return;
  if (e.key === 'Escape') {
    v.closeHelp();
    return;
  }
  if (isTyping(e.target)) return;
  const act = {
    ArrowLeft: () => v.go(v.index - 1),
    ArrowRight: () => v.go(v.index + 1),
    '+': () => v.zoomStep(1),
    '=': () => v.zoomStep(1),
    '-': () => v.zoomStep(-1),
    '0': () => v.setMode(1),
    f: () => v.setMode(v.mode === 'page' ? 'width' : 'page'),
    r: () => v.rotate(1),
    R: () => v.rotate(-1),
    t: () => v.toggleText(),
    '?': () => v.toggleHelp(),
  }[e.key];
  if (!act) return;
  e.preventDefault();
  act();
}

const storageKey = (kind) => `stare-page-zoom-${kind}`;

function readMode(kind) {
  try {
    return parseStoredMode(localStorage.getItem(storageKey(kind)));
  } catch {
    return null;
  }
}

function writeMode(kind, mode) {
  try {
    localStorage.setItem(storageKey(kind), storedMode(mode));
  } catch {
    // Storage blocked or full: the mode lasts until the page is left.
  }
}

/** The toolbar and page area, for `prefix` ("ap" for the PDF, "pv" for the scans). */
function viewHtml(prefix, kind, count) {
  const id = (s) => `${prefix}-${s}`;
  const keys = KEYS.map(([k, what]) => `<dt><kbd>${esc(k)}</kbd></dt><dd>${esc(what)}</dd>`).join('');
  return `<div class="page-viewer" data-view="${kind}">
    <div class="page-viewer-toolbar" role="toolbar" aria-label="Page view">
      <div class="pv-group">
        <button type="button" class="page-viewer-btn" id="${id('prev')}" aria-label="Previous page" title="Previous page (←)">&#9664;</button>
        <label class="page-viewer-info" id="${id('info')}">Page
          <input type="text" class="pv-page-input" id="${id('page')}" inputmode="numeric" autocomplete="off"
            size="3" aria-label="Page of the case (or p. and a printed page number)"
            title="Type a page and press Enter (p. 149 for printed page 149)">
          <span id="${id('count')}">of ${count}</span></label>
        <span class="pv-label" id="${id('label')}" title="Printed page"></span>
        <button type="button" class="page-viewer-btn" id="${id('next')}" aria-label="Next page" title="Next page (→)">&#9654;</button>
      </div>
      <div class="pv-group" role="group" aria-label="Zoom">
        <button type="button" class="page-viewer-btn" id="${id('zoom-out')}" aria-label="Zoom out" title="Zoom out (−)">−</button>
        <output class="page-viewer-zoom" id="${id('zoom')}" aria-live="polite" title="Zoom, of the printed size"></output>
        <button type="button" class="page-viewer-btn" id="${id('zoom-in')}" aria-label="Zoom in" title="Zoom in (+)">+</button>
        <button type="button" class="page-viewer-btn pv-mode" id="${id('fit-page')}" data-mode="page" aria-pressed="false" title="Fit the whole page (f)">Fit page</button>
        <button type="button" class="page-viewer-btn pv-mode" id="${id('fit-width')}" data-mode="width" aria-pressed="false" title="Fit the page's width (f)">Fit width</button>
        <button type="button" class="page-viewer-btn pv-mode" id="${id('actual')}" data-mode="1" aria-pressed="false" title="The printed size (0)">100%</button>
      </div>
      <div class="pv-group">
        <button type="button" class="page-viewer-btn" id="${id('rotate')}" aria-label="Rotate clockwise" title="Rotate (r)">&#8635;</button>
        <button type="button" class="page-viewer-btn" id="${id('text')}" aria-pressed="false" title="Show the OCR text over the page (t)">Text</button>
        <a class="page-viewer-btn" id="${id('pdf')}" target="_blank" rel="noopener" title="Open this page in the volume's archival PDF">PDF</a>
        <button type="button" class="page-viewer-btn" id="${id('print')}" title="Print this page">Print</button>
        <button type="button" class="page-viewer-btn" id="${id('help')}" aria-label="Keyboard shortcuts" aria-expanded="false" aria-controls="${id('keys')}" title="Keyboard shortcuts (?)">?</button>
      </div>
      <div class="pv-help" id="${id('keys')}" role="region" aria-label="Keyboard shortcuts" hidden>
        <dl>${keys}</dl>
      </div>
    </div>
    <div class="page-viewer-image" id="${id('area')}"></div>
  </div>`;
}

/**
 * Build the page view in `container` and show page `start` of the case's `count` pages.
 * `labels` are the pages' printed labels (null where unknown); `pdfHref(i)` links page i in
 * the archival PDF; `onPage(i)` hears of each page shown (for the URL hash); `pages` are
 * the view's hooks (above). Returns the view, whose `area` the page element goes in.
 */
export function createPageView(container, {
  kind, prefix, count, start = 1, labels = [], pdfHref, onPage = () => {}, pages,
}) {
  container.innerHTML = viewHtml(prefix, kind, count);
  const $ = (s) => container.querySelector(`#${prefix}-${s}`);
  const root = container.querySelector('.page-viewer');
  const area = $('area');
  const input = $('page');
  const help = $('keys');
  const selection = watchSelection(area);

  const v = {
    kind, area, root, count, labels,
    index: Math.min(Math.max(1, start | 0 || 1), count),
    mode: null, zoom: 1, rotation: 0, text: false, size: null, destroyed: false,
    loadToken: 0, renderTimer: 0,
  };

  // The view's visible width and height for the page, less the area's padding: the part of
  // the area inside the window, so a page that fits is wholly on screen.
  function available() {
    const cs = getComputedStyle(area);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const top = Math.max(area.getBoundingClientRect().top, 0);
    const height = Math.min(area.clientHeight, window.innerHeight - top);
    return { w: area.clientWidth - padX, h: height - padY };
  }

  v.mode = readMode(kind) ?? defaultMode(available().w || window.innerWidth);

  v.visible = () => !v.destroyed && area.isConnected && !container.classList.contains('hidden')
    && area.clientWidth > 0;

  function updateToolbar() {
    if (document.activeElement !== input) input.value = String(v.index);
    const label = v.labels?.[v.index - 1];
    $('label').textContent = label ? `p. ${label}` : '';
    $('prev').disabled = v.index <= 1;
    $('next').disabled = v.index >= v.count;
    $('zoom').textContent = zoomLabel(v.zoom);
    $('zoom-out').disabled = v.zoom <= ZOOM_MIN + 1e-6;
    $('zoom-in').disabled = v.zoom >= ZOOM_MAX - 1e-6;
    for (const b of container.querySelectorAll('.pv-mode')) {
      const m = b.dataset.mode;
      b.setAttribute('aria-pressed', String(m === String(v.mode)));
    }
    $('text').setAttribute('aria-pressed', String(v.text));
    root.classList.toggle('pv-show-text', v.text);
    const href = pdfHref?.(v.index);
    if (href) $('pdf').href = href;
    else $('pdf').removeAttribute('href');
    root.dataset.zoom = String(v.zoom);
    root.dataset.rotation = String(v.rotation);
    root.dataset.mode = String(v.mode);
  }

  function pageBox() {
    const el = area.firstElementChild;
    if (!el) return null;
    const a = area.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { left: r.left - a.left, top: r.top - a.top, width: r.width, height: r.height };
  }

  function scheduleRender() {
    clearTimeout(v.renderTimer);
    v.renderTimer = setTimeout(() => {
      if (!v.destroyed && v.size && v.visible()) pages.render(v.zoom, v.rotation);
    }, RENDER_DELAY_MS);
  }

  // Size the page for the mode and the view; `anchor` ({ x, y } in the area) keeps the
  // point of the page under it in place. The proper drawing follows once things settle.
  function layout(anchor = null, now = false) {
    if (!v.size || !v.visible()) return;
    const { w, h } = available();
    v.zoom = fitZoom(v.mode, v.size.width, v.size.height, w, h, v.rotation);
    const before = anchor && pageBox();
    const scroll = { left: area.scrollLeft, top: area.scrollTop };
    pages.place(v.zoom, v.rotation);
    if (before) {
      const after = pageBox();
      const s = anchoredScroll(scroll, before, after, anchor.x, anchor.y);
      area.scrollLeft = s.left;
      area.scrollTop = s.top;
    }
    area.classList.toggle('pv-pannable', area.scrollWidth > area.clientWidth + 1 || area.scrollHeight > area.clientHeight + 1);
    updateToolbar();
    if (now) {
      clearTimeout(v.renderTimer);
      pages.render(v.zoom, v.rotation);
    } else {
      scheduleRender();
    }
  }

  const centre = () => ({ x: area.clientWidth / 2, y: area.clientHeight / 2 });

  v.setMode = (mode, anchor = centre()) => {
    v.mode = typeof mode === 'number' ? clampZoom(mode) : mode;
    writeMode(kind, v.mode);
    layout(anchor);
  };
  v.zoomStep = (dir) => v.setMode(stepZoom(v.zoom, dir));
  v.rotate = (dir) => {
    v.rotation = rotate(v.rotation, dir);
    layout(null);
  };
  v.toggleText = () => {
    v.text = !v.text;
    updateToolbar();
  };
  v.toggleHelp = (open = help.hidden) => {
    help.hidden = !open;
    $('help').setAttribute('aria-expanded', String(open));
  };
  v.closeHelp = () => v.toggleHelp(false);

  // Show page i: load it (the view shows its own loading state), then size and draw it.
  v.go = async (i) => {
    if (!(i >= 1 && i <= v.count)) {
      updateToolbar();
      return;
    }
    const token = ++v.loadToken;
    v.index = i;
    updateToolbar();
    onPage(i);
    area.scrollTo?.(0, 0);
    let size;
    try {
      size = await pages.load(i);
    } catch (e) {
      if (token === v.loadToken) pages.fail?.(e, i);
      return;
    }
    if (token !== v.loadToken || v.destroyed || !size) return;
    v.size = size;
    layout(null, true);
  };

  // The toolbar.
  $('prev').addEventListener('click', () => v.go(v.index - 1));
  $('next').addEventListener('click', () => v.go(v.index + 1));
  $('zoom-in').addEventListener('click', () => v.zoomStep(1));
  $('zoom-out').addEventListener('click', () => v.zoomStep(-1));
  for (const b of container.querySelectorAll('.pv-mode')) {
    b.addEventListener('click', () => {
      const m = b.dataset.mode;
      v.setMode(m === 'page' || m === 'width' ? m : Number(m));
    });
  }
  $('rotate').addEventListener('click', () => v.rotate(1));
  $('text').addEventListener('click', () => v.toggleText());
  $('help').addEventListener('click', () => v.toggleHelp());
  $('print').addEventListener('click', () => printPage(v.index));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const i = parsePageInput(input.value, v.count, v.labels);
      input.value = String(i ?? v.index);
      if (i !== null && i !== v.index) v.go(i);
      input.select();
    } else if (e.key === 'Escape') {
      input.value = String(v.index);
      input.blur();
    }
  });
  input.addEventListener('focus', () => input.select());
  input.addEventListener('blur', () => { input.value = String(v.index); });
  const onDocClick = (e) => {
    if (!help.hidden && !help.contains(e.target) && !$('help').contains(e.target)) v.closeHelp();
  };
  document.addEventListener('click', onDocClick);

  // Print just the page image, from a frame of its own.
  async function printPage(i) {
    let url;
    try {
      url = await pages.printUrl(i);
    } catch (e) {
      console.error('Page view print:', e);
      return;
    }
    if (!url) return;
    const frame = document.createElement('iframe');
    frame.className = 'pv-print-frame';
    frame.setAttribute('aria-hidden', 'true');
    frame.srcdoc = `<!doctype html><title>Page</title><style>@page{margin:0.4in}html,body{margin:0;height:100%}
      img{display:block;max-width:100%;max-height:100%;margin:auto;object-fit:contain}</style><img src="${esc(url)}" alt="">`;
    frame.addEventListener('load', () => {
      const img = frame.contentDocument?.querySelector('img');
      const go = () => {
        frame.contentWindow?.print();
        setTimeout(() => frame.remove(), 1000);
      };
      if (img && !img.complete) img.addEventListener('load', go, { once: true });
      else go();
    }, { once: true });
    document.body.appendChild(frame);
  }

  // Ctrl/Cmd + wheel (and a trackpad's pinch, which arrives as one) zooms at the pointer.
  area.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !v.size) return;
    e.preventDefault();
    const per = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.002;
    const a = area.getBoundingClientRect();
    v.mode = clampZoom(v.zoom * Math.exp(-e.deltaY * per));
    writeMode(kind, v.mode);
    layout({ x: e.clientX - a.left, y: e.clientY - a.top });
  }, { passive: false });

  // Pinch zoom on a touch screen, about the fingers' midpoint. One finger scrolls as usual.
  let pinch = null;
  const touchInfo = (t) => {
    const a = area.getBoundingClientRect();
    const [p, q] = [t[0], t[1]];
    return {
      dist: Math.hypot(p.clientX - q.clientX, p.clientY - q.clientY),
      x: (p.clientX + q.clientX) / 2 - a.left,
      y: (p.clientY + q.clientY) / 2 - a.top,
    };
  };
  area.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2 && v.size) pinch = { ...touchInfo(e.touches), zoom: v.zoom };
  }, { passive: true });
  area.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const t = touchInfo(e.touches);
    if (!(pinch.dist > 0)) return;
    v.mode = clampZoom(pinch.zoom * (t.dist / pinch.dist));
    layout({ x: t.x, y: t.y });
  }, { passive: false });
  const endPinch = (e) => {
    if (pinch && e.touches.length < 2) {
      pinch = null;
      writeMode(kind, v.mode);
    }
  };
  area.addEventListener('touchend', endPinch);
  area.addEventListener('touchcancel', endPinch);
  // Safari's own page zoom gesture.
  area.addEventListener('gesturestart', (e) => e.preventDefault());

  // Drag to pan a page bigger than the view, with the mouse, except on the text (which is
  // there to be selected).
  let drag = null;
  area.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || !area.classList.contains('pv-pannable')) return;
    if (e.target instanceof Element && e.target.closest('.textLayer span, .textLayer br, .alto-line, a, button, input')) return;
    drag = { x: e.clientX, y: e.clientY, left: area.scrollLeft, top: area.scrollTop, id: e.pointerId };
    area.setPointerCapture?.(e.pointerId);
    area.classList.add('pv-panning');
    e.preventDefault();
  });
  area.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    area.scrollLeft = drag.left - (e.clientX - drag.x);
    area.scrollTop = drag.top - (e.clientY - drag.y);
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    area.classList.remove('pv-panning');
  };
  area.addEventListener('pointerup', endDrag);
  area.addEventListener('pointercancel', endDrag);

  // Size the page again when the view changes size: a resized window, a turned phone, the
  // tab shown again, or a browser zoom (a new device pixel ratio).
  let lastSize = '';
  const resized = () => {
    if (v.destroyed) return;
    const key = `${area.clientWidth}x${area.clientHeight}@${window.devicePixelRatio}`;
    if (area.clientWidth > 0 && key !== lastSize) {
      lastSize = key;
      layout(null);
    }
  };
  const observer = new ResizeObserver(resized);
  observer.observe(area);
  window.addEventListener('resize', resized);
  window.addEventListener('orientationchange', resized);

  v.destroy = () => {
    v.destroyed = true;
    clearTimeout(v.renderTimer);
    selection.destroy();
    observer.disconnect();
    window.removeEventListener('resize', resized);
    window.removeEventListener('orientationchange', resized);
    document.removeEventListener('click', onDocClick);
    views.delete(v);
  };
  v.setLabels = (l) => {
    v.labels = l;
    updateToolbar();
  };
  v.relayout = () => layout(null, true);

  views.add(v);
  if (!keysWired) {
    keysWired = true;
    document.addEventListener('keydown', onKey);
  }
  updateToolbar();
  return v;
}

/** The page view shown in `el` (#pdf-viewer, #page-viewer), or undefined. */
export const pageViewIn = (el) => [...views].find((v) => el.contains(v.root));

/**
 * The printed labels of the case's `count` pages (pagezoom.js's caseLabels): its first
 * page, from its file name (`148-01`), and the labels its CAP HTML marks at each page
 * break after that (`<a class="page-label" data-label="149">`), as the reader's page
 * markers have them. `extractFile` is resolve.js's.
 */
export function pageLabels(count, extractFile, result) {
  let breaks = [];
  try {
    const html = extractFile(result.zipData, `html/${result.caseFile}.html`);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    breaks = [...doc.querySelectorAll('.page-label')].map((a) => a.getAttribute('data-label')).filter(Boolean);
  } catch {
    breaks = [];
  }
  const first = filePage(result.caseFile);
  return caseLabels(count, first == null ? null : String(first), null, breaks);
}
