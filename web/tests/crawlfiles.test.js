// robots.txt, llms.txt and the sitemap (codexpublicus/stare#171, #161).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isAllowed, parseLlmsTxt, parseRobots } from '../src/lib/crawlfiles.js';
import {
  CASE_PREFIX, ROBOTS_MAX_BYTES, curatedAllows, curatedSet, curatedSitemapEntries, renderRobots,
} from '../src/lib/robots.js';
import {
  SITE, contentFiles, parseSitemap, relativeImports, renderSitemap, sitePages,
} from '../src/lib/sitemap.js';

const publicFile = (name) => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
const pagesDir = fileURLToPath(new URL('../src/pages/', import.meta.url));
const curatedList = JSON.parse(readFileSync(new URL('../src/data/curated.json', import.meta.url), 'utf8'));
const groupOf = (text) => parseRobots(text).groups.find((g) => g.agents.includes('*'));

describe('robots.txt (ruling D44)', () => {
  const text = renderRobots(curatedSet(curatedList));
  const robots = parseRobots(text);
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

  test('allows the site pages and disallows /c/', () => {
    for (const path of ['/', '/about/', '/check/', '/data/', '/updates/', '/updates.xml', '/llms.txt',
      '/js/main.js', '/wasm/stare_wasm_bg.wasm']) {
      assert.ok(isAllowed(all, path), path);
    }
    for (const path of [CASE_PREFIX, `${CASE_PREFIX}zz-not-curated/1/1/`]) assert.ok(!isAllowed(all, path), path);
  });

  test('/c/ catches no site page that starts with its letter', () => {
    assert.ok(isAllowed(all, '/check/'));
    assert.ok(isAllowed(all, '/c'));
  });

  test('allows exactly the curated set from src/data/curated.json', () => {
    const allows = all.allow.filter((p) => p.startsWith(CASE_PREFIX)).sort();
    assert.deepEqual(allows, curatedAllows(curatedSet(curatedList)));
  });

  test('a curated case is allowed at its one /c/ URL, and its neighbours are not', () => {
    const g = groupOf(renderRobots(curatedSet([{ path: 'a2d/31/647' }])));
    assert.ok(isAllowed(g, '/c/a2d/31/647/'));
    assert.ok(!isAllowed(g, '/c/a2d/31/6470/'));
    assert.ok(!isAllowed(g, '/c/a2d/31/648/'));
    assert.ok(isAllowed(g, '/about/'));
  });

  test('a subpath allows a whole volume or reporter and replaces the cases under it', () => {
    const set = curatedSet([
      { path: 'a2d/31/647' }, { path: 'a2d/31/' }, { path: 'us/' }, { path: 'us/598/175' }, { path: 'us/598/' },
      { path: 'f2d/1/1' },
    ]);
    assert.deepEqual(curatedAllows(set), ['/c/a2d/31/', '/c/f2d/1/1/', '/c/us/']);
    const g = groupOf(renderRobots(set));
    assert.ok(isAllowed(g, '/c/a2d/31/9/'));
    assert.ok(!isAllowed(g, '/c/a2d/32/1/'));
    assert.ok(isAllowed(g, '/c/us/1/1/'));
    // The sitemap still lists every curated case, not the subpaths.
    assert.deepEqual(curatedSitemapEntries(set).map((e) => e.loc),
      [`${SITE}/c/a2d/31/647/`, `${SITE}/c/f2d/1/1/`, `${SITE}/c/us/598/175/`]);
  });

  test('10,000 single cases with long slugs fit under 500 KiB, and more throws', () => {
    const many = (n) => Array.from({ length: n }, (_, i) => ({ path: `cal-app-4th-supp-something/${1000 + (i % 9000)}/${10000 + i}` }));
    const text = renderRobots(curatedSet(many(10_000)));
    assert.ok(new TextEncoder().encode(text).length <= ROBOTS_MAX_BYTES);
    assert.equal(groupOf(text).allow.length, 10_001);
    assert.throws(() => renderRobots(curatedSet(many(20_000))), /past the 512000/);
  });

  test('curatedSet rejects bad paths, bad dates and duplicates', () => {
    assert.throws(() => curatedSet({}), /not an array/);
    for (const path of ['A2d/31/647', 'a2d/31', 'a2d/31/647/', '/a2d/31/647', 'a2d/*/647', 'a2d/31/64$', 'a2d/3 1/647']) {
      assert.throws(() => curatedSet([{ path }]), /bad path/, path);
    }
    assert.throws(() => curatedSet([{ path: 'a2d/31/647', lastmod: 'yesterday' }]), /bad lastmod/);
    assert.throws(() => curatedSet([{ path: 'a2d/31/' , lastmod: '2026-10-18' }]), /has no lastmod/);
    assert.throws(() => curatedSet([{ path: 'a2d/31/647' }, { path: 'a2d/31/647' }]), /twice/);
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
      ['Resolving a citation', 'Pages', 'Files', 'Licences', 'Local tools', 'Crawling and use']);
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

  test('curated cases follow the pages, at their /c/ URL with the lastmod curated.json gives', () => {
    const set = curatedSet([{ path: 'us/598/175', lastmod: '2026-10-18' }, { path: 'a2d/31/647' }]);
    assert.deepEqual(curatedSitemapEntries(set), [
      { loc: `${SITE}/c/a2d/31/647/`, lastmod: null },
      { loc: `${SITE}/c/us/598/175/`, lastmod: '2026-10-18' },
    ]);
    assert.deepEqual(parseSitemap(renderSitemap(curatedSitemapEntries(set))).map((e) => e.loc),
      [`${SITE}/c/a2d/31/647/`, `${SITE}/c/us/598/175/`]);
  });

  test('a page\'s content files are what it imports, not its styles', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const files = contentFiles(`${pagesDir}about.astro`).map((f) => relative(root, f));
    assert.deepEqual(files, [
      'CHANGELOG.md',
      'web/src/components/Brand.astro',
      'web/src/components/SiteFooter.astro',
      'web/src/components/SiteHead.astro',
      'web/src/data/collection.json',
      'web/src/lib/changelog.js',
      'web/src/lib/collection.js',
      'web/src/lib/marks.js',
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
