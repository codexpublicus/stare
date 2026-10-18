// A page check that can't reach the index (#144): a network error, a timeout or a 5xx
// on a volume's .bin or .idx.gz is neither a hit nor a miss. It is retried once; if it
// still fails, the citation is "couldn't check", which never renders as a link, in the
// reader, the sidebar or /check, and never links out either.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  caseLookupLinks,
  checkCitation,
  checkPage,
  citedCaseHtml,
  heldVolumeMiss,
  lookupFailed,
  processCitations,
  renderTextHtml,
} from '../public/js/citations.js';
import { idxEntries } from '../public/js/idx.js';
import { normalizeManifest } from '../public/js/manifest.js';

const FIXTURES = new URL('../../crates/stare/tests/fixtures/', import.meta.url);
const BIN_138 = readFileSync(new URL('a3d-138.bin', FIXTURES));

// stare::index::lookup in JS: 8 bytes per page, all zeros for no case.
function binLookup(bin, page) {
  const entry = bin.subarray(page * 8, page * 8 + 8);
  if (entry.length < 8 || entry.every((b) => b === 0)) return null;
  return Buffer.from(entry).toString('utf8').replace(/\0+$/, '');
}

// lookup_idx in JS, enough for unsplit files.
function idxLookup(bytes, page) {
  const entries = Buffer.from(bytes).toString('utf8').split('\n')
    .map((l) => l.trim().split(','))
    .filter((f) => f.length === 3 && f[0] === String(page))
    .map(([p, source, ref]) => ({ page: p, source, ref }));
  return { part: 0, entries };
}

const OLD = normalizeManifest({ format: 2, reporters: { a3d: ['101', '138'] } });
const UNIFIED = normalizeManifest({ format: 2, idx: 1, reporters: { a3d: ['101', '138'] } });

const networkError = () => new TypeError('Failed to fetch');
const serverError = () => new Error('HTTP 503 fetching https://idx.stare.pub/a3d/101.bin');

// Deps for checkPage on the .bin format, with `fail(n)` deciding whether the nth read
// of a volume (from 0) fails.
function binDeps(fail, reads = []) {
  return {
    manifest: OLD,
    retryDelay: 0,
    lookup: binLookup,
    readBin: async (slug, volume) => {
      const n = reads.filter((r) => r === `${slug}/${volume}`).length;
      reads.push(`${slug}/${volume}`);
      if (fail(n, volume)) throw networkError();
      return volume === '138' ? BIN_138 : null;
    },
  };
}

function idxDeps(fail, reads = []) {
  return {
    manifest: UNIFIED,
    retryDelay: 0,
    readBin: async (slug, volume) => { reads.push(`bin ${slug}/${volume}`); return BIN_138; },
    lookup: binLookup,
    idxEntries: (slug, volume, page) => idxEntries(slug, volume, page, {
      readIdx: async (s, v) => {
        const n = reads.filter((r) => r === `idx ${s}/${v}`).length;
        reads.push(`idx ${s}/${v}`);
        if (fail(n, v)) throw serverError();
        return new TextEncoder().encode('249,cap,0249-01\n');
      },
      lookup: idxLookup,
    }),
  };
}

const cite = (volume, page) => ({
  raw: `${volume} A.3d ${page}`, type: 'FullCaseCitation', harvard_slug: 'a3d', volume, page: String(page),
  reporter: 'A.3d', externalUrl: null,
  caseLinks: [{ source: 'courtlistener', kind: 'citation', url: `https://www.courtlistener.com/c/A.3d/${volume}/${page}/` }],
});

describe('checkPage when the index can\'t be read', () => {
  test('a .bin that fails twice is unknown (null), not a hit or a miss', async () => {
    const reads = [];
    assert.equal(await checkPage('a3d', 101, '249', binDeps(() => true, reads)), null);
    assert.deepEqual(reads, ['a3d/101', 'a3d/101']);
  });

  test('a .bin that fails once is retried and answers', async () => {
    const reads = [];
    assert.equal(await checkPage('a3d', 138, '8', binDeps((n) => n === 0, reads)), true);
    assert.deepEqual(reads, ['a3d/138', 'a3d/138']);
  });

  test('an .idx.gz that fails twice is unknown, and doesn\'t fall back to the .bin', async () => {
    const reads = [];
    assert.equal(await checkPage('a3d', 101, '249', idxDeps(() => true, reads)), null);
    assert.deepEqual(reads, ['idx a3d/101', 'idx a3d/101']);
  });

  test('an .idx.gz that fails once is retried and answers', async () => {
    const reads = [];
    assert.equal(await checkPage('a3d', 101, '249', idxDeps((n) => n === 0, reads)), true);
    assert.equal(await checkPage('a3d', 101, '250', idxDeps(() => false)), false);
  });
});

describe('a citation whose page couldn\'t be checked', () => {
  const unknown = () => checkCitation(cite(101, 249), async () => true, async () => null);

  test('is held but neither resolvable nor a miss', async () => {
    const c = await unknown();
    assert.equal(c.volumeHeld, true);
    assert.equal(c.resolvable, false);
    assert.equal(c.pageUnknown, true);
    assert.equal(heldVolumeMiss(c), null);
    assert.equal(lookupFailed(c), "Couldn't reach the index for A.3d vol. 101; reload to try again");
  });

  test('never links out', async () => {
    assert.deepEqual(caseLookupLinks(await unknown()), []);
  });

  test('a short form to it inherits the unknown state', async () => {
    const short = { raw: 'Id.', type: 'IdCitation', antecedent: cite(101, 249) };
    const c = await checkCitation(short, async () => true, async () => null);
    assert.equal(c.resolvable, false);
    assert.equal(c.pageUnknown, true);
  });

  test('has a neutral sidebar and /check entry with no link', async () => {
    const html = citedCaseHtml(await unknown(), () => '/#a3d/101/249-01');
    assert.doesNotMatch(html, /<a\b/);
    assert.match(html, /cited-status unknown/);
    assert.match(html, /<span class="cited-status unknown">\?<\/span>/);
    assert.match(html, /Couldn&#39;t reach the index for A\.3d vol\. 101; reload to try again/);
  });
});

describe('the reader, with a page check that fails', () => {
  const text = 'See Brooks v. Powers, 101 A.3d 249 (2014); and 138 A.3d 8.';
  const detected = [
    { ...cite(101, 249), start: 22, end: 34 },
    { ...cite(138, 8), start: 47, end: 57 },
  ];

  async function render(deps) {
    const { unique, occurrencesByOpinion } = await processCitations(
      { casebody: { opinions: [{ text }] } },
      async () => true,
      async () => detected,
      (slug, volume, page) => checkPage(slug, volume, page, deps),
    );
    const map = new Map(unique.map((c) => [c.key, c]));
    return renderTextHtml(text, occurrencesByOpinion[0], map).join('\n');
  }

  for (const [name, deps] of [
    ['.bin', () => binDeps((n, v) => v === '101')],
    ['.idx.gz', () => idxDeps((n, v) => v === '101')],
  ]) {
    test(`renders the unreadable volume's citation without a link (${name})`, async () => {
      const html = await render(deps());
      assert.doesNotMatch(html, /<a [^>]*>101 A\.3d 249<\/a>/, html);
      assert.match(html, /<span class="cite-unresolved cite-unknown" title="Couldn&#39;t reach the index for A\.3d vol\. 101; reload to try again">101 A\.3d 249<\/span>/, html);
    });
  }

  test('still links a citation the index answers (.bin)', async () => {
    const html = await render(binDeps((n, v) => v === '101'));
    assert.match(html, /<a class="cite-link" href="#a3d\/138\/8"[^>]*>138 A\.3d 8<\/a>/, html);
  });
});
