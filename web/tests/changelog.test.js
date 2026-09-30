import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { plainText, parseChangelog } from '../src/lib/changelog.js';

const REPO = 'https://github.com/codexpublicus/stare';

// The shape cliff.toml's template writes.
const LINKED = `## [v2026.10.03.1](${REPO}/releases/tag/v2026.10.03.1) - 2026-10-03\n\n### Fixes\n\n- web: a fix ([abc1234](${REPO}/commit/abc1234)) ([#61](${REPO}/pull/61))\n`;

const CHANGELOG = `# Changelog

Site releases of stare.pub. Each release is tagged \`vYYYY.MM.DD.N\` and deployed to production when its release PR merges.

## Unreleased

### Features

- web: something queued

## v2026.10.02.1 - 2026-10-02

### Features

- web: show the release in the footer
- add a thing

### Fixes

- web: announce a short citation status

## v2026.09.30.2 - 2026-09-30

### Performance

- stare: faster index lookups

## v2026.09.30.1 - 2026-09-30

### Fixes

`;

describe('plainText', () => {
  test('reduces every markdown link to its label', () => {
    assert.equal(plainText(`fix it ([abc](${REPO}/commit/abc)) now`), 'fix it (abc) now');
    assert.equal(plainText('see [docs](https://example.com/x)'), 'see docs');
  });

  test('keeps plain text and HTML-looking text as it is (the page escapes it)', () => {
    assert.equal(plainText('no links here'), 'no links here');
    assert.equal(plainText('<b>bold</b>'), '<b>bold</b>');
  });
});

describe('parseChangelog', () => {
  test('a CHANGELOG line that carries links renders as text with no href', () => {
    const [release] = parseChangelog(LINKED);
    assert.equal(release.version, 'v2026.10.03.1');
    assert.equal(release.href, undefined);
    assert.deepEqual(release.groups[0].items, ['web: a fix (abc1234) (#61)']);
    assert.ok(!JSON.stringify(release).includes('github.com'));
  });

  test('parses releases newest first and skips Unreleased and empty releases', () => {
    const releases = parseChangelog(CHANGELOG);
    assert.deepEqual(releases.map(r => r.version), ['v2026.10.02.1', 'v2026.09.30.2']);

    const [latest] = releases;
    assert.equal(latest.date, '2026-10-02');
    assert.deepEqual(latest.groups.map(g => g.title), ['Features', 'Fixes']);
    assert.equal(latest.groups[0].items.length, 2);
    assert.equal(latest.groups[0].items[0], 'web: show the release in the footer');
    assert.deepEqual(latest.groups[0].items[1], 'add a thing');
  });

  test('maxItems caps each group and counts the rest', () => {
    const [latest] = parseChangelog(CHANGELOG, { maxItems: 1 });
    assert.equal(latest.groups[0].items.length, 1);
    assert.equal(latest.groups[0].more, 1);
    assert.equal(latest.groups[1].more, 0);
  });

  test('limit keeps the newest N', () => {
    assert.deepEqual(parseChangelog(CHANGELOG, { limit: 1 }).map(r => r.version), ['v2026.10.02.1']);
  });

  test('includeUnreleased keeps the Unreleased section', () => {
    const releases = parseChangelog(CHANGELOG, { includeUnreleased: true });
    assert.equal(releases[0].version, 'Unreleased');
  });

  test('a changelog with only its header has no releases', () => {
    assert.deepEqual(parseChangelog('# Changelog\n\nSite releases of stare.pub.\n'), []);
    assert.deepEqual(parseChangelog(''), []);
    assert.deepEqual(parseChangelog(undefined), []);
  });

  test('accepts CRLF line endings', () => {
    const releases = parseChangelog(CHANGELOG.replace(/\n/g, '\r\n'));
    assert.equal(releases.length, 2);
  });
});
