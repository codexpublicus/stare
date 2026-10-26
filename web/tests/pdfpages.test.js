import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PdfMissingError, RANGE_CHUNK_SIZE, casePdfPages, clampPages, documentOptions, fetchRange,
  openRangeTransport, parseContentRange,
} from '../public/js/pdfpages.js';

describe('casePdfPages', () => {
  test('gives the case\'s PDF pages from its METS ORDERs', () => {
    // a2d/31's 647-01 starts at ORDER 695 (smoke.spec.js).
    assert.deepEqual(casePdfPages({ first: 695, last: 702 }), { first: 695, last: 702, count: 8 });
    assert.deepEqual(casePdfPages({ first: 184, last: 184 }), { first: 184, last: 184, count: 1 });
  });

  test('gives null for missing, reversed or bad orders', () => {
    assert.equal(casePdfPages(null), null);
    assert.equal(casePdfPages({ first: 5 }), null);
    assert.equal(casePdfPages({ first: 9, last: 5 }), null);
    assert.equal(casePdfPages({ first: 0, last: 3 }), null);
    assert.equal(casePdfPages({ first: '3', last: 4 }), null);
    assert.equal(casePdfPages({ first: 1.5, last: 4 }), null);
  });
});

describe('clampPages', () => {
  test('cuts the range at the PDF\'s last page', () => {
    assert.deepEqual(clampPages({ first: 10, last: 14, count: 5 }, 12), { first: 10, last: 12, count: 3 });
    assert.deepEqual(clampPages({ first: 10, last: 14, count: 5 }, 100), { first: 10, last: 14, count: 5 });
  });

  test('gives null when the case starts past the end', () => {
    assert.equal(clampPages({ first: 13, last: 14, count: 2 }, 12), null);
    assert.equal(clampPages(null, 12), null);
    assert.equal(clampPages({ first: 1, last: 1, count: 1 }, undefined), null);
  });
});

test('documentOptions asks PDF.js for ranges only, without eval', () => {
  const options = documentOptions('https://stare.pub/vendor/pdfjs/');
  assert.equal(options.disableAutoFetch, true);
  assert.equal(options.disableStream, true);
  assert.equal(options.isEvalSupported, false);
  assert.equal(options.rangeChunkSize, RANGE_CHUNK_SIZE);
  assert.equal(options.wasmUrl, 'https://stare.pub/vendor/pdfjs/');
  // A chunk is a whole number of KiB, and no bigger than a few of the PDFs' pages.
  assert.equal(RANGE_CHUNK_SIZE % 1024, 0);
  assert.ok(RANGE_CHUNK_SIZE >= 16384 && RANGE_CHUNK_SIZE <= 262144);
});

test('parseContentRange', () => {
  assert.deepEqual(parseContentRange('bytes 0-1023/3255361'), { start: 0, end: 1023, total: 3255361 });
  assert.equal(parseContentRange('bytes */3255361'), null);
  assert.equal(parseContentRange('bytes 10-5/100'), null);
  assert.equal(parseContentRange('bytes 0-100/100'), null);
  assert.equal(parseContentRange(null), null);
});

// A fake data.stare.pub: `file` is the PDF's bytes; `status` overrides the answer.
function fakeServer(file, { status = null } = {}) {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, range: opts.headers.Range, aborted: () => opts.signal.aborted });
    if (status === 404) return new Response('Not Found', { status: 404 });
    if (status === 200) return new Response(file, { status: 200 });
    const [, b, e] = /^bytes=(\d+)-(\d+)$/.exec(opts.headers.Range).map(Number);
    const end = Math.min(e, file.length - 1);
    return new Response(file.slice(b, end + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${b}-${end}/${file.length}` },
    });
  };
  return { calls, fetchFn };
}

const URL_ = 'https://data.stare.pub/pdf/us/a2d/31.pdf';

describe('fetchRange', () => {
  const file = new Uint8Array(200_000).map((_, i) => i % 251);

  test('reads exactly the bytes asked for, with the total length', async () => {
    const { calls, fetchFn } = fakeServer(file);
    const { bytes, total } = await fetchRange(URL_, 100, 300, fetchFn);
    assert.equal(total, 200_000);
    assert.deepEqual(bytes, file.slice(100, 300));
    assert.equal(calls[0].range, 'bytes=100-299');
  });

  test('takes a short last range at the end of the file', async () => {
    const { fetchFn } = fakeServer(file);
    const { bytes } = await fetchRange(URL_, 199_990, 200_000 + RANGE_CHUNK_SIZE, fetchFn);
    assert.equal(bytes.length, 10);
  });

  test('says a 404 is a missing PDF', async () => {
    const { fetchFn } = fakeServer(file, { status: 404 });
    await assert.rejects(fetchRange(URL_, 0, 100, fetchFn), PdfMissingError);
  });

  test('cuts off a server that sends the whole file', async () => {
    const { calls, fetchFn } = fakeServer(file, { status: 200 });
    await assert.rejects(fetchRange(URL_, 0, 100, fetchFn), /HTTP 200/);
    assert.equal(calls[0].aborted(), true);
  });
});

describe('openRangeTransport', () => {
  // PDF.js's PDFDataRangeTransport, as far as the transport uses it.
  class Base {
    constructor(length, initialData) {
      this.length = length;
      this.initialData = initialData;
      this.ranges = [];
    }
    onDataRange(begin, chunk) {
      this.ranges.push([begin, chunk.length]);
    }
  }

  test('starts from the first chunk and the file\'s length, then serves each range', async () => {
    const file = new Uint8Array(500_000);
    const { calls, fetchFn } = fakeServer(file);
    const transport = await openRangeTransport(Base, URL_, { fetchFn });
    assert.equal(transport.length, 500_000);
    assert.equal(transport.initialData.length, RANGE_CHUNK_SIZE);
    assert.equal(calls[0].range, `bytes=0-${RANGE_CHUNK_SIZE - 1}`);

    transport.requestDataRange(262144, 393216);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(transport.ranges, [[262144, 131072]]);
    assert.equal(calls.length, 2);
  });

  test('tries a dropped request again, and reports one that keeps failing to onError', async () => {
    const file = new Uint8Array(500_000);
    const server = fakeServer(file);
    let failures = 0;
    let attempts = 0;
    const fetchFn = (url, opts) => {
      attempts++;
      if (failures > 0) {
        failures--;
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return server.fetchFn(url, opts);
    };
    const errors = [];
    const transport = await openRangeTransport(Base, URL_, { fetchFn, onError: (e) => errors.push(e.message), delayMs: 1 });

    failures = 2;
    attempts = 0;
    transport.requestDataRange(65536, 131072);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(attempts, 3);
    assert.deepEqual(transport.ranges, [[65536, 65536]]);
    assert.deepEqual(errors, []);

    failures = 3;
    attempts = 0;
    transport.requestDataRange(131072, 196608);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(attempts, 3);
    assert.deepEqual(errors, ['Failed to fetch']);
  });

  test('doesn\'t try an HTTP error again', async () => {
    const { calls, fetchFn } = fakeServer(new Uint8Array(10), { status: 404 });
    await assert.rejects(openRangeTransport(Base, URL_, { fetchFn, delayMs: 1 }), PdfMissingError);
    assert.equal(calls.length, 1);
  });
});
