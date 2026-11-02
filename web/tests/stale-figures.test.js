// CAP's own figures given as the whole collection (#297). The site holds CAP's
// finished scan and CourtListener's records, so CAP's case count ("6.9 million") and
// its last year (2020, as the end of a range) belong only in text about CAP. This
// scans every page and file of a build, block by block (a paragraph, a list item, a
// meta description, a JSON-LD string, a line of llms.txt), and fails on such a figure
// in a block that doesn't name CAP, or that names CourtListener too.
//
// Release notes (/updates, the feed, /about's "What's new") are dated records of
// what changed and are left out.
//
// Skipped without web/dist, unless STARE_REQUIRE_DIST is set, as build-web sets it
// after the build.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { cap, formatCount, formatMillions } from '../src/lib/collection.js';

const WEB = new URL('..', import.meta.url).pathname;
const DIST = join(WEB, 'dist');
const SKIPPED = ['updates/index.html', 'updates.xml'];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const capYear = String(cap.last_year);
const STALE = [
  new RegExp(`\\b${escape(formatMillions(cap.cases))}\\b`),
  new RegExp(`\\b${escape(formatCount(cap.cases))}\\b`),
  new RegExp(`\\b\\d{4}\\s*(?:–|—|-)\\s*${capYear}\\b`),
  new RegExp(`\\bbetween \\d{4} and ${capYear}\\b`, 'i'),
  new RegExp(`\\b(?:through|until|up to|to)\\s+${capYear}\\b`),
];
const NAMES_CAP = /Caselaw Access Project|\bCAP\b/;
const NAMES_CL = /CourtListener/;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', middot: '·', sect: '§' };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });

function jsonStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => jsonStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => jsonStrings(v, out));
  return out;
}

const BLOCK = /<\/?(?:p|li|ul|ol|div|h[1-6]|section|article|header|footer|nav|main|aside|table|tr|td|th|dl|dd|dt|blockquote|figure|figcaption|form|label|button|br|title)\b[^>]*>/gi;

/** The blocks of text in a file, by its kind. */
export function blocks(name, text) {
  if (name.endsWith('.json')) return jsonStrings(JSON.parse(text));
  if (name.endsWith('.txt') || name.endsWith('.md')) return text.split('\n');
  if (name.endsWith('.svg')) return [...text.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map((m) => decode(m[1]));
  if (!name.endsWith('.html') && !name.endsWith('.xml')) return [];
  const out = [];
  for (const m of text.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    out.push(...jsonStrings(JSON.parse(m[1])));
  }
  for (const m of text.matchAll(/<meta\b[^>]*\bcontent="([^"]*)"/gi)) out.push(decode(m[1]));
  const body = text
    .replace(/<section class="whats-new-release"[\s\S]*?<\/section>/g, '')
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(BLOCK, '\n\n')
    .replace(/<[^>]+>/g, '');
  out.push(...decode(body).split(/\n\s*\n/));
  return out.map((b) => b.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** The blocks that give one of CAP's figures without being about CAP alone. */
export function staleBlocks(name, text) {
  return blocks(name, text).filter(
    (b) => STALE.some((re) => re.test(b)) && !(NAMES_CAP.test(b) && !NAMES_CL.test(b)),
  );
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe('staleBlocks', () => {
  test('flags CAP\'s figures given as the collection\'s', () => {
    const page = `<html><head><meta name="description" content="6.9 million cases, 1658&ndash;2020. No server.">
      <script type="application/ld+json">{"description":"A citation index, 6.9 million cases from the Caselaw Access Project and 900,342 records from CourtListener"}</script></head>
      <body><div><strong>6.9 million cases</strong><span>1658 to 2020</span></div><p>Decisions up to 2020.</p></body></html>`;
    assert.deepEqual(staleBlocks('index.html', page), [
      'A citation index, 6.9 million cases from the Caselaw Access Project and 900,342 records from CourtListener',
      '6.9 million cases, 1658–2020. No server.',
      '6.9 million cases1658 to 2020',
      'Decisions up to 2020.',
    ]);
    assert.deepEqual(staleBlocks('llms.txt', '# t\n\n> It has case law decided from 1658 to 2020, 6.9 million cases.\n'), [
      '> It has case law decided from 1658 to 2020, 6.9 million cases.',
    ]);
  });

  test('leaves sentences about CAP alone, and other years', () => {
    const page = `<body><p>Most of the cases come from the <a href="https://case.law/">Caselaw Access Project</a> (CAP). Between 2013 and 2018 Harvard scanned 40,622 volumes holding 6.9 million cases, decided between 1658 and 2020.</p>
      <p>7.8 million decisions from 1658 to 2026, from the Caselaw Access Project and CourtListener.</p>
      <section class="whats-new-release"><li>Show 6.9 million cases, 1658-2020</li></section></body>`;
    assert.deepEqual(staleBlocks('about/index.html', page), []);
    assert.deepEqual(staleBlocks('openapi.json', JSON.stringify({ d: 'A JSON Schema, draft 2020-12', c: 'Copyright (c) 2020, Free Law Project' })), []);
    assert.deepEqual(staleBlocks('data/index.html', '<p>under their BSD 2-Clause licence (Copyright (c) 2014 and 2020, Free Law Project).</p>'), []);
  });
});

describe('the built site', () => {
  const have = existsSync(DIST);
  test('gives no CAP figure as the whole collection\'s', { skip: !have && !process.env.STARE_REQUIRE_DIST && 'no web/dist; run the site build first' }, () => {
    assert.ok(have, 'STARE_REQUIRE_DIST is set and there is no web/dist');
    const files = walk(DIST).filter((f) => /\.(html|xml|txt|json|svg)$/.test(f) && !SKIPPED.includes(relative(DIST, f)));
    assert.ok(files.some((f) => f.endsWith('index.html')));
    const stale = files.flatMap((f) => staleBlocks(f, readFileSync(f, 'utf8')).map((b) => `${relative(DIST, f)}: ${b}`));
    assert.deepEqual(stale, []);
  });
});
