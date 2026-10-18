// @ts-check
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { defineConfig } from 'astro/config';

import { isAllowed, parseLlmsTxt, parseRobots } from './src/lib/crawlfiles.js';
import { CURATED_PREFIX, FULL_PREFIX, SITE, isShallow, parseSitemap, renderSitemap, sitemapEntries } from './src/lib/sitemap.js';

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

// Writes /sitemap.xml (src/lib/sitemap.js) and checks it, robots.txt and llms.txt
// (codexpublicus/stare#171, #161): the build fails if one is missing or wouldn't
// parse, if robots.txt stops pointing at the sitemap, disallowing the full-corpus
// case prefix or allowing the site's pages, or if the sitemap lists a page
// robots.txt disallows.
const crawlFiles = {
	name: 'stare-crawl-files',
	hooks: {
		'astro:build:done': ({ dir, logger }) => {
			const pagesDir = fileURLToPath(new URL('./src/pages/', import.meta.url));
			const dated = !isShallow(pagesDir);
			if (!dated) logger.warn('shallow clone: sitemap.xml has no lastmod (git can\'t date the pages)');
			const xml = renderSitemap(sitemapEntries(pagesDir, { dated }));
			writeFileSync(fileURLToPath(new URL('sitemap.xml', dir)), xml);
			const urls = parseSitemap(xml);

			const read = (name) => {
				const file = fileURLToPath(new URL(name, dir));
				if (!existsSync(file)) throw new Error(`${name} is missing from the build`);
				return readFileSync(file, 'utf8');
			};
			const robots = parseRobots(read('robots.txt'));
			const all = robots.groups.find((g) => g.agents.includes('*'));
			if (!all) throw new Error('robots.txt has no User-agent: * group');
			if (!robots.sitemaps.includes(`${SITE}/sitemap.xml`)) throw new Error('robots.txt must name the sitemap');
			if (isAllowed(all, `${FULL_PREFIX}a2d/31/647`)) throw new Error(`robots.txt must disallow ${FULL_PREFIX}`);
			if (!isAllowed(all, `${CURATED_PREFIX}a2d/31/647`)) throw new Error(`robots.txt must allow ${CURATED_PREFIX}`);
			for (const { loc } of urls) {
				if (!isAllowed(all, new URL(loc).pathname)) throw new Error(`robots.txt disallows ${loc}, which the sitemap lists`);
			}
			parseLlmsTxt(read('llms.txt'));
			logger.info(`sitemap.xml: ${urls.length} pages${dated ? '' : ', undated'}; robots.txt and llms.txt check out`);
		},
	},
};

// https://astro.build/config
export default defineConfig({
	integrations: [wasmSize, crawlFiles],
	vite: {
		server: {
			// /about imports the repo-root CHANGELOG.md (?raw); let the dev server
			// read one level above web/.
			fs: { allow: ['..'] },
		},
	},
});
