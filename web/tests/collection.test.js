// The collection's figures live in web/src/data/collection.json (#92).
// These tests fail when a page, a social description or the OG image
// carries a figure of its own.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  collection,
  casesLabel,
  formatCount,
  formatMillions,
  yearRange,
} from '../src/lib/collection.js';
import { pngTextChunks } from '../scripts/png-text.mjs';

const WEB = new URL('..', import.meta.url).pathname;

// "6.7 million cases", "6.9M cases", "6,920,596 cases"
const FIGURE = /\b\d[\d,.]*\s*(?:million|M)\s+cases\b|\b\d{1,3}(?:,\d{3}){2,}\s+cases\b/gi;

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
    for (const key of ['cases', 'volumes', 'first_year', 'last_year', 'source', 'as_of']) {
      assert.ok(key in collection, `missing ${key}`);
    }
    assert.ok(Number.isInteger(collection.cases) && collection.cases > 1_000_000);
    assert.ok(Number.isInteger(collection.volumes) && collection.volumes > 0);
    assert.ok(Number.isInteger(collection.indexed_volumes));
    assert.ok(collection.indexed_volumes <= collection.volumes);
    assert.ok(collection.first_year < collection.last_year);
    assert.match(collection.as_of, /^\d{4}-\d{2}-\d{2}$/);
  });

  test('has the CourtListener records the live index points at', () => {
    const cl = collection.courtlistener;
    assert.match(cl.index_version, /^v\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/);
    assert.match(cl.export, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Number.isInteger(cl.records) && cl.records > 0);
    assert.ok(cl.source);
  });
});

describe('formatMillions', () => {
  test('rounds down to one decimal', () => {
    assert.equal(formatMillions(6_920_596), '6.9 million');
    assert.equal(formatMillions(6_999_999), '6.9 million');
    assert.equal(formatMillions(7_000_000), '7 million');
    assert.equal(formatMillions(12_340_000), '12.3 million');
  });

  test('refuses what it cannot say in millions', () => {
    assert.throws(() => formatMillions(999_999), RangeError);
    assert.throws(() => formatMillions(6.5e6 + 0.5), RangeError);
  });

  test('formatCount groups thousands', () => {
    assert.equal(formatCount(40622), '40,622');
  });
});

describe('no figure outside the data file', () => {
  // og-image.svg is written from the data file by scripts/og-image.mjs and
  // checked against it below.
  test('the page sources carry no hard-coded case count', () => {
    const files = [
      ...walk(join(WEB, 'src'), ['.astro', '.js', '.mjs', '.md']),
      ...walk(join(WEB, 'public'), ['.html', '.js', '.svg', '.json']),
    ].filter((f) => !f.endsWith(join('public', 'og-image.svg')));
    const offenders = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(FIGURE)) offenders.push(`${relative(WEB, file)}: "${m[0]}"`);
    }
    assert.deepEqual(offenders, []);
  });

  test('every page in a build gives the same figure as the data file', { skip: !existsSync(join(WEB, 'dist')) && 'no web/dist; run the site build first' }, () => {
    const pages = walk(join(WEB, 'dist'), ['.html']);
    assert.ok(pages.length > 0);
    const wrong = [];
    for (const page of pages) {
      const html = readFileSync(page, 'utf8');
      for (const m of html.matchAll(FIGURE)) {
        if (m[0] !== casesLabel) wrong.push(`${relative(WEB, page)}: "${m[0]}"`);
      }
    }
    assert.deepEqual(wrong, []);
    const home = readFileSync(join(WEB, 'dist', 'index.html'), 'utf8');
    assert.ok(home.includes(casesLabel), `home page lacks "${casesLabel}"`);
    assert.ok(home.includes(yearRange), `home page lacks "${yearRange}"`);
  });
});

describe('og-image', () => {
  const svg = readFileSync(join(WEB, 'public', 'og-image.svg'), 'utf8');

  test('the SVG gives the figures from the data file', () => {
    assert.ok(svg.includes(`${casesLabel} · ${yearRange}`), `og-image.svg lacks "${casesLabel} · ${yearRange}"`);
  });

  test('the PNG was rendered from the current SVG (npm --prefix web run og-image)', () => {
    const png = readFileSync(join(WEB, 'public', 'og-image.png'));
    const chunks = pngTextChunks(png);
    const sha = createHash('sha256').update(svg).digest('hex');
    assert.equal(chunks['stare:source-sha256'], sha);
  });
});
