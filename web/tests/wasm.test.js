import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import { createWasmLoader, progressFraction, WasmLoadError } from '../public/js/wasm.js';

const MODULE_BYTES = 1000;
// The bundle: 100 bytes of 1, then 100 of 2, served gzipped.
const DATA_BYTES = 200;
const DATA = new Uint8Array(DATA_BYTES).fill(1, 0, 100).fill(2, 100);
const DATA_SHA256 = createHash('sha256').update(DATA).digest('hex');
const GZ = new Uint8Array(gzipSync(DATA, { level: 9 }));
const DATA_URL = `/data/citare/v1/citare-data-${DATA_SHA256.slice(0, 16)}.bin.gz`;

// A Response of `bytes` bytes whose body arrives in `chunks` pieces, with
// optional headers. `gate`, when given, is awaited before each piece.
function bodyResponse({ bytes, chunks = 4, headers = {}, gate }) {
  const size = bytes / chunks;
  let sent = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (gate) await gate();
      if (sent === chunks) return controller.close();
      sent++;
      controller.enqueue(new Uint8Array(size).fill(sent));
    },
  });
  return new Response(body, { headers });
}

const wasmResponse = ({ chunks = 4, headers = {}, gate } = {}) =>
  bodyResponse({ bytes: MODULE_BYTES, chunks, gate, headers: { 'Content-Type': 'application/wasm', ...headers } });
// The gzipped bundle `gz` as a Response in two pieces, as served: gzip
// bytes, application/gzip, no Content-Encoding.
function dataResponse({ gz = GZ } = {}) {
  const half = Math.floor(gz.byteLength / 2);
  const pieces = [gz.slice(0, half), gz.slice(half)];
  const body = new ReadableStream({
    pull(controller) {
      if (!pieces.length) return controller.close();
      controller.enqueue(pieces.shift());
    },
  });
  return new Response(body, { headers: { 'Content-Type': 'application/gzip' } });
}

// A fake fetch for the module, the bundle and the build info JSON. `wasm`
// and `data` are lists of handlers, one per request (the last repeats):
// each returns a Response or throws. `info` is the JSON's body, or null for
// a 404.
function fakeFetch({
  info = {
    bytes: MODULE_BYTES,
    data: { url: DATA_URL, bytes: GZ.byteLength, uncompressedBytes: DATA_BYTES, sha256: DATA_SHA256 },
  },
  wasm = [() => wasmResponse()],
  data = [() => dataResponse()],
} = {}) {
  const calls = [];
  const nth = (handlers, ext) => handlers[Math.min(calls.filter((c) => c.url.endsWith(ext)).length, handlers.length) - 1];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('.json')) {
      if (info == null) return new Response('not found', { status: 404 });
      return Response.json(info);
    }
    if (url.endsWith('.gz')) return nth(data, '.gz')();
    return nth(wasm, '.wasm')();
  };
  fetch.calls = calls;
  fetch.wasmCalls = () => calls.filter((c) => c.url.endsWith('.wasm'));
  fetch.dataCalls = () => calls.filter((c) => c.url.endsWith('.gz'));
  return fetch;
}

function makeLoader(fetch, overrides = {}) {
  const glue = {
    default: async ({ module_or_path }) => { glue.module = module_or_path; },
    init_data: (bytes) => {
      if (!glue.module) throw new Error('init_data before the module');
      glue.data = bytes;
    },
    detect_citations: () => '[]',
  };
  const errors = [];
  const loader = createWasmLoader({
    fetch,
    importGlue: async () => glue,
    // Reads the whole (counted) body, as compileStreaming would.
    compile: async (response) => ({ bytes: (await response.arrayBuffer()).byteLength }),
    schedule: (run) => { loader.scheduled = run; },
    logError: (e) => errors.push(e),
    ...overrides,
  });
  loader.glue = glue;
  loader.errors = errors;
  return loader;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('progressFraction', () => {
  test('is loaded over total, clamped to [0, 1]', () => {
    assert.equal(progressFraction({ loaded: 250, total: 1000 }), 0.25);
    assert.equal(progressFraction({ loaded: 0, total: 1000 }), 0);
    assert.equal(progressFraction({ loaded: 1200, total: 1000 }), 1);
  });

  test('is null when the total is unknown', () => {
    assert.equal(progressFraction({ loaded: 250, total: null }), null);
    assert.equal(progressFraction({ loaded: 250, total: 0 }), null);
  });
});

describe('createWasmLoader', () => {
  test('callers share one load and one fetch of each file', async () => {
    const fetch = fakeFetch();
    const loader = makeLoader(fetch);
    const a = loader.load();
    const b = loader.load();
    assert.equal(a, b);
    const [ma, mb] = await Promise.all([a, b]);
    assert.equal(ma, loader.glue);
    assert.equal(mb, loader.glue);
    assert.equal(await loader.load(), loader.glue);
    assert.equal(fetch.wasmCalls().length, 1);
    assert.equal(fetch.dataCalls().length, 1);
    // The glue is initialized with the compiled module, all of the body read.
    assert.deepEqual(loader.glue.module, { bytes: MODULE_BYTES });
  });

  test('fetches the bundle alongside the module and loads it before resolving', async () => {
    // The module's body waits until the bundle has been requested.
    let release;
    const released = new Promise((r) => { release = r; });
    const fetch = fakeFetch({ wasm: [() => wasmResponse({ gate: () => released })] });
    const loader = makeLoader(fetch);
    let resolved = false;
    const loading = loader.load().then((m) => { resolved = true; return m; });
    await tick();
    await tick();
    assert.equal(fetch.wasmCalls().length, 1);
    assert.deepEqual(fetch.dataCalls().map((c) => c.url), [DATA_URL]);
    assert.equal(fetch.dataCalls()[0].init.priority, fetch.wasmCalls()[0].init.priority);
    assert.equal(resolved, false);
    release();

    assert.equal(await loading, loader.glue);
    assert.ok(loader.glue.data instanceof Uint8Array);
    // Gunzipped, whole and in order.
    assert.deepEqual(loader.glue.data, DATA);
  });

  test('reports progress in module bytes plus gzipped bundle bytes against the build info', async () => {
    // Content-Encoding makes Content-Length the compressed size; the loader
    // must take the total from the build info, not the header.
    let releaseWasm;
    const wasmGate = new Promise((r) => { releaseWasm = r; });
    const fetch = fakeFetch({
      wasm: [() => wasmResponse({ gate: () => wasmGate, headers: { 'Content-Encoding': 'br', 'Content-Length': '400' } })],
    });
    const loader = makeLoader(fetch);
    const seen = [];
    loader.onProgress((p) => seen.push(p));
    const loading = loader.load();
    // The bundle arrives first, then the module.
    for (let i = 0; i < 10; i++) await tick();
    releaseWasm();
    await loading;

    const gz = GZ.byteLength;
    const total = MODULE_BYTES + gz;
    assert.deepEqual(seen[0], { state: 'idle', loaded: 0, total: null });
    const steps = seen.filter((p) => p.state === 'loading' && p.total != null);
    assert.ok(steps.every((p) => p.total === total));
    assert.deepEqual(steps.map((p) => p.loaded), [0, Math.floor(gz / 2), gz, gz + 250, gz + 500, gz + 750, gz + 1000]);
    assert.deepEqual(steps.map(progressFraction).at(-1), 1);
    assert.deepEqual(seen.at(-1), { state: 'ready', loaded: total, total });
    assert.deepEqual(loader.progress(), seen.at(-1));
  });

  test('without the build info, the load fails: it names the bundle', async () => {
    const loader = makeLoader(fakeFetch({ info: null }));
    const e = await loader.load().catch((err) => err);
    assert.ok(e instanceof WasmLoadError);
    assert.match(e.cause.message, /stare_wasm_bg\.json: HTTP 404/);

    const noData = makeLoader(fakeFetch({ info: { bytes: MODULE_BYTES } }));
    const e2 = await noData.load().catch((err) => err);
    assert.match(e2.cause.message, /names no citare data bundle/);

    // Without the uncompressed size and hash the loader can't check it.
    const unchecked = makeLoader(fakeFetch({ info: { bytes: MODULE_BYTES, data: { url: DATA_URL, bytes: GZ.byteLength } } }));
    const e3 = await unchecked.load().catch((err) => err);
    assert.match(e3.cause.message, /names no citare data bundle/);
  });

  test('a failed bundle fetch fails the load, and a retry fetches both again', async () => {
    const fetch = fakeFetch({
      data: [
        () => new Response('gone', { status: 503 }),
        () => dataResponse(),
      ],
    });
    const loader = makeLoader(fetch);
    const first = await loader.load().catch((e) => e);
    assert.ok(first instanceof WasmLoadError);
    assert.equal(first.cause.message, `${DATA_URL}: HTTP 503`);
    assert.equal(loader.progress().state, 'error');
    assert.equal(loader.glue.data, undefined);
    // Cached until retried.
    assert.equal(await loader.load().catch((e) => e), first);
    assert.equal(fetch.dataCalls().length, 1);
    assert.equal(loader.errors.length, 1);

    assert.equal(await loader.retry(), loader.glue);
    assert.equal(fetch.dataCalls().length, 2);
    assert.equal(fetch.wasmCalls().length, 2);
    assert.deepEqual(loader.glue.data, DATA);
    assert.equal(loader.progress().state, 'ready');
  });

  test('a short, altered, non-gzip or rejected bundle fails the load', async () => {
    const short = makeLoader(fakeFetch({ data: [() => dataResponse({ gz: gzipSync(DATA.slice(0, 100)) })] }));
    const e = await short.load().catch((err) => err);
    assert.ok(e instanceof WasmLoadError);
    assert.match(e.cause.message, /100 bytes gunzipped, expected 200/);

    const altered = makeLoader(fakeFetch({ data: [() => dataResponse({ gz: gzipSync(new Uint8Array(DATA_BYTES)) })] }));
    const e1 = await altered.load().catch((err) => err);
    assert.match(e1.cause.message, new RegExp(`SHA-256 [0-9a-f]{64}, expected ${DATA_SHA256}`));

    const plain = makeLoader(fakeFetch({ data: [() => dataResponse({ gz: DATA })] }));
    const e3 = await plain.load().catch((err) => err);
    assert.ok(e3 instanceof WasmLoadError);
    assert.equal(plain.glue.data, undefined);

    const rejected = makeLoader(fakeFetch());
    rejected.glue.init_data = () => { throw new Error('not a citare data bundle'); };
    const e2 = await rejected.load().catch((err) => err);
    assert.ok(e2 instanceof WasmLoadError);
    assert.equal(e2.cause.message, 'not a citare data bundle');
  });

  test('a failed load rejects every caller with one WasmLoadError until retried', async () => {
    const fetch = fakeFetch({
      wasm: [
        () => { throw new TypeError('network down'); },
        () => wasmResponse(),
      ],
    });
    const loader = makeLoader(fetch);
    const states = [];
    loader.onProgress((p) => states.push(p.state));

    const first = await loader.load().catch((e) => e);
    assert.ok(first instanceof WasmLoadError);
    assert.equal(first.cause.message, 'network down');
    // Cached: no second fetch, no second log.
    assert.equal(await loader.load().catch((e) => e), first);
    assert.equal(fetch.wasmCalls().length, 1);
    assert.equal(loader.errors.length, 1);
    assert.equal(loader.progress().state, 'error');

    assert.equal(await loader.retry(), loader.glue);
    assert.equal(fetch.wasmCalls().length, 2);
    assert.equal(loader.progress().state, 'ready');
    assert.deepEqual(states.filter((s, i) => s !== states[i - 1]), ['idle', 'loading', 'error', 'loading', 'ready']);
  });

  test('an HTTP error is a failed load', async () => {
    const loader = makeLoader(fakeFetch({ wasm: [() => new Response('gone', { status: 404 })] }));
    await assert.rejects(loader.load(), WasmLoadError);
  });

  test('retry does nothing while a load is going or done', async () => {
    const fetch = fakeFetch();
    const loader = makeLoader(fetch);
    const loading = loader.load();
    assert.equal(loader.retry(), loading);
    await loading;
    await loader.retry();
    assert.equal(fetch.wasmCalls().length, 1);
  });

  test('preload waits for the scheduled moment and fetches at low priority', async () => {
    const fetch = fakeFetch();
    const loader = makeLoader(fetch);
    loader.preload();
    loader.preload();
    assert.equal(fetch.calls.length, 0, 'nothing is fetched before the page has painted');
    assert.equal(typeof loader.scheduled, 'function');

    loader.scheduled();
    const module = await loader.load();
    assert.equal(module, loader.glue);
    assert.equal(fetch.wasmCalls().length, 1);
    assert.equal(fetch.wasmCalls()[0].init.priority, 'low');
    assert.equal(fetch.dataCalls()[0].init.priority, 'low');
    assert.deepEqual(loader.glue.data, DATA);
  });

  test('a load asked for before the preload runs takes its place', async () => {
    const fetch = fakeFetch();
    const loader = makeLoader(fetch);
    loader.preload();
    await loader.load();
    loader.scheduled();
    assert.equal(fetch.wasmCalls().length, 1);
    assert.equal(fetch.wasmCalls()[0].init.priority, 'auto');
  });

  test('a failed preload nobody waited on is tried again on first use', async () => {
    const fetch = fakeFetch({
      wasm: [
        () => { throw new TypeError('flaky'); },
        () => wasmResponse(),
      ],
    });
    const loader = makeLoader(fetch);
    loader.preload();
    loader.scheduled();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(loader.progress().state, 'error');

    assert.equal(await loader.load(), loader.glue);
    assert.equal(fetch.wasmCalls().length, 2);
  });

  test('a caller joining a preload that then fails gets the failure, cached', async () => {
    let fail;
    const fetch = fakeFetch({ wasm: [() => new Promise((_, reject) => { fail = reject; })] });
    const loader = makeLoader(fetch);
    loader.preload();
    loader.scheduled();
    const joined = loader.load();
    await new Promise((r) => setTimeout(r, 0));
    fail(new TypeError('down'));
    await assert.rejects(joined, WasmLoadError);
    await assert.rejects(loader.load(), WasmLoadError);
    assert.equal(fetch.wasmCalls().length, 1);
  });
});
