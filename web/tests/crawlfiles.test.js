// robots.txt, llms.txt and the sitemap (codexpublicus/stare#171, #161).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isAllowed, parseLlmsTxt, parseRobots } from '../src/lib/crawlfiles.js';
import {
  CURATED_PREFIX, FULL_PREFIX, SITE, contentFiles, parseSitemap, relativeImports, renderSitemap, sitePages,
} from '../src/lib/sitemap.js';

const publicFile = (name) => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
const pagesDir = fileURLToPath(new URL('../src/pages/', import.meta.url));

describe('public/robots.txt', () => {
  const robots = parseRobots(publicFile('robots.txt'));
  const all = robots.groups.find((g) => g.agents.includes('*'));

  test('has one group, for every agent', () => {
    assert.equal(robots.groups.length, 1);
    assert.deepEqual(all.agents, ['*']);
  });

  test('states search and ai-input, and leaves ai-train unstated (D40)', () => {
    assert.deepEqual(all.signals, { search: 'yes', 'ai-input': 'yes' });
  });

  test('names the sitemap', () => {
    assert.deepEqual(robots.sitemaps, [`${SITE}/sitemap.xml`]);
  });

  test('allows the site pages and curated cases, and disallows the full corpus', () => {
    for (const path of ['/', '/about/', '/check/', '/data/', '/updates/', '/updates.xml', '/llms.txt',
      '/js/main.js', '/wasm/stare_wasm_bg.wasm', `${CURATED_PREFIX}a2d/31/647`]) {
      assert.ok(isAllowed(all, path), path);
    }
    for (const path of [`${FULL_PREFIX}a2d/31/647`, FULL_PREFIX]) {
      assert.ok(!isAllowed(all, path), path);
    }
  });

  test('the full-corpus prefix catches no site page that starts with its letter', () => {
    assert.ok(isAllowed(all, '/check/'));
    assert.ok(isAllowed(all, '/c'));
  });
});

describe('parseRobots', () => {
  test('rejects an unknown field, a rule outside a group, a relative sitemap and a bad signal', () => {
    assert.throws(() => parseRobots('User-agent: *\nCrawl-delay: 5\n'), /unknown field/);
    assert.throws(() => parseRobots('Disallow: /\n'), /before any User-agent/);
    assert.throws(() => parseRobots('Sitemap: /sitemap.xml\n'), /absolute/);
    assert.throws(() => parseRobots('User-agent: *\nContent-Signal: search=maybe\n'), /bad content signal/);
    assert.throws(() => parseRobots('User-agent: *\nContent-Signal: ai-everything=yes\n'), /bad content signal/);
  });

  test('groups consecutive user agents', () => {
    const { groups } = parseRobots('User-agent: a\nUser-agent: b\nDisallow: /\n\nUser-agent: c\nAllow: /\n');
    assert.deepEqual(groups.map((g) => g.agents), [['a', 'b'], ['c']]);
  });

  test('isAllowed takes the longest match, and Allow on a tie', () => {
    const [g] = parseRobots('User-agent: *\nDisallow: /c/\nAllow: /c/ok/\nDisallow: /x\nAllow: /x\n').groups;
    assert.ok(!isAllowed(g, '/c/no'));
    assert.ok(isAllowed(g, '/c/ok/1'));
    assert.ok(isAllowed(g, '/x'));
    assert.ok(isAllowed(g, '/'));
  });
});

describe('public/llms.txt', () => {
  const llms = parseLlmsTxt(publicFile('llms.txt'));

  test('has llmstxt.org\'s title, summary and sections', () => {
    assert.equal(llms.title, 'stare.pub');
    assert.match(llms.summary, /citation/);
    assert.deepEqual(llms.sections.map((s) => s.name),
      ['Resolving a citation', 'Pages', 'Files', 'Local tools', 'Crawling and use']);
  });

  test('links every page in the sitemap', () => {
    const linked = new Set(llms.sections.flatMap((s) => s.links.map((l) => l.url)));
    for (const { path } of sitePages(pagesDir)) assert.ok(linked.has(`${SITE}${path}`), path);
  });

  test('states the same content signals as robots.txt', () => {
    assert.match(publicFile('llms.txt'), /`search=yes, ai-input=yes`. `ai-train` is not stated/);
  });

  test('rejects a file without a title or summary', () => {
    assert.throws(() => parseLlmsTxt('stare\n'), /H1/);
    assert.throws(() => parseLlmsTxt('# stare\n\nno summary\n## A\n'), /summary/);
    assert.throws(() => parseLlmsTxt('# stare\n> s\n## A\n- [x](/rel)\n'), /absolute/);
  });
});

describe('sitemap', () => {
  test('lists every page as its directory URL, and no endpoint', () => {
    assert.deepEqual(sitePages(pagesDir).map((p) => p.path), ['/', '/about/', '/check/', '/data/', '/updates/']);
  });

  test('a page\'s content files are what it imports, not its styles', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const files = contentFiles(`${pagesDir}about.astro`).map((f) => relative(root, f));
    assert.deepEqual(files, [
      'CHANGELOG.md',
      'web/src/components/SiteFooter.astro',
      'web/src/data/collection.json',
      'web/src/lib/changelog.js',
      'web/src/lib/collection.js',
      'web/src/lib/version.js',
      'web/src/pages/about.astro',
    ]);
  });

  test('relativeImports drops queries and bare specifiers', () => {
    const src = "import a from './a.js';\nimport b from '../b.md?raw';\nimport 'astro/x';\nimport { c } from \"./c.astro\";\n";
    assert.deepEqual(relativeImports('/r/s/p.astro', src), ['/r/s/a.js', '/r/b.md', '/r/s/c.astro']);
  });

  test('renders and parses back, with lastmod only where there is one', () => {
    const xml = renderSitemap([
      { loc: `${SITE}/`, lastmod: '2026-10-17T12:00:00Z' },
      { loc: `${SITE}/about/`, lastmod: null },
    ]);
    assert.deepEqual(parseSitemap(xml), [
      { loc: `${SITE}/`, lastmod: '2026-10-17T12:00:00Z' },
      { loc: `${SITE}/about/`, lastmod: null },
    ]);
    assert.doesNotMatch(xml, /priority|changefreq/);
  });

  test('parseSitemap rejects a foreign loc and a bad date', () => {
    const one = (url) => renderSitemap([url]);
    assert.throws(() => parseSitemap(one({ loc: 'https://example.com/', lastmod: null })), /bad loc/);
    assert.throws(() => parseSitemap(one({ loc: `${SITE}/`, lastmod: 'yesterday' })), /bad lastmod/);
  });
});
