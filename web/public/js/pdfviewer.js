// The Archival PDF view: the case's pages of our archival PDF of its volume
// (data.stare.pub/pdf/..., stare-builder's pdf-publish; #51), drawn by PDF.js from only the
// bytes those pages need. The PDFs are linearized, so the first range request gives the
// file's length and layout, and each page after that is a range request or two
// (pdfpages.js). PDF.js is our own copy (pdfjs-path.js), loaded the first time the view
// opens.
import { getPageOrders } from './resolve.js';
import { PDFJS_BASE } from './pdfjs-path.js';
import {
  PdfMissingError, ZOOM_STEP, casePdfPages, clampPages, documentOptions, fitScale,
  openRangeTransport, pageInfo, stepZoom,
} from './pdfpages.js';
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

// The view's state for the case shown; one keyboard handler serves every case.
let current = null;

function isTyping(target) {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable="true"]');
}

document.addEventListener('keydown', (e) => {
  const v = current;
  if (!v || v.container.classList.contains('hidden') || !v.doc || isTyping(e.target)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'ArrowLeft' && v.page > v.pages.first) v.show(v.page - 1);
  else if (e.key === 'ArrowRight' && v.page < v.pages.last) v.show(v.page + 1);
  else if (e.key === '+' || e.key === '=') v.zoomBy(ZOOM_STEP);
  else if (e.key === '-') v.zoomBy(-ZOOM_STEP);
  else if (e.key === '0') v.zoomTo(1);
});

function messageHtml(text, scansHint) {
  const hint = scansHint
    ? ' <button type="button" class="pdf-view-scans">Open the Raw Scans</button> to see the pages.'
    : '';
  return `<div class="pdf-view-message" role="status">${esc(text)}${hint}</div>`;
}

/**
 * Show `result`'s case in `container` from its volume's archival PDF. `openScans`
 * switches the reader to Raw Scans, which the error messages offer.
 */
export async function renderPdfViewer(container, result, { openScans } = {}) {
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
    container, doc: null, task: null, pages: wanted, page: wanted.first, zoom: 1,
    renderTask: null, textLayer: null, token: 0, destroyed: false,
    show: () => {}, zoomBy: () => {}, zoomTo: () => {},
    destroy() {
      this.destroyed = true;
      this.renderTask?.cancel();
      this.textLayer?.cancel();
      this.task?.destroy();
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
  view.page = view.pages.first;

  container.innerHTML = `<div class="page-viewer pdf-view">
    <div class="page-viewer-toolbar">
      <button class="page-viewer-btn" id="ap-prev" title="Previous page (←)">&#9664;</button>
      <span class="page-viewer-info" id="ap-info"></span>
      <button class="page-viewer-btn" id="ap-next" title="Next page (→)">&#9654;</button>
      <span class="page-viewer-sep">|</span>
      <button class="page-viewer-btn" id="ap-zoom-out" title="Zoom out (-)">−</button>
      <span class="page-viewer-zoom" id="ap-zoom">100%</span>
      <button class="page-viewer-btn" id="ap-zoom-in" title="Zoom in (+)">+</button>
    </div>
    <div class="page-viewer-image" id="ap-page">
      <div class="pdf-page">
        <canvas class="pdf-page-canvas"></canvas>
        <div class="textLayer"></div>
      </div>
    </div>
  </div>`;

  const $ = (sel) => container.querySelector(sel);
  const prevBtn = $('#ap-prev');
  const nextBtn = $('#ap-next');
  const info = $('#ap-info');
  const zoomInfo = $('#ap-zoom');
  const area = $('#ap-page');
  const pageEl = $('.pdf-page');
  const canvas = $('.pdf-page-canvas');
  const textEl = $('.textLayer');

  prevBtn.addEventListener('click', () => view.show(view.page - 1));
  nextBtn.addEventListener('click', () => view.show(view.page + 1));
  $('#ap-zoom-in').addEventListener('click', () => view.zoomBy(ZOOM_STEP));
  $('#ap-zoom-out').addEventListener('click', () => view.zoomBy(-ZOOM_STEP));

  // Fetch the next page's bytes, and decode it, while the reader reads this one.
  const prefetched = new Set();
  function prefetch(n) {
    if (n > view.pages.last || prefetched.has(n)) return;
    prefetched.add(n);
    view.doc.getPage(n).then((p) => p.getOperatorList()).catch(() => prefetched.delete(n));
  }

  async function draw(n) {
    const token = ++view.token;
    view.renderTask?.cancel();
    view.textLayer?.cancel();
    view.renderTask = null;
    view.textLayer = null;
    const page = await view.doc.getPage(n);
    if (token !== view.token || view.destroyed) return;

    // Fit the page to the view's width at 100%, as Raw Scans does.
    const style = getComputedStyle(area);
    const width = area.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const scale = fitScale(width, page.getViewport({ scale: 1 }).width, view.zoom);
    const viewport = page.getViewport({ scale });
    const ratio = window.devicePixelRatio || 1;

    const next = document.createElement('canvas');
    next.className = 'pdf-page-canvas';
    next.width = Math.floor(viewport.width * ratio);
    next.height = Math.floor(viewport.height * ratio);
    next.style.width = `${Math.floor(viewport.width)}px`;
    next.style.height = `${Math.floor(viewport.height)}px`;
    const task = page.render({
      canvasContext: next.getContext('2d'),
      viewport,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null,
    });
    view.renderTask = task;
    try {
      await task.promise;
    } catch (e) {
      if (e?.name === 'RenderingCancelledException') return;
      throw e;
    }
    if (token !== view.token || view.destroyed) return;

    // Swap the finished page in whole, so the old one shows until the new one is ready.
    pageEl.style.setProperty('--total-scale-factor', String(viewport.scale));
    pageEl.querySelector('.pdf-page-canvas').replaceWith(next);
    textEl.replaceChildren();
    pageEl.dataset.page = String(n);
    const textLayer = new pdfjs.TextLayer({
      textContentSource: page.streamTextContent(),
      container: textEl,
      viewport,
    });
    view.textLayer = textLayer;
    try {
      await textLayer.render();
    } catch (e) {
      if (e?.name !== 'AbortException') console.error('Archival PDF text layer:', e);
    }
    if (token !== view.token || view.destroyed) return;
    pageEl.dataset.rendered = String(n);
    prefetch(n + 1);
  }

  function update() {
    info.textContent = pageInfo(view.pages, view.page);
    prevBtn.disabled = view.page <= view.pages.first;
    nextBtn.disabled = view.page >= view.pages.last;
    zoomInfo.textContent = `${Math.round(view.zoom * 100)}%`;
  }

  function redraw() {
    update();
    return draw(view.page).catch((e) => {
      if (view.destroyed) return;
      console.error('Archival PDF page:', e);
      area.innerHTML = messageHtml(`Couldn't show page ${view.page}: ${e.message || e}.`, true);
      area.querySelector('.pdf-view-scans')?.addEventListener('click', () => openScans?.());
    });
  }

  view.show = (n) => {
    if (n < view.pages.first || n > view.pages.last || n === view.page) return;
    view.page = n;
    area.scrollTo?.(0, 0);
    container.closest('.main-content')?.scrollTo?.(0, 0);
    redraw();
  };
  view.zoomTo = (z) => {
    if (z === view.zoom) return;
    view.zoom = z;
    redraw();
  };
  view.zoomBy = (delta) => view.zoomTo(stepZoom(view.zoom, delta));

  // The canvas is drawn for the view's width; draw it again when that changes.
  let lastWidth = area.clientWidth;
  const resize = new ResizeObserver(() => {
    if (view.destroyed || !area.isConnected) return resize.disconnect();
    const w = area.clientWidth;
    if (w > 0 && w !== lastWidth) {
      lastWidth = w;
      redraw();
    }
  });
  resize.observe(area);
  const destroy = view.destroy.bind(view);
  view.destroy = () => {
    resize.disconnect();
    destroy();
  };

  await redraw();
}

/** Stop the view's work (a new case is shown). */
export function resetPdfViewer() {
  current?.destroy();
  current = null;
}
