// Parallel-citation aliases in the unified index (#151): a `cap` line whose ref names a
// case in another volume (`<slug>/<folder>/<file>`), with where it came from
// (`via=cl:<cluster>`, CourtListener's citation metadata). `lookup` below is the WASM's
// lookup_idx in JS, on plain text, for the alias lines (crates/stare/src/idx.rs is the
// real one, and its tests cover the parsing).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALIASES_ONLY, aliasNoteHtml, caseLookupLinks, checkAvailability, checkCitation, checkPage,
  citationCounts, citedCaseHtml, groupCitations, heldVolumeMiss, inheritStatus, pageResult, renderTextHtml, viaLabel,
} from '../public/js/citations.js';
import { idxEntries } from '../public/js/idx.js';
import { hasAliasVolume, holdsVolume, normalizeManifest } from '../public/js/manifest.js';
// groupCitations groups through the stare WASM (#198).
import './wasm-node.js';

const H1 = '0f3a9c2e7b1d4a65';

// n-w 260 has only aliases (Pettegrew, 260 N.W. 287, is neb/128/0783-01); a2d 31 is
// CAP's, with an alias at page 693 (a regional reprint page CAP's scan doesn't carry)
// and one at page 647, where CAP has its own case.
const MANIFEST = normalizeManifest({
  format: 2,
  idx: 1,
  reporters: { a2d: ['31'], neb: ['128'] },
  aliases: { 'n-w': ['260'], a2d: ['31'], bad: ['../x'] },
});
const FILES = {
  'n-w/260/0': '287,cap,neb/128/0783-01,via=cl:8077312\n',
  'a2d/31/0': `647,cap,0647-01\n647,cap,neb/128/0790-01,via=cl:5\n693,cl,7/${H1}\n693,cap,pa-super/150/0001-01,via=cl:6\n`,
};

const pageKey = (p) => (/^\d+$/.test(String(p)) ? Number(p) : String(p).toLowerCase());

function lookup(bytes, page) {
  const lines = Buffer.from(bytes).toString('utf8').split('\n').filter(Boolean);
  const rank = (e) => (e.source === 'cl' ? 2 : e.reporter ? 1 : 0);
  const entries = lines
    .map((l) => l.split(','))
    .filter((f) => pageKey(f[0]) === pageKey(page))
    .map(([p, source, ref, ...fields]) => {
      const via = fields.find((f) => f.startsWith('via='))?.slice(4);
      if (source === 'cl') {
        const [id, hash] = ref.split('/');
        return { page: p, source, ref, cluster_id: Number(id), hash };
      }
      const segs = ref.split('/');
      if (segs.length === 3) {
        return { page: p, source, ref, reporter: segs[0], folder: segs[1], case_file: segs[2], via };
      }
      return { page: p, source, ref, case_file: segs[segs.length - 1] };
    })
    .sort((a, b) => rank(a) - rank(b));
  return { part: 0, entries };
}

const deps = {
  manifest: MANIFEST,
  readBin: async () => null,
  lookup: () => null,
  retryDelay: 0,
  idxEntries: (slug, volume, page) => idxEntries(slug, volume, page, {
    readIdx: async (s, v, part) => {
      const text = FILES[`${s}/${v}/${part}`];
      return text == null ? null : new TextEncoder().encode(text);
    },
    lookup,
  }),
};

const check = (slug, volume) => checkAvailability(slug, volume, MANIFEST);
const pageCheck = (slug, volume, page) => checkPage(slug, volume, page, deps);

const cite = (slug, reporter, volume, page) => ({
  raw: `${volume} ${reporter} ${page}`, type: 'FullCaseCitation', slug, harvard_slug: slug,
  volume, page: String(page), reporter, externalUrl: null,
  caseLinks: [{ source: 'courtlistener', kind: 'citation', url: `https://www.courtlistener.com/c/${reporter}/${volume}/${page}/` }],
});

describe('the manifest\'s aliases', () => {
  test('a volume of aliases only is listed apart from the held volumes', () => {
    assert.ok(hasAliasVolume(MANIFEST, 'n-w', 260));
    assert.ok(!holdsVolume(MANIFEST, 'n-w', 260));
    // Held wins; bad names are dropped.
    assert.ok(!hasAliasVolume(MANIFEST, 'a2d', '31'));
    assert.deepEqual(MANIFEST.aliases, { 'n-w': ['260'] });
    // Without the unified index, aliases mean nothing.
    assert.ok(!hasAliasVolume(normalizeManifest({ format: 2, reporters: {}, aliases: { 'n-w': ['260'] } }), 'n-w', '260'));
    assert.deepEqual(normalizeManifest({ a2d: [31] }).aliases, {});
  });

  test('checkAvailability says which', async () => {
    assert.equal(await check('a2d', 31), true);
    assert.equal(await check('n-w', 260), ALIASES_ONLY);
    assert.equal(await check('n-w', 261), false);
  });
});

describe('pageResult', () => {
  test('an alias first names its case and source; anything else is a plain hit', () => {
    assert.equal(pageResult([]), false);
    assert.equal(pageResult([{ source: 'cl', cluster_id: 1, hash: H1 }]), true);
    assert.equal(pageResult([{ source: 'cap', case_file: '0001-01' }]), true);
    assert.deepEqual(
      pageResult([{ source: 'cap', reporter: 'neb', folder: '128', case_file: '0783-01', via: 'cl:8077312' }]),
      { via: 'cl:8077312', target: { slug: 'neb', folder: '128', caseFile: '0783-01' } },
    );
  });
});

describe('checkCitation with aliases', () => {
  test('a page in a volume of aliases only resolves, labelled with its source', async () => {
    const info = await checkCitation(cite('n-w', 'N.W.', 260, 287), check, pageCheck);
    assert.equal(info.resolvable, true);
    assert.equal(info.volumeHeld, false);
    assert.equal(info.via, 'cl:8077312');
    assert.deepEqual(info.aliasOf, { slug: 'neb', folder: '128', caseFile: '0783-01' });
    assert.deepEqual(caseLookupLinks(info), []);
    assert.equal(citationCounts(groupCitations(null, [info])).resolvable, 1);
  });

  test('a miss there is a volume stare.pub doesn\'t hold, linked out', async () => {
    const info = await checkCitation(cite('n-w', 'N.W.', 260, 288), check, pageCheck);
    assert.equal(info.resolvable, false);
    assert.equal(info.volumeHeld, false);
    assert.equal(heldVolumeMiss(info), null);
    assert.equal(caseLookupLinks(info).length, 1);
  });

  test('a failed check there links out too, since stare.pub holds none of the volume', async () => {
    const failing = { ...deps, idxEntries: async () => { throw new Error('503'); } };
    const info = await checkCitation(cite('n-w', 'N.W.', 260, 287), check,
      (s, v, p) => checkPage(s, v, p, failing));
    assert.equal(info.resolvable, false);
    assert.equal(caseLookupLinks(info).length, 1);
  });

  test('in a held volume an alias resolves a page CAP\'s scan doesn\'t carry, ahead of a record', async () => {
    const info = await checkCitation(cite('a2d', 'A.2d', 31, 693), check, pageCheck);
    assert.equal(info.resolvable, true);
    assert.equal(info.volumeHeld, true);
    assert.equal(info.via, 'cl:6');
  });

  test('CAP\'s own case at the page comes first; the alias changes nothing', async () => {
    const info = await checkCitation(cite('a2d', 'A.2d', 31, 647), check, pageCheck);
    assert.equal(info.resolvable, true);
    assert.equal(info.via, null);
    assert.equal(info.aliasOf, null);
  });

  test('a short form inherits the alias\'s source', async () => {
    const a = await checkCitation(cite('n-w', 'N.W.', 260, 287), check, pageCheck);
    const id = inheritStatus({ raw: 'Id.', type: 'IdCitation', pin: '290', antecedent: a }, a);
    assert.equal(id.resolvable, true);
    assert.equal(id.via, 'cl:8077312');
  });
});

describe('display', () => {
  test('the label names CourtListener\'s citation metadata and never says verified', () => {
    assert.equal(viaLabel('cl:8077312'), "Resolved through CourtListener's citation metadata");
    assert.equal(viaLabel(null), '');
    assert.equal(viaLabel('human:3'), 'Resolved through human:3');
    assert.doesNotMatch(viaLabel('cl:1'), /verif/i);
    assert.equal(viaLabel('nominative:us'), "Resolved as the U.S. Reports under its reporter's name");
    assert.equal(viaLabel('official:us'), "Resolved by the reporter's official page; CAP's scan numbers the case on another page");
    assert.equal(viaLabel('official:ohio'), "Resolved by the reporter's official page; CAP's scan numbers the case on another page");
    assert.equal(viaLabel('officials:us'), 'Resolved through officials:us');
  });

  test('the cited-cases entry links here and says where the link came from', async () => {
    const info = await checkCitation(cite('n-w', 'N.W.', 260, 287), check, pageCheck);
    const html = citedCaseHtml(info, (c) => `/#${c.slug}/${c.volume}/${c.page}`);
    assert.match(html, /href="\/#n-w\/260\/287"/);
    assert.match(html, /class="cited-lookup cited-via">Resolved through CourtListener&#39;s citation metadata</);
    assert.doesNotMatch(html, /verif/i);
    const plain = citedCaseHtml({ ...info, via: null }, () => '/#x');
    assert.doesNotMatch(plain, /cited-via/);
  });

  test('the inline link carries the source in its title', async () => {
    const info = await checkCitation(cite('n-w', 'N.W.', 260, 287), check, pageCheck);
    const text = 'See 260 N.W. 287.';
    const occ = [{ raw: info.raw, key: info.key, pin: null, start: 4, end: 16 }];
    const [p] = renderTextHtml(text, occ, new Map([[info.key, info]]));
    assert.match(p, /href="#n-w\/260\/287"/);
    assert.match(p, /data-via="cl:8077312"/);
    assert.match(p, /title="260 N\.W\. 287\. Resolved through CourtListener&#39;s citation metadata"/);
  });

  test('the case viewer\'s note says what was cited and which cluster', () => {
    assert.equal(
      aliasNoteHtml({ via: 'cl:8077312', reporter: 'n-w', volume: '260', page: 287 }),
      '<div class="reader-alias" role="note">Cited as n-w 260 287. Resolved through CourtListener&#39;s citation metadata (cluster 8077312).</div>',
    );
    assert.equal(aliasNoteHtml(null), '');
  });

  test('an official-page alias says the page is the U.S. Reports\' own', () => {
    assert.equal(
      aliasNoteHtml({ via: 'official:us', reporter: 'us', volume: '8', page: 29 }),
      '<div class="reader-alias" role="note">Cited as us 8 29. Resolved by the reporter&#39;s official page; CAP&#39;s scan numbers the case on another page.</div>',
    );
  });

  test('a nominative alias says it is the U.S. Reports under the reporter\'s name', () => {
    assert.equal(
      aliasNoteHtml({ via: 'nominative:us', reporter: 'wall', volume: '22', page: 238 }),
      '<div class="reader-alias" role="note">Cited as wall 22 238. Resolved as the U.S. Reports under its reporter&#39;s name.</div>',
    );
  });
});
