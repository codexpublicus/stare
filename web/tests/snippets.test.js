// Spike (D171): the search page's snippets (public/js/snippets.js): a card's route, the
// case's texts, and the passage shown for a query's tokens.
import assert from 'node:assert/strict';
import test from 'node:test';

import { caseTexts, findPassage, parseRoute } from '../public/js/snippets.js';
import { tokens } from '../src/vendor/stare-search-format2/tokenize.mjs';

test('a card\'s route is a reporter, volume, page and sequence', () => {
  assert.deepEqual(parseRoute('a2d/142/148-02'), { reporter: 'a2d', volume: '142', page: 148, seq: 2 });
  assert.deepEqual(parseRoute('us/384/436'), { reporter: 'us', volume: '384', page: 436, seq: null });
  assert.deepEqual(parseRoute('a3d/138-2/1012'), { reporter: 'a3d', volume: '138-2', page: 1012, seq: null });
  assert.deepEqual(parseRoute('cal-app-4th/15/supp.%201-01'), { reporter: 'cal-app-4th', volume: '15', page: 'supp. 1', seq: 1 });
  assert.equal(parseRoute(''), null);
  assert.equal(parseRoute('not a route'), null);
});

test('a case\'s texts are its opinions, then its head matter', () => {
  const c = { casebody: { head_matter: 'Head.', opinions: [{ text: 'One.' }, { text: ' ' }, { text: 'Two.' }] } };
  assert.deepEqual(caseTexts(c), ['One.', 'Two.', 'Head.']);
  assert.deepEqual(caseTexts({}), []);
});

test('the passage is the first with every token, marked as the tokenizer folds', () => {
  const text = 'The railroad was sued. Many years later, in a different matter, a guard pushed a passenger. '
    + 'Palsgraf v. Long Island Railroad Co. held the railroad owed no duty to her.';
  const p = findPassage([text], tokens('palsgraf railroad'));
  assert.equal(p.found, 2);
  assert.equal(p.of, 2);
  assert.match(p.text, /^… .*Palsgraf v\. Long Island Railroad/);
  assert.ok(p.text.length < 320);
});

test('without every token together, the passage with the most of them, else none', () => {
  const p = findPassage(['Only negligence is here.'], tokens('res ipsa loquitur negligence'));
  assert.equal(p.found, 1);
  assert.equal(p.text, 'Only negligence is here.');
  assert.equal(findPassage(['Nothing to see.'], tokens('chevron')), null);
  assert.equal(findPassage(['Anything.'], []), null);
});

test('a possessive and curly apostrophe fold as the tokenizer does', () => {
  const p = findPassage(['It was Miranda’s confession in Arizona.'], tokens('miranda arizona'));
  assert.equal(p.found, 2);
});
