// The unified per-volume index (docs/plans/courtlistener-mirror.md, "Index"): its paths,
// the manifest's `idx`, following a split volume's `#parts` header, CAP first, and the
// page check reading it instead of the .bin files. `lookup` below is the WASM's
// lookup_idx in JS, on plain text (the WASM reads gzip or plain).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkAvailability, checkCitation, checkPage, caseLookupLinks, heldVolumeMiss,
} from '../public/js/citations.js';
import { idxEntries } from '../public/js/idx.js';
import { hasIdx, holdsVolume, normalizeManifest } from '../public/js/manifest.js';
import { idxPath } from '../public/js/sources.js';

const H1 = '0f3a9c2e7b1d4a65';
const H2 = 'a1b2c3d4e5f60718';

// a3d 213 is CAP's, with a CourtListener alias at page 5; 250 only CourtListener's;
// 300 is split, with pages from 900 in part 1.
const MANIFEST = normalizeManifest({
  format: 2,
  idx: 1,
  base: 'v/v2026.10.12/',
  reporters: { a3d: ['213', '250', '300'], 'ny-slip-op': ['2019'] },
  cl: { export: '2026-09-30', reporters: { a3d: ['999'] } },
});
const FILES = {
  'a3d/213/0': `5,cap,0005-01\n5,cl,7/${H1}\n9,cap,0009-01\n`,
  'a3d/250/0': `100,cl,9876543/${H1}\n100,cl,9876544/${H2}\nbad line\n112,cl,9876601/${H1}\n`,
  'a3d/300/0': '#parts,900\n1,cap,0001-01\n',
  'a3d/300/1': '900,cap,0900-01\n901,cl,5/' + H1 + '\n',
};

const pageKey = (p) => (/^\d+$/.test(String(p)) ? Number(p) : String(p).toLowerCase());

function lookup(bytes, page) {
  const text = Buffer.from(bytes).toString('utf8');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const want = pageKey(page);
  let parts = [];
  if (lines[0]?.startsWith('#parts,')) parts = lines.shift().slice(7).split(',').map(pageKey);
  const entries = lines
    .map((l) => l.split(','))
    .filter((f) => f.length === 3 && pageKey(f[0]) === want)
    .map(([p, source, ref]) => {
      if (source === 'cap') {
        const [folder, file] = ref.includes('/') ? ref.split('/') : [undefined, ref];
        return { page: p, source, ref, ...(folder ? { folder } : {}), case_file: file };
      }
      const [id, hash] = ref.split('/');
      return { page: p, source, ref, cluster_id: Number(id), hash };
    })
    .sort((a, b) => (a.source === b.source ? 0 : a.source === 'cap' ? -1 : 1));
  const part = parts.filter((p) => (typeof p === typeof want ? p <= want : typeof p === 'number')).length;
  return { part, entries };
}

function deps(log = []) {
  return {
    manifest: MANIFEST,
    readBin: async (slug, volume) => { log.push(`bin ${slug}/${volume}`); return null; },
    lookup: () => null,
    idxEntries: (slug, volume, page) => idxEntries(slug, volume, page, {
      readIdx: async (s, v, part) => {
        log.push(`idx ${s}/${v}.${part}`);
        const text = FILES[`${s}/${v}/${part}`];
        return text == null ? null : new TextEncoder().encode(text);
      },
      lookup,
    }),
  };
}

const cite = (volume, page) => ({
  raw: `${volume} A.3d ${page}`, type: 'FullCaseCitation', harvard_slug: 'a3d', volume, page: String(page),
  reporter: 'A.3d', externalUrl: null,
  caseLinks: [{ source: 'courtlistener', kind: 'citation', url: `https://www.courtlistener.com/c/A.3d/${volume}/${page}/` }],
});

describe('idxPath', () => {
  test('part 0 is the volume, later parts are numbered', () => {
    assert.equal(idxPath('a3d', '138'), 'a3d/138.idx.gz');
    assert.equal(idxPath('ny-slip-op', '2019', 2), 'ny-slip-op/2019.2.idx.gz');
    assert.equal(idxPath('ga', '33-suppl', 0), 'ga/33-suppl.idx.gz');
  });

  test('nothing that could leave the path is accepted', () => {
    assert.throws(() => idxPath('../a3d', '250'));
    assert.throws(() => idxPath('a3d', '250/..'));
    assert.throws(() => idxPath('A.3d', '250'));
    assert.throws(() => idxPath('a3d', '250', -1));
    assert.throws(() => idxPath('a3d', '250', '1'));
  });
});

describe('the manifest\'s idx', () => {
  test('format 1 is the unified index; anything else is not', () => {
    assert.ok(hasIdx(MANIFEST));
    assert.equal(MANIFEST.idx, 1);
    assert.ok(!hasIdx(normalizeManifest({ format: 2, idx: 2, reporters: {} })));
    assert.ok(!hasIdx(normalizeManifest({ format: 2, reporters: { a2d: ['31'] } })));
    assert.ok(!hasIdx(normalizeManifest({ a2d: [31], idx: [1] })));
    assert.ok(!hasIdx(null));
  });

  test('reporters cover every source; the old cl block is ignored', () => {
    assert.ok(holdsVolume(MANIFEST, 'a3d', 250));
    assert.ok(holdsVolume(MANIFEST, 'ny-slip-op', '2019'));
    assert.ok(!holdsVolume(MANIFEST, 'a3d', '999'));
    assert.equal(MANIFEST.cl, undefined);
  });
});

describe('idxEntries', () => {
  const read = deps().idxEntries;

  test('CAP first at a page CourtListener also has', async () => {
    const at5 = await read('a3d', '213', 5);
    assert.deepEqual(at5.map((e) => e.source), ['cap', 'cl']);
    assert.equal(at5[0].case_file, '0005-01');
  });

  test('every record at a shared page, in the file\'s order', async () => {
    const at100 = await read('a3d', 250, 100);
    assert.deepEqual(at100.map((e) => e.cluster_id), [9876543, 9876544]);
    assert.deepEqual(await read('a3d', 250, 101), []);
  });

  test('a page past the split is read from the later part', async () => {
    const log = [];
    const d = deps(log);
    assert.equal((await d.idxEntries('a3d', '300', 900))[0].case_file, '0900-01');
    assert.equal((await d.idxEntries('a3d', '300', 1))[0].case_file, '0001-01');
    assert.deepEqual(log, ['idx a3d/300.0', 'idx a3d/300.1', 'idx a3d/300.0']);
  });

  test('no file is null, so callers fall back to the .bin', async () => {
    assert.equal(await read('a3d', '138-2', 5), null);
  });

  test('a missing later part is an error, not a miss', async () => {
    const d = {
      readIdx: async (s, v, part) => (part === 0 ? new TextEncoder().encode('#parts,10\n') : null),
      lookup,
    };
    await assert.rejects(idxEntries('a3d', '1', 20, d), /Missing part 1/);
  });
});

describe('the page check with the unified index', () => {
  test('a volume only CourtListener has counts as held', async () => {
    assert.equal(await checkAvailability('a3d', 250, MANIFEST), true);
    assert.equal(await checkAvailability('a3d', 251, MANIFEST), false);
  });

  test('reads the .idx.gz and never a .bin', async () => {
    const log = [];
    assert.equal(await checkPage('a3d', 250, '100', deps(log)), true);
    assert.equal(await checkPage('a3d', 250, '101', deps(log)), false);
    assert.equal(await checkPage('a3d', 300, '901', deps(log)), true);
    assert.ok(log.every((l) => l.startsWith('idx ')), log.join());
  });

  test('a volume with no .idx.gz falls back to the .bin', async () => {
    const log = [];
    assert.equal(await checkPage('a3d', '138', '5', deps(log)), false);
    assert.deepEqual(log, ['idx a3d/138.0', 'bin a3d/138']);
  });

  test('a manifest without idx reads only the .bin', async () => {
    const log = [];
    const d = { ...deps(log), manifest: normalizeManifest({ format: 2, reporters: { a3d: ['213'] } }) };
    assert.equal(await checkPage('a3d', 213, '5', d), false);
    assert.deepEqual(log, ['bin a3d/213']);
  });

  test('a CourtListener hit resolves here, and is not a link-out', async () => {
    const d = deps();
    const c = await checkCitation(cite(250, 100), (s, v) => checkAvailability(s, v, MANIFEST),
      (s, v, p) => checkPage(s, v, p, d));
    assert.equal(c.volumeHeld, true);
    assert.equal(c.resolvable, true);
    assert.deepEqual(caseLookupLinks(c), []);
  });

  test('a miss in a held volume never links out', async () => {
    const d = deps();
    const c = await checkCitation(cite(250, 101), (s, v) => checkAvailability(s, v, MANIFEST),
      (s, v, p) => checkPage(s, v, p, d));
    assert.equal(c.resolvable, false);
    assert.equal(heldVolumeMiss(c), 'No case found at this page in A.3d vol. 250');
    assert.deepEqual(caseLookupLinks(c), []);
  });
});
