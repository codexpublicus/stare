import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  attachRouteLabel, citationIn, handOff, isNotCitation, markNotCitation, routeNoteHtml, routeOf,
  searchHref, takeHandOff,
} from '../public/js/boxroute.js';

test('text that reads as a citation routes to the reader, as the citation it names', () => {
  const cases = {
    '347 U.S. 483': '347 U.S. 483',
    '347 US 483': '347 US 483',
    '31 A.2d 647, 650 (1943)': '31 A.2d 647',
    '467 U.S. 837, 842-43': '467 U.S. 837',
    '15 Cal. App. 4th 123': '15 Cal. App. 4th 123',
    '1 Cai. Cas. xxix': '1 Cai. Cas. xxix',
    '2021 ND 123': '2021 ND 123',
    '2019-Ohio-1234': '2019-Ohio-1234',
    'a2d 31 647': 'a2d 31 647',
    'a2d/31/647-01': 'a2d/31/647-01',
    'Misc. 32 426': 'Misc. 32 426',
    'Brown v. Board of Education, 347 U.S. 483 (1954)': '347 U.S. 483',
    'palsgraf 248 N.Y. 339': '248 N.Y. 339',
  };
  for (const [text, cite] of Object.entries(cases)) {
    assert.equal(citationIn(text), cite, text);
    assert.equal(routeOf(text), 'cite', text);
  }
});

test('words, statutes and numbers that are not a citation route to the search', () => {
  for (const text of [
    'palsgraf railroad', 'Brown v. Board 347', 'section 1983', '1983 nys2d', 'N.Y.S.2d', '42 U.S.C.',
    '42 U.S.C. 1983', '5 USC 552', 'the 5 Justices in 1954', 'chevron deference 1984',
    'title 42 1983 claims against officers',
  ]) {
    assert.equal(citationIn(text), null, text);
    assert.equal(routeOf(text), 'search', text);
  }
  assert.equal(routeOf('   '), '');
});

test('the search URL and the reader note escape the text', () => {
  assert.equal(searchHref(' kale & marauders '), '/search/?q=kale%20%26%20marauders');
  const html = routeNoteHtml('<b>31 A.2d 647</b>');
  assert.ok(!html.includes('<b>'));
  assert.match(html, /Opened “&lt;b&gt;31 A\.2d 647&lt;\/b&gt;” as a citation\./);
  assert.match(html, /href="\/search\/\?q=%3Cb%3E31%20A\.2d%20647%3C%2Fb%3E">Search for this text instead<\/a>/);
});

// A minimal DOM for attachRouteLabel: an input that dispatches events, a button with a dataset.
function fakeBox(value = '') {
  const listeners = {};
  const input = {
    value,
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    type(text) { this.value = text; for (const fn of listeners.input || []) fn(); },
  };
  return { input, button: { dataset: {} }, live: { textContent: '' } };
}

test('the button follows the text; the live region hears a changed route once typing pauses', async () => {
  const { input, button, live } = fakeBox();
  globalThis.document = { activeElement: input };
  try {
    attachRouteLabel(input, button, live, { delay: 20 });
    assert.equal(button.dataset.goes, 'search');
    for (const t of ['3', '34', '347', '347 U', '347 U.S', '347 U.S. 4', '347 U.S. 48', '347 U.S. 483']) input.type(t);
    assert.equal(button.dataset.goes, 'cite');
    assert.equal(live.textContent, '', 'nothing while typing');
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(live.textContent, 'Enter opens the citation');
    // the same route again isn't said again
    live.textContent = '';
    input.type('347 U.S. 48');
    input.type('347 U.S. 483');
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(live.textContent, '');
    input.type('negligence');
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(button.dataset.goes, 'search');
    assert.equal(live.textContent, 'Enter searches');
  } finally {
    delete globalThis.document;
  }
});

test('text put in the box from script sets the label without a word', async () => {
  const { input, button, live } = fakeBox();
  globalThis.document = { activeElement: input };
  try {
    const r = attachRouteLabel(input, button, live, { delay: 10 });
    input.value = '31 A.2d 647';
    r.update();
    assert.equal(button.dataset.goes, 'cite');
    await new Promise((res) => setTimeout(res, 30));
    assert.equal(live.textContent, '');
  } finally {
    delete globalThis.document;
  }
});

test('a hand-off reaches only the case it was made for, once; a refused citation is remembered', () => {
  const data = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
  try {
    handOff('#us/347/483', ' 347 U.S. 483 ');
    assert.equal(takeHandOff('#us/347/483'), '347 U.S. 483');
    assert.equal(takeHandOff('#us/347/483'), null);
    handOff('#us/347/483', '347 U.S. 483');
    assert.equal(takeHandOff('#a2d/31/647'), null);
    assert.ok(!isNotCitation('12 Foo Bar 34'));
    markNotCitation('12 Foo Bar 34');
    assert.ok(isNotCitation(' 12 Foo Bar 34'));
  } finally {
    delete globalThis.sessionStorage;
  }
  // without storage, nothing is handed over and nothing throws
  handOff('#x/1/1', 'x');
  assert.equal(takeHandOff('#x/1/1'), null);
});
