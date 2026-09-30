import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { inlineSegments, parseChangelog } from '../src/lib/changelog.js';

const REPO = 'https://github.com/codexpublicus/stare';

// The shape cliff.toml's template writes.
const CHANGELOG = `# Changelog

Site releases of stare.pub. Each release is tagged \`vYYYY.MM.DD.N\` and deployed to production when its release PR merges.

## Unreleased

### Features

- web: something queued ([1111111](${REPO}/commit/1111111))

## [v2026.10.02.1](${REPO}/releases/tag/v2026.10.02.1) - 2026-10-02

### Features

- web: show the release in the footer ([abc1234](${REPO}/commit/abc1234)) ([#61](${REPO}/pull/61))
- add a thing

### Fixes

- web: announce a short citation status ([6980384](${REPO}/commit/6980384))

## [v2026.09.30.2](${REPO}/releases/tag/v2026.09.30.2) - 2026-09-30

### Performance

- stare: faster index lookups ([def5678](${REPO}/commit/def5678))

## [v2026.09.30.1](${REPO}/releases/tag/v2026.09.30.1) - 2026-09-30

### Fixes

`;

describe('inlineSegments', () => {
  test('splits text and links into this repo', () => {
    assert.deepEqual(inlineSegments(`fix it ([abc](${REPO}/commit/abc)) now`), [
      { text: 'fix it (' },
      { text: 'abc', href: `${REPO}/commit/abc` },
      { text: ') now' },
    ]);
  });

  test('renders links anywhere else as text', () => {
    assert.deepEqual(inlineSegments('see [docs](https://example.com/x)'), [
      { text: 'see ' },
      { text: 'docs' },
    ]);
    assert.deepEqual(inlineSegments('[x](https://github.com/someone/else/pull/1)'), [{ text: 'x' }]);
    assert.deepEqual(inlineSegments('[x](https://github.com/codexpublicus/stare.evil/pull/1)'), [{ text: 'x' }]);
    assert.deepEqual(inlineSegments('[x](http://github.com/codexpublicus/stare/pull/1)'), [{ text: 'x' }]);
  });

  test('keeps plain text as one segment', () => {
    assert.deepEqual(inlineSegments('no links here'), [{ text: 'no links here' }]);
  });

  test('drops the href of a non-http link', () => {
    assert.deepEqual(inlineSegments('[click](javascript:alert(1))'), [
      { text: 'click' },
      { text: ')' },
    ]);
  });

  test('leaves HTML-looking text as text (the page escapes it)', () => {
    assert.deepEqual(inlineSegments('<b>bold</b>'), [{ text: '<b>bold</b>' }]);
  });
});

describe('parseChangelog', () => {
  test('parses releases newest first and skips Unreleased and empty releases', () => {
    const releases = parseChangelog(CHANGELOG);
    assert.deepEqual(releases.map(r => r.version), ['v2026.10.02.1', 'v2026.09.30.2']);

    const [latest] = releases;
    assert.equal(latest.href, `${REPO}/releases/tag/v2026.10.02.1`);
    assert.equal(latest.date, '2026-10-02');
    assert.deepEqual(latest.groups.map(g => g.title), ['Features', 'Fixes']);
    assert.equal(latest.groups[0].items.length, 2);
    assert.deepEqual(latest.groups[0].items[0], [
      { text: 'web: show the release in the footer (' },
      { text: 'abc1234', href: `${REPO}/commit/abc1234` },
      { text: ') (' },
      { text: '#61', href: `${REPO}/pull/61` },
      { text: ')' },
    ]);
    assert.deepEqual(latest.groups[0].items[1], [{ text: 'add a thing' }]);
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
    assert.equal(releases[0].href, null);
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
