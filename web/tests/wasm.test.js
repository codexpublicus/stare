import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createWasmLoader, progressFraction, WasmLoadError } from '../public/js/wasm.js';

const MODULE_BYTES = 1000;

// A Response whose body arrives in `chunks` pieces, with optional headers.
function wasmResponse({ chunks = 4, headers = {} } = {}) {
  const size = MODULE_BYTES / chunks;
  let sent = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (sent === chunks) return controller.close();
      sent++;
      controller.enqueue(new Uint8Array(size));
    },
  });
  return new Response(body, { headers: { 'Content-Type': 'application/wasm', ...headers } });
}

// A fake fetch for the module and its size JSON. `wasm` is a list of
// handlers, one per module request (the last repeats): each returns a
// Response or throws.
function fakeFetch({ size = MODULE_BYTES, wasm = [() => wasmResponse()] } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('.json')) {
      if (size == null) return new Response('not found', { status: 404 });
      return Response.json({ bytes: size });
    }
    const n = calls.filter((c) => c.url.endsWith('.wasm')).length;
    return wasm[Math.min(n, wasm.length) - 1]();
  };
  fetch.calls = calls;
  fetch.wasmCalls = () => calls.filter((c) => c.url.endsWith('.wasm'));
  return fetch;
}

function makeLoader(fetch, overrides = {}) {
  const glue = { default: async ({ module_or_path }) => { glue.module = module_or_path; }, detect_citations: () => '[]' };
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
  test('callers share one load and one fetch of the module', async () => {
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
    // The glue is initialized with the compiled module, all of the body read.
    assert.deepEqual(loader.glue.module, { bytes: MODULE_BYTES });
  });

  test('reports progress in uncompressed bytes against the size JSON', async () => {
    // Content-Encoding makes Content-Length the compressed size; the loader
    // must take the total from the size JSON, not the header.
    const fetch = fakeFetch({
      wasm: [() => wasmResponse({ headers: { 'Content-Encoding': 'br', 'Content-Length': '400' } })],
    });
    const loader = makeLoader(fetch);
    const seen = [];
    loader.onProgress((p) => seen.push(p));
    await loader.load();

    assert.deepEqual(seen[0], { state: 'idle', loaded: 0, total: null });
    const loading = seen.filter((p) => p.state === 'loading' && p.total != null);
    assert.deepEqual(loading.map((p) => p.loaded), [0, 250, 500, 750, 1000]);
    assert.ok(loading.every((p) => p.total === MODULE_BYTES));
    assert.deepEqual(loading.map(progressFraction), [0, 0.25, 0.5, 0.75, 1]);
    assert.deepEqual(seen.at(-1), { state: 'ready', loaded: MODULE_BYTES, total: MODULE_BYTES });
    assert.deepEqual(loader.progress(), seen.at(-1));
  });

  test('without the size JSON, uses Content-Length only for an uncompressed response', async () => {
    const plain = makeLoader(fakeFetch({ size: null, wasm: [() => wasmResponse({ headers: { 'Content-Length': '1000' } })] }));
    await plain.load();
    assert.equal(plain.progress().total, 1000);

    const compressed = makeLoader(fakeFetch({
      size: null,
      wasm: [() => wasmResponse({ headers: { 'Content-Encoding': 'gzip', 'Content-Length': '400' } })],
    }));
    const totals = new Set();
    compressed.onProgress((p) => { if (p.state === 'loading') totals.add(p.total); });
    await compressed.load();
    assert.deepEqual([...totals], [null]);
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
