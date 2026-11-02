// The collection's figures live in web/src/data/collection.json (#92), which
// web/scripts/collection.mjs writes from the live index before every site build
// (#297). These tests fail when a page, a social description, llms.txt or the OG
// image carries a figure of its own.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  collection,
  decisionsLabel,
  figures,
  formatCount,
  formatMillions,
  llmsSummary,
  ogLine,
  yearSpan,
} from '../src/lib/collection.js';
import { CAP_RELEASE, collectionFromIndex, readCollection } from '../src/lib/collection-read.js';
import { ogSvg, withLlmsSummary } from '../scripts/collection.mjs';
import { pngTextChunks } from '../scripts/png-text.mjs';

const WEB = new URL('..', import.meta.url).pathname;

// "6.7 million cases", "7.8M decisions", "6,920,596 cases"
const FIGURE = /\b\d[\d,.]*\s*(?:million|M)\s+(?:cases|decisions)\b|\b\d{1,3}(?:,\d{3}){2,}\s+(?:cases|decisions)\b/gi;

const fixture = (name) => JSON.parse(readFileSync(join(WEB, 'tests', 'fixtures', 'collection', `${name}.json`), 'utf8'));
const index = () => ({ manifest: fixture('manifest'), report: fixture('report'), facets: fixture('facets') });

function walk(dir, exts) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(path);
  }
  return out;
}

describe('collection.json', () => {
  test('has every field, with sane values', () => {
    assert.match(collection.index_version, /^v\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/);
    assert.ok(Number.isInteger(collection.decisions) && collection.decisions > 1_000_000);
    assert.equal(collection.decisions, collection.cap.cases + collection.courtlistener.records);
    assert.ok(collection.first_year <= collection.cap.first_year);
    assert.ok(collection.last_year >= collection.cap.last_year);
    assert.ok(Number.isInteger(collection.cap.volumes) && collection.cap.volumes > 0);
    assert.ok(collection.cap.indexed_volumes <= collection.cap.volumes);
    assert.match(collection.courtlistener.export, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Number.isInteger(collection.courtlistener.records) && collection.courtlistener.records > 0);
    assert.ok(collection.source);
  });

  test('is what collection.mjs writes for its index build (re-run npm --prefix web run collection)', () => {
    // The snapshot's own build, if it is the fixture's; otherwise only its shape is checked above.
    if (collection.index_version !== fixture('report').version) return;
    assert.deepEqual(collection, collectionFromIndex(index()));
  });
});

describe('collectionFromIndex', () => {
  test('adds CAP and CourtListener, and takes the years from the facets', () => {
    const c = collectionFromIndex(index());
    assert.equal(c.index_version, 'v2026.10.26.2');
    assert.equal(c.cap.cases, 6_920_598);
    assert.equal(c.courtlistener.records, 900_342);
    assert.equal(c.decisions, 7_820_940);
    assert.equal(c.first_year, 1658);
    assert.equal(c.last_year, 2026);
    assert.equal(c.cap.first_year, CAP_RELEASE.first_year);
    assert.equal(c.cap.last_year, CAP_RELEASE.last_year);
    assert.equal(c.cap.indexed_volumes, 40_622);
  });

  test('leaves out years after the CourtListener export', () => {
    const c = collectionFromIndex(index());
    assert.deepEqual(c.years_ignored, [{ year: 2028, decisions: 1 }]);
  });

  test('fails on files from different builds', () => {
    const i = index();
    i.facets.version = 'v2026.10.23';
    assert.throws(() => collectionFromIndex(i), /facets\.json is build v2026\.10\.23/);
    const j = index();
    j.manifest.version = 'v2026.10.23';
    assert.throws(() => collectionFromIndex(j), /manifest\.json is build/);
  });

  test('fails on another CAP release, whose volumes and years were never counted', () => {
    const i = index();
    i.report.build.cap_release = 'VolumesMetadata.json sha256:00';
    assert.throws(() => collectionFromIndex(i), /recount/);
  });

  test('fails on a build without CourtListener, or without years', () => {
    const i = index();
    delete i.report.idx;
    assert.throws(() => collectionFromIndex(i), /cl_input/);
    const j = index();
    j.facets.years = [];
    assert.throws(() => collectionFromIndex(j), /no years/);
  });

  test('readCollection follows the live manifest\'s base, and fails on a missing file', async () => {
    const files = {
      'https://idx.test/manifest.json': { ...fixture('manifest'), base: 'v/v2026.10.26.2/' },
      'https://idx.test/v/v2026.10.26.2/manifest.json': fixture('manifest'),
      'https://idx.test/v/v2026.10.26.2/report.json': fixture('report'),
      'https://idx.test/v/v2026.10.26.2/search/facets.json': fixture('facets'),
    };
    const fetch = async (url) =>
      url in files ? { ok: true, status: 200, json: async () => files[url] } : { ok: false, status: 404 };
    assert.equal((await readCollection({ index: 'https://idx.test', fetch })).decisions, 7_820_940);
    assert.equal((await readCollection({ index: 'https://idx.test', version: 'v2026.10.26.2', fetch })).last_year, 2026);
    delete files['https://idx.test/v/v2026.10.26.2/search/facets.json'];
    await assert.rejects(readCollection({ index: 'https://idx.test', fetch }), /HTTP 404 for .*facets\.json/);
  });
});

describe('formatMillions', () => {
  test('rounds down to one decimal', () => {
    assert.equal(formatMillions(6_920_596), '6.9 million');
    assert.equal(formatMillions(6_999_999), '6.9 million');
    assert.equal(formatMillions(7_000_000), '7 million');
    assert.equal(formatMillions(7_820_940), '7.8 million');
    assert.equal(formatMillions(12_340_000), '12.3 million');
  });

  test('refuses what it cannot say in millions', () => {
    assert.throws(() => formatMillions(999_999), RangeError);
    assert.throws(() => formatMillions(6.5e6 + 0.5), RangeError);
  });

  test('formatCount groups thousands', () => {
    assert.equal(formatCount(40622), '40,622');
  });

  test('the phrases', () => {
    const f = figures(collectionFromIndex(index()));
    assert.equal(f.coverage, '7.8 million decisions from 1658 to 2026, from the Caselaw Access Project and CourtListener');
    assert.equal(f.capCasesLabel, '6.9 million cases');
    assert.equal(f.ogLine, '7.8 million decisions · 1658 to 2026 · Serverless. Actually.');
  });
});

describe('no figure outside the data file', () => {
  // og-image.svg is written from the data file by scripts/collection.mjs and
  // checked against it below.
  test('the page sources carry no hard-coded count', () => {
    const files = [
      ...walk(join(WEB, 'src'), ['.astro', '.js', '.mjs', '.md']),
      ...walk(join(WEB, 'public'), ['.html', '.js', '.svg', '.json', '.txt']),
    ].filter((f) => !f.endsWith(join('public', 'og-image.svg')) && !f.endsWith(join('public', 'llms.txt')));
    const offenders = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(FIGURE)) offenders.push(`${relative(WEB, file)}: "${m[0]}"`);
    }
    assert.deepEqual(offenders, []);
  });

  test('llms.txt\'s summary is the one the data file gives', () => {
    const llms = readFileSync(join(WEB, 'public', 'llms.txt'), 'utf8');
    assert.equal(withLlmsSummary(llms, llmsSummary), llms);
    assert.ok(llms.includes(llmsSummary));
  });

  test('every page in a build gives the same figure as the data file', { skip: !existsSync(join(WEB, 'dist')) && 'no web/dist; run the site build first' }, () => {
    const pages = walk(join(WEB, 'dist'), ['.html', '.txt']);
    assert.ok(pages.length > 0);
    const capCases = figures(collection).capCasesLabel;
    const wrong = [];
    for (const page of pages) {
      const html = readFileSync(page, 'utf8');
      for (const m of html.matchAll(FIGURE)) {
        if (m[0] !== decisionsLabel && m[0] !== capCases) wrong.push(`${relative(WEB, page)}: "${m[0]}"`);
      }
    }
    assert.deepEqual(wrong, []);
    const home = readFileSync(join(WEB, 'dist', 'index.html'), 'utf8');
    assert.ok(home.includes(decisionsLabel), `home page lacks "${decisionsLabel}"`);
    assert.ok(home.includes(yearSpan), `home page lacks "${yearSpan}"`);
  });
});

describe('og-image', () => {
  const svg = readFileSync(join(WEB, 'public', 'og-image.svg'), 'utf8');

  test('the SVG is the one collection.mjs writes from the data file', () => {
    assert.ok(svg.includes(ogLine), `og-image.svg lacks "${ogLine}"`);
    assert.equal(svg, ogSvg(ogLine));
  });

  test('the PNG was rendered from the current SVG (npm --prefix web run collection)', () => {
    const png = readFileSync(join(WEB, 'public', 'og-image.png'));
    const chunks = pngTextChunks(png);
    const sha = createHash('sha256').update(svg).digest('hex');
    assert.equal(chunks['stare:source-sha256'], sha);
  });
});
