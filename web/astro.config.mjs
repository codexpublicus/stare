// @ts-check
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';

// Writes the WASM module's byte count to /wasm/stare_wasm_bg.json, for the
// loader's progress bar (public/js/wasm.js). The response is compressed in
// transit and its body stream decompressed, so Content-Length can't give the
// size the stream adds up to. Skipped when the module wasn't built.
const wasmSize = {
	name: 'stare-wasm-size',
	hooks: {
		'astro:build:done': ({ dir, logger }) => {
			const wasm = fileURLToPath(new URL('wasm/stare_wasm_bg.wasm', dir));
			if (!existsSync(wasm)) {
				logger.warn('no wasm/stare_wasm_bg.wasm; the loading bar will show no percentage');
				return;
			}
			const bytes = statSync(wasm).size;
			writeFileSync(fileURLToPath(new URL('wasm/stare_wasm_bg.json', dir)), `${JSON.stringify({ bytes })}\n`);
			logger.info(`wasm/stare_wasm_bg.json: ${bytes} bytes`);
		},
	},
};

// https://astro.build/config
export default defineConfig({
	integrations: [wasmSize],
	vite: {
		server: {
			// /about imports the repo-root CHANGELOG.md (?raw); let the dev server
			// read one level above web/.
			fs: { allow: ['..'] },
		},
	},
});
