import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { resetMemoryCache } from '../public/js/cache.js';
import { fetchPageImage } from '../public/js/pageviewer.js';
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
