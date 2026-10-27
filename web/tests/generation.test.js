import { test } from 'node:test';
import assert from 'node:assert/strict';

import { processCitations } from '../public/js/citations.js';
import { generations } from '../public/js/generation.js';
import { reconcile } from './wasm-node.js';

// #267: a case load that another replaces is over; its late results must not reach the
// case on screen.

test('starting a load ends the one before it', () => {
  const loads = generations();
  const a = loads.start();
  assert.equal(a.current(), true);
  assert.equal(a.signal.aborted, false);
  const b = loads.start();
  assert.equal(a.current(), false);
  assert.equal(a.signal.aborted, true);
  assert.equal(b.current(), true);
  assert.equal(b.signal.aborted, false);
});

test('cancel ends the current load and starts none', () => {
  const loads = generations();
  const a = loads.start();
  loads.cancel();
  assert.equal(a.current(), false);
  assert.equal(a.signal.aborted, true);
  const b = loads.start();
  assert.equal(b.current(), true);
});

const TEXT = 'See 31 A.2d 647 and 138 U.S. 529.';

// A detected citation in the shape detectCitations returns.
function cite(raw, fields) {
  const start = TEXT.indexOf(raw);
  return {
    raw, type: 'FullCaseCitation', harvard_slug: fields.slug, start, end: start + raw.length,
    externalUrl: null, caseLinks: [], pin: null, antecedent: null, caseName: null, parallelTo: null,
    year: null, ...fields,
  };
}

const DETECTED = [
  cite('31 A.2d 647', { slug: 'a2d', volume: 31, page: '647', reporter: 'A.2d' }),
  cite('138 U.S. 529', { slug: 'us', volume: 138, page: '529', reporter: 'U.S.' }),
];

// One opinion citing two cases; the index lookups (`check`) are held until `release`.
function heldPass() {
  const checked = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const check = async (slug, volume) => {
    checked.push(`${slug}/${volume}`);
    await held;
    return true;
  };
  const pageCheck = async () => true;
  const caseData = { casebody: { opinions: [{ text: TEXT }] } };
  return { caseData, check, pageCheck, checked, release };
}

const detect = async () => DETECTED;

test('a citation pass whose load has ended rejects with an AbortError and returns nothing', async () => {
  const loads = generations();
  const load = loads.start();
  const pass = heldPass();
  const out = processCitations(
    pass.caseData, pass.check, detect, pass.pageCheck, reconcile, undefined,
    { signal: load.signal },
  );
  // The next case starts while the first one's index lookups are out.
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(pass.checked.length > 0, 'the lookups started');
  loads.start();
  pass.release();
  await assert.rejects(out, { name: 'AbortError' });
});

test('a citation pass ended before it starts looks nothing up', async () => {
  const loads = generations();
  const load = loads.start();
  loads.start();
  const pass = heldPass();
  pass.release();
  let detected = 0;
  const counted = async () => { detected += 1; return DETECTED; };
  await assert.rejects(
    processCitations(pass.caseData, pass.check, counted, pass.pageCheck, reconcile, undefined, { signal: load.signal }),
    { name: 'AbortError' },
  );
  assert.equal(detected, 0);
  assert.deepEqual(pass.checked, []);
});

test('a citation pass still current returns its citations', async () => {
  const loads = generations();
  const load = loads.start();
  const pass = heldPass();
  pass.release();
  const { unique } = await processCitations(
    pass.caseData, pass.check, detect, pass.pageCheck, reconcile, undefined,
    { signal: load.signal },
  );
  assert.deepEqual(unique.map((c) => [c.raw, c.resolvable]), [['31 A.2d 647', true], ['138 U.S. 529', true]]);
});
