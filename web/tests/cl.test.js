// CourtListener records (docs/plans/courtlistener-mirror.md): their paths, reading one,
// and its source line. The fixture record is the one the Rust tests read. Finding a
// record through the unified index is in idx.test.js.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

import { gunzip, isClRecord, isGzip, sourceLineHtml } from '../public/js/cl.js';
import { clRecordPath, clRecordUrl } from '../public/js/sources.js';

const RECORD_BYTES = readFileSync(new URL('../../crates/stare/tests/fixtures/cl-record.json', import.meta.url));
const RECORD = JSON.parse(RECORD_BYTES);
const H1 = '0f3a9c2e7b1d4a65';

describe('CourtListener paths', () => {
  test('a record is one gzipped object per case under cl/c', () => {
    assert.equal(clRecordPath(9876543, H1), `cl/c/9876543/${H1}.json.gz`);
    assert.equal(clRecordUrl(9876543, H1), `https://data.stare.pub/cl/c/9876543/${H1}.json.gz`);
  });

  test('nothing that could leave the path is accepted', () => {
    assert.throws(() => clRecordPath(1, '../x'));
    assert.throws(() => clRecordPath(1, H1.toUpperCase()));
    assert.throws(() => clRecordPath('1', H1));
    assert.throws(() => clRecordPath(-1, H1));
  });
});

describe('records', () => {
  test('gunzips a stored record, and passes a plain one through', async () => {
    const gz = new Uint8Array(gzipSync(RECORD_BYTES));
    assert.ok(isGzip(gz));
    assert.ok(!isGzip(new Uint8Array(RECORD_BYTES)));
    assert.deepEqual(Buffer.from(await gunzip(gz)), RECORD_BYTES);
    const plain = new Uint8Array(RECORD_BYTES);
    assert.equal(await gunzip(plain), plain);
  });

  test('a CAP case has no source and no source line', () => {
    const cap = { ...RECORD, source: undefined };
    assert.ok(!isClRecord(cap));
    assert.equal(sourceLineHtml(cap), '');
    assert.ok(isClRecord(RECORD));
  });

  test('the source line names the export and links the case on CourtListener', () => {
    assert.equal(
      sourceLineHtml(RECORD),
      '<div class="reader-source"><a class="source-link" href="https://www.courtlistener.com/opinion/9876543/smith-v-jones/" target="_blank" rel="noopener noreferrer">From CourtListener&#39;s bulk data, export 2026-09-30</a>'
        + ' &middot; <span>Docket J-12-2021</span> &middot; <span>Published</span></div>',
    );
  });

  test('without a URL, docket or status, the line is just the source', () => {
    const bare = { source: { name: 'courtlistener', export: '2026-09-30', url: 'javascript:alert(1)' } };
    assert.equal(sourceLineHtml(bare, 'x'),
      '<div class="x">From CourtListener&#39;s bulk data, export 2026-09-30</div>');
    assert.ok(!sourceLineHtml(RECORD, 'x', { docket: false }).includes('Docket'));
    assert.equal(sourceLineHtml({ source: { name: 'courtlistener' } }),
      '<div class="reader-source">From CourtListener&#39;s bulk data</div>');
  });

  test('escapes what the record says', () => {
    const html = sourceLineHtml({ source: { name: 'courtlistener', docket_number: '<b>1</b>', precedential_status: '"x"' } });
    assert.ok(html.includes('Docket &lt;b&gt;1&lt;/b&gt;'));
    assert.ok(html.includes('&quot;x&quot;'));
  });
});
