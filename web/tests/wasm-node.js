// The stare WASM in Node, for tests: the module `mise run build-wasm` (or CI's
// "Build stare-wasm" step, which runs before the JS tests) writes to
// web/public/wasm. The site loads it through wasm.js, from '/wasm/', which
// Node can't fetch; tests hand these functions to the code under test instead.
// Nothing here loads citare's data bundle, so detect_citations isn't usable.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const glueUrl = new URL('../public/wasm/stare_wasm.js', import.meta.url);
const wasmUrl = new URL('../public/wasm/stare_wasm_bg.wasm', import.meta.url);

if (!existsSync(fileURLToPath(wasmUrl))) {
  throw new Error(`${fileURLToPath(wasmUrl)} is missing: run \`mise run build-wasm\` before the JS tests`);
}

export const wasm = await import(glueUrl.href);
wasm.initSync({ module: readFileSync(wasmUrl) });

/** reconcileParallels (web/public/js/citations.js) on this module. */
export async function reconcile(printings) {
  return JSON.parse(wasm.reconcile_parallels(JSON.stringify(printings)));
}
