import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

import { detectCitations, processCitations } from '../public/js/citations.js';
import { WasmLoadError } from '../public/js/wasm.js';
import { codePointOffset, fakeDetect } from './fake-detect.js';

describe('codePointOffset (test fixture)', () => {
  test('astral character before the target shifts the code point offset', () => {
    // U+1F600 is a surrogate pair in UTF-16 (2 code units, 1 code point).
    const text = '\u{1F600} 123 U.S. 456.';
    assert.equal(text.indexOf('123'), 3);
    assert.equal(codePointOffset(text, 3), 2);
  });
});

describe('detectCitations without the WASM', () => {
  test('rejects with a WasmLoadError, logs once, and does not retry', async (t) => {
    // The WASM module is imported from an absolute site path ('/wasm/...')
    // that does not exist under plain Node, so the load fails. There is no
    // regex fallback: detectCitations must reject, not return results.
    t.mock.method(console, 'error', () => {});

    await assert.rejects(detectCitations('See 123 U.S. 456 for details.'), WasmLoadError);
    await assert.rejects(detectCitations('And 78 N.E.2d 90.'), WasmLoadError);

    // The failed load is cached until retryWasm(): one load, one log.
    assert.equal(console.error.mock.calls.length, 1);
  });

  test('processCitations rejects too, rather than reporting no citations', async (t) => {
    t.mock.method(console, 'error', () => {});
    const caseData = { casebody: { opinions: [{ text: 'See 123 U.S. 456.' }] } };
    await assert.rejects(processCitations(caseData, async () => true), WasmLoadError);
  });
});

describe('processCitations', () => {
  test('dedups repeated citations by raw string using an injected check', async () => {
    const caseData = {
      casebody: {
        opinions: [
          { text: 'First cite to 123 U.S. 456 here.' },
          { text: 'Second mention of 123 U.S. 456 and also 78 N.E.2d 90.' },
        ],
      },
    };

    const check = mock.fn(async () => true);

    const { unique: result } = await processCitations(caseData, check, fakeDetect, async () => true);

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

  test('never resolves a blank page, even in an indexed volume', async () => {
    // citare v0.4.0 reports `1 U.S. ___` with page: null. Neither the
    // harvard_slug branch nor the slug guess may turn it into a link.
    const blank = (text) => [
      {
        raw: '599 U.S. ___', type: 'FullCaseCitation', harvard_slug: 'us', volume: 599,
        page: null, reporter: 'U.S.', year: null, start: 4, end: 16, externalUrl: null,
      },
      {
        raw: '12 Foo ___', type: 'FullCaseCitation', harvard_slug: null, volume: 12,
        page: null, reporter: 'Foo', year: null, start: 21, end: 31, externalUrl: null,
      },
    ];
    const check = mock.fn(async () => true);

    const { unique } = await processCitations(
      { casebody: { opinions: [{ text: 'See 599 U.S. ___ and 12 Foo ___.' }] } },
      check,
      blank,
      async () => true,
    );

    assert.equal(check.mock.calls.length, 0);
    assert.ok(unique.every((c) => c.resolvable === false && c.slug === null));
  });

  test('keeps every occurrence per opinion with its code point offsets', async () => {
    const caseData = {
      casebody: {
        opinions: [
          { text: 'See 123 U.S. 456; accord 123 U.S. 456.' },
          { text: '\u{1F600} 78 N.E.2d 90' },
        ],
      },
    };

    const { unique, occurrencesByOpinion } = await processCitations(caseData, async () => false, fakeDetect, async () => true);

    assert.equal(unique.length, 2);
    assert.deepEqual(occurrencesByOpinion, [
      [
        { raw: '123 U.S. 456', key: '123 U.S. 456', pin: null, start: 4, end: 16 },
        { raw: '123 U.S. 456', key: '123 U.S. 456', pin: null, start: 25, end: 37 },
      ],
      [{ raw: '78 N.E.2d 90', key: '78 N.E.2d 90', pin: null, start: 2, end: 14 }],
    ]);
  });
});
