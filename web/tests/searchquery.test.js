import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_PAGE, caseHref, cardFields, clientFilters, countText, droppedWords, filterChips, formatDate,
  hasFilters, looksLikeCitation, nameSegments, noteText, pageCount, pageLinks, parseSearchState,
  sameQuery, searchString, statusText, summaryText, yearBins,
} from '../public/js/searchquery.js';
import { STOPWORDS, tokens as vendorTokens } from '../src/vendor/stare-search/tokenize.mjs';

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

test('counts read plainly, and the live region says them once with the page', () => {
  const r = (total, exact = true, relaxed = false, tokens = ['x']) => ({ total, exact, relaxed, tokens });
  assert.equal(countText(r(1)), '1 match');
  assert.equal(countText(r(4657)), '4,657 matches');
  assert.equal(countText(r(4352, false)), 'Top 4,352 matches');
  assert.equal(statusText(r(1), 1), '1 match');
  assert.equal(statusText(r(137), 2), '137 matches, page 2 of 7');
  assert.equal(statusText(r(0), 1), 'No matches');
  assert.equal(statusText(r(0, true, false, []), 1), 'Nothing to search for');
  assert.equal(summaryText(r(1), 1), '1 match.');
  assert.equal(summaryText(r(137), 2), '137 matches. Page 2 of 7.');
  assert.equal(summaryText(r(4352, false), 1), `Top 4,352 matches. Page 1 of 218. ${noteText(r(4352, false))}`);
  assert.equal(summaryText(r(3, true, true, ['a', 'b', 'c']), 1), '3 matches. No decision has every word, so these have all but one.');
  assert.equal(summaryText(r(0, true, false, ['zebra']), 1), 'No decisions match.');
  assert.match(summaryText(r(0, true, false, []), 1), /too common/);
  assert.equal(noteText(r(137)), '');
  for (const t of [summaryText(r(4352, false), 1), summaryText(r(3, true, true), 1)]) assert.doesNotMatch(t, /\u2014/);
});

test('a case name\'s words the query matched are marked, folded as the tokenizer folds them', () => {
  const marked = (name, q) => nameSegments(name, vendorTokens(q)).filter((s) => s.hit).map((s) => s.text);
  assert.deepEqual(marked('Palsgraf v. Long Island Railroad Co.', 'palsgraf railroad'), ['Palsgraf', 'Railroad']);
  assert.deepEqual(marked('United States v. U.S. Steel', 'us steel'), ['U.S.', 'Steel']);
  assert.deepEqual(marked('Smith\'s Estate v. Jones', 'smith estate'), ['Smith\'s', 'Estate']);
  assert.deepEqual(marked('Café Néon v. Board', 'cafe neon'), ['Café', 'Néon']);
  assert.deepEqual(marked('Brown v. Board of Education', 'of the board'), ['Board']);
  // the runs put back together are the name
  const name = 'In re O\u2019Brien, 1,000 Acres (Ohio)';
  assert.equal(nameSegments(name, ['brien', '1000']).map((s) => s.text).join(''), name);
  assert.deepEqual(nameSegments(name, ['brien', '1000']).filter((s) => s.hit).map((s) => s.text), ['O\u2019Brien', '1,000']);
  assert.deepEqual(nameSegments('A v. B', []), [{ text: 'A v. B', hit: false }]);
});

test('the words a query left out are the stopwords and single letters the tokenizer drops', () => {
  assert.deepEqual(droppedWords('The Palsgraf of a railroad', vendorTokens('The Palsgraf of a railroad')), ['the', 'of', 'a']);
  assert.deepEqual(droppedWords('palsgraf', ['palsgraf']), []);
  for (const w of STOPWORDS) assert.deepEqual(droppedWords(`${w} kale`, vendorTokens(`${w} kale`)), [w]);
});

test('a query that reads as a citation is offered to the reader; words are not', () => {
  for (const q of ['347 U.S. 483', '31 A.2d 647', '31 A.2d 647, 650 (1943)', '248 N.Y. 339', 'a2d 31 647', 'a2d/31/647', 'ny 248 339-02', '1 Cai. Cas. 12']) {
    assert.ok(looksLikeCitation(q), q);
  }
  for (const q of ['palsgraf railroad', '1983 nys2d', 'section 1983', 'N.Y.S.2d', '42 U.S.C.', 'title 42 1983 claims against officers']) {
    assert.ok(!looksLikeCitation(q), q);
  }
});

test('filter chips name the filters in use, from facets.json when it\'s in', () => {
  const facets = { jurisdictions: [{ key: 'ny', name: 'New York' }], courts: [{ key: 'nyappdiv', name: 'Appellate Division' }] };
  const state = parseSearchState('?q=x&jurisdiction=ny&court=nyappdiv&from=1920&to=1930');
  assert.ok(hasFilters(state));
  assert.ok(!hasFilters(parseSearchState('?q=x')));
  assert.deepEqual(filterChips(state, facets), [
    { key: 'jurisdiction', label: 'Jurisdiction', text: 'New York' },
    { key: 'court', label: 'Court', text: 'Appellate Division' },
    { key: 'years', label: 'Decided', text: '1920 to 1930' },
  ]);
  assert.deepEqual(filterChips(state, null, { court: 'N.Y. App. Div.' }).map((c) => c.text), ['ny', 'N.Y. App. Div.', '1920 to 1930']);
  assert.equal(filterChips({ from: '1920', to: '1920' })[0].text, '1920');
  assert.equal(filterChips({ from: '1920' })[0].text, '1920 and later');
  assert.equal(filterChips({ to: '1920' })[0].text, '1920 and earlier');
  assert.deepEqual(filterChips({}), []);
});

test('the year chart\'s bins: whole years, at most 60, every decision counted once', () => {
  const years = [{ key: '1658', decisions: 1 }, { key: '1900', decisions: 10 }, { key: '2026', decisions: 5 }, { key: '2028', decisions: 1 }];
  const bins = yearBins(years, '1658', '2028');
  assert.ok(bins.length <= 60);
  assert.equal(bins[0].from, 1658);
  assert.equal(bins[bins.length - 1].to, 2028);
  assert.equal(bins.reduce((n, b) => n + b.decisions, 0), 17);
  for (let i = 1; i < bins.length; i++) assert.equal(bins[i].from, bins[i - 1].to + 1);
  assert.deepEqual(yearBins(years, '1900', '1902'), [{ from: 1900, to: 1900, decisions: 10 }, { from: 1901, to: 1901, decisions: 0 }, { from: 1902, to: 1902, decisions: 0 }]);
  assert.deepEqual(yearBins(years, '2000', '1990'), []);
});
