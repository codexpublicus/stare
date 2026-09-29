import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  codePointOffset,
  detectCitationsRegex,
  detectCitations,
  processCitations,
} from '../public/js/citations.js';

describe('codePointOffset', () => {
  test('plain ASCII: UTF-16 offset equals code point offset', () => {
    const text = 'See 123 U.S. 456 for details.';
    const utf16Index = text.indexOf('123');
    assert.equal(codePointOffset(text, utf16Index), utf16Index);
  });

  test('astral character before the target shifts the code point offset', () => {
    // U+1F600 (grinning face) is a surrogate pair in UTF-16 (2 code units,
    // 1 code point).
    const emoji = '\u{1F600}';
    const text = `${emoji} 123 U.S. 456.`;
    const utf16Index = text.indexOf('123');
    // UTF-16 index counts the emoji as 2 units; code point offset counts it
    // as 1, so the code point offset is one less than the UTF-16 index.
    assert.equal(utf16Index, 3);
    assert.equal(codePointOffset(text, utf16Index), 2);
  });
});

describe('detectCitationsRegex', () => {
  test('finds citations after a surrogate pair with code point offsets', () => {
    const emoji = '\u{1F600}';
    const text = `${emoji} 123 U.S. 456 and later 78 N.E.2d 90.`;

    const results = detectCitationsRegex(text);

    assert.equal(results.length, 2);

    const [first, second] = results;
    assert.equal(first.raw, '123 U.S. 456');
    assert.equal(first.volume, 123);
    assert.equal(first.reporter, 'U.S.');
    assert.equal(first.page, '456');
    assert.equal(first.type, 'case');

    // The emoji is 1 code point but 2 UTF-16 code units; the code point
    // offset of the first citation must account for that difference.
    const utf16Start = text.indexOf('123 U.S. 456');
    assert.equal(codePointOffset(text, utf16Start), first.start);
    assert.equal(
      codePointOffset(text, utf16Start + '123 U.S. 456'.length),
      first.end
    );

    assert.equal(second.raw, '78 N.E.2d 90');
    assert.equal(second.volume, 78);
    assert.equal(second.reporter, 'N.E.2d');
    assert.equal(second.page, '90');
  });
});

describe('detectCitations WASM fallback', () => {
  test('falls back to the regex path when the WASM module cannot load under Node', async (t) => {
    // The WASM module is fetched from an absolute site path ('/wasm/...')
    // that does not exist under plain Node, so detectCitations must catch
    // that failure and fall back to detectCitationsRegex. Stub
    // console.warn so the expected warning does not pollute test output.
    t.mock.method(console, 'warn', () => {});

    const results = await detectCitations('See 123 U.S. 456 for details.');

    assert.equal(results.length, 1);
    assert.equal(results[0].raw, '123 U.S. 456');
    assert.equal(console.warn.mock.calls.length, 1);
  });
});

describe('processCitations', () => {
  test('dedups repeated citations by raw string using an injected check', async (t) => {
    // detectCitations also hits the WASM-unavailable fallback here; stub
    // console.warn so that expected noise does not print.
    t.mock.method(console, 'warn', () => {});

    const caseData = {
      casebody: {
        opinions: [
          { text: 'First cite to 123 U.S. 456 here.' },
          { text: 'Second mention of 123 U.S. 456 and also 78 N.E.2d 90.' },
        ],
      },
    };

    const check = mock.fn(async () => true);

    const result = await processCitations(caseData, check);

    // Two opinions detect the same "123 U.S. 456" twice; dedup by raw
    // string must leave exactly two unique citations.
    assert.equal(result.length, 2);
    const raws = result.map((c) => c.raw).sort();
    assert.deepEqual(raws, ['123 U.S. 456', '78 N.E.2d 90']);

    // The injected check, not the real checkAvailability (which would
    // fetch), was used for availability.
    assert.equal(check.mock.calls.length, 2);
    assert.ok(result.every((c) => c.resolvable === true));
  });
});
