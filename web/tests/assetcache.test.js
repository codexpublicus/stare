// The build steps behind the site's long caching (#266, src/lib/assetcache.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { contentHash, fingerprintWasm, hashedName, modulePreloads, pageEntries, staticGraph } from '../src/lib/assetcache.js';

// esbuild resolves the import graph; CI runs these tests before npm ci, so the graph
// tests skip without it.
let build;
try {
  ({ build } = await import('esbuild'));
} catch {
  build = null;
}

function site(files) {
  const dir = mkdtempSync(join(tmpdir(), 'assetcache-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

test('hashedName puts the hash before the extension', () => {
  assert.equal(hashedName('stare_wasm_bg.wasm', 'abc'), 'stare_wasm_bg.abc.wasm');
  assert.equal(hashedName('stare_wasm.js', 'abc'), 'stare_wasm.abc.js');
});

test('fingerprintWasm copies the module and glue to hashed names and points wasm.js at them', (t) => {
  const loader = "// loads /wasm/stare_wasm.js\nconst GLUE_URL = '/wasm/stare_wasm.js';\nconst WASM_URL = '/wasm/stare_wasm_bg.wasm';\n";
  const dir = site({ 'js/wasm.js': loader, 'wasm/stare_wasm.js': 'glue', 'wasm/stare_wasm_bg.wasm': 'module' });
  t.after(() => rmSync(dir, { recursive: true }));
  const { module, glue } = fingerprintWasm(dir);
  assert.equal(module, `/wasm/stare_wasm_bg.${contentHash('module')}.wasm`);
  assert.equal(glue, `/wasm/stare_wasm.${contentHash('glue')}.js`);
  assert.equal(readFileSync(join(dir, module), 'utf8'), 'module');
  assert.equal(readFileSync(join(dir, glue), 'utf8'), 'glue');
  // The plain names stay.
  assert.deepEqual(readdirSync(join(dir, 'wasm')).sort(), [
    'stare_wasm.js', glue.slice(6), 'stare_wasm_bg.wasm', module.slice(6),
  ].sort());
  const stamped = readFileSync(join(dir, 'js/wasm.js'), 'utf8');
  assert.ok(stamped.includes(`const GLUE_URL = '${glue}';`));
  assert.ok(stamped.includes(`const WASM_URL = '${module}';`));
  assert.ok(stamped.startsWith('// loads /wasm/stare_wasm.js\n'), 'only the quoted literals change');
});

test('fingerprintWasm fails when the loader no longer names the plain URL once', (t) => {
  const dir = site({
    'js/wasm.js': "const WASM_URL = '/wasm/stare_wasm_bg.wasm';\n",
    'wasm/stare_wasm.js': 'glue',
    'wasm/stare_wasm_bg.wasm': 'module',
  });
  t.after(() => rmSync(dir, { recursive: true }));
  assert.throws(() => fingerprintWasm(dir), /expected the literal '\/wasm\/stare_wasm\.js' once, found it 0 times/);
});

test('pageEntries finds module scripts by src and the static imports of inline ones', () => {
  const html = `<head><script type="module" src="/js/main.js"></script>
    <script is:inline>var x = 1;</script>
    <script type="module">
      import { a } from '/js/a.js';
      import '/js/side.js';
      const later = () => import('/js/lazy.js');
    </script>
    <script src="/js/classic.js"></script></head>`;
  assert.deepEqual(pageEntries(html), ['/js/main.js', '/js/a.js', '/js/side.js']);
});

test('staticGraph follows static imports and leaves dynamic ones alone', async (t) => {
  if (!build) return t.skip('esbuild is not installed (npm --prefix web ci)');
  const dir = site({
    'js/main.js': "import { b } from './b.js';\nimport '/js/c.js';\nexport const lazy = () => import('./lazy.js');\nconst glue = '/wasm/x.js'; import(glue);\n",
    'js/b.js': "import { d } from './d.js';\nexport const b = d;\n",
    'js/c.js': "import { b } from './b.js';\nexport { b };\n",
    'js/d.js': 'export const d = 1;\n',
    'js/lazy.js': "import { d } from './d.js';\nimport './only-lazy.js';\nexport { d };\n",
    'js/only-lazy.js': 'export {};\n',
  });
  t.after(() => rmSync(dir, { recursive: true }));
  assert.deepEqual(await staticGraph(dir, ['/js/main.js'], { build }), ['/js/main.js', '/js/b.js', '/js/c.js', '/js/d.js']);
});

test('modulePreloads adds links to the pages that load modules, once', async (t) => {
  if (!build) return t.skip('esbuild is not installed (npm --prefix web ci)');
  const dir = site({
    'index.html': '<html><head><title>x</title></head><body><script type="module" src="/js/main.js"></script></body></html>',
    'about/index.html': '<html><head></head><body>no scripts</body></html>',
    'js/main.js': "import './b.js';\n",
    'js/b.js': 'export {};\n',
  });
  t.after(() => rmSync(dir, { recursive: true }));
  assert.deepEqual(await modulePreloads(dir, { build }), { pages: 1, modules: 2 });
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  assert.ok(html.includes('<link rel="modulepreload" href="/js/main.js"><link rel="modulepreload" href="/js/b.js"></head>'));
  assert.equal(readFileSync(join(dir, 'about/index.html'), 'utf8'), '<html><head></head><body>no scripts</body></html>');
  await modulePreloads(dir, { build });
  assert.equal(readFileSync(join(dir, 'index.html'), 'utf8'), html, 'a second run changes nothing');
});
