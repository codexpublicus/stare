// The search page's client, vendored and bundled.
//
// src/vendor/stare-search/ holds stare-builder's reference query (search.mjs) and its
// tokenizer (tokenize.mjs), and src/vendor/roaringbuckets-client/ the roaringbuckets JS
// client they read the tree with, each a byte-for-byte copy at the commit
// src/vendor/search-client.json names, with each file's SHA-256. The ranking is that file's
// and nobody else's: the page calls its `openSearch`, `search` and `readRanges` and adds
// only the year-range keys (public/js/searchquery.js). `verifyVendored` fails the build and
// web/tests/searchclient.test.js if a copy has been edited, and the same test runs the
// copies on a fixture tree against what stare-builder's own client returned for it.
//
// To move to a newer stare-builder or roaringbuckets: copy the files in again from that
// commit, update search-client.json's commits and hashes and SEARCH_CLIENT_DIR in
// public/js/searchclient-path.js, and regenerate web/tests/fixtures/search-expected.json
// with that commit's client (web/tests/fixtures/README.md). `mise run search-vendor`
// compares the copies with the pinned commits, and says whether stare-builder's main has
// changed them since.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The pins: search-client.json in `vendorDir`. */
export function readPins(vendorDir) {
  return JSON.parse(readFileSync(join(vendorDir, 'search-client.json'), 'utf8'));
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

/** The output directory's name for the pins: `vendor/stare-search-<7>-rb<7>`. */
export function clientDirName(pins) {
  const short = (c) => c.slice(0, 7);
  return `vendor/stare-search-${short(pins['stare-search'].commit)}-rb${short(pins['roaringbuckets-client'].commit)}`;
}

/**
 * Bundle search.mjs with the roaringbuckets client into one minified ES module at
 * `outFile` (src/lib/searchclient-entry.js: search.mjs's own exports, and decodeRoaring).
 * `build` is esbuild's.
 */
export async function bundleSearchClient({ build, vendorDir, outFile }) {
  const bad = verifyVendored(vendorDir);
  if (bad.length) throw new Error(`the vendored search client was edited:\n  ${bad.join('\n  ')}`);
  const pins = readPins(vendorDir);
  const ss = pins['stare-search'];
  const rb = pins['roaringbuckets-client'];
  mkdirSync(dirname(outFile), { recursive: true });
  await build({
    entryPoints: [join(dirname(vendorDir), 'lib', 'searchclient-entry.js')],
    bundle: true,
    format: 'esm',
    minify: true,
    target: 'es2022',
    outfile: outFile,
    alias: { '@roaringbuckets/client': join(vendorDir, 'roaringbuckets-client', 'index.js') },
    legalComments: 'none',
    banner: {
      js: `/* stare.pub's search client: ${ss.repo} ${ss.commit} ${ss.path}/search.mjs and tokenize.mjs, `
        + `with ${rb.repo} ${rb.tag} (${rb.commit}) ${rb.path} (PolyForm Shield 1.0.0) */`,
    },
    logLevel: 'warning',
  });
}
