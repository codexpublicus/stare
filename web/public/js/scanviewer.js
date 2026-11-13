// The Raw Scans view: CAP's color JPEGs of the case's pages, from the volume's tar on
// static.case.law by range requests through its `.tar.csv`, with the page's ALTO OCR text
// over the image (hidden unless the toolbar's Text button shows it). The toolbar, zoom and
// keys are pageshell.js's, shared with the Archival PDF.
import { fetchCachedText } from './cache.js';
import { createPageView, pageLabels } from './pageshell.js';
import { CSS_PER_SCAN_PIXEL } from './pagezoom.js';
import { extractFile, getPageOrders } from './resolve.js';
import { pdfPage } from './scans.js';
import { selectionLayer } from './selectionpaint.js';
import { pdfUrl, tarCsvUrl, tarUrl } from './sources.js';
import { loadWasm } from './wasm.js';

/**
 * Parse tar.csv and build sorted indexes of images and ALTO files.
 */
const tarIndexCache = new Map();

export async function getTarIndex(reporter, volume) {
  const key = `${reporter}/${volume}`;
  if (tarIndexCache.has(key)) return tarIndexCache.get(key);

  const csvKey = `${reporter}/${volume}.tar.csv`;
  const csvUrl = tarCsvUrl(reporter, volume);
  const csv = await fetchCachedText('multi', csvKey, csvUrl);
  if (!csv) throw new Error('tar.csv not available');

  const lines = csv.split('\n').filter(l => l.trim());
  const hasHeader = lines[0].startsWith('path,');
  const dataLines = hasHeader ? lines.slice(1) : lines;

  const images = [];
  const altos = [];

  for (const line of dataLines) {
    const [path, offsetStr, sizeStr] = line.split(',');
    if (!path) continue;
    const size = parseInt(sizeStr, 10);
    if (size === 0) continue;
    const entry = { path, offset: parseInt(offsetStr, 10), size };

    if (path.endsWith('.jpg')) {
      images.push(entry);
    } else if (path.includes('/alto/') && path.endsWith('.xml.gz')) {
      altos.push(entry);
    }
  }

  // Sort by filename
  const sortByName = (a, b) => a.path.split('/').pop().localeCompare(b.path.split('/').pop());
  images.sort(sortByName);
  altos.sort(sortByName);

  // Build page_order → entry mapping (1-indexed)
  const imagesByOrder = new Map();
  for (let i = 0; i < images.length; i++) {
    imagesByOrder.set(i + 1, images[i]);
  }

  // Build image sequence → ALTO mapping
  // Image: {barcode}_{seq}_{side}.jpg → ALTO: {barcode}_redacted_ALTO_{seq}_{side}.xml.gz
  const altoBySeq = new Map();
  for (const alto of altos) {
    const name = alto.path.split('/').pop();
    const match = name.match(/_ALTO_(\d+_\d+)\./);
    if (match) altoBySeq.set(match[1], alto);
  }

  const result = { imagesByOrder, altoBySeq, imageCount: images.length };
  tarIndexCache.set(key, result);
  return result;
}

// A range of the tar that fails without an answer (the connection dropped or changed), or
// with an answer that may not happen again (a timeout on a cold tar, a 5xx, a 429), is tried
// this many more times, after TAR_RETRY_DELAY_MS and then twice that, as the Archival PDF
// tries its ranges again (pdfpages.js). Any other HTTP error is final.
export const TAR_RETRIES = 2;
export const TAR_RETRY_DELAY_MS = 250;
const retryStatus = (status) => status === 408 || status === 429 || status >= 500;

/**
 * An entry's bytes from the tar by an HTTP range request, tried again as above. `deps`
 * ({ fetch, delayMs }) are injectable for tests.
 */
export async function fetchTarBytes(reporter, volume, entry, deps = {}) {
  const url = tarUrl(reporter, volume);
  const fetchFn = deps.fetch || globalThis.fetch;
  const delayMs = deps.delayMs ?? TAR_RETRY_DELAY_MS;
  const range = `bytes=${entry.offset}-${entry.offset + entry.size - 1}`;
  for (let attempt = 0; ; attempt++) {
    let error;
    try {
      const response = await fetchFn(url, { headers: { Range: range } });
      if (response.ok || response.status === 206) return new Uint8Array(await response.arrayBuffer());
      error = new Error(`HTTP ${response.status} for ${range} of the volume's tar`);
      error.retry = retryStatus(response.status);
    } catch (e) {
      error = e;
      error.retry = e instanceof TypeError;
    }
    if (!error.retry || attempt >= TAR_RETRIES) throw error;
    await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** attempt));
  }
}

/**
 * Fetch a page image. Returns a Blob URL.
 */
export async function fetchPageImage(reporter, volume, pageOrder, deps = {}) {
  const { imagesByOrder } = await getTarIndex(reporter, volume);
  const entry = imagesByOrder.get(pageOrder);
  if (!entry) return null;
  const bytes = await fetchTarBytes(reporter, volume, entry, deps);
  return URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
}

/**
 * Get the ALTO entry for a given page order.
 */
function getAltoForPage(tarIndex, pageOrder) {
  const imgEntry = tarIndex.imagesByOrder.get(pageOrder);
  if (!imgEntry) return null;
  // Extract sequence from image filename: {barcode}_{seq}_{side}.jpg
  const imgName = imgEntry.path.split('/').pop();
  const match = imgName.match(/_(\d+_\d+)\.jpg$/);
  if (!match) return null;
  return tarIndex.altoBySeq.get(match[1]) || null;
}

/**
 * Fetch and parse ALTO for a page. Returns AltoPage, or null when the volume's tar has no
 * ALTO for the page; a fetch that still fails after its retries is thrown, for the view to
 * say so. `deps` ({ fetch, delayMs, wasm }) are injectable for tests.
 */
export async function fetchAltoForPage(reporter, volume, pageOrder, deps = {}) {
  const tarIndex = await getTarIndex(reporter, volume);
  const altoEntry = getAltoForPage(tarIndex, pageOrder);
  if (!altoEntry) return null;

  const gzData = await fetchTarBytes(reporter, volume, altoEntry, deps);

  const w = deps.wasm || await loadWasm();
  const json = w.parse_alto(gzData);
  return JSON.parse(json);
}

/**
 * The ALTO text over a page: each line placed in the ALTO page's own pixels, in a box the
 * size of that page, which place() scales to the image's drawn size.
 */
function renderOverlay(altoPage) {
  const overlay = document.createElement('div');
  overlay.className = 'alto-overlay';
  overlay.style.width = `${altoPage.width}px`;
  overlay.style.height = `${altoPage.height}px`;
  for (const line of altoPage.lines) {
    // Each line is a positioned div containing inline text nodes.
    // This gives the browser a natural text flow for selection within each line.
    const lineDiv = document.createElement('div');
    lineDiv.className = 'alto-line';
    lineDiv.style.left = `${line.x}px`;
    lineDiv.style.top = `${line.y}px`;
    lineDiv.style.width = `${line.width}px`;
    lineDiv.style.height = `${line.height}px`;
    lineDiv.style.fontSize = `${Math.max(1, Math.round(line.height * 0.85))}px`;
    lineDiv.style.lineHeight = `${Math.round(line.height)}px`;
    lineDiv.textContent = line.words.map((w) => w.text).join(' ');
    overlay.appendChild(lineDiv);
  }
  return overlay;
}

let current = null;

/**
 * Render the page viewer for a case. `page` is the case's page to open at (1-based, from
 * the URL hash); `onPage(i)` hears of each page shown.
 */
export async function renderPageViewer(container, result, { page = 1, onPage } = {}) {
  current?.destroy();
  current = null;
  const orders = getPageOrders(result.zipData, result.caseFile);
  if (!orders) {
    container.innerHTML = '<div class="pdf-view-message">Page order data not available for this case.</div>';
    return;
  }
  const count = orders.last - orders.first + 1;
  const orderOf = (i) => orders.first + i - 1;
  const labels = pageLabels(count, extractFile, result);

  // The page shown: its element (outer box at the drawn, rotated size; inner box at the
  // unrotated size, turned), image and overlay, and the blob URLs fetched, by ORDER.
  let shown = null;
  const blobs = new Map();
  let destroyed = false;

  // The text layer for the page shown, put in once its ALTO is read: on a failure (after
  // fetchTarBytes's retries) the view says so, with a Retry, and the scan stays usable.
  const TEXT_FAILED = "The page's text layer couldn't be loaded, so its text can't be shown or selected.";
  function addOverlay(altoPage) {
    if (!shown || shown.overlay || !altoPage?.lines?.length) return;
    shown.overlay = renderOverlay(altoPage);
    shown.altoPage = altoPage;
    shown.inner.appendChild(shown.overlay);
    ui.relayout();
  }
  function textFailed(order, e) {
    console.warn(`Raw Scans: the ALTO for page ${order} couldn't be read:`, e);
    ui.notice(TEXT_FAILED, {
      retry: async () => {
        ui.notice(null);
        try {
          const altoPage = await fetchAltoForPage(result.reporter, result.volume, order);
          if (!destroyed && shown?.order === order) addOverlay(altoPage);
        } catch (err) {
          if (!destroyed && shown?.order === order) textFailed(order, err);
        }
      },
    });
  }

  async function pageImage(order) {
    if (!blobs.has(order)) {
      const url = await fetchPageImage(result.reporter, result.volume, order);
      if (!url) throw new Error(`no image for page ${order} in the volume's tar`);
      blobs.set(order, url);
    }
    return blobs.get(order);
  }

  const ui = createPageView(container, {
    kind: 'scans',
    prefix: 'pv',
    count,
    start: page,
    labels,
    pdfHref: (i) => pdfUrl(result.reporter, result.volume, pdfPage(orderOf(i))),
    onPage,
    pages: {
      async load(i) {
        const order = orderOf(i);
        if (!shown) ui.area.innerHTML = '<div class="page-viewer-loading"><span class="spinner"></span> Loading page...</div>';
        ui.notice(null);
        let altoError = null;
        const [blobUrl, altoPage] = await Promise.all([
          pageImage(order),
          fetchAltoForPage(result.reporter, result.volume, order).catch((e) => {
            altoError = e;
            return null;
          }),
        ]);
        const img = document.createElement('img');
        img.src = blobUrl;
        img.alt = `Page ${i} of ${count}`;
        img.className = 'page-viewer-img';
        img.draggable = false;
        await img.decode();
        if (destroyed) return null;
        const outer = document.createElement('div');
        outer.className = 'page-wrapper';
        outer.dataset.page = String(order);
        const inner = document.createElement('div');
        inner.className = 'page-turn';
        inner.appendChild(img);
        inner.appendChild(selectionLayer());
        const overlay = altoPage?.lines?.length ? renderOverlay(altoPage) : null;
        if (overlay) inner.appendChild(overlay);
        outer.appendChild(inner);
        ui.area.replaceChildren(outer);
        const width = img.naturalWidth * CSS_PER_SCAN_PIXEL;
        const height = img.naturalHeight * CSS_PER_SCAN_PIXEL;
        shown = { order, outer, inner, overlay, altoPage, width, height };
        if (altoError) textFailed(order, altoError);
        return { width, height };
      },
      place(zoom, rotation) {
        if (!shown) return;
        const { outer, inner, overlay, altoPage, width, height } = shown;
        const w = width * zoom;
        const h = height * zoom;
        const turned = rotation % 180 !== 0;
        outer.style.width = `${Math.floor(turned ? h : w)}px`;
        outer.style.height = `${Math.floor(turned ? w : h)}px`;
        inner.style.width = `${w}px`;
        inner.style.height = `${h}px`;
        inner.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
        if (overlay) overlay.style.transform = `scale(${w / altoPage.width}, ${h / altoPage.height})`;
        outer.dataset.rendered = String(outer.dataset.page);
      },
      render() {},
      fail(e) {
        ui.area.innerHTML = `<div class="pdf-view-message" role="status">Failed to load page: ${String(e?.message || e).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</div>`;
        shown = null;
      },
      printUrl: (i) => pageImage(orderOf(i)),
    },
  });
  current = {
    destroy() {
      destroyed = true;
      ui.destroy();
      for (const url of blobs.values()) URL.revokeObjectURL(url);
    },
  };
  await ui.go(ui.index);
}

/** Stop the view's work (a new case is shown). */
export function resetPageViewer() {
  current?.destroy();
  current = null;
}
