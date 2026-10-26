// The Archival PDF view: the case's pages of our archival PDF of its volume
// (data.stare.pub/pdf/..., stare-builder's pdf-publish; #51), drawn by PDF.js from only the
// bytes those pages need. The PDFs are linearized, so the first range request gives the
// file's length and layout, and each page after that is a range request or two
// (pdfpages.js). PDF.js is our own copy (pdfjs-path.js), loaded the first time the view
// opens. The toolbar, zoom and keys are pageview.js's, shared with the Raw Scans.
import { extractFile, getPageOrders } from './resolve.js';
import { PDFJS_BASE } from './pdfjs-path.js';
import {
  PdfMissingError, casePdfPages, clampPages, documentOptions, openRangeTransport,
} from './pdfpages.js';
import { createPageView, pageLabels } from './pageview.js';
import { CSS_PER_POINT, canvasRatio } from './pagezoom.js';
import { selectionLayer } from './selectionpaint.js';
import { pdfUrl } from './sources.js';

let pdfjsPromise = null;

// PDF.js and its worker, once per page load.
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(`${PDFJS_BASE}pdf.min.mjs`).then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}pdf.worker.min.mjs`;
      return pdfjs;
    });
    pdfjsPromise.catch(() => { pdfjsPromise = null; });
  }
  return pdfjsPromise;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// A page is printed at this many dots to the inch, drawn again from the page already
// fetched.
const PRINT_DPI = 200;

// The view's state for the case shown.
let current = null;

function messageHtml(text, scansHint) {
  const hint = scansHint
    ? ' <button type="button" class="pdf-view-scans">Open the Raw Scans</button> to see the pages.'
    : '';
  return `<div class="pdf-view-message" role="status">${esc(text)}${hint}</div>`;
}

/**
 * Show `result`'s case in `container` from its volume's archival PDF. `openScans`
 * switches the reader to Raw Scans, which the error messages offer. `page` is the case's
 * page to open at (1-based, from the URL hash); `onPage(i)` hears of each page shown.
 */
export async function renderPdfViewer(container, result, { openScans, page = 1, onPage } = {}) {
  current?.destroy();
  current = null;

  const showMessage = (text, scansHint = true) => {
    container.innerHTML = messageHtml(text, scansHint);
    container.querySelector('.pdf-view-scans')?.addEventListener('click', () => openScans?.());
  };

  let orders = null;
  try {
    orders = getPageOrders(result.zipData, result.caseFile);
  } catch {
    orders = null;
  }
  const wanted = casePdfPages(orders);
  if (!wanted) {
    showMessage('Page order data not available for this case.', false);
    return;
  }

  container.innerHTML = '<div class="page-viewer-loading"><span class="spinner"></span> Loading the archival PDF...</div>';

  const url = pdfUrl(result.reporter, result.volume);
  const view = {
    doc: null, task: null, pages: wanted, renderTask: null, textLayer: null, token: 0,
    destroyed: false, ui: null,
    destroy() {
      this.destroyed = true;
      this.renderTask?.cancel();
      this.textLayer?.cancel();
      this.task?.destroy();
      this.ui?.destroy();
    },
  };
  current = view;

  const fail = (e) => {
    if (view.destroyed) return;
    if (!(e instanceof PdfMissingError)) console.error('Archival PDF view:', e);
    view.destroy();
    if (current === view) current = null;
    showMessage(e instanceof PdfMissingError
      ? 'The archival PDF of this volume isn\'t published yet.'
      : `Couldn't load the archival PDF: ${e.message || e}.`);
  };

  let pdfjs;
  try {
    pdfjs = await loadPdfjs();
    const range = await openRangeTransport(pdfjs.PDFDataRangeTransport, url, { onError: fail });
    if (view.destroyed) return;
    view.task = pdfjs.getDocument({
      ...documentOptions(new URL(PDFJS_BASE, window.location.href).href),
      range,
      verbosity: pdfjs.VerbosityLevel.ERRORS,
    });
    view.doc = await view.task.promise;
  } catch (e) {
    fail(e);
    return;
  }
  if (view.destroyed) return;

  view.pages = clampPages(wanted, view.doc.numPages);
  if (!view.pages) {
    fail(new Error(`the case's pages aren't in the volume's ${view.doc.numPages}-page PDF`));
    return;
  }
  const { first, count } = view.pages;
  const pdfPageOf = (i) => first + i - 1;

  // The printed labels: the PDF's own page labels (the volume's METS ORDERLABELs), else the
  // case's, as the reader's page markers have them.
  const fallbackLabels = pageLabels(count, extractFile, result);

  let pageEl = null;
  let shown = null; // { n, page } for the page in pageEl
  let drawn = '';

  function pageElement() {
    if (pageEl?.isConnected) return pageEl;
    pageEl = document.createElement('div');
    pageEl.className = 'pdf-page';
    pageEl.innerHTML = '<canvas class="pdf-page-canvas"></canvas><div class="textLayer"></div>';
    // The selection's highlight, under the text and over the canvas, in the text layer's
    // own (unturned) coordinates, so a turned page's lines still run across it.
    pageEl.querySelector('.textLayer').before(selectionLayer());
    ui.area.replaceChildren(pageEl);
    return pageEl;
  }

  // Fetch the next page's bytes, and decode it, while the reader reads this one.
  const prefetched = new Set();
  function prefetch(n) {
    if (n > view.pages.last || prefetched.has(n)) return;
    prefetched.add(n);
    view.doc.getPage(n).then((p) => p.getOperatorList()).catch(() => prefetched.delete(n));
  }

  const viewportFor = (p, zoom, rotation) => p.getViewport({
    scale: zoom * CSS_PER_POINT,
    rotation: (p.rotate + rotation) % 360,
  });

  function showError(e, n) {
    if (view.destroyed) return;
    console.error('Archival PDF page:', e);
    ui.area.innerHTML = messageHtml(`Couldn't show page ${n}: ${e.message || e}.`, true);
    ui.area.querySelector('.pdf-view-scans')?.addEventListener('click', () => openScans?.());
    pageEl = null;
  }

  // Draw the page at `zoom` and `rotation`, swapping the finished canvas in whole, so the
  // old one shows (stretched to the new size) until the new one is ready.
  async function render(zoom, rotation) {
    if (!shown) return;
    const { n, page: p } = shown;
    const viewport = viewportFor(p, zoom, rotation);
    const ratio = canvasRatio(viewport.width, viewport.height, window.devicePixelRatio || 1);
    const key = `${n}:${viewport.scale}:${viewport.rotation}:${ratio}`;
    if (key === drawn) return;
    const token = ++view.token;
    view.renderTask?.cancel();
    view.textLayer?.cancel();
    view.renderTask = null;
    view.textLayer = null;

    const next = document.createElement('canvas');
    next.className = 'pdf-page-canvas';
    next.width = Math.floor(viewport.width * ratio);
    next.height = Math.floor(viewport.height * ratio);
    next.style.width = '100%';
    next.style.height = '100%';
    const task = p.render({
      canvasContext: next.getContext('2d'),
      viewport,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null,
    });
    view.renderTask = task;
    try {
      await task.promise;
    } catch (e) {
      if (e?.name === 'RenderingCancelledException') return;
      showError(e, n);
      return;
    }
    if (token !== view.token || view.destroyed) return;

    const el = pageElement();
    el.querySelector('.pdf-page-canvas').replaceWith(next);
    el.style.setProperty('--total-scale-factor', String(viewport.scale));
    const textEl = el.querySelector('.textLayer');
    textEl.replaceChildren();
    el.dataset.page = String(n);
    const textLayer = new pdfjs.TextLayer({
      textContentSource: p.streamTextContent(),
      container: textEl,
      viewport,
    });
    view.textLayer = textLayer;
    const layer = el.querySelector('.pv-selection');
    layer.style.width = textEl.style.width;
    layer.style.height = textEl.style.height;
    layer.setAttribute('data-main-rotation', textEl.getAttribute('data-main-rotation') ?? '0');
    try {
      await textLayer.render();
    } catch (e) {
      if (e?.name !== 'AbortException') console.error('Archival PDF text layer:', e);
    }
    if (token !== view.token || view.destroyed) return;
    drawn = key;
    el.dataset.rendered = String(n);
    el.dataset.scale = String(viewport.scale);
    el.dataset.rotation = String(rotation);
    el.dataset.ratio = String(ratio);
    prefetch(n + 1);
  }

  const ui = createPageView(container, {
    kind: 'pdf',
    prefix: 'ap',
    count,
    start: page,
    labels: fallbackLabels,
    pdfHref: (i) => pdfUrl(result.reporter, result.volume, pdfPageOf(i)),
    onPage,
    pages: {
      async load(i) {
        const n = pdfPageOf(i);
        const p = await view.doc.getPage(n);
        if (view.destroyed) return null;
        shown = { n, page: p };
        drawn = '';
        const vp = p.getViewport({ scale: CSS_PER_POINT });
        return { width: vp.width, height: vp.height };
      },
      // Size the page box, and the canvas in it, to the new size at once; render() draws
      // it properly once the zoom settles.
      place(zoom, rotation) {
        if (!shown) return;
        const vp = viewportFor(shown.page, zoom, rotation);
        const el = pageElement();
        el.style.width = `${Math.floor(vp.width)}px`;
        el.style.height = `${Math.floor(vp.height)}px`;
        const canvas = el.querySelector('.pdf-page-canvas');
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        const textEl = el.querySelector('.textLayer');
        // A text layer drawn for another rotation is wrong until it's drawn again.
        if (textEl.getAttribute('data-main-rotation') !== String(vp.rotation)) textEl.replaceChildren();
        el.style.setProperty('--total-scale-factor', String(vp.scale));
      },
      render: (zoom, rotation) => render(zoom, rotation).catch((e) => showError(e, shown?.n)),
      fail: (e, i) => showError(e, pdfPageOf(i)),
      async printUrl(i) {
        const p = await view.doc.getPage(pdfPageOf(i));
        const vp = p.getViewport({ scale: PRINT_DPI / 72 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        await p.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        return blob ? URL.createObjectURL(blob) : null;
      },
    },
  });
  view.ui = ui;
  ui.area.innerHTML = '<div class="page-viewer-loading"><span class="spinner"></span> Loading page...</div>';

  // The PDF's own labels, when it has them for these pages.
  view.doc.getPageLabels().then((all) => {
    if (view.destroyed || !all) return;
    const mine = Array.from({ length: count }, (_, k) => all[first - 1 + k] || null);
    if (mine.some(Boolean)) ui.setLabels(mine.map((l, k) => l || fallbackLabels[k]));
  }).catch(() => {});

  await ui.go(ui.index);
}

/** Stop the view's work (a new case is shown). */
export function resetPdfViewer() {
  current?.destroy();
  current = null;
}
