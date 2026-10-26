// The Raw Scans view: CAP's color JPEGs of the case's pages, from the volume's tar on
// static.case.law by range requests through its `.tar.csv`, with the page's ALTO OCR text
// over the image (hidden unless the toolbar's Text button shows it). The toolbar, zoom and
// keys are pageview.js's, shared with the Archival PDF.
import { fetchCachedText } from './cache.js';
import { createPageView, pageLabels } from './pageview.js';
import { CSS_PER_SCAN_PIXEL } from './pagezoom.js';
import { extractFile, getPageOrders } from './resolve.js';
import { pdfPage } from './scans.js';
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

/**
 * Fetch raw bytes from the tar via HTTP range request.
 */
async function fetchTarRange(reporter, volume, entry) {
  const url = tarUrl(reporter, volume);
  const response = await fetch(url, {
    headers: { 'Range': `bytes=${entry.offset}-${entry.offset + entry.size - 1}` },
  });
  if (!response.ok && response.status !== 206) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response;
}

/**
 * Fetch a page image. Returns a Blob URL.
 */
export async function fetchPageImage(reporter, volume, pageOrder) {
  const { imagesByOrder } = await getTarIndex(reporter, volume);
  const entry = imagesByOrder.get(pageOrder);
  if (!entry) return null;
  const response = await fetchTarRange(reporter, volume, entry);
  const blob = await response.blob();
  return URL.createObjectURL(blob);
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
 * Fetch and parse ALTO for a page. Returns AltoPage or null.
 */
export async function fetchAltoForPage(reporter, volume, pageOrder) {
  const tarIndex = await getTarIndex(reporter, volume);
  const altoEntry = getAltoForPage(tarIndex, pageOrder);
  if (!altoEntry) return null;

  const response = await fetchTarRange(reporter, volume, altoEntry);
  const gzData = new Uint8Array(await response.arrayBuffer());

  const w = await loadWasm();
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
        const [blobUrl, altoPage] = await Promise.all([
          pageImage(order),
          fetchAltoForPage(result.reporter, result.volume, order).catch(() => null),
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
        const overlay = altoPage?.lines?.length ? renderOverlay(altoPage) : null;
        if (overlay) inner.appendChild(overlay);
        outer.appendChild(inner);
        ui.area.replaceChildren(outer);
        const width = img.naturalWidth * CSS_PER_SCAN_PIXEL;
        const height = img.naturalHeight * CSS_PER_SCAN_PIXEL;
        shown = { outer, inner, overlay, altoPage, width, height };
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
