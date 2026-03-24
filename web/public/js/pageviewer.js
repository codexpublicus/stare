import { fetchCachedText } from './cache.js';
import { getPageOrders } from './resolve.js';

const TAR_URL = 'https://static.case.law';

/**
 * Parse tar.csv and build a sorted index of image files.
 * Returns: Map<pageOrder (1-indexed), { path, offset, size }>
 */
const tarIndexCache = new Map();

export async function getTarIndex(reporter, volume) {
  const key = `${reporter}/${volume}`;
  if (tarIndexCache.has(key)) return tarIndexCache.get(key);

  const csvKey = `${reporter}/${volume}.tar.csv`;
  const csvUrl = `${TAR_URL}/${reporter}/${volume}.tar.csv`;
  const csv = await fetchCachedText('multi', csvKey, csvUrl);
  if (!csv) throw new Error('tar.csv not available');

  const lines = csv.split('\n').filter(l => l.trim());
  const hasHeader = lines[0].startsWith('path,');
  const dataLines = hasHeader ? lines.slice(1) : lines;

  // Extract image files (.jpg), sort by filename for page ordering
  const images = [];
  for (const line of dataLines) {
    const [path, offsetStr, sizeStr] = line.split(',');
    if (!path || !path.endsWith('.jpg')) continue;
    const size = parseInt(sizeStr, 10);
    if (size === 0) continue;
    images.push({ path, offset: parseInt(offsetStr, 10), size });
  }

  // Sort by filename to establish page order
  images.sort((a, b) => {
    const nameA = a.path.split('/').pop();
    const nameB = b.path.split('/').pop();
    return nameA.localeCompare(nameB);
  });

  // Build page_order → image mapping (1-indexed)
  const byOrder = new Map();
  for (let i = 0; i < images.length; i++) {
    byOrder.set(i + 1, images[i]);
  }

  tarIndexCache.set(key, byOrder);
  return byOrder;
}

/**
 * Fetch a page image from the tar via HTTP range request.
 * Returns a Blob URL for the image.
 */
export async function fetchPageImage(reporter, volume, pageOrder) {
  const byOrder = await getTarIndex(reporter, volume);
  const entry = byOrder.get(pageOrder);
  if (!entry) return null;

  const tarUrl = `${TAR_URL}/${reporter}/${volume}.tar`;
  const response = await fetch(tarUrl, {
    headers: {
      'Range': `bytes=${entry.offset}-${entry.offset + entry.size - 1}`,
    },
  });

  if (!response.ok && response.status !== 206) {
    throw new Error(`Failed to fetch page image: HTTP ${response.status}`);
  }

  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

/**
 * Render the page viewer for a case.
 * Shows page images with prev/next navigation.
 */
export async function renderPageViewer(container, result, onStatus) {
  const orders = getPageOrders(result.zipData, result.caseFile);
  if (!orders) {
    container.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-secondary)">Page order data not available for this case.</div>';
    return;
  }

  let currentPage = orders.first;

  async function showPage(pageOrder) {
    currentPage = pageOrder;
    container.innerHTML = `<div class="page-viewer">
      <div class="page-viewer-toolbar">
        <button class="page-viewer-btn" id="pv-prev" ${pageOrder <= orders.first ? 'disabled' : ''}>&#9664; Prev</button>
        <span class="page-viewer-info">Page ${pageOrder - orders.first + 1} of ${orders.last - orders.first + 1}</span>
        <button class="page-viewer-btn" id="pv-next" ${pageOrder >= orders.last ? 'disabled' : ''}>Next &#9654;</button>
      </div>
      <div class="page-viewer-image" id="pv-image">
        <div class="page-viewer-loading"><span class="spinner"></span> Loading page...</div>
      </div>
    </div>`;

    // Wire buttons
    const prevBtn = container.querySelector('#pv-prev');
    const nextBtn = container.querySelector('#pv-next');
    prevBtn?.addEventListener('click', () => showPage(currentPage - 1));
    nextBtn?.addEventListener('click', () => showPage(currentPage + 1));

    // Fetch and display image
    try {
      const blobUrl = await fetchPageImage(result.reporter, result.volume, pageOrder);
      const imgEl = container.querySelector('#pv-image');
      if (blobUrl && imgEl) {
        imgEl.innerHTML = `<img src="${blobUrl}" alt="Page ${pageOrder}" class="page-viewer-img" />`;
      } else if (imgEl) {
        imgEl.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-secondary)">Page image not available.</div>';
      }
    } catch (e) {
      const imgEl = container.querySelector('#pv-image');
      if (imgEl) {
        imgEl.innerHTML = `<div style="padding:32px;text-align:center;color:var(--error-text)">Failed to load page: ${e.message}</div>`;
      }
    }
  }

  await showPage(currentPage);
}
