// What each smoke spec tests, as paths from the repo root (#294). A pull request's
// Preview PR job hashes each spec's inputs (select.mjs) and skips a spec whose hash
// already has a recorded pass; pushes to main, the release PR, the nightly run and the
// `full-smoke` label run every spec. web/tests/smoke-inputs.test.js fails if a file
// under web/ belongs to no spec and isn't in NOT_INPUTS, or if a spec's inputs import,
// fetch by path or read a file outside them, so this map can't silently fall behind.
//
// Globs: `*` matches within one path segment, `**` across segments. An input that
// belongs to a group every spec uses goes in SHARED; when in doubt, put it there:
// a file in SHARED reruns everything, a file left out of a spec that needs it lets
// a broken change skip that spec.

// Built by build-site before the smoke test, not in git: hashed as built, so a Rust
// change that leaves the WASM byte-identical reruns nothing.
export const GENERATED = [
  'web/public/wasm/**',
  'web/public/data/citare/**',
  'web/public/reporters.json',
];

// Every spec's inputs: the harness, the build, and what every page loads.
export const SHARED = [
  // The harness: this map, the selector, Playwright's config and version, and how CI runs it
  'web/e2e/inputs.js',
  'web/e2e/select.mjs',
  'web/playwright.config.js',
  'web/package.json',
  'web/package-lock.json',
  '.github/actions/smoke-test/**',
  // The build: Astro's config and integrations, the Worker's config, how CI builds
  'web/astro.config.mjs',
  'web/tsconfig.json',
  'wrangler.jsonc',
  'worker/**',
  '.github/actions/build-site/**',
  '.github/actions/build-web/**',
  'web/public/_headers',
  // Every page's head, header, footer, styles, fonts and figures
  'web/src/components/**',
  'web/src/lib/**',
  'web/src/data/**',
  'web/src/styles/theme.css',
  'web/src/styles/layout.css',
  'web/src/styles/fonts.css',
  'web/src/styles/fonts-fallback.css',
  'web/src/styles/fonts-themes.css',
  'web/src/vendor/cp-footer/**',
  'web/public/fonts/**',
  'web/public/favicon*',
  'web/public/apple-touch-icon.png',
  'web/public/og-image.*',
  // The footer's data line (SiteFooter.astro) and the modules astro.config.mjs imports
  'web/public/js/dataversion.js',
  'web/public/js/sources.js',
  'web/public/js/pdfjs-path.js',
  'web/public/js/searchclient-path.js',
];

// Files a SHARED glob takes in that only some specs need.
export const SHARED_EXCLUDE = [];

// The search page's own files, which nothing else loads.
const SEARCH_ONLY_JS = [
  'web/public/js/searchpage.js',
  'web/public/js/searchquery.js',
  'web/public/js/searchfilters.js',
];
// The /data page's own module.
const DATA_ONLY_JS = ['web/public/js/datapage.js'];

// The reader (/), with every module main.js imports statically or lazily, and the WASM,
// citare's bundle and the reporter map it fetches. A new module under public/js/ joins
// the reader unless it's added to a narrower group above.
const READER = {
  include: [
    'web/src/pages/index.astro',
    'web/public/js/**',
    'web/src/styles/reader.css',
    'web/src/styles/suggest.css',
    // Older static copies of one volume's index files (smoke.spec.js names them)
    'web/public/data/a2d/**',
    ...GENERATED,
  ],
  exclude: [...SEARCH_ONLY_JS, ...DATA_ONLY_JS],
};

// /check, which loads the reader's citation modules (in READER).
const CHECK = ['web/src/pages/check.astro'];

// The site's other pages and the files agents read.
const PAGES = [
  'web/src/pages/about.astro',
  'web/src/pages/data.astro',
  'web/src/pages/updates.astro',
  'web/src/pages/updates.xml.js',
  'web/src/pages/robots.txt.js',
  'web/src/pages/schemas/**',
  'web/src/styles/data.css',
  ...DATA_ONLY_JS,
  'web/public/llms.txt',
  'web/public/openapi.json',
  'CHANGELOG.md',
  'schemas/*.schema.json',
];

// The search page, its bundled clients, one per search format (src/lib/searchvendor.js
// bundles src/vendor/ into public/vendor/ at build time), and the search tree fixtures
// search.spec.js serves, one per format.
const SEARCH = [
  'web/src/pages/search.astro',
  'web/src/styles/search.css',
  ...SEARCH_ONLY_JS,
  'web/src/vendor/search-client.json',
  'web/src/vendor/roaringbuckets-client/**',
  'web/src/vendor/stare-search/**',
  'web/src/vendor/stare-search-format2/**',
  'web/tests/fixtures/searchtree.js',
  'web/tests/fixtures/search-expected.json',
  'web/tests/fixtures/search-tree/**',
  'web/tests/fixtures/search-expected-format3.json',
  'web/tests/fixtures/search-tree-format3/**',
];

// sitemap.xml lists every page in src/pages/ (undated in a PR's shallow build), so a
// spec that reads it depends on which pages exist: their names, not their contents.
const SITEMAP = { include: [], exclude: [], names: ['web/src/pages/**'] };

// A spec's groups, each { include, exclude, names }: an exclude applies only to its own
// group, and a file matching `names` adds its path to the hash but not its contents.
const group = (...parts) => parts.map((p) => (Array.isArray(p) ? { include: p, exclude: [] } : p));

// Each spec under web/e2e/ and the groups it tests, beyond SHARED and the spec itself.
export const SPECS = {
  'web/e2e/addresses.spec.js': group(READER, ['web/tests/fixtures/crk/**']),
  'web/e2e/agents.spec.js': group(READER, PAGES),
  'web/e2e/cache.spec.js': group(READER, CHECK, PAGES, SITEMAP),
  'web/e2e/caseload.spec.js': group(READER),
  'web/e2e/caseswitch.spec.js': group(READER),
  'web/e2e/onebox.spec.js': group(READER, SEARCH),
  'web/e2e/resilience.spec.js': group(READER, CHECK, PAGES),
  'web/e2e/search.spec.js': group(READER, SEARCH),
  'web/e2e/smoke.spec.js': group(READER, CHECK, PAGES, SITEMAP, [
    'crates/stare/tests/fixtures/cl-record.json',
    'crates/stare/tests/fixtures/cl-record-blocked.json',
  ]),
  'web/e2e/zipcache.spec.js': group(READER),
};

// Files under web/ that no smoke spec tests, and why. Anything else under web/ must be
// in SHARED or a spec's inputs.
export const NOT_INPUTS = {
  'web/README.md': 'documentation',
  'web/.gitignore': 'git configuration',
  'web/.vscode/**': 'editor settings',
  'web/public/wasm/.gitignore': 'git configuration',
  'web/tests/**': 'unit tests, which build-site runs with node --test (the search fixture is in SEARCH)',
  'web/checks/**': 'the content-blocker check, which build-site runs on the build',
  'web/scripts/**': 'maintenance scripts whose outputs (fonts, marks, og-image, fixtures) are committed',
};

// The files outside the site that external data the specs fetch at run time comes
// from: a new index or scans manifest reruns everything. Fetched by select.mjs when
// it hashes; if one can't be fetched, every spec runs.
export const EXTERNAL = [
  'https://idx.stare.pub/manifest.json',
  'https://data.stare.pub/pdf/manifest.json',
];

// Reads the dependency scan in web/tests/smoke-inputs.test.js finds in a SHARED file but
// that only some specs' pages depend on, with where those specs list them.
export const SCOPED_READS = {
  'web/astro.config.mjs': {
    'web/src/pages/': 'the sitemap lists every page; the specs that read it list SITEMAP',
    'web/src/vendor/': 'the search client bundle, which only the search page loads (SEARCH)',
  },
  'web/e2e/select.mjs': {
    './': 'the repo root, whose files it hashes',
  },
  'web/src/lib/assetcache.js': {
    'web/public/js/': 'each page\'s modulepreload links follow that page\'s own imports',
  },
};
