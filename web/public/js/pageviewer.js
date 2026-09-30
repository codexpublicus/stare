import { fetchCachedText } from './cache.js';
import { getPageOrders } from './resolve.js';
import { mirrorUrl } from './sources.js';

let wasm = null;
async function getWasm() {
  if (!wasm) {
    const mod = await import('/wasm/stare_wasm.js');
    await mod.default();
    wasm = mod;
  }
  return wasm;
}

/**
 * Parse tar.csv and build sorted indexes of images and ALTO files.
 */
const tarIndexCache = new Map();

export async function getTarIndex(reporter, volume) {
  const key = `${reporter}/${volume}`;
  if (tarIndexCache.has(key)) return tarIndexCache.get(key);

  const csvKey = `${reporter}/${volume}.tar.csv`;
  const csvUrl = mirrorUrl(reporter, volume, 'tar.csv');
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
  const tarUrl = mirrorUrl(reporter, volume, 'tar');
  const response = await fetch(tarUrl, {
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

  const w = await getWasm();
  const json = w.parse_alto(gzData);
  return JSON.parse(json);
}

/**
 * Render the text overlay on a page image.
 */
function renderOverlay(container, altoPage, renderedHeight) {
  const overlay = document.createElement('div');
  overlay.className = 'alto-overlay';

  const pw = altoPage.width;
  const ph = altoPage.height;
  // Scale factor: rendered pixels per ALTO pixel
  const scale = renderedHeight / ph;

  for (const line of altoPage.lines) {
    // Each line is a positioned div containing inline text nodes.
    // This gives the browser a natural text flow for selection within each line.
    const lineDiv = document.createElement('div');
    lineDiv.className = 'alto-line';
    lineDiv.style.left = (line.x / pw * 100) + '%';
    lineDiv.style.top = (line.y / ph * 100) + '%';
    lineDiv.style.width = (line.width / pw * 100) + '%';
    lineDiv.style.height = (line.height / ph * 100) + '%';

    const fontSize = Math.max(1, Math.round(line.height * scale * 0.85));
    lineDiv.style.fontSize = fontSize + 'px';
    lineDiv.style.lineHeight = Math.round(line.height * scale) + 'px';

    for (let i = 0; i < line.words.length; i++) {
      lineDiv.appendChild(document.createTextNode(line.words[i].text));
      if (i < line.words.length - 1) {
        lineDiv.appendChild(document.createTextNode(' '));
      }
    }

    overlay.appendChild(lineDiv);
  }

  container.appendChild(overlay);
}

/**
 * Render the page viewer for a case.
 */
export async function renderPageViewer(container, result, onStatus) {
  const orders = getPageOrders(result.zipData, result.caseFile);
  if (!orders) {
    container.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-secondary)">Page order data not available for this case.</div>';
    return;
  }

  let currentPage = orders.first;
  let zoomLevel = 1;

  // Keyboard navigation
  function handleKey(e) {
    if (container.classList.contains('hidden')) return;
    if (e.key === 'ArrowLeft' && currentPage > orders.first) {
      showPage(currentPage - 1);
    } else if (e.key === 'ArrowRight' && currentPage < orders.last) {
      showPage(currentPage + 1);
    } else if (e.key === '+' || e.key === '=') {
      adjustZoom(0.25);
    } else if (e.key === '-') {
      adjustZoom(-0.25);
    } else if (e.key === '0') {
      zoomLevel = 1;
      applyZoom();
    }
  }
  document.addEventListener('keydown', handleKey);

  function adjustZoom(delta) {
    zoomLevel = Math.max(0.5, Math.min(3, zoomLevel + delta));
    applyZoom();
  }

  function applyZoom() {
    const img = container.querySelector('.page-viewer-img');
    if (img) img.style.maxWidth = (100 * zoomLevel) + '%';
    const zoomInfo = container.querySelector('#pv-zoom');
    if (zoomInfo) zoomInfo.textContent = Math.round(zoomLevel * 100) + '%';
  }

  async function showPage(pageOrder) {
    currentPage = pageOrder;
    container.innerHTML = `<div class="page-viewer">
      <div class="page-viewer-toolbar">
        <button class="page-viewer-btn" id="pv-prev" ${pageOrder <= orders.first ? 'disabled' : ''} title="Previous page (←)">&#9664;</button>
        <span class="page-viewer-info">Page ${pageOrder - orders.first + 1} of ${orders.last - orders.first + 1}</span>
        <button class="page-viewer-btn" id="pv-next" ${pageOrder >= orders.last ? 'disabled' : ''} title="Next page (→)">&#9654;</button>
        <span class="page-viewer-sep">|</span>
        <button class="page-viewer-btn" id="pv-zoom-out" title="Zoom out (-)">−</button>
        <span class="page-viewer-zoom" id="pv-zoom">${Math.round(zoomLevel * 100)}%</span>
        <button class="page-viewer-btn" id="pv-zoom-in" title="Zoom in (+)">+</button>
      </div>
      <div class="page-viewer-image" id="pv-image">
        <div class="page-viewer-loading"><span class="spinner"></span> Loading page...</div>
      </div>
    </div>`;

    container.querySelector('#pv-prev')?.addEventListener('click', () => showPage(currentPage - 1));
    container.querySelector('#pv-next')?.addEventListener('click', () => showPage(currentPage + 1));
    container.querySelector('#pv-zoom-in')?.addEventListener('click', () => adjustZoom(0.25));
    container.querySelector('#pv-zoom-out')?.addEventListener('click', () => adjustZoom(-0.25));

    const imgEl = container.querySelector('#pv-image');

    try {
      // Fetch image and ALTO in parallel
      const [blobUrl, altoPage] = await Promise.all([
        fetchPageImage(result.reporter, result.volume, pageOrder),
        fetchAltoForPage(result.reporter, result.volume, pageOrder).catch(() => null),
      ]);

      if (!blobUrl || !imgEl) return;

      // Create image + overlay container
      const wrapper = document.createElement('div');
      wrapper.className = 'page-wrapper';

      const img = document.createElement('img');
      img.src = blobUrl;
      img.alt = `Page ${pageOrder}`;
      img.className = 'page-viewer-img';
      img.draggable = false;
      wrapper.appendChild(img);

      imgEl.innerHTML = '';
      imgEl.appendChild(wrapper);

      if (altoPage && altoPage.lines.length > 0) {
        // Wait for image to load so we know rendered dimensions
        if (img.complete) {
          renderOverlay(wrapper, altoPage, img.clientHeight);
        } else {
          img.addEventListener('load', () => {
            renderOverlay(wrapper, altoPage, img.clientHeight);
          });
        }
      }
    } catch (e) {
      if (imgEl) {
        imgEl.innerHTML = `<div style="padding:32px;text-align:center;color:var(--error-text)">Failed to load page: ${e.message}</div>`;
      }
    }
  }

  await showPage(currentPage);
}
