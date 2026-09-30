import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildInfo, buildLine, REPO_URL } from '../src/lib/version.js';
import { formatDataLine, loadDataLine, MANIFEST_URL } from '../public/js/dataversion.js';

const SHA = '7c42187aa0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5';

describe('buildInfo', () => {
  test('a local build with nothing set is "dev"', () => {
    const info = buildInfo({});
    assert.deepEqual(info, { label: 'dev', labelHref: null, sha: null, shaHref: null, date: null });
    assert.equal(buildLine(info), 'dev');
  });

  test('a release links the tag and the commit', () => {
    const info = buildInfo({ release: 'v2026.09.30.1', commit: SHA, date: '2026-09-30' });
    assert.equal(info.label, 'v2026.09.30.1');
    assert.equal(info.labelHref, `${REPO_URL}/releases/tag/v2026.09.30.1`);
    assert.equal(info.sha, '7c42187');
    assert.equal(info.shaHref, `${REPO_URL}/commit/${SHA}`);
    assert.equal(buildLine(info), 'v2026.09.30.1 · 7c42187 · 2026-09-30');
  });

  test('a main preview links its label to the commit and does not repeat the SHA', () => {
    const info = buildInfo({ release: 'main-7c42187', commit: SHA, date: '2026-09-29' });
    assert.equal(info.labelHref, `${REPO_URL}/commit/${SHA}`);
    assert.equal(info.sha, null);
    assert.equal(buildLine(info), 'main-7c42187 · 2026-09-29');
  });

  test('a PR preview shows its label and the commit', () => {
    const info = buildInfo({ release: 'pr-60', commit: SHA, date: '2026-09-29' });
    assert.equal(info.labelHref, null);
    assert.equal(buildLine(info), 'pr-60 · 7c42187 · 2026-09-29');
  });

  test('empty strings, as unset env vars arrive, fall back to "dev"', () => {
    assert.equal(buildLine(buildInfo({ release: '', commit: '', date: '' })), 'dev');
  });

  test('malformed values are dropped, not shown', () => {
    const info = buildInfo({ release: '<script>', commit: 'not-a-sha', date: 'yesterday' });
    assert.equal(buildLine(info), 'dev');
    assert.equal(info.shaHref, null);
  });
});

describe('formatDataLine', () => {
  test('shows the manifest version when it has one', () => {
    assert.equal(formatDataLine({ version: '2026.09.27.1', a2d: [31] }, null), 'Index v2026.09.27.1');
    assert.equal(formatDataLine({ version: 'v2026.09.27' }, 'Tue, 24 Mar 2026 08:40:34 GMT'), 'Index v2026.09.27');
  });

  test('falls back to Last-Modified for today\'s bare reporter map', () => {
    assert.equal(
      formatDataLine({ a2d: [31, 32] }, 'Tue, 24 Mar 2026 08:40:34 GMT'),
      'Index updated 2026-03-24',
    );
  });

  test('a reporter slug named "version" is not mistaken for a data version', () => {
    assert.equal(formatDataLine({ version: [1, 2] }, null), null);
  });

  test('returns null with nothing usable', () => {
    assert.equal(formatDataLine(null, null), null);
    assert.equal(formatDataLine({}, 'garbage'), null);
  });
});

describe('loadDataLine', () => {
  function fakeResponse({ ok = true, json, lastModified = null }) {
    return {
      ok,
      headers: { get: name => (name.toLowerCase() === 'last-modified' ? lastModified : null) },
      json: async () => {
        if (json instanceof Error) throw json;
        return json;
      },
    };
  }

  test('fills and unhides the element', async () => {
    const el = { textContent: '', hidden: true };
    let requested;
    const fetchFn = async url => {
      requested = url;
      return fakeResponse({ json: { a2d: [31] }, lastModified: 'Tue, 24 Mar 2026 08:40:34 GMT' });
    };
    assert.equal(await loadDataLine(el, fetchFn), 'Index updated 2026-03-24');
    assert.equal(requested, MANIFEST_URL);
    assert.equal(el.textContent, 'Index updated 2026-03-24');
    assert.equal(el.hidden, false);
  });

  test('stays hidden when the fetch fails or the response is unusable', async () => {
    for (const fetchFn of [
      async () => { throw new Error('offline'); },
      async () => fakeResponse({ ok: false }),
      async () => fakeResponse({ json: new Error('bad json') }),
    ]) {
      const el = { textContent: '', hidden: true };
      assert.equal(await loadDataLine(el, fetchFn), null);
      assert.equal(el.hidden, true);
      assert.equal(el.textContent, '');
    }
  });
});
