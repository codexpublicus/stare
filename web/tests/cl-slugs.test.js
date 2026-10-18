// Citations of reporters CAP never had resolve through citare's edition slug (#153).
// crates/stare/tests/fixtures/cl-sample-build.json is a sample build: for each
// citation, what the WASM detects in a reader's citation string, and the unified
// index stare-admin writes. stare-admin's tests check both against citare; here the
// site looks each one up through them, as the landing box and the sidebar do.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { checkAvailability, checkCitation, checkPage, citationsFromRust } from '../public/js/citations.js';
import { idxEntries } from '../public/js/idx.js';
import { citedSlug, normalizeManifest } from '../public/js/manifest.js';
import { inputFromCitations } from '../public/js/resolve.js';

const SAMPLE = JSON.parse(readFileSync(
  new URL('../../crates/stare/tests/fixtures/cl-sample-build.json', import.meta.url), 'utf8',
));

// The build's manifest: every volume the sample's index has.
const reporters = {};
for (const key of Object.keys(SAMPLE.idx)) {
  const [slug, volume] = key.split('/');
  (reporters[slug] ||= []).push(volume);
}
const MANIFEST = normalizeManifest({ format: 2, idx: 1, reporters });

// The WASM's lookup_idx on plain text, for the one-part files of the sample.
function lookup(bytes, page) {
  const lines = Buffer.from(bytes).toString('utf8').split('\n').filter(Boolean);
  const entries = lines
    .map((l) => l.split(','))
    .filter(([p]) => Number(p) === Number(page))
    .map(([p, source, ref]) => {
      const [id, hash] = ref.split('/');
      return { page: p, source, ref, cluster_id: Number(id), hash };
    });
  return { part: 0, entries };
}

const readIdx = async (slug, volume, part) => {
  const text = part === 0 ? SAMPLE.idx[`${slug}/${volume}`] : undefined;
  return text == null ? null : new TextEncoder().encode(text);
};
const entries = (slug, volume, page) => idxEntries(slug, volume, page, { readIdx, lookup });

// One citation as the WASM's detect_citations returns it.
const rust = (c, fields = c.detected) => ({
  matched_text: c.text,
  citation_type: 'FullCaseCitation',
  span: [0, [...c.text].length],
  reporter: c.reporter,
  year: null,
  external_url: null,
  law: null,
  case_links: [],
  pin: null,
  antecedent: null,
  ...fields,
});

describe('a CourtListener-only reporter in a sample build', () => {
  for (const c of SAMPLE.citations) {
    test(`${c.text} resolves to its record`, async () => {
      // The landing box: the citation string to a slug, volume and page.
      const input = inputFromCitations([rust(c)]);
      assert.equal(input.reporter, c.detected.slug);
      assert.equal(input.volume, c.detected.volume);
      const found = await entries(input.reporter, input.volume, input.page);
      assert.deepEqual(found.map((e) => [e.source, e.cluster_id, e.hash]), [['cl', c.cluster_id, SAMPLE.hash]]);

      // The sidebar: a citation in a case's text, linked into stare.pub.
      const [cite] = citationsFromRust([rust(c)]);
      const checked = await checkCitation(
        cite,
        (s, v) => checkAvailability(s, v, MANIFEST),
        (s, v, p) => checkPage(s, v, p, { manifest: MANIFEST, idxEntries: entries }),
      );
      assert.equal(checked.slug, c.detected.slug);
      assert.equal(checked.volumeHeld, true);
      assert.equal(checked.resolvable, true);
    });
  }

  test('the Ohio and North Dakota neutral citations share CAP\'s slugs at year volumes', () => {
    const by = (text) => SAMPLE.citations.find((c) => c.text === text);
    assert.deepEqual(inputFromCitations([rust(by('2019-Ohio-1234'))]), { reporter: 'ohio', volume: '2019', page: 1234, seq: null });
    assert.deepEqual(inputFromCitations([rust(by('2021 ND 123'))]), { reporter: 'nd', volume: '2021', page: 123, seq: null });
  });
});

describe('citedSlug', () => {
  test('citare\'s slug, whatever harvard_slug says', () => {
    assert.equal(citedSlug({ slug: 'nd', harvard_slug: null }), 'nd');
    assert.equal(citedSlug({ slug: 'us-ct-cl', harvard_slug: 'wv-ct-cl' }), 'us-ct-cl');
  });

  test('a null slug is none: a law citare gives a reporter\'s harvard_slug', () => {
    assert.equal(citedSlug({ slug: null, harvard_slug: 'ny' }), null);
  });

  test('output with no slug field, from before citare v0.6.0, falls back to harvard_slug', () => {
    assert.equal(citedSlug({ harvard_slug: 'a2d' }), 'a2d');
    assert.equal(citedSlug({ harvard_slug: null }), null);
    const old = { matched_text: '31 A.2d 647', harvard_slug: 'a2d', volume: '31', page: '647' };
    assert.deepEqual(inputFromCitations([old]), { reporter: 'a2d', volume: '31', page: 647, seq: null });
    assert.equal(citationsFromRust([rust({ text: '31 A.2d 647', reporter: 'A.2d' }, old)])[0].slug, 'a2d');
  });

  test('an old module can\'t reach a reporter CAP never had', () => {
    const old = { matched_text: '2021 NY Slip Op 01234', harvard_slug: null, volume: '2021', page: '01234' };
    assert.equal(inputFromCitations([old]), null);
  });
});
