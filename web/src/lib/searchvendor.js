// The search page's clients, vendored and bundled.
//
// The index builder's reference query (search.mjs) and its tokenizer (tokenize.mjs) read one
// search format each: src/vendor/stare-search/ holds the copy for format 3 and
// src/vendor/stare-search-format2/ the one for format 2, which the live tree is in until a
// format-3 tree is published. src/vendor/roaringbuckets-client/ holds the RoaringBuckets JS
// client both read the tree with. Each is a byte-for-byte copy at the commit
// src/vendor/search-client.json names, with each file's SHA-256 and, for a stare-search
// copy, the `format_version` it reads. The ranking is those files' and nobody else's: the
// page reads the tree's manifest, loads the client for its format, calls its `openSearch`,
// `search` and `readRanges`, and adds nothing to them. `verifyVendored` fails the build and
// web/tests/searchclient.test.js if a copy has been edited, and the same test runs each copy
// on a fixture tree of its format against what the index builder's own client returned for it.
//
// To move to a newer index builder or RoaringBuckets commit: copy the files in again from that
// commit, update search-client.json's commits and hashes and SEARCH_CLIENT_DIRS in
// public/js/searchclient-path.js, and regenerate the fixtures' expected results with that
// commit's client (web/tests/fixtures/README.md). A new format gets a directory and a pin
// of its own; a format no tree is in any more loses both. `mise run search-vendor` compares
// the copies with the pinned commits, and says whether the index builder's main has changed the
// client since the newest pin.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The pins: search-client.json in `vendorDir`. */
export function readPins(vendorDir) {
  return JSON.parse(readFileSync(join(vendorDir, 'search-client.json'), 'utf8'));
}

/** The stare-search pins, as [directory, pin] pairs, each pin with its `format_version`. */
export function clientPins(pins) {
  return Object.entries(pins).filter(([, pin]) => pin.format_version !== undefined);
}

/** Each vendored file whose SHA-256 isn't the pinned one, as `dir/file: why`. */
export function verifyVendored(vendorDir) {
  const pins = readPins(vendorDir);
  const bad = [];
  for (const [dir, pin] of Object.entries(pins)) {
    for (const [file, sha256] of Object.entries(pin.files)) {
      let got;
      try {
        got = createHash('sha256').update(readFileSync(join(vendorDir, dir, file))).digest('hex');
      } catch {
        bad.push(`${dir}/${file}: missing`);
        continue;
      }
      if (got !== sha256) bad.push(`${dir}/${file}: SHA-256 ${got}, pinned ${sha256}`);
    }
  }
  return bad;
}

/**
 * The output directory's name for each format's client, `{ 3: 'vendor/stare-search-<7>-rb<7>' }`:
 * the index builder commit of that format's copy and the RoaringBuckets client commit.
 */
export function clientDirNames(pins) {
  const short = (c) => c.slice(0, 7);
  const rb = short(pins['roaringbuckets-client'].commit);
  return Object.fromEntries(clientPins(pins).map(([, pin]) => [pin.format_version, `vendor/stare-search-${short(pin.commit)}-rb${rb}`]));
}

/**
 * Bundle one format's search.mjs with the RoaringBuckets client into one minified ES module
 * at `outFiles[format_version]`, for each stare-search pin: search.mjs's own exports,
 * unchanged. `build` is esbuild's.
 */
export async function bundleSearchClients({ build, vendorDir, outFiles }) {
  const bad = verifyVendored(vendorDir);
  if (bad.length) throw new Error(`the vendored search client was edited:\n  ${bad.join('\n  ')}`);
  const pins = readPins(vendorDir);
  const rb = pins['roaringbuckets-client'];
  for (const [dir, ss] of clientPins(pins)) {
    const outFile = outFiles[ss.format_version];
    if (!outFile) throw new Error(`no output file for search format ${ss.format_version} (${dir})`);
    mkdirSync(dirname(outFile), { recursive: true });
    await build({
      stdin: { contents: "export * from './search.mjs';", resolveDir: join(vendorDir, dir), sourcefile: `${dir}/entry.js`, loader: 'js' },
      bundle: true,
      format: 'esm',
      minify: true,
      target: 'es2022',
      outfile: outFile,
      alias: { '@roaringbuckets/client': join(vendorDir, 'roaringbuckets-client', 'index.js') },
      legalComments: 'none',
      banner: {
        js: `/* stare.pub's search client for search format ${ss.format_version}: ${ss.source} ${ss.commit} ${ss.path}/search.mjs and tokenize.mjs, `
          + `with ${rb.source}${rb.tag ? ` ${rb.tag}` : ''} ${rb.commit} ${rb.path} (PolyForm Shield 1.0.0) */`,
      },
      logLevel: 'warning',
    });
  }
}
