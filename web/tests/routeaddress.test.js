// router.js on a permanent case address (#283): the address stays the route's path while
// the case it opened is shown, and leaves it for `/#<case>` when another case opens.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { getHashParams, replaceHash, routePath, setHash, setRoute } from '../public/js/router.js';

let entries;
function at(url) {
  const u = new URL(url, 'https://stare.pub');
  globalThis.window.location.pathname = u.pathname;
  globalThis.window.location.hash = u.hash;
}
beforeEach(() => {
  entries = [];
  globalThis.window = { location: { pathname: '/', hash: '' } };
  globalThis.history = {
    state: null,
    replaceState: (s, t, url) => { at(url); entries.push(['replace', url]); },
    pushState: (s, t, url) => { at(url); entries.push(['push', url]); },
  };
  setRoute(null);
});

test('the case a route opens keeps the route\'s path', () => {
  at('/k/us/dc/69/1943-05-11/');
  setRoute('/k/us/dc/69/1943-05-11/');
  setHash('a2d', '31', 647, 1);
  assert.equal(window.location.pathname, '/k/us/dc/69/1943-05-11/');
  assert.equal(window.location.hash, '');
  assert.deepEqual(entries, []);
  // The hash's params still name the case, for the reader's own links.
  assert.equal(getHashParams().page, 647);
});

test('a place in the case adds the hash to the path; leaving it takes it off', () => {
  at('/k/us/dc/69/1943-05-11/');
  setRoute('/k/us/dc/69/1943-05-11/');
  setHash('a2d', '31', 647, 1);
  replaceHash('#a2d/31/647-01~c=3');
  assert.equal(window.location.pathname + window.location.hash, '/k/us/dc/69/1943-05-11/#a2d/31/647-01~c=3');
  replaceHash('#a2d/31/647-01');
  assert.equal(window.location.pathname + window.location.hash, '/k/us/dc/69/1943-05-11/');
});

test('another case leaves the path for /#<case> in a new history entry', () => {
  at('/c/us/a2d/31/647/');
  setRoute('/c/us/a2d/31/647/');
  setHash('a2d', '31', 647, 1);
  setHash('a2d', '142', 148, 1);
  assert.deepEqual(entries, [['push', '/#a2d/142/148-01']]);
  assert.equal(routePath(), null);
});

test('a link in the text that already set the hash is replaced, not pushed again', () => {
  at('/k/us/dc/69/1943-05-11/');
  setRoute('/k/us/dc/69/1943-05-11/');
  setHash('a2d', '31', 647, 1);
  at('/k/us/dc/69/1943-05-11/#a2d/142/148-01');
  setHash('a2d', '142', 148, 1);
  assert.deepEqual(entries, [['replace', '/#a2d/142/148-01']]);
});

test('off `/` with no route, a case goes to `/`', () => {
  at('/c/us/a2d/31/999999/');
  setHash('a2d', '142', 148, 1);
  assert.deepEqual(entries, [['push', '/#a2d/142/148-01']]);
});
