import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  hasVolume, isVolumeKey, loadManifest, normalizeManifest, volumeCandidates,
} from '../public/js/manifest.js';

// a3d 138 as stare-admin build-manifest writes it: CAP split it over two folders whose
// page ranges overlap, so a range only rules a part out. tca 1's halves don't overlap.
const FORMAT_2 = {
  format: 2,
  volumes: 5,
  entries: 1000,
  reporters: { a3d: ['9', '138', '138-2'], tca: ['1', '1-2'], ga: ['33-suppl'] },
  parts: {
    a3d: {
      138: [
        { volume: '138', first_page: 8, last_page: 1221 },
        { volume: '138-2', first_page: 2, last_page: 1263 },
      ],
    },
    tca: {
      1: [
        { volume: '1', first_page: 1, last_page: 874 },
        { volume: '1-2', first_page: 880, last_page: 1480 },
      ],
    },
  },
};

describe('isVolumeKey', () => {
  test('accepts CAP folder names and nothing that could leave a path', () => {
    for (const ok of ['1', '138', '138-2', '33-suppl', '81-12']) assert.ok(isVolumeKey(ok), ok);
    for (const bad of ['', '-2', 'a3d', '138/2', '../1', '138-', '13A', 138]) {
      assert.ok(!isVolumeKey(bad), String(bad));
    }
  });
});

describe('normalizeManifest', () => {
  test('reads the legacy integer map', () => {
    const m = normalizeManifest({ a2d: [2, 31], us: [3] });
    assert.equal(m.legacy, true);
    assert.deepEqual(m.reporters.a2d, ['2', '31']);
    assert.ok(hasVolume(m, 'a2d', 31));
    assert.ok(hasVolume(m, 'a2d', '31'));
    assert.ok(!hasVolume(m, 'a2d', 32));
  });

  test('reads format 2, split folders included', () => {
    const m = normalizeManifest(FORMAT_2);
    assert.equal(m.legacy, false);
    assert.ok(hasVolume(m, 'a3d', '138-2'));
    assert.ok(hasVolume(m, 'a3d', 138));
    assert.ok(hasVolume(m, 'ga', '33-suppl'));
    // The top-level counts aren't reporters.
    assert.ok(!hasVolume(m, 'format', '2'));
  });

  test('drops anything that is not a volume folder name', () => {
    const m = normalizeManifest({ a2d: [31, '../x', null] });
    assert.deepEqual(m.reporters.a2d, ['31']);
  });

  test('reads garbage as an empty legacy manifest', () => {
    for (const raw of [null, 'x', [], { format: 2 }]) {
      const m = normalizeManifest(raw);
      assert.deepEqual(m.reporters, {});
    }
  });
});

describe('volumeCandidates', () => {
  const m = normalizeManifest(FORMAT_2);

  test('an unsplit volume is itself', () => {
    assert.deepEqual(volumeCandidates(m, 'a3d', '9', 100), ['9']);
  });

  test('overlapping parts are both tried, in folder order', () => {
    assert.deepEqual(volumeCandidates(m, 'a3d', '138', 1012), ['138', '138-2']);
    assert.deepEqual(volumeCandidates(m, 'a3d', 138, 2), ['138-2']);
    assert.deepEqual(volumeCandidates(m, 'a3d', '138', 5000), []);
  });

  test('disjoint parts pick by page range', () => {
    assert.deepEqual(volumeCandidates(m, 'tca', '1', 900), ['1-2']);
    assert.deepEqual(volumeCandidates(m, 'tca', '1', 12), ['1']);
  });

  test('a folder name is itself', () => {
    assert.deepEqual(volumeCandidates(m, 'a3d', '138-2', 1012), ['138-2']);
  });

  test('the legacy manifest guesses a second part', () => {
    const legacy = normalizeManifest({ a3d: [138] });
    assert.deepEqual(volumeCandidates(legacy, 'a3d', '138', 1012), ['138', '138-2']);
    assert.deepEqual(volumeCandidates(legacy, 'a3d', '138-2', 1012), ['138-2']);
  });
});

test('loadManifest fetches once and survives a failed fetch', async () => {
  let calls = 0;
  const failing = async () => {
    calls += 1;
    throw new Error('offline');
  };
  const m = await loadManifest(failing);
  assert.deepEqual(m.reporters, {});
  await loadManifest(failing);
  assert.equal(calls, 1);
});
