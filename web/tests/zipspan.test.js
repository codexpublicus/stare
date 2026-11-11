// Reading a CAP case by its index line's zip span (D180, #313): the span's checks, the one
// Range request and what's done with each answer, the inflating, the index lines read in
// JS, and the reader's span path (resolve.js's readBySpan and spanZip) with its fallbacks.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateRawSync, gzipSync } from 'node:zlib';

import {
  idxEntries, idxEntriesJs, lineEntry, parseIdxLine, partFor, parseIdxText, volumeCaseFiles,
} from '../public/js/idx.js';
import { readBySpan, spanZip } from '../public/js/resolve.js';
import { fetchSpan, inflate, parseSpan, readSpanText, spanKey, spanRange, SpanError } from '../public/js/zipspan.js';
import { wasm } from './wasm-node.js';

const H1 = '0f3a9c2e7b1d4a65';
const enc = (s) => new TextEncoder().encode(s);

// A zip's bytes with one entry's compressed data at `offset`, padded either side.
function zipWith(json, offset, method = 8) {
  const data = method === 8 ? new Uint8Array(deflateRawSync(Buffer.from(json))) : enc(json);
  const bytes = new Uint8Array(offset + data.length + 50);
  bytes.set(data, offset);
  return { bytes, span: { offset, length: data.length, method } };
}

// A fetch serving `bytes` as data.stare.pub does, logging each request's Range.
function server(bytes, { status = null, log = [], shift = 0 } = {}) {
  return async (url, init = {}) => {
    const range = init.headers?.Range ?? null;
    log.push({ url, range });
    if (status === 200 || !range) return new Response(bytes, { status: 200 });
    if (status) return new Response('', { status });
    const m = /^bytes=(\d+)-(\d+)$/.exec(range);
    const a = Number(m[1]) + shift;
    const b = Number(m[2]) + shift;
    return new Response(bytes.slice(a, b + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${a}-${b}/${bytes.length}` },
    });
  };
}

const CASE = {
  id: 1, name: 'Smith v. Jones', name_abbreviation: 'Smith v. Jones', decision_date: '1943-01-01', citations: [],
  court: { name: 'Supreme Court' }, jurisdiction: { name_long: 'Rhode Island' },
  casebody: { head_matter: '', opinions: [{ type: 'majority', author: '', text: 'A contract was made.' }] },
};

describe('parseSpan', () => {
  test('reads the line\'s form and the WASM\'s', () => {
    assert.deepEqual(parseSpan('39997:8435:8'), { offset: 39997, length: 8435, method: 8 });
    assert.deepEqual(parseSpan({ offset: 0, length: 3, method: 0 }), { offset: 0, length: 3, method: 0 });
    assert.equal(spanRange(parseSpan('39997:8435:8')), 'bytes=39997-48431');
  });

  test('none for an empty span, a method it can\'t inflate, or anything else', () => {
    for (const bad of ['1:0:8', '1:2:12', '1:2', 'a:b:c', '', null, undefined, {}, { offset: -1, length: 2, method: 8 }]) {
      assert.equal(parseSpan(bad), null, JSON.stringify(bad));
    }
  });

  test('the cache key names the build, the zip and the span', () => {
    assert.equal(spanKey('v/v2026.11.05.3/', 'ri', '69', parseSpan('39997:8435:8')), 'v/v2026.11.05.3/span/ri/69.zip@39997:8435:8');
  });
});

describe('fetchSpan and readSpanText', () => {
  const json = JSON.stringify(CASE);

  test('one Range request for exactly the span, inflated, with the zip\'s size', async () => {
    const { bytes, span } = zipWith(json, 1234);
    const log = [];
    const got = await readSpanText('https://data.stare.pub/cap/x/1.zip', span, { fetch: server(bytes, { log }) });
    assert.equal(got.text, json);
    assert.equal(got.total, bytes.length);
    assert.deepEqual(log, [{ url: 'https://data.stare.pub/cap/x/1.zip', range: spanRange(span) }]);
  });

  test('a stored entry is read as is', async () => {
    const { bytes, span } = zipWith(json, 7, 0);
    assert.equal((await readSpanText('u', span, { fetch: server(bytes) })).text, json);
  });

  test('a 200 is the whole zip, for the caller to read the case out of', async () => {
    const { bytes, span } = zipWith(json, 10);
    const got = await fetchSpan('u', span, { fetch: server(bytes, { status: 200 }) });
    assert.deepEqual(got.whole, bytes);
  });

  test('any other answer is a SpanError: a status, bytes other than the span\'s', async () => {
    const { bytes, span } = zipWith(json, 10);
    await assert.rejects(fetchSpan('u', span, { fetch: server(bytes, { status: 416 }) }), SpanError);
    await assert.rejects(fetchSpan('u', span, { fetch: server(bytes, { shift: 1 }) }), SpanError);
    // Bytes that aren't deflate.
    await assert.rejects(readSpanText('u', { ...span, offset: 0 }, { fetch: server(new Uint8Array(bytes.length).fill(255)) }), SpanError);
  });

  test('kept in the cache under its key, and read from there without a request', async () => {
    const { bytes, span } = zipWith(json, 100);
    const store = new Map();
    const cache = {
      cacheGet: async (s, k) => store.get(`${s}:${k}`) || null,
      cacheSet: async (s, k, v) => { store.set(`${s}:${k}`, v); },
    };
    const log = [];
    await readSpanText('u', span, { fetch: server(bytes, { log }), key: 'K', ...cache });
    assert.ok(store.has('zips:K'));
    const again = await readSpanText('u', span, { fetch: server(bytes, { log }), key: 'K', ...cache });
    assert.equal(again.text, json);
    assert.equal(again.total, null);
    assert.equal(log.length, 1);
  });

  test('inflate refuses a method it doesn\'t know', async () => {
    await assert.rejects(inflate(enc('x'), 12), SpanError);
  });
});

describe('index lines in JS', () => {
  test('fields come off the end, so a case file with a comma stays whole', () => {
    assert.deepEqual(parseIdxLine('53,cap,11, 12-01,zip=10:20:0'),
      { page: 53, source: 'cap', ref: '11, 12-01', fields: { zip: '10:20:0' } });
    assert.deepEqual(parseIdxLine('1,cap,ri/69/0051-01,via=cl:4105300,zip=39997:8435:8').fields,
      { via: 'cl:4105300', zip: '39997:8435:8' });
    assert.equal(parseIdxLine('#parts,900'), null);
    assert.equal(parseIdxLine('bad line'), null);
    assert.equal(parseIdxLine('XXIX,cap,xxix-01').page, 'xxix');
  });

  test('a line\'s entry is the WASM\'s, span included', () => {
    const line = '1,cap,ri/69/0051-01,via=cl:4105300,zip=39997:8435:8';
    const mine = lineEntry(parseIdxLine(line));
    const theirs = JSON.parse(wasm.lookup_idx(enc(line), '1')).entries[0];
    assert.deepEqual(mine, theirs);
    const own = '51,cap,138-2/0051-01,zip=1:2:8';
    assert.deepEqual(lineEntry(parseIdxLine(own)), JSON.parse(wasm.lookup_idx(enc(own), '51')).entries[0]);
    const cl = `5,cl,7/${H1}`;
    assert.deepEqual(lineEntry(parseIdxLine(cl)), JSON.parse(wasm.lookup_idx(enc(cl), '5')).entries[0]);
    // A span this reader can't use is left off; the WASM keeps what it parses.
    assert.equal(lineEntry(parseIdxLine('51,cap,0051-01,zip=1:2:12')).zip, undefined);
  });

  const FILES = {
    'a3d/138/0': '#parts,900\n5,cap,0005-01,zip=1:2:8\n5,cap,neb/1/0001-01,via=cl:1,zip=3:4:8\n'
      + `5,cl,7/${H1}\n8,cap,138-2/0008-01,zip=5:6:8\n`,
    'a3d/138/1': '900,cap,0900-01,zip=7:8:8\n901,cap,138-2/0901-01\n',
  };
  const readIdx = async (s, v, part) => {
    const t = FILES[`${s}/${v}/${part}`];
    return t == null ? null : new Uint8Array(gzipSync(Buffer.from(t)));
  };

  test('idxEntriesJs looks a page up as lookup_idx does, following #parts', async () => {
    const wasmLookup = (bytes, page) => JSON.parse(wasm.lookup_idx(bytes, String(page)));
    for (const page of [5, 8, 900, 901, 7]) {
      assert.deepEqual(await idxEntriesJs('a3d', '138', page, { readIdx }),
        await idxEntries('a3d', '138', page, { readIdx, lookup: wasmLookup }), String(page));
    }
    assert.equal(await idxEntriesJs('a3d', '139', 5, { readIdx }), null);
    assert.equal(partFor(parseIdxText('#parts,900,xx\n').parts, 'xxi'), 2);
  });

  test('a folder\'s case files from every part, without aliases or records', async () => {
    assert.deepEqual(await volumeCaseFiles('a3d', '138', '138', { readIdx }), ['0005-01', '0900-01']);
    assert.deepEqual(await volumeCaseFiles('a3d', '138', '138-2', { readIdx }), ['0008-01', '0901-01']);
    assert.deepEqual(await volumeCaseFiles('a3d', '139', '139', { readIdx }), []);
  });
});

describe('a recorded CAP zip (crates/stare/tests/fixtures/a2d-31.zip)', () => {
  const zip = new Uint8Array(readFileSync(new URL('../../crates/stare/tests/fixtures/a2d-31.zip', import.meta.url)));
  // The span the index builder writes for an entry: past the local header (30 bytes, the
  // name and the extra field), its compressed length, its method.
  function spanOf(name) {
    const dir = JSON.parse(wasm.zip_directory(zip, 0)).entries;
    const e = dir.find((x) => x.name === name);
    const v = new DataView(zip.buffer, zip.byteOffset + e.start);
    const offset = e.start + 30 + v.getUint16(26, true) + v.getUint16(28, true);
    return { offset, length: v.getUint32(18, true), method: v.getUint16(8, true) };
  }

  test('each case JSON read by its span is the case extract_case reads out of the whole zip', async () => {
    for (const file of ['0647-01', '0657-01', '0657-02']) {
      const span = spanOf(`json/${file}.json`);
      assert.equal(span.method, 8);
      const log = [];
      const got = await readSpanText('u', span, { fetch: server(zip, { log }) });
      assert.equal(log.length, 1);
      assert.deepEqual(JSON.parse(wasm.parse_case_json(got.raw)), JSON.parse(wasm.extract_case(zip, file)));
    }
  });
});

describe('the reader\'s span path (readBySpan, spanZip)', () => {
  const json = JSON.stringify(CASE);
  const { bytes, span } = zipWith(json, 500);
  const w = async () => wasm;
  // fetchSpanText's shape, over the zip above.
  const reader = (log, opts = {}) => (reporter, folder, s) => readSpanText(`https://data.stare.pub/cap/${reporter}/${folder}.zip`, s, {
    fetch: server(bytes, { log, ...opts }),
  });

  test('a case with a span is one Range request, parsed as the reader parses records', async () => {
    const log = [];
    const got = await readBySpan('x', '1', '0500-01', new Map([['0500-01', span]]), null, {
      wasm: w, readSpan: reader(log), volumeCaseFiles: async () => ['0001-01', '0500-01'],
    });
    assert.equal(log.length, 1);
    assert.equal(log[0].range, spanRange(span));
    assert.equal(got.zipData, null);
    assert.equal(got.caseData.name_abbreviation, 'Smith v. Jones');
    assert.deepEqual(got.caseData, JSON.parse(wasm.parse_case_json(enc(json))));
    assert.deepEqual(got.volumeCases, ['0001-01', '0500-01']);
    assert.equal(typeof got.zip.html, 'function');
  });

  test('no span, or a span that can\'t be read, leaves the case to the whole zip', async () => {
    const none = await readBySpan('x', '1', '0500-01', new Map([['0500-01', undefined]]), null, { wasm: w });
    assert.equal(none, null);
    assert.equal(await readBySpan('x', '1', '0500-01', null, null, { wasm: w }), null);
    const wrong = await readBySpan('x', '1', '0500-01', new Map([['0500-01', span]]), null, {
      wasm: w, readSpan: reader([], { shift: 3 }), volumeCaseFiles: async () => [],
    });
    assert.equal(wrong, null);
    const refused = await readBySpan('x', '1', '0500-01', new Map([['0500-01', span]]), null, {
      wasm: w, readSpan: reader([], { status: 403 }), volumeCaseFiles: async () => [],
    });
    assert.equal(refused, null);
    const offline = await readBySpan('x', '1', '0500-01', new Map([['0500-01', span]]), null, {
      wasm: w, readSpan: async () => { throw new TypeError('Failed to fetch'); }, volumeCaseFiles: async () => [],
    });
    assert.equal(offline, null);
  });

  test('a server that ignores Range sends the zip, which is kept and handed back', async () => {
    const kept = [];
    const got = await readBySpan('x', '1', '0500-01', new Map([['0500-01', span]]), null, {
      wasm: w, readSpan: reader([], { status: 200 }), volumeCaseFiles: async () => [],
      cacheSet: (s, k) => kept.push(`${s}:${k}`),
    });
    assert.deepEqual(got.whole, bytes);
    assert.deepEqual(kept, ['zips:x/1.zip']);
  });

  test('a WASM that won\'t load is thrown, for the loading bar', async () => {
    await assert.rejects(readBySpan('x', '1', '0500-01', new Map([['0500-01', span]]), null, {
      wasm: async () => { throw new Error('no wasm'); }, readSpan: reader([]), volumeCaseFiles: async () => [],
    }), /no wasm/);
  });

  test('spanZip reads the HTML and another case by range, and keeps the HTML', async () => {
    const store = new Map();
    const reads = [];
    const z = spanZip('x', '1', new Map([['0500-01', span], ['0500-02', undefined]]), bytes.length, {
      wasm,
      base: 'v/v1/',
      cacheGet: async (s, k) => store.get(`${s}:${k}`) || null,
      cacheSet: async (s, k, v) => { store.set(`${s}:${k}`, v); },
      zipFileText: async (url, name, deps) => {
        reads.push({ url, name, size: deps.size });
        return name.startsWith('html/') ? '<p>html</p>' : json;
      },
      volumePageOrders: async () => ({ '0500-01': { first: 12, last: 14 } }),
    });
    assert.equal(await z.html('0500-01'), '<p>html</p>');
    assert.deepEqual(reads, [{ url: 'https://data.stare.pub/cap/x/1.zip', name: 'html/0500-01.html', size: bytes.length }]);
    assert.deepEqual([...store.keys()], [`zips:v/v1/span/x/1.zip@500:${span.length}:8#html`]);
    // The second case has no span: it comes out of the zip by range.
    assert.equal((await z.caseData('0500-02')).name, 'Smith v. Jones');
    assert.equal(reads[1].name, 'json/0500-02.json');
    assert.deepEqual(await z.pageOrders('0500-01'), { first: 12, last: 14 });
    assert.equal(await z.pageOrders('0600-01'), null);
  });
});
