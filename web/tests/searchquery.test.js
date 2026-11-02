import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_PAGE, caseHref, cardFields, clientFilters, formatDate, pageCount, pageLinks,
  parseSearchState, sameQuery, searchString, summaryText,
} from '../public/js/searchquery.js';

test('the URL\'s state round-trips, dropping what is malformed', () => {
  const s = parseSearchState('?q=+palsgraf++railroad+&court=nyappdiv&jurisdiction=United+States&from=1930&to=1920&page=3');
  assert.deepEqual(s, { q: 'palsgraf railroad', jurisdiction: 'United States', court: 'nyappdiv', from: '1920', to: '1930', page: 3 });
  assert.equal(searchString(s), '?q=palsgraf+railroad&jurisdiction=United+States&court=nyappdiv&from=1920&to=1930&page=3');
  assert.deepEqual(parseSearchState(searchString(s)), s);
  assert.deepEqual(
    parseSearchState('?q=x&court=%3Cscript%3E&from=19x0&to=12345&page=-2'),
    { q: 'x', jurisdiction: '', court: '', from: '', to: '', page: 1 },
  );
  assert.equal(parseSearchState(`?q=x&page=${MAX_PAGE + 50}`).page, MAX_PAGE);
  assert.equal(searchString({ q: 'x', page: 1 }), '?q=x');
  assert.equal(searchString({ q: '', page: 1 }), '');
  assert.equal(parseSearchState(`?q=${'a'.repeat(600)}`).q.length, 500);
});

test('the page aside, two states ask the same query', () => {
  const a = parseSearchState('?q=kale&court=ny&page=2');
  assert.ok(sameQuery(a, parseSearchState('?q=kale&court=ny')));
  assert.ok(!sameQuery(a, parseSearchState('?q=kale&court=ny&from=1920')));
});

const FACETS = {
  years: ['1920', '1921', '1925', '1930', '2010'].map((key) => ({ key })),
  courts: [{ key: 'ny', years: ['1920', '1930'] }, { key: 'ca1', years: ['2010', '2010'] }],
};

test('filters: one year is the format\'s key, a range year_from and year_to, and a range over everything none', () => {
  assert.deepEqual(clientFilters({ court: 'ny', from: '1925', to: '1925' }), { court: 'ny', year: '1925' });
  assert.deepEqual(clientFilters({ jurisdiction: 'ny', from: '1921', to: '1925' }, FACETS), { jurisdiction: 'ny', year_from: '1921', year_to: '1925' });
  assert.deepEqual(clientFilters({ from: '1925' }, FACETS), { year_from: '1925', year_to: '2010' });
  assert.deepEqual(clientFilters({ to: '1921' }, FACETS), { year_from: '1920', year_to: '1921' });
  assert.deepEqual(clientFilters({ from: '1900', to: '2026' }, FACETS), {});
  // the court's own years bound it: from 1925 on is 1925..1930 for ny, and all of ca1
  assert.deepEqual(clientFilters({ court: 'ny', from: '1925' }, FACETS), { court: 'ny', year_from: '1925', year_to: '1930' });
  assert.deepEqual(clientFilters({ court: 'ca1', from: '2000' }, FACETS), { court: 'ca1' });
  assert.deepEqual(clientFilters({ court: 'ny', from: '1930', to: '1999' }, FACETS), { court: 'ny', year: '1930' });
  assert.throws(() => clientFilters({ from: '1920', to: '1930' }, null), /facets/);
});

test('a card links to the reader by its route, and nothing else', () => {
  assert.equal(caseHref('ny/248/339'), '/#ny/248/339');
  assert.equal(caseHref('a2d/142/148-02'), '/#a2d/142/148-02');
  assert.equal(caseHref('cal-app-4th/15/supp.%201'), '/#cal-app-4th/15/supp.%201');
  for (const bad of ['', 'javascript:alert(1)', 'ny/248', 'ny/248/339"><x', '../x/1/2', null, 42]) {
    assert.equal(caseHref(bad), null, String(bad));
  }
  assert.deepEqual(cardFields({ n: 'A v. B', c: '1 N.Y. 1', ct: 'N.Y.', d: '1850', r: 'ny/1/1', x: 1 }),
    { name: 'A v. B', citation: '1 N.Y. 1', court: 'N.Y.', date: '1850', route: 'ny/1/1' });
  assert.deepEqual(cardFields(null), { name: '', citation: '', court: '', date: '', route: '' });
});

test('dates read as precisely as the card has them', () => {
  assert.equal(formatDate('1928-05-29'), 'May 29, 1928');
  assert.equal(formatDate('1882-05'), 'May 1882');
  assert.equal(formatDate('1882'), '1882');
  assert.equal(formatDate('1882-13'), '1882');
  assert.equal(formatDate('sometime'), 'sometime');
  assert.equal(formatDate(undefined), '');
});

test('pages: 20 a page, the first, last and two either side linked', () => {
  assert.equal(pageCount(0), 1);
  assert.equal(pageCount(20), 1);
  assert.equal(pageCount(21), 2);
  assert.equal(pageCount(1e7), MAX_PAGE);
  assert.deepEqual(pageLinks(1, 1), [1]);
  assert.deepEqual(pageLinks(1, 9), [1, 2, 3, null, 9]);
  assert.deepEqual(pageLinks(5, 9), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(pageLinks(10, 30), [1, null, 8, 9, 10, 11, 12, null, 30]);
});

test('the live region says how many matched and whether that is all of them', () => {
  assert.equal(summaryText({ total: 1, exact: true, relaxed: false, tokens: ['x'] }, 1), '1 decision matches.');
  assert.equal(summaryText({ total: 137, exact: true, relaxed: false, tokens: ['x'] }, 2), '137 decisions match. Page 2 of 7.');
  assert.equal(summaryText({ total: 4352, exact: false, relaxed: false, tokens: ['x'] }, 1), 'The best 4,352 matches found. Page 1 of 218.');
  assert.equal(summaryText({ total: 3, exact: true, relaxed: true, tokens: ['a', 'b', 'c'] }, 1), '3 decisions match. No decision has every word; these have all but one.');
  assert.equal(summaryText({ total: 0, exact: true, relaxed: false, tokens: ['zebra'] }, 1), 'No decisions match.');
  assert.match(summaryText({ total: 0, exact: true, relaxed: false, tokens: [] }, 1), /too common/);
});
