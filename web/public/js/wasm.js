// The one loader for the stare WASM (/wasm/stare_wasm.js and the .wasm it
// wraps: citare citation detection and the index, zip and case lookups) and
// citare's data bundle, which the module is built without (#117).
// Nothing else imports /wasm/; every caller goes through loadWasm().
//
//   loadWasm()          Promise of the initialized module, its citare data
//                       loaded. Every caller shares one load; the first call
//                       starts it.
//   preloadWasm()       Starts the load at low fetch priority once the page has
//                       loaded, painted and gone idle. Pages that may need the
//                       WASM call it at startup; nothing waits on it.
//   onWasmProgress(fn)  Calls fn(progress) now and on every change; returns an
//                       unsubscribe function. progress is { state, loaded,
//                       total }: state is 'idle', 'loading', 'ready' or
//                       'error'; loaded and total are bytes of the module
//                       (uncompressed) and the gzipped bundle together, and
//                       total is null until the build info says the sizes.
//   wasmProgress()      The current progress.
//   retryWasm()         Starts a fresh load after a failure (the progress
//                       bar's Retry button); a no-op otherwise.
//   progressFraction(p) loaded / total in [0, 1], or null when unknown.
//
// The build writes /wasm/stare_wasm_bg.json (web/astro.config.mjs): the
// module's byte count, and the bundle's URL, gzipped size, uncompressed size
// and SHA-256. The bundle is a .gz file served as application/gzip with no
// Content-Encoding, so the browser hands over the gzip bytes and the loader
// gunzips them with DecompressionStream. Its name is the uncompressed
// bundle's hash and it's served immutable, so a repeat visit reads it from
// the browser's cache until reporters-db or courts-db changes. The loader
// fetches the module straight away and the bundle as soon as that JSON names
// it, both at the same priority, checks the bundle's length and SHA-256, and
// hands it to the module's init_data before the load resolves.
//
// A failed load, of either file, that a caller asked for is cached until
// retryWasm(): both are static files of the same deployment, so an automatic
// retry a moment later fails the same way, and the case viewer would
// otherwise retry, and log, once per opinion. A failed preload nobody waited
// on isn't cached, so the first real use tries again.
//
// The module's size: its body stream is decompressed, so Content-Length (the
// compressed size, when there is one) can't measure it.

const GLUE_URL = '/wasm/stare_wasm.js';
const WASM_URL = '/wasm/stare_wasm_bg.wasm';
const INFO_URL = '/wasm/stare_wasm_bg.json';

export class WasmLoadError extends Error {
  constructor(cause) {
    super('The citation parser failed to load.', { cause });
    this.name = 'WasmLoadError';
  }
}

export function progressFraction({ loaded, total }) {
  if (!total || total <= 0) return null;
  return Math.min(1, Math.max(0, loaded / total));
}

// Calls `then` once the page has had its first contentful paint, or after
// `fallback` ms if the browser can't say (no paint timing, or a hidden tab,
// which never paints).
function afterFirstPaint(then, fallback = 5000) {
  let done = false;
  const once = () => {
    if (!done) {
      done = true;
      then();
    }
  };
  const fcp = 'first-contentful-paint';
  if (performance.getEntriesByName(fcp).length) return once();
  if (globalThis.PerformanceObserver?.supportedEntryTypes?.includes('paint')) {
    const observer = new PerformanceObserver((list) => {
      if (list.getEntriesByName(fcp).length) {
        observer.disconnect();
        once();
      }
    });
    observer.observe({ type: 'paint', buffered: true });
  } else {
    // A timeout queued from an animation frame runs after that frame paints.
    requestAnimationFrame(() => setTimeout(once, 0));
  }
  setTimeout(once, fallback);
}

// Runs `run` once the page has loaded and painted, when the browser is next
// idle (or after `timeout` ms without an idle period).
function afterPaintWhenIdle(run, timeout = 3000) {
  const idle = () => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout });
    else setTimeout(run, 200);
  };
  const afterLoad = () => afterFirstPaint(idle);
  if (document.readyState === 'complete') afterLoad();
  else addEventListener('load', afterLoad, { once: true });
}

function positive(n) {
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Reads a gzipped response body, calling onBytes(n) as each compressed chunk
// arrives, and returns the gunzipped bytes.
async function readGunzipped(res, onBytes) {
  const source = res.body ?? new Blob([await res.arrayBuffer()]).stream();
  const counted = source.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      onBytes(chunk.byteLength);
      controller.enqueue(chunk);
    },
  }));
  const body = counted.pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(body).arrayBuffer());
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function compileStreaming(response) {
  if (typeof WebAssembly.compileStreaming === 'function') {
    return WebAssembly.compileStreaming(response);
  }
  return WebAssembly.compile(await response.arrayBuffer());
}

/**
 * A loader with its own state. The page uses the default one below; tests
 * build their own with fakes for `fetch`, `importGlue`, `compile` and
 * `schedule`.
 */
export function createWasmLoader({
  glueUrl = GLUE_URL,
  wasmUrl = WASM_URL,
  infoUrl = INFO_URL,
  fetch: fetchFn = (...args) => fetch(...args),
  importGlue = (url) => import(url),
  compile = compileStreaming,
  schedule = afterPaintWhenIdle,
  logError = (e) => console.error('stare WASM failed to load:', e),
} = {}) {
  let progress = { state: 'idle', loaded: 0, total: null };
  const listeners = new Set();
  let loading = null;
  let demanded = false;
  let preloadScheduled = false;

  function update(changes) {
    progress = { ...progress, ...changes };
    for (const fn of listeners) fn(progress);
  }

  // What the build wrote:
  // { bytes, data: { url, bytes, uncompressedBytes, sha256 } }.
  async function buildInfo() {
    const res = await fetchFn(infoUrl);
    if (!res.ok) throw new Error(`${infoUrl}: HTTP ${res.status}`);
    const info = await res.json();
    const data = info?.data;
    if (typeof data?.url !== 'string' || typeof data.sha256 !== 'string' || !positive(data.uncompressedBytes)) {
      throw new Error(`${infoUrl} names no citare data bundle`);
    }
    return {
      moduleBytes: positive(info.bytes),
      dataUrl: data.url,
      dataBytes: positive(data.bytes),
      dataSize: data.uncompressedBytes,
      dataSha256: data.sha256,
    };
  }

  async function run(priority) {
    update({ state: 'loading', loaded: 0, total: null });
    let moduleLoaded = 0;
    let dataLoaded = 0;
    const counted = () => update({ loaded: moduleLoaded + dataLoaded });

    const glueLoad = importGlue(glueUrl);
    const infoLoad = buildInfo();
    // The bundle starts as soon as the build info names it, alongside the
    // module, and at the same priority.
    const dataLoad = infoLoad.then(async ({ moduleBytes, dataUrl, dataBytes, dataSize, dataSha256 }) => {
      update({ total: moduleBytes && dataBytes ? moduleBytes + dataBytes : null });
      const res = await fetchFn(dataUrl, { priority });
      if (!res.ok) throw new Error(`${dataUrl}: HTTP ${res.status}`);
      const bytes = await readGunzipped(res, (n) => {
        dataLoaded += n;
        counted();
      });
      if (bytes.byteLength !== dataSize) {
        throw new Error(`${dataUrl}: ${bytes.byteLength} bytes gunzipped, expected ${dataSize}`);
      }
      const sha256 = await sha256Hex(bytes);
      if (sha256 !== dataSha256) {
        throw new Error(`${dataUrl}: SHA-256 ${sha256}, expected ${dataSha256}`);
      }
      return bytes;
    });
    // A rejection here is handled where it's awaited; don't let it go
    // unhandled meanwhile.
    glueLoad.catch(() => {});
    dataLoad.catch(() => {});

    const res = await fetchFn(wasmUrl, { priority });
    if (!res.ok) throw new Error(`${wasmUrl}: HTTP ${res.status}`);
    let response = res;
    if (res.body) {
      const body = res.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          moduleLoaded += chunk.byteLength;
          counted();
          controller.enqueue(chunk);
        },
      }));
      response = new Response(body, { headers: { 'Content-Type': 'application/wasm' } });
    }
    const module = await compile(response);
    const glue = await glueLoad;
    await glue.default({ module_or_path: module });
    glue.init_data(await dataLoad);
    update({ state: 'ready', loaded: progress.total ?? progress.loaded });
    return glue;
  }

  function start(priority) {
    loading = run(priority).catch((e) => {
      logError(e);
      update({ state: 'error' });
      // Nobody waited on this load (a preload): the next use tries again.
      if (!demanded) loading = null;
      throw new WasmLoadError(e);
    });
    return loading;
  }

  function load() {
    demanded = true;
    return loading || start('auto');
  }

  function preload() {
    if (preloadScheduled || loading) return;
    preloadScheduled = true;
    schedule(() => {
      if (!loading) start('low').catch(() => {});
    });
  }

  function retry() {
    if (progress.state !== 'error') return loading || load();
    loading = null;
    return load();
  }

  function onProgress(fn) {
    listeners.add(fn);
    fn(progress);
    return () => listeners.delete(fn);
  }

  return { load, preload, retry, onProgress, progress: () => progress };
}

const loader = createWasmLoader();

export const loadWasm = () => loader.load();
export const preloadWasm = () => loader.preload();
export const retryWasm = () => loader.retry();
export const onWasmProgress = (fn) => loader.onProgress(fn);
export const wasmProgress = () => loader.progress();
