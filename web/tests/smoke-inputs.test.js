import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';

import { GENERATED, NOT_INPUTS, SCOPED_READS, SHARED, SHARED_EXCLUDE, SPECS } from '../e2e/inputs.js';
import {
  ROOT, filterFor, generatedFiles, globRegExp, isInput, isNotInput, matches, mergeLedgers, plan, record,
  specOutcomes, trackedFiles,
} from '../e2e/select.mjs';

// The map in web/e2e/inputs.js decides which smoke specs a PR can skip (#294), so it
// has to cover the site: every file under web/ is some spec's input or listed as not
// one, and each spec's inputs are closed under what they import, fetch by path or read.

const tracked = trackedFiles();
const generated = generatedFiles();
const files = [...new Set([...tracked, ...generated])].sort();

test('globs: ** spans directories, * stays in one', () => {
  assert.ok(globRegExp('web/public/js/**').test('web/public/js/a/b.js'));
  assert.ok(globRegExp('web/src/**').test('web/src/x.css'));
  assert.ok(globRegExp('web/public/favicon*').test('web/public/favicon-32.png'));
  assert.ok(!globRegExp('web/public/favicon*').test('web/public/x/favicon.ico'));
  assert.ok(!globRegExp('schemas/*.schema.json').test('schemas/a/b.schema.json'));
  assert.ok(!globRegExp('web/public/reporters.json').test('web/public/reportersXjson'));
});

test('every file under web/ is a smoke spec\'s input or in NOT_INPUTS', () => {
  const specFiles = Object.keys(SPECS);
  const orphans = tracked.filter((f) => f.startsWith('web/')
    && !specFiles.some((s) => isInput(f, s)) && !isNotInput(f));
  assert.deepEqual(orphans, [], 'add these to SHARED, a group in web/e2e/inputs.js, or NOT_INPUTS');
});

test('every spec under web/e2e/ is in SPECS, and every entry in SPECS exists', () => {
  const onDisk = readdirSync(join(ROOT, 'web/e2e')).filter((n) => /\.spec\.[cm]?js$/.test(n)).map((n) => `web/e2e/${n}`).sort();
  assert.deepEqual(Object.keys(SPECS).sort(), onDisk);
});

test('every glob in the map matches a file', () => {
  const globs = [...SHARED, ...SHARED_EXCLUDE, ...Object.values(SPECS).flatMap((parts) => parts.flatMap((p) => [...p.include, ...p.exclude, ...(p.names ?? [])]))];
  // The generated files exist only after the build; build-site runs these tests after the
  // WASM build but before citare's bundle and the reporter map.
  const stale = [...new Set(globs)].filter((g) => !GENERATED.includes(g) && !files.some((f) => matches(f, [g])));
  assert.deepEqual(stale, []);
});

// What a source file depends on, as repo paths; a path ending in / stands for a directory.
// Relative imports (static, dynamic, `export from`, CSS @import), `new URL('...',
// import.meta.url)`, `import.meta.glob`, and site paths: '/js/x.js' in a string, src= or
// href= attributes with a file extension, and CSS url('/...'). Bare package specifiers
// come from package-lock.json, which is in SHARED.
const SITE_PATH = /['"`](\/(?:js|wasm|data\/citare|fonts)\/[^'"`$?#\s]*|\/reporters\.json|\/llms\.txt|\/openapi\.json)['"`]/g;
function dependencies(file, text) {
  const dir = posix.dirname(file);
  const out = new Set();
  const rel = (spec) => {
    const clean = spec.replace(/\?.*$/, '');
    if (clean.startsWith('./') || clean.startsWith('../')) {
      out.add(posix.normalize(posix.join(dir, clean)));
    } else if (clean.startsWith('/')) {
      // A site path: a file in public/ or one the build generates there. Other site
      // paths are pages, endpoints or public/vendor/, which the build makes from src/
      // and node_modules.
      const p = `web/public${clean}`;
      if (existsSync(join(ROOT, p)) || matches(p, GENERATED) || matches(`${p}x`, GENERATED)) out.add(p);
    }
  };
  const all = (re, f = rel) => { for (const m of text.matchAll(re)) f(m[1]); };
  if (/\.(js|mjs|astro)$/.test(file)) {
    all(/^\s*(?:import|export)\s(?:[^'"()]*?\sfrom\s)?['"]([^'"]+)['"]/gm);
    all(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g);
    all(/new URL\(\s*['"`]([^'"`$]+)['"`]\s*,\s*import\.meta\.url\s*\)/g);
    all(/import\.meta\.glob\(\s*['"]([^'"]+)['"]/g);
    all(SITE_PATH);
  }
  if (file.endsWith('.astro')) all(/\b(?:src|href)=["'](\/[^"'?#]+\.[a-z0-9]+)["']/g);
  if (file.endsWith('.css')) {
    all(/@import\s+(?:url\()?['"]([^'"]+)['"]/g);
    all(/url\(\s*['"]?(\/[^'")?#]+)/g);
  }
  return [...out].filter((p) => !p.startsWith('web/node_modules/'));
}

// A dependency is covered when the spec's inputs include it; a directory or glob when
// they include something under it.
function covered(dep, spec) {
  if (dep.includes('*')) {
    const re = globRegExp(dep);
    const hits = files.filter((f) => re.test(f));
    return hits.length > 0 && hits.every((f) => isInput(f, spec));
  }
  if (dep.endsWith('/')) {
    const under = files.filter((f) => f.startsWith(dep));
    return under.length > 0 ? under.every((f) => isInput(f, spec)) : isInput(`${dep}x`, spec);
  }
  return isInput(dep, spec);
}

test('each spec\'s inputs include everything they import, fetch by path or read', () => {
  const problems = [];
  for (const spec of Object.keys(SPECS)) {
    const mine = files.filter((f) => isInput(f, spec) && existsSync(join(ROOT, f)) && /\.(js|mjs|astro|css)$/.test(f));
    for (const file of mine) {
      for (const dep of dependencies(file, readFileSync(join(ROOT, file), 'utf8'))) {
        if (SCOPED_READS[file]?.[dep]) continue;
        if (!covered(dep, spec)) problems.push(`${spec}: ${file} -> ${dep}`);
      }
    }
  }
  assert.deepEqual(problems, [], 'add the dependency to the spec\'s inputs in web/e2e/inputs.js');
});

test('the dependency scan finds what the specs and pages use', () => {
  const deps = (f) => dependencies(f, readFileSync(join(ROOT, f), 'utf8'));
  assert.ok(deps('web/e2e/search.spec.js').includes('web/tests/fixtures/searchtree.js'));
  assert.ok(deps('web/tests/fixtures/searchtree.js').includes('web/tests/fixtures/search-tree/'));
  assert.ok(deps('web/src/pages/index.astro').includes('web/public/js/main.js'));
  assert.ok(deps('web/src/pages/about.astro').includes('CHANGELOG.md'));
  assert.ok(deps('web/public/js/main.js').includes('web/public/js/pdfviewer.js'));
  assert.ok(deps('web/src/styles/layout.css').includes('web/src/vendor/cp-footer/footer.css'));
  assert.ok(deps('web/src/pages/schemas/[name].json.js').includes('schemas/*.schema.json'));
});

test('a spec for each page view: caseload doesn\'t take the search page, search.spec does', () => {
  assert.ok(!isInput('web/public/js/searchpage.js', 'web/e2e/caseload.spec.js'));
  assert.ok(isInput('web/public/js/searchpage.js', 'web/e2e/search.spec.js'));
  assert.ok(isInput('web/public/js/main.js', 'web/e2e/search.spec.js'));
  assert.ok(!isInput('web/public/js/datapage.js', 'web/e2e/search.spec.js'));
  assert.ok(!isInput('README.md', 'web/e2e/smoke.spec.js'));
  assert.ok(!isInput('docs/x.md', 'web/e2e/smoke.spec.js'));
});

test('the filter for a spec matches only that spec', () => {
  const re = new RegExp(filterFor('web/e2e/cache.spec.js'));
  assert.ok(re.test('/runner/_work/stare/stare/web/e2e/cache.spec.js'));
  assert.ok(!re.test('/runner/_work/stare/stare/web/e2e/zipcache.spec.js'));
});

const KEYS = { format: 1, specs: { 'web/e2e/a.spec.js': 'k-a', 'web/e2e/b.spec.js': 'k-b' } };
const report = (tests) => ({
  suites: Object.entries(tests).map(([file, statuses]) => ({
    file,
    specs: statuses.map(([status, tries = 1]) => ({ tests: [{ status, results: Array(tries).fill({}) }] })),
  })),
});

test('plan: a spec runs unless its own key has a recorded pass; all runs everything', () => {
  const ledger = { format: 1, entries: { 'k-a': { spec: 'web/e2e/a.spec.js', ok: true, run: 'https://x/runs/1', at: '2026-11-01T00:00:00Z' } } };
  const affected = plan(KEYS, ledger, 'affected');
  assert.deepEqual(affected.run.map((r) => r.spec), ['web/e2e/b.spec.js']);
  assert.deepEqual(affected.reused.map((r) => r.spec), ['web/e2e/a.spec.js']);
  assert.equal(plan(KEYS, ledger, 'all').run.length, 2);
  // The same key recorded for another spec isn't this spec's pass.
  const other = { format: 1, entries: { 'k-a': { ...ledger.entries['k-a'], spec: 'web/e2e/b.spec.js' } } };
  assert.equal(plan(KEYS, other, 'affected').run.length, 2);
  // A recorded failure isn't a pass.
  const failed = { format: 1, entries: { 'k-a': { ...ledger.entries['k-a'], ok: false } } };
  assert.equal(plan(KEYS, failed, 'affected').run.length, 2);
  // A spec file the map doesn't know runs.
  const extra = plan(KEYS, ledger, 'affected', ['web/e2e/a.spec.js', 'web/e2e/b.spec.js', 'web/e2e/new.spec.js']);
  assert.deepEqual(extra.run.map((r) => r.spec), ['web/e2e/b.spec.js', 'web/e2e/new.spec.js']);
});

test('record: passes on the first try recorded as passes, failures and flakes as failures, old entries dropped', () => {
  const now = new Date('2026-11-02T00:00:00Z');
  const ledger = { format: 1, entries: {
    'k-b': { spec: 'web/e2e/b.spec.js', run: 'r0', at: '2026-11-01T00:00:00Z' },
    old: { spec: 'web/e2e/c.spec.js', run: 'r0', at: '2026-09-01T00:00:00Z' },
  } };
  const pass = record(KEYS, report({ 'a.spec.js': [['expected'], ['expected']], 'b.spec.js': [['expected'], ['unexpected', 2]] }), ledger, { run: 'r1', now });
  assert.deepEqual(Object.keys(pass.ledger.entries).sort(), ['k-a', 'k-b']);
  assert.equal(pass.ledger.entries['k-a'].ok, true);
  assert.equal(pass.ledger.entries['k-b'].ok, false);
  assert.deepEqual(pass.outcomes, { 'web/e2e/a.spec.js': 'passed', 'web/e2e/b.spec.js': 'failed' });
  const flaky = record(KEYS, report({ 'a.spec.js': [['expected'], ['flaky', 2]] }), { format: 1, entries: {} }, { run: 'r1', now });
  assert.equal(flaky.ledger.entries['k-a'].ok, false);
  const skipped = record(KEYS, report({ 'a.spec.js': [['skipped', 0]] }), { format: 1, entries: {} }, { run: 'r1', now });
  assert.equal(skipped.ledger.entries['k-a'].ok, false);
  // A newer failure in one ledger outweighs an older pass in another.
  const merged = mergeLedgers([pass.ledger, { format: 1, entries: { 'k-b': { spec: 'web/e2e/b.spec.js', ok: true, run: 'r0', at: '2026-11-01T00:00:00Z' } } }]);
  assert.equal(plan(KEYS, merged, 'affected').run.map((r) => r.spec).includes('web/e2e/b.spec.js'), true);
});

test('specOutcomes reads nested describe blocks', () => {
  const r = { suites: [{ file: 'a.spec.js', specs: [], suites: [{ title: 'd', specs: [{ tests: [{ status: 'unexpected', results: [{}] }] }] }] }] };
  assert.deepEqual(specOutcomes(r), { 'web/e2e/a.spec.js': 'failed' });
});

test('mergeLedgers keeps the latest entry for a key', () => {
  const a = { format: 1, entries: { k: { spec: 's', run: 'old', at: '2026-10-01T00:00:00Z' } } };
  const b = { format: 1, entries: { k: { spec: 's', run: 'new', at: '2026-10-02T00:00:00Z' } } };
  assert.equal(mergeLedgers([a, b]).entries.k.run, 'new');
  assert.equal(mergeLedgers([b, a]).entries.k.run, 'new');
});

test('NOT_INPUTS says why for each entry', () => {
  for (const [glob, why] of Object.entries(NOT_INPUTS)) assert.ok(why.length > 5, glob);
});
