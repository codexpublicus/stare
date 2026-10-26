// The Archival PDF view's plain logic, apart from PDF.js and the DOM (pdfviewer.js uses it;
// web/tests/pdfpages.test.js tests it): which pages of the volume's PDF a case is on, and how
// the view asks for them. The zoom it shares with Raw Scans is pagezoom.js's.
import { pdfPage } from './scans.js';

// PDF.js asks for the file in chunks of this many bytes, and joins neighbouring chunks
// into one request. An archival PDF's page is one JBIG2 image of roughly 20 to 80 KB with
// its dictionary and text beside it. Measured on 2026-10-26 (a2d/142, f2d/500, us/400),
// opening a case and drawing its first page took 140 to 240 KB at 32 KiB, 240 to 340 KB at
// 64 KiB and 500 to 660 KB at 128 KiB, in one or two more requests at 32 KiB and the same
// time to the first page.
export const RANGE_CHUNK_SIZE = 32768;

// The getDocument options for a volume's PDF (pdfviewer.js adds `range`, its transport).
// disableAutoFetch keeps PDF.js from reading the rest of the file in the background once
// the pages asked for are in; disableStream keeps it from streaming the whole file.
// The worker's page lookup is patched (web/src/lib/pdfjs-vendor.js) so that finding a page
// doesn't fetch every page's dictionary first.
export function documentOptions(wasmUrl) {
  return {
    rangeChunkSize: RANGE_CHUNK_SIZE,
    disableAutoFetch: true,
    disableStream: true,
    isEvalSupported: false,
    wasmUrl,
  };
}

/**
 * The case's pages in its volume's archival PDF, from its METS ORDERs (getPageOrders):
 * `{ first, last, count }`, 1-based, or null when the orders don't give a page range.
 * Every published PDF's pages are its volume's ORDERs 1 to N (scans.js's pdfPage).
 */
export function casePdfPages(orders) {
  const first = pdfPage(orders?.first);
  const last = pdfPage(orders?.last);
  if (first === null || last === null || last < first) return null;
  return { first, last, count: last - first + 1 };
}

/** `pages` cut to a PDF of `numPages` pages, or null when the case starts past its end. */
export function clampPages(pages, numPages) {
  if (!pages || !Number.isSafeInteger(numPages) || pages.first > numPages) return null;
  const last = Math.min(pages.last, numPages);
  return { first: pages.first, last, count: last - pages.first + 1 };
}

/** `bytes <start>-<end>/<total>` as numbers, or null. */
export function parseContentRange(header) {
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(header ?? '').trim());
  if (!m) return null;
  const [start, end, total] = m.slice(1).map(Number);
  return end >= start && total > end ? { start, end, total } : null;
}

// The PDF isn't there: the one scanned volume without one yet (f-appx/660), or a volume
// published later than this page was loaded.
export class PdfMissingError extends Error {
  constructor(url) {
    super(`No archival PDF at ${url}`);
    this.name = 'PdfMissingError';
  }
}

/**
 * Bytes `begin` to `end` (exclusive) of `url`, by one HTTP range request, with the file's
 * total length: `{ bytes, total }`. Anything but a 206 for exactly that range throws, and a
 * server that answers with the whole file is cut off rather than read to the end.
 */
export async function fetchRange(url, begin, end, fetchFn = globalThis.fetch) {
  const controller = new AbortController();
  const response = await fetchFn(url, {
    headers: { Range: `bytes=${begin}-${end - 1}` },
    signal: controller.signal,
  });
  if (response.status === 404) {
    controller.abort();
    throw new PdfMissingError(url);
  }
  if (response.status !== 206) {
    controller.abort();
    throw new Error(`Range request for the archival PDF answered HTTP ${response.status}`);
  }
  const range = parseContentRange(response.headers.get('Content-Range'));
  if (!range || range.start !== begin) {
    controller.abort();
    throw new Error('Range request for the archival PDF returned the wrong bytes');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== Math.min(end, range.total) - begin) {
    throw new Error('Range request for the archival PDF returned a short body');
  }
  return { bytes, total: range.total };
}

// A range request that fails without an answer (the connection dropped or changed) is
// tried this many more times, after RETRY_DELAY_MS and then twice that. An HTTP error is
// final.
export const RETRIES = 2;
export const RETRY_DELAY_MS = 250;

/** fetchRange, trying again after a network failure. */
export async function fetchRangeRetrying(url, begin, end, fetchFn = globalThis.fetch, delayMs = RETRY_DELAY_MS) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchRange(url, begin, end, fetchFn);
    } catch (e) {
      if (!(e instanceof TypeError) || attempt >= RETRIES) throw e;
      await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** attempt));
    }
  }
}

/**
 * A PDF.js range transport for `url` (`Base` is PDF.js's PDFDataRangeTransport): the file's
 * first RANGE_CHUNK_SIZE bytes, which give its length, its linearization dictionary and
 * the first page's cross-reference section, and then each range PDF.js asks for.
 * `onError` gets a failed request, since PDF.js gives the transport no way to report one.
 */
export async function openRangeTransport(Base, url, { fetchFn = globalThis.fetch, onError = () => {}, delayMs = RETRY_DELAY_MS } = {}) {
  const first = await fetchRangeRetrying(url, 0, RANGE_CHUNK_SIZE, fetchFn, delayMs);
  class RangeTransport extends Base {
    requestDataRange(begin, end) {
      fetchRangeRetrying(url, begin, end, fetchFn, delayMs).then(
        ({ bytes }) => this.onDataRange(begin, bytes),
        onError,
      );
    }
  }
  return new RangeTransport(first.total, first.bytes);
}
