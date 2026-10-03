// The one loader for the stare WASM (/wasm/stare_wasm.js and the .wasm it
// wraps: citare citation detection and the index, zip and case lookups).
// Nothing else imports /wasm/; every caller goes through loadWasm().
//
//   loadWasm()          Promise of the initialized module. Every caller shares
//                       one load; the first call starts it.
//   preloadWasm()       Starts the load at low fetch priority once the page has
//                       loaded, painted and gone idle. Pages that may need the
//                       WASM call it at startup; nothing waits on it.
//   onWasmProgress(fn)  Calls fn(progress) now and on every change; returns an
//                       unsubscribe function. progress is { state, loaded,
//                       total }: state is 'idle', 'loading', 'ready' or
//                       'error'; loaded and total are uncompressed bytes, and
//                       total is null when the size is unknown.
//   wasmProgress()      The current progress.
//   retryWasm()         Starts a fresh load after a failure (the progress
//                       bar's Retry button); a no-op otherwise.
//   progressFraction(p) loaded / total in [0, 1], or null when unknown.
//
// A failed load that a caller asked for is cached until retryWasm(): the
// module is a static file of the same deployment, so an automatic retry a
// moment later fails the same way, and the case viewer would otherwise
// retry, and log, once per opinion. A failed preload nobody waited on isn't
// cached, so the first real use tries again.
//
// The size: the body stream is decompressed, so Content-Length (the
// compressed size, when there is one) can't measure it. The build writes the
// module's byte count to /wasm/stare_wasm_bg.json (web/astro.config.mjs).

const GLUE_URL = '/wasm/stare_wasm.js';
const WASM_URL = '/wasm/stare_wasm_bg.wasm';
const SIZE_URL = '/wasm/stare_wasm_bg.json';

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
  sizeUrl = SIZE_URL,
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

  async function expectedSize() {
    try {
      const res = await fetchFn(sizeUrl);
      if (!res.ok) return null;
      const { bytes } = await res.json();
      return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
    } catch {
      return null;
    }
  }

  async function run(priority) {
    update({ state: 'loading', loaded: 0, total: null });
    const sizeLoad = expectedSize();
    const glueLoad = importGlue(glueUrl);
    // A rejection here is handled where it's awaited; don't let it go
    // unhandled meanwhile.
    glueLoad.catch(() => {});

    const res = await fetchFn(wasmUrl, { priority });
    if (!res.ok) throw new Error(`${wasmUrl}: HTTP ${res.status}`);
    let total = await sizeLoad;
    if (total == null && !res.headers.get('Content-Encoding')) {
      total = Number(res.headers.get('Content-Length')) || null;
    }
    update({ total });

    let response = res;
    if (res.body) {
      let loaded = 0;
      const counted = res.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          loaded += chunk.byteLength;
          update({ loaded });
          controller.enqueue(chunk);
        },
      }));
      response = new Response(counted, { headers: { 'Content-Type': 'application/wasm' } });
    }
    const module = await compile(response);
    const glue = await glueLoad;
    await glue.default({ module_or_path: module });
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
