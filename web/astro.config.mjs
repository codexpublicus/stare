// @ts-check
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { defineConfig } from 'astro/config';

// Writes /wasm/stare_wasm_bg.json for the loader (public/js/wasm.js): the WASM
// module's byte count, for the progress bar, and the citare data bundle the
// module loads (#117), so the two can't drift apart. The response is
// compressed in transit and its body stream decompressed, so Content-Length
// can't give the size the stream adds up to.
//
// The bundle is the one `stare-site export-citare-data` wrote to
// public/data/citare/v1/ from the same Cargo.lock as the module, gzipped and
// named citare-data-<first 16 hex digits of the uncompressed SHA-256>.bin.gz.
// The JSON gives the .gz's size (`bytes`, what the progress bar counts) and
// the uncompressed size and SHA-256 the loader checks. The build fails if
// the module is there and the bundle isn't, since the module can't detect
// citations without it. Skipped when the module wasn't built.
const BUNDLE_DIR = 'data/citare/v1/';

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
			const data = citareBundle(new URL(BUNDLE_DIR, dir));
			writeFileSync(
				fileURLToPath(new URL('wasm/stare_wasm_bg.json', dir)),
				`${JSON.stringify({ bytes, data })}\n`,
			);
			logger.info(`wasm/stare_wasm_bg.json: ${bytes} bytes, ${data.url} ${data.bytes} bytes (${data.uncompressedBytes} gunzipped)`);
		},
	},
};

function citareBundle(dirUrl) {
	const dir = fileURLToPath(dirUrl);
	const names = existsSync(dir)
		? readdirSync(dir).filter((n) => /^citare-data-[0-9a-f]{16}\.bin\.gz$/.test(n))
		: [];
	if (names.length !== 1) {
		throw new Error(
			`expected one citare data bundle in ${BUNDLE_DIR}, found ${names.length}; ` +
				`run stare-site export-citare-data web/public/${BUNDLE_DIR}`,
		);
	}
	const [name] = names;
	const gz = readFileSync(new URL(name, dirUrl));
	const body = gunzipSync(gz);
	const sha256 = createHash('sha256').update(body).digest('hex');
	if (!name.includes(sha256.slice(0, 16))) {
		throw new Error(`${BUNDLE_DIR}${name}: its bundle's SHA-256 is ${sha256}`);
	}
	return { url: `/${BUNDLE_DIR}${name}`, bytes: gz.length, uncompressedBytes: body.length, sha256 };
}

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
