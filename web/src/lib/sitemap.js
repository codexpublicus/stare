// The site's sitemap.xml (codexpublicus/stare#171), written by the build
// (astro.config.mjs) from the pages in src/pages.
//
// Each page's <lastmod> is the date of the last commit that touched the page or
// anything it renders from: the components, libraries and data it imports, and
// CHANGELOG.md for /about and /updates. Stylesheets are left out, since a style
// change doesn't change what a page says, and so is the footer's per-build
// release tag, which comes from the environment rather than a file. A crawler
// that trusts lastmod then refetches a page only when its content changed.
//
// In a shallow clone (the PR and main preview builds check out one commit) git
// can't date a file, so the build leaves lastmod out rather than guessing; the
// release build checks out the full history and dates every page.
//
// Case pages aren't here yet. The curated set (#172) goes under CURATED_PREFIX
// with its own lastmod from the record, and the rest of the corpus under
// FULL_PREFIX, which robots.txt disallows.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

export const SITE = 'https://stare.pub';
export const CURATED_PREFIX = '/case/';
export const FULL_PREFIX = '/c/';

// Source files whose changes count as a page's content changing.
const FOLLOW = new Set(['.astro', '.js', '.mjs', '.ts']);
const LEAF = new Set(['.json', '.md']);

const IMPORT = /\bimport\s+(?:[\w*{}\s,]+?\s+from\s+)?['"]([^'"]+)['"]/g;

// The relative imports in a source file, resolved to absolute paths without
// their query (`?raw`). Bare package specifiers are dependencies, not content.
export function relativeImports(file, text) {
  const out = [];
  for (const [, spec] of text.matchAll(IMPORT)) {
    if (!spec.startsWith('.')) continue;
    out.push(resolve(dirname(file), spec.replace(/\?.*$/, '')));
  }
  return out;
}

// The page plus every content file it imports, transitively.
export function contentFiles(page, read = (f) => readFileSync(f, 'utf8')) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    const ext = extname(file);
    if (!FOLLOW.has(ext) && !LEAF.has(ext)) return;
    seen.add(file);
    if (FOLLOW.has(ext)) for (const dep of relativeImports(file, read(file))) visit(dep);
  };
  visit(resolve(page));
  return [...seen].sort();
}

// The URL path of each HTML page in `pagesDir`: `index.astro` is `/`, `about.astro`
// `/about/` (the site serves directory URLs; `/about` redirects there). Endpoints
// (`updates.xml.js`), dynamic routes and underscore-prefixed files aren't pages.
export function sitePages(pagesDir) {
  const pages = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.name.startsWith('_') || entry.name.includes('[')) continue;
      if (entry.isDirectory()) { walk(file); continue; }
      if (extname(entry.name) !== '.astro') continue;
      const route = relative(pagesDir, file).replace(/\.astro$/, '').split(/[\\/]/);
      if (route.at(-1) === 'index') route.pop();
      pages.push({ path: route.length ? `/${route.join('/')}/` : '/', file });
    }
  };
  walk(pagesDir);
  return pages.sort((a, b) => a.path.localeCompare(b.path));
}

export function isShallow(cwd) {
  return execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd, encoding: 'utf8' }).trim() === 'true';
}

// The committer date (strict ISO 8601) of the last commit touching any of `files`,
// or null when none has.
export function lastCommitDate(files, cwd) {
  const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', ...files], { cwd, encoding: 'utf8' }).trim();
  return out || null;
}

const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// sitemaps.org's urlset. Google ignores <priority> and <changefreq>, so there are none.
export function renderSitemap(entries) {
  const urls = entries.map(({ loc, lastmod }) => [
    '  <url>',
    `    <loc>${escapeXml(loc)}</loc>`,
    ...(lastmod ? [`    <lastmod>${lastmod}</lastmod>`] : []),
    '  </url>',
  ].join('\n'));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}

// Every page with its lastmod, or without one in a shallow clone.
export function sitemapEntries(pagesDir, { dated = true } = {}) {
  return sitePages(pagesDir).map(({ path, file }) => {
    const files = contentFiles(file).filter(existsSync);
    const lastmod = dated ? lastCommitDate(files, dirname(file)) : null;
    return { loc: `${SITE}${path}`, lastmod };
  });
}

// Checks a sitemap's text the way a crawler reads it: well-formed enough to find
// every <url>, each with an absolute https loc on SITE and an ISO date lastmod if
// any. Returns the locs; throws naming the first problem.
export function parseSitemap(xml) {
  if (!xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')) throw new Error('sitemap: no XML declaration');
  if (!/<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/.test(xml)) throw new Error('sitemap: no sitemaps.org urlset');
  if (!xml.trimEnd().endsWith('</urlset>')) throw new Error('sitemap: urlset not closed');
  const blocks = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
  if (blocks.length === 0) throw new Error('sitemap: no <url> entries');
  return blocks.map((block) => {
    const loc = block.match(/<loc>([^<]+)<\/loc>/)?.[1];
    if (!loc || !loc.startsWith(`${SITE}/`)) throw new Error(`sitemap: bad loc ${loc}`);
    const lastmod = block.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1];
    if (lastmod !== undefined && Number.isNaN(Date.parse(lastmod))) throw new Error(`sitemap: bad lastmod ${lastmod} for ${loc}`);
    if (/<(priority|changefreq)>/.test(block)) throw new Error(`sitemap: ${loc} has priority or changefreq`);
    return { loc, lastmod: lastmod ?? null };
  });
}
