// CourtListener records on a CAP miss (docs/plans/courtlistener-mirror.md): the
// manifest's `cl` block, the sidecar lookups the page check makes, the record's paths
// and its source line. The fixture record is the one the Rust tests read.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

import {
  checkAvailability, checkCitation, checkPage, caseLookupLinks, heldVolumeMiss,
} from '../public/js/citations.js';
import { clEntries, gunzip, isClRecord, isGzip, sourceLineHtml } from '../public/js/cl.js';
import { hasClVolume, holdsCapVolume, normalizeManifest } from '../public/js/manifest.js';
import { clRecordPath, clRecordUrl, clSidecarPath } from '../public/js/sources.js';

const RECORD_BYTES = readFileSync(new URL('../../crates/stare/tests/fixtures/cl-record.json', import.meta.url));
const RECORD = JSON.parse(RECORD_BYTES);
const H1 = '0f3a9c2e7b1d4a65';
const H2 = 'a1b2c3d4e5f60718';

// a3d 213 is CAP's; 250 only CourtListener's; 200 both (CAP left pages out of it).
const MANIFEST = normalizeManifest({
  format: 2,
  base: 'v/v2026.10.05/',
  reporters: { a3d: ['200', '213'] },
  cl: { export: '2026-09-30', reporters: { a3d: ['200', '250'], 'ohio-2d': [2021] } },
});

// A sidecar for each CourtListener volume, looked up as the WASM does.
const SIDECARS = {
  'a3d/250': `100,9876543,${H1}\n100,9876544,${H2}\n112,9876601,${H1}\n`,
  'a3d/200': `5,111,${H1}\n`,
};
function lookup(text, page) {
  return text.trim().split('\n').map((l) => l.split(','))
    .filter(([p]) => Number(p) === page)
    .map(([p, id, hash]) => ({ page: Number(p), cluster_id: Number(id), hash }));
}

function deps(log = []) {
  return {
    manifest: MANIFEST,
    lookup: () => null, // no CAP case at any page
    readBin: async (slug, volume) => { log.push(`bin ${slug}/${volume}`); return new Uint8Array(8); },
    clEntries: (slug, volume, page) => {
      log.push(`cl ${slug}/${volume}`);
      return clEntries(slug, volume, page, {
        readSidecar: async (s, v) => SIDECARS[`${s}/${v}`] ?? null,
        lookup,
      });
    },
  };
}

const cite = (volume, page) => ({
  raw: `${volume} A.3d ${page}`, type: 'FullCaseCitation', harvard_slug: 'a3d', volume, page: String(page),
  reporter: 'A.3d', externalUrl: null,
  caseLinks: [{ source: 'courtlistener', kind: 'citation', url: `https://www.courtlistener.com/c/A.3d/${volume}/${page}/` }],
});

describe('CourtListener paths', () => {
  test('a record is one gzipped object per case under cl/c', () => {
    assert.equal(clRecordPath(9876543, H1), `cl/c/9876543/${H1}.json.gz`);
    assert.equal(clRecordUrl(9876543, H1), `https://data.stare.pub/cl/c/9876543/${H1}.json.gz`);
  });

  test('a sidecar is next to the volume\'s .bin', () => {
    assert.equal(clSidecarPath('a3d', '250'), 'a3d/250.cl');
    assert.equal(clSidecarPath('cal-app-4th', '138-2'), 'cal-app-4th/138-2.cl');
  });

  test('nothing that could leave the path is accepted', () => {
    assert.throws(() => clRecordPath(1, '../x'));
    assert.throws(() => clRecordPath(1, H1.toUpperCase()));
    assert.throws(() => clRecordPath('1', H1));
    assert.throws(() => clRecordPath(-1, H1));
    assert.throws(() => clSidecarPath('../a3d', '250'));
    assert.throws(() => clSidecarPath('a3d', '250/..'));
    assert.throws(() => clSidecarPath('A.3d', '250'));
  });
});

describe('the manifest\'s cl block', () => {
  test('lists the volumes with a sidecar, and the export', () => {
    assert.equal(MANIFEST.cl.export, '2026-09-30');
    assert.ok(hasClVolume(MANIFEST, 'a3d', 250));
    assert.ok(hasClVolume(MANIFEST, 'ohio-2d', '2021'));
    assert.ok(!hasClVolume(MANIFEST, 'a3d', '213'));
    assert.ok(!holdsCapVolume(MANIFEST, 'a3d', '250'));
    assert.ok(holdsCapVolume(MANIFEST, 'a3d', '200'));
  });

  test('a manifest without one reads as before, with cl null', () => {
    for (const raw of [{ format: 2, reporters: { a2d: ['31'] } }, { a2d: [31] }, null]) {
      const m = normalizeManifest(raw);
      assert.equal(m.cl, null);
      assert.ok(!hasClVolume(m, 'a2d', '31'));
    }
    // The legacy format has no cl block: a "cl" key there is a reporter.
    assert.equal(normalizeManifest({ cl: [1] }).cl, null);
  });

  test('drops reporters and volumes that could leave a path', () => {
    const m = normalizeManifest({
      format: 2, reporters: {}, cl: { reporters: { '../x': ['1'], a3d: ['../1', '250'] } },
    });
    assert.deepEqual(m.cl.reporters, { a3d: ['250'] });
    assert.equal(m.cl.export, null);
  });
});

describe('availability with CourtListener volumes', () => {
  test('a volume only CourtListener has counts as held', async () => {
    assert.equal(await checkAvailability('a3d', 250, MANIFEST), true);
    assert.equal(await checkAvailability('a3d', 251, MANIFEST), false);
  });

  test('its pages are looked up in the sidecar, never in a CAP .bin', async () => {
    const log = [];
    assert.equal(await checkPage('a3d', 250, '100', deps(log)), true);
    assert.equal(await checkPage('a3d', 250, '101', deps(log)), false);
    assert.deepEqual(log, ['cl a3d/250', 'cl a3d/250']);
  });

  test('a CAP miss in a volume both hold falls back to the sidecar', async () => {
    const log = [];
    assert.equal(await checkPage('a3d', 200, '5', deps(log)), true);
    assert.deepEqual(log, ['bin a3d/200', 'cl a3d/200']);
  });

  test('a volume the cl block doesn\'t list never reads a sidecar', async () => {
    const log = [];
    assert.equal(await checkPage('a3d', 213, '5', deps(log)), false);
    assert.deepEqual(log, ['bin a3d/213']);
  });

  test('a sidecar hit resolves here, and is not a link-out', async () => {
    const d = deps();
    const c = await checkCitation(cite(250, 100), (s, v) => checkAvailability(s, v, MANIFEST),
      (s, v, p) => checkPage(s, v, p, d));
    assert.equal(c.volumeHeld, true);
    assert.equal(c.resolvable, true);
    assert.deepEqual(caseLookupLinks(c), []);
  });

  test('a sidecar miss is a held-volume miss, which never links out', async () => {
    const d = deps();
    const c = await checkCitation(cite(250, 101), (s, v) => checkAvailability(s, v, MANIFEST),
      (s, v, p) => checkPage(s, v, p, d));
    assert.equal(c.resolvable, false);
    assert.equal(heldVolumeMiss(c), 'No case found at this page in A.3d vol. 250');
    assert.deepEqual(caseLookupLinks(c), []);
  });
});

describe('clEntries', () => {
  const read = { readSidecar: async (s, v) => SIDECARS[`${s}/${v}`] ?? null, lookup };

  test('every record at a shared page, in the sidecar\'s order', async () => {
    const at100 = await clEntries('a3d', 250, 100, read);
    assert.deepEqual(at100.map((e) => e.cluster_id), [9876543, 9876544]);
    assert.deepEqual(await clEntries('a3d', 250, '112', read), [{ page: 112, cluster_id: 9876601, hash: H1 }]);
  });

  test('a missing sidecar has nothing', async () => {
    assert.deepEqual(await clEntries('a3d', 999, 1, read), []);
  });
});

describe('records', () => {
  test('gunzips a stored record, and passes a plain one through', async () => {
    const gz = new Uint8Array(gzipSync(RECORD_BYTES));
    assert.ok(isGzip(gz));
    assert.ok(!isGzip(new Uint8Array(RECORD_BYTES)));
    assert.deepEqual(Buffer.from(await gunzip(gz)), RECORD_BYTES);
    const plain = new Uint8Array(RECORD_BYTES);
    assert.equal(await gunzip(plain), plain);
  });

  test('a CAP case has no source and no source line', () => {
    const cap = { ...RECORD, source: undefined };
    assert.ok(!isClRecord(cap));
    assert.equal(sourceLineHtml(cap), '');
    assert.ok(isClRecord(RECORD));
  });

  test('the source line names the export and links the case on CourtListener', () => {
    assert.equal(
      sourceLineHtml(RECORD),
      '<div class="reader-source"><a class="source-link" href="https://www.courtlistener.com/opinion/9876543/smith-v-jones/" target="_blank" rel="noopener noreferrer">From CourtListener&#39;s bulk data, export 2026-09-30</a>'
        + ' &middot; <span>Docket J-12-2021</span> &middot; <span>Published</span></div>',
    );
  });

  test('without a URL, docket or status, the line is just the source', () => {
    const bare = { source: { name: 'courtlistener', export: '2026-09-30', url: 'javascript:alert(1)' } };
    assert.equal(sourceLineHtml(bare, 'x'),
      '<div class="x">From CourtListener&#39;s bulk data, export 2026-09-30</div>');
    assert.equal(sourceLineHtml({ source: { name: 'courtlistener' } }),
      '<div class="reader-source">From CourtListener&#39;s bulk data</div>');
  });

  test('escapes what the record says', () => {
    const html = sourceLineHtml({ source: { name: 'courtlistener', docket_number: '<b>1</b>', precedential_status: '"x"' } });
    assert.ok(html.includes('Docket &lt;b&gt;1&lt;/b&gt;'));
    assert.ok(html.includes('&quot;x&quot;'));
  });
});
