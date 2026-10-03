// A citation into the second CAP folder of a split volume (#94 with #97's
// link-outs): 138 A.3d 1012 (Brooks v. Powers) is only in a3d/138-2, so the
// page check has to try that part, or the sidebar and /check would call it a
// held-volume miss. Uses a3d 138's two real .bin files from idx.stare.pub.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { checkAvailability, checkCitation, checkPage, heldVolumeMiss } from '../public/js/citations.js';
import { normalizeManifest } from '../public/js/manifest.js';

const FIXTURES = new URL('../../crates/stare/tests/fixtures/', import.meta.url);
const BINS = {
  138: readFileSync(new URL('a3d-138.bin', FIXTURES)),
  '138-2': readFileSync(new URL('a3d-138-2.bin', FIXTURES)),
};

// stare::index::lookup in JS: 8 bytes per page, all zeros for no case.
function lookup(bin, page) {
  const entry = bin.subarray(page * 8, page * 8 + 8);
  if (entry.length < 8 || entry.every((b) => b === 0)) return null;
  return Buffer.from(entry).toString('utf8').replace(/\0+$/, '');
}

const readBin = async (slug, volume) => (slug === 'a3d' ? BINS[volume] ?? null : null);

const FORMAT_2 = normalizeManifest({
  format: 2,
  reporters: { a3d: ['138', '138-2'] },
  parts: {
    a3d: {
      138: [
        { volume: '138', first_page: 8, last_page: 1221 },
        { volume: '138-2', first_page: 2, last_page: 1263 },
      ],
    },
  },
});
const LEGACY = normalizeManifest({ a3d: [138] });

const cite = {
  raw: '138 A.3d 1012', type: 'FullCaseCitation', harvard_slug: 'a3d', volume: 138, page: '1012',
  reporter: 'A.3d', externalUrl: null, caseLinks: [],
};

for (const [name, manifest] of [['format 2', FORMAT_2], ['legacy', LEGACY]]) {
  describe(`a page in part 2 of a split volume, ${name} manifest`, () => {
    const deps = { manifest, readBin, lookup };
    const check = (slug, volume) => checkAvailability(slug, volume, manifest);
    const pageCheck = (slug, volume, page) => checkPage(slug, volume, page, deps);

    test('the page is found in 138-2', async () => {
      assert.equal(await pageCheck('a3d', 138, '1012'), true);
      // Page 8 is in the first part; no page 5000 anywhere.
      assert.equal(await pageCheck('a3d', 138, '8'), true);
      assert.equal(await pageCheck('a3d', 138, '5000'), false);
    });

    test('resolves, and is not a held-volume miss', async () => {
      const c = await checkCitation(cite, check, pageCheck);
      assert.equal(c.volumeHeld, true);
      assert.equal(c.resolvable, true);
      assert.equal(heldVolumeMiss(c), null);
    });

    test('a page in neither part is still a held-volume miss', async () => {
      const c = await checkCitation({ ...cite, raw: '138 A.3d 1013', page: '1013' }, check, pageCheck);
      assert.equal(c.resolvable, false);
      assert.equal(heldVolumeMiss(c), 'No case found at this page in A.3d vol. 138');
    });
  });
}

test('a volume held only as split parts counts as held', async () => {
  const m = normalizeManifest({
    format: 2,
    reporters: { x: ['5-2'] },
    parts: { x: { 5: [{ volume: '5-2', first_page: 1, last_page: 9 }] } },
  });
  assert.equal(await checkAvailability('x', 5, m), true);
  assert.equal(await checkAvailability('x', 6, m), false);
});
