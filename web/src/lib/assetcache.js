// Build steps that let browsers keep the site's static files (#266). They run on the built
// site (dist/) in astro.config.mjs's astro:build:done hook; nothing in public/ changes.
//
// What web/public/_headers marks immutable is only what has a content-addressed URL:
// Astro's /_astro/* (hashed by Vite), /vendor/pdfjs-<version>-p<rev>/, citare's data
// bundle and the WASM files fingerprintWasm() names below. Everything else is revalidated
// on every load (max-age=0, must-revalidate), and the un-hashed modules under /js/ are in
// that class: they import each other by plain name, so a long max-age would let a browser
// mix one deployment's main.js with another's citations.js, and immutable would keep a
// fixed module (#259 renamed two for content blockers) out of browsers for a year.
//
// fingerprintWasm   Copies the WASM module and its wasm-bindgen glue to names carrying
//                   their content hash and points the built /js/wasm.js at them. wasm.js
//                   is revalidated, so a new deployment's loader names the new files.
//                   The un-hashed copies stay, for anything that asks for them by name.
// modulePreloads    Adds <link rel="modulepreload"> to each page's <head> for every
//                   module its scripts import statically, so the revalidations go out
//                   in one parallel wave instead of one level of the import graph at a
//                   time. Dynamic import()s aren't followed: a lazily loaded module
//                   stays lazy.
// casePreloads      Writes the WASM's preloads, by the hashed names fingerprintWasm made,
//                   into index.html's head script (src/lib/caseroute.js), which adds
//                   them on a case link only, so a case's WASM download starts with the
//                   HTML (#262) and the landing keeps loading it late and at low priority.
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { WASM_PRELOADS_MARK } from './caseroute.js';

export const WASM_DIR = 'wasm';
export const WASM_MODULE = 'stare_wasm_bg.wasm';
export const WASM_GLUE = 'stare_wasm.js';
export const WASM_LOADER = 'js/wasm.js';
export const WASM_INFO = 'stare_wasm_bg.json';
export const CASE_PAGE = 'index.html';

// Sixteen hex digits of the SHA-256, as citare's data bundle is named.
export const contentHash = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

// stare_wasm_bg.wasm -> stare_wasm_bg.<hash>.wasm
export const hashedName = (name, hash) => name.replace(/(\.[^.]+)$/, `.${hash}$1`);

/**
 * Copies dist/wasm/'s module and glue to hashed names and rewrites the two URL literals
 * in dist/js/wasm.js to match. Throws unless each literal occurs exactly once, so a
 * change to the loader can't silently leave it on the un-hashed names.
 * Returns { module, glue }: the new site paths.
 */
export function fingerprintWasm(distDir) {
  const loaderPath = join(distDir, WASM_LOADER);
  let loader = readFileSync(loaderPath, 'utf8');
  const urls = {};
  for (const [key, name] of [['module', WASM_MODULE], ['glue', WASM_GLUE]]) {
    const file = join(distDir, WASM_DIR, name);
    const hashed = hashedName(name, contentHash(readFileSync(file)));
    copyFileSync(file, join(distDir, WASM_DIR, hashed));
    const from = `'/${WASM_DIR}/${name}'`;
    const count = loader.split(from).length - 1;
    if (count !== 1) {
      throw new Error(`${WASM_LOADER}: expected the literal ${from} once, found it ${count} times`);
    }
    urls[key] = `/${WASM_DIR}/${hashed}`;
    loader = loader.replace(from, `'${urls[key]}'`);
  }
  writeFileSync(loaderPath, loader);
  return urls;
}

/**
 * The links that start the WASM's load: the module and citare's data bundle as fetch()
 * preloads, the build info naming the bundle likewise, and the glue as a module.
 * `urls` is fingerprintWasm's result; `info` the build info (stare_wasm_bg.json).
 */
export function wasmPreloads(urls, info) {
  const links = [
    { rel: 'preload', as: 'fetch', href: urls.module, crossorigin: true },
    { rel: 'modulepreload', href: urls.glue },
    { rel: 'preload', as: 'fetch', href: `/${WASM_DIR}/${WASM_INFO}`, crossorigin: true },
  ];
  if (typeof info?.data?.url === 'string') {
    links.push({ rel: 'preload', as: 'fetch', href: info.data.url, crossorigin: true });
  }
  return links;
}

/**
 * Writes wasmPreloads into dist/index.html at caseroute.js's WASM_PRELOADS_MARK. Throws
 * unless the mark is there exactly once, so the head script can't silently lose them.
 * Returns the links written.
 */
export function casePreloads(distDir, urls) {
  const page = join(distDir, CASE_PAGE);
  const html = readFileSync(page, 'utf8');
  const count = html.split(WASM_PRELOADS_MARK).length - 1;
  if (count !== 1) {
    throw new Error(`${CASE_PAGE}: expected the mark ${WASM_PRELOADS_MARK} once, found it ${count} times`);
  }
  const info = JSON.parse(readFileSync(join(distDir, WASM_DIR, WASM_INFO), 'utf8'));
  const links = wasmPreloads(urls, info);
  // JSON in a <script>: "<" escaped, so no URL could close the element.
  const json = JSON.stringify(links).replace(/</g, '\\u003c');
  writeFileSync(page, html.replace(WASM_PRELOADS_MARK, () => `/*stare:wasm-preloads*/${json}`));
  return links;
}

function htmlFiles(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.html'))
    .map((e) => join(e.parentPath ?? e.path, e.name));
}

// The /js/ modules a page loads straight away: <script type="module" src="/js/...">, and
// the static imports of its inline module scripts.
export function pageEntries(html) {
  const entries = new Set();
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const [, attrs, body] = m;
    if (!/\btype=["']?module\b/i.test(attrs)) continue;
    const src = attrs.match(/\bsrc=["']?(\/js\/[^"'\s>]+)/i);
    if (src) entries.add(src[1]);
    for (const imp of body.matchAll(/(?:^|[;\s])(?:import|export)\s[^'"]*?from\s*['"](\/js\/[^'"]+)['"]|(?:^|[;\s])import\s*['"](\/js\/[^'"]+)['"]/g)) {
      entries.add(imp[1] ?? imp[2]);
    }
  }
  return [...entries];
}

/**
 * The static import closure of `entries` (site paths under /js/), entries first, in
 * the order the browser would discover them. `build` is esbuild's, which resolves the
 * graph (passed in, as pdfjs-vendor.js's minifier is, so this module loads without
 * node_modules); only import-statement edges are followed.
 */
export async function staticGraph(distDir, entries, { build }) {
  if (entries.length === 0) return [];
  const jsDir = join(distDir, 'js') + sep;
  // esbuild keys its metafile by path relative to absWorkingDir: 'js/main.js'.
  const key = (site) => site.slice(1);
  const result = await build({
    absWorkingDir: distDir,
    entryPoints: entries.map(key),
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    logLevel: 'silent',
    outdir: '.modulepreload',
    plugins: [{
      name: 'site-paths',
      setup(b) {
        b.onResolve({ filter: /.*/ }, (args) => {
          if (args.kind === 'entry-point') return undefined;
          if (args.path.startsWith('/js/')) return { path: join(distDir, args.path) };
          if (args.path.startsWith('./') || args.path.startsWith('../')) {
            const abs = join(dirname(args.importer), args.path);
            if (abs.startsWith(jsDir)) return { path: abs };
          }
          return { path: args.path, external: true };
        });
      },
    }],
  });
  const inputs = result.metafile.inputs;
  const seen = new Set();
  const order = [];
  const queue = [...entries];
  while (queue.length > 0) {
    const site = queue.shift();
    if (seen.has(site)) continue;
    seen.add(site);
    order.push(site);
    const input = inputs[key(site)];
    if (!input) throw new Error(`modulepreload: esbuild didn't read ${site}`);
    for (const imp of input.imports) {
      if (imp.kind === 'import-statement' && !imp.external) queue.push(`/${imp.path}`);
    }
  }
  return order;
}

export const preloadLinks = (paths) => paths.map((p) => `<link rel="modulepreload" href="${p}">`).join('');

/**
 * Adds the modulepreload links to every page under distDir that loads /js/ modules,
 * skipping any the page already has. Returns { pages, modules }: how many pages got
 * links, and the most one page got. `build` is esbuild's, as for staticGraph.
 */
export async function modulePreloads(distDir, { build }) {
  let pages = 0;
  let modules = 0;
  for (const file of htmlFiles(distDir)) {
    const html = readFileSync(file, 'utf8');
    // A page may preload some modules itself; add only the rest.
    const have = new Set([...html.matchAll(/<link\b[^>]*\brel=["']?modulepreload\b[^>]*\bhref=["']?([^"'\s>]+)/gi)].map((m) => m[1]));
    const graph = (await staticGraph(distDir, pageEntries(html), { build })).filter((p) => !have.has(p));
    if (graph.length === 0) continue;
    const at = html.search(/<\/head>/i);
    if (at < 0) throw new Error(`${relative(distDir, file)} has no </head>`);
    writeFileSync(file, html.slice(0, at) + preloadLinks(graph) + html.slice(at));
    pages += 1;
    modules = Math.max(modules, graph.length);
  }
  return { pages, modules };
}
