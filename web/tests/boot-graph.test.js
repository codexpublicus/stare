import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// main.js runs only once every module it imports statically has loaded, so one module a
// content blocker refuses takes the whole reader down (#265). The page views and the
// typeahead are imported when first wanted, with a message if they fail; this keeps them
// out of the static graph.
const dir = fileURLToPath(new URL('../public/js/', import.meta.url));

const LAZY = [
  'pdfviewer.js', 'pdfpages.js', 'pdfjs-path.js', 'scanviewer.js', 'pageshell.js', 'pagezoom.js',
  'selectionpaint.js', 'searchbox.js', 'suggest.js', 'casenames.js',
];

// The modules `entry` imports statically, itself included (`import ... from './x.js'`,
// `export ... from`, and `import './x.js'`; not `import()`).
function staticGraph(entry) {
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const src = readFileSync(`${dir}${name}`, 'utf8');
    const re = /^\s*(?:import|export)\s(?:[^'"()]*?\sfrom\s)?['"]\.\/([^'"]+)['"]/gm;
    for (const m of src.matchAll(re)) visit(m[1]);
  };
  visit(entry);
  return seen;
}

test('the reader statically imports none of the page views or the typeahead', () => {
  const graph = staticGraph('main.js');
  assert.deepEqual(LAZY.filter((n) => graph.has(n)), []);
  // The parser finds the imports at all: the reader's own modules are there.
  for (const core of ['resolve.js', 'ui.js', 'citations.js', 'wasm.js', 'router.js']) assert.ok(graph.has(core), core);
});

test('the page views and the typeahead are imported dynamically', () => {
  const main = readFileSync(`${dir}main.js`, 'utf8');
  for (const name of ['pdfviewer.js', 'scanviewer.js', 'pageshell.js', 'searchbox.js']) {
    assert.ok(main.includes(`import('./${name}')`), name);
  }
});

test('main.js tells the boot guard it started', () => {
  const main = readFileSync(`${dir}main.js`, 'utf8');
  assert.match(main, /globalThis\.stareBoot\?\.ready\(\);\s*$/);
});
