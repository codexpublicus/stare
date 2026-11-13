import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { resetMemoryCache } from '../public/js/cache.js';
import { fetchAltoForPage, fetchPageImage, fetchTarBytes, TAR_RETRIES } from '../public/js/scanviewer.js';
import { tarCsvUrl, tarUrl } from '../public/js/sources.js';

describe('fetchPageImage', () => {
  const realFetch = globalThis.fetch;
  let calls;

  beforeEach(() => {
    resetMemoryCache();
    calls = [];
    const csv = [
      'path,offset,size',
      'vol/images/B_00002_0.jpg,2048,300',
      'vol/images/B_00001_0.jpg,1024,200',
      'vol/alto/B_redacted_ALTO_00001_0.xml.gz,4096,50',
    ].join('\n');
    globalThis.fetch = async (url, opts = {}) => {
      calls.push({ url, range: opts.headers?.Range });
      if (url === tarCsvUrl('pageviewer-test', 1)) return new Response(csv);
      return new Response(new Uint8Array([0xff, 0xd8]), { status: 206 });
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // Regression: a local `const tarUrl = tarUrl(...)` shadowed the import and threw
  // "Cannot access 'tarUrl' before initialization" on every scan.
  test('range-requests the page image from the volume tar', async () => {
    const blobUrl = await fetchPageImage('pageviewer-test', 1, 1);
    assert.match(blobUrl, /^blob:/);
    const tarCall = calls.find(c => c.url === tarUrl('pageviewer-test', 1));
    assert.ok(tarCall, 'fetched the tar');
    assert.equal(tarCall.range, 'bytes=1024-1223');
  });

  test('returns null for a page past the last image', async () => {
    assert.equal(await fetchPageImage('pageviewer-test', 1, 9), null);
  });
});

// A failed range of the tar is tried again (#254), as the Archival PDF's are; an ALTO that
// still can't be read is thrown, for the view's notice, where a page with no ALTO is null.
describe('fetchTarBytes and fetchAltoForPage', () => {
  const entry = { offset: 4096, size: 50 };
  // A fetch that answers with `answers` in turn (a status, or 'drop' for a network error).
  const flaky = (answers, log = []) => async (url, init) => {
    log.push(init.headers.Range);
    const a = answers[Math.min(log.length - 1, answers.length - 1)];
    if (a === 'drop') throw new TypeError('Failed to fetch');
    return new Response(a === 206 ? new Uint8Array([1, 2, 3]) : 'no', { status: a });
  };

  test('a dropped connection or a timeout is tried again, then read', async () => {
    for (const first of ['drop', 504, 503, 429, 408]) {
      const log = [];
      const bytes = await fetchTarBytes('pageviewer-test', 1, entry, { fetch: flaky([first, 206], log), delayMs: 0 });
      assert.deepEqual([...bytes], [1, 2, 3], String(first));
      assert.deepEqual(log, ['bytes=4096-4145', 'bytes=4096-4145']);
    }
  });

  test('another HTTP error is final, and a failure that persists is thrown after the retries', async () => {
    const log = [];
    await assert.rejects(fetchTarBytes('pageviewer-test', 1, entry, { fetch: flaky([404], log), delayMs: 0 }), /HTTP 404/);
    assert.equal(log.length, 1);
    const drops = [];
    await assert.rejects(fetchTarBytes('pageviewer-test', 1, entry, { fetch: flaky(['drop'], drops), delayMs: 0 }), TypeError);
    assert.equal(drops.length, TAR_RETRIES + 1);
  });

  test('an ALTO that can\'t be read is thrown; a page with none is null', async () => {
    const csv = [
      'path,offset,size',
      'vol/images/B_00001_0.jpg,1024,200',
      'vol/images/B_00002_0.jpg,2048,300',
      'vol/alto/B_redacted_ALTO_00001_0.xml.gz,4096,50',
    ].join('\n');
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(csv);
    try {
      resetMemoryCache();
      await assert.rejects(
        fetchAltoForPage('alto-test', 1, 1, { fetch: flaky(['drop']), delayMs: 0, wasm: { parse_alto: () => '{}' } }),
        TypeError,
      );
      assert.equal(await fetchAltoForPage('alto-test', 1, 2, { fetch: flaky([206]), delayMs: 0 }), null);
      const page = await fetchAltoForPage('alto-test', 1, 1, {
        fetch: flaky(['drop', 206]), delayMs: 0, wasm: { parse_alto: () => '{"width":1,"height":1,"lines":[]}' },
      });
      assert.deepEqual(page, { width: 1, height: 1, lines: [] });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
