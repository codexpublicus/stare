// The routing contract (D146, D147, #283): real files always win, one fallback for paths no
// file matches (the reader, for browser navigations), and no other server rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import worker from '../../worker/index.js';

const root = new URL('../../', import.meta.url);
// wrangler.jsonc less its line comments (none of its strings hold `//` after a space).
const config = JSON.parse(readFileSync(new URL('wrangler.jsonc', root), 'utf8').replace(/^\s*\/\/.*$/gm, ''));

test('the fallback is the single-page application, and nothing runs before the files', () => {
  assert.equal(config.assets.not_found_handling, 'single-page-application');
  assert.equal(config.assets.directory, './web/dist');
  // run_worker_first would put the Worker in front of real files and turn off the
  // navigation check that keeps the fallback away from crawlers and scripts.
  assert.equal(config.assets.run_worker_first, undefined);
  // The navigation check is the default from 2025-04-01 on; turning it off would serve the
  // reader to everything.
  assert.ok(config.compatibility_date >= '2025-04-01');
  assert.ok(!(config.compatibility_flags || []).includes('assets_navigation_has_no_effect'));
  assert.equal(config.main, './worker/index.js');
});

test('no other server rule: no _redirects or _routes.json', () => {
  for (const f of ['web/public/_redirects', 'web/public/_routes.json', 'web/dist/_redirects', 'web/dist/_routes.json']) {
    assert.ok(!existsSync(new URL(f, root)), f);
  }
});

test('the Worker answers what reaches it with a 404 that is not the reader', async () => {
  const resp = await worker.fetch(new Request('https://stare.pub/k/us/dc/69/1943-05-11/'));
  assert.equal(resp.status, 404);
  assert.match(resp.headers.get('Content-Type'), /^text\/plain/);
});
