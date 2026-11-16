// /self-host/, the page that tells people how to run their own copy (#231). It quotes the
// release key and links the kit's README; both have to stay what the kit ships.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const PAGE = read('web/src/pages/self-host.astro');

test('the page gives the release key the site publishes and the kit README repeats', () => {
  const [, comment, key] = read('web/public/.well-known/stare-release-key.pub').match(/^untrusted comment: minisign public key ([0-9A-F]{16})\n(\S+)\n$/);
  assert.ok(PAGE.includes(`const RELEASE_KEY_ID = '${comment}';`), 'the page names the release key ID');
  assert.ok(PAGE.includes(`const RELEASE_KEY = '${key}';`), 'the page gives the release key');
  const readme = read('mirror-kit/README.md');
  for (const m of readme.matchAll(/minisign -Vm \S+ -P (\S+)/g)) assert.equal(m[1], key, 'the kit README verifies with the same key');
});

test('the page links the kit README, and the commands read the release latest.json names', () => {
  const kit = PAGE.match(/const KIT = '(https:\/\/github\.com\/codexpublicus\/stare\/blob\/main\/([^']+))';/);
  assert.ok(kit, 'KIT is the README on GitHub');
  assert.ok(existsSync(new URL(kit[2], root)), `${kit[2]} exists`);
  assert.ok(PAGE.includes("'release=$(jq -r .release latest.json)'"));
  assert.ok(PAGE.includes(`.tiers["1"].tar.sha256`), 'the tar is checked against release.json');
});
