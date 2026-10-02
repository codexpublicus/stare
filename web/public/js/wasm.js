// The one loader for /wasm/stare_wasm.js (citare citation detection and the
// index, zip and case lookups). Every caller shares one load.
//
// A failed load is cached for the life of the page, not retried: the module
// and the .wasm it fetches are static files of the same deployment, so a
// second attempt a moment later fails the same way, and the case viewer
// would otherwise retry, and log, once per opinion. Reloading the page
// retries.

export class WasmLoadError extends Error {
  constructor(cause) {
    super('The citation parser failed to load. Reload the page to try again.', { cause });
    this.name = 'WasmLoadError';
  }
}

let loading = null;

export function loadWasm() {
  if (!loading) {
    loading = (async () => {
      const mod = await import('/wasm/stare_wasm.js');
      await mod.default();
      return mod;
    })().catch((e) => {
      console.error('stare WASM failed to load:', e);
      throw new WasmLoadError(e);
    });
  }
  return loading;
}
