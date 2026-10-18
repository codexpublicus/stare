// A variation (citare#86): `127 Ohio 545` is the Ohio State Reports, which
// citare reads from the `Ohio` the text cites and slugs `ohio-st`. The
// reader keeps the citation as written and says what it was read as.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  citationsFromRust,
  heldVolumeMiss,
  processCitations,
  readAs,
  renderTextHtml,
} from '../public/js/citations.js';

const withoutPlaces = (html) => html.replace(/ data-cite-(?:group|form)="[^"]*"/g, '');

const TEXT = 'Troop A Riding Academy v. Miller, 127 Ohio 545 (1934). Id. at 547.';

// stare-wasm's detect_citations output for TEXT.
const TROOP = {
  matched_text: '127 Ohio 545', citation_type: 'FullCaseCitation', span: [34, 46],
  harvard_slug: 'ohio-st', slug: 'ohio-st', volume: '127', page: '545', reporter: 'Ohio',
  corrected_reporter: 'Ohio St.', year: 1934, external_url: null, law: null,
  case_links: [], pin: null, case_name: 'Troop A Riding Academy v. Miller', parallel_of: null,
};
const { pin, case_name, parallel_of, ...troopAntecedent } = TROOP;
const RAW = [
  TROOP,
  {
    matched_text: 'Id.', citation_type: 'IdCitation', span: [55, 58], harvard_slug: null, slug: null,
    volume: null, page: null, reporter: null, year: null, external_url: null, law: null,
    case_links: [], pin: '547', antecedent: troopAntecedent, case_name: null, parallel_of: null,
  },
];

async function render(cases) {
  const detected = citationsFromRust(RAW);
  const { unique, occurrencesByOpinion } = await processCitations(
    { casebody: { opinions: [{ text: TEXT }] } },
    async () => true,
    async () => detected,
    async (slug, volume, page) => Boolean(cases[`${slug}/${volume}/${page}`]),
  );
  const map = new Map(unique.map((c) => [c.key, c]));
  return withoutPlaces(renderTextHtml(TEXT, occurrencesByOpinion[0], map).join('\n'));
}

describe('a variation', () => {
  test('keeps the reporter as cited and the edition it was read as', () => {
    const [c, id] = citationsFromRust(RAW);
    assert.equal(c.reporter, 'Ohio');
    assert.equal(c.correctedReporter, 'Ohio St.');
    assert.equal(c.slug, 'ohio-st');
    assert.equal(readAs(c), 'Read as 127 Ohio St. 545');
    assert.equal(id.antecedent.correctedReporter, 'Ohio St.');
    assert.equal(readAs(id), null, 'a short form refers to its antecedent instead');
  });

  test('a citation of an edition by its own name has nothing to read as', () => {
    const [c] = citationsFromRust([{ ...TROOP, reporter: 'Ohio St.', corrected_reporter: null }]);
    assert.equal(c.correctedReporter, null);
    assert.equal(readAs(c), null);
  });

  test('links under the edition it was read as, and says so', async () => {
    const html = await render({ 'ohio-st/127/545': true });
    assert.match(html, /<a class="cite-link" href="#ohio-st\/127\/545"[^>]*title="127 Ohio 545\. Read as 127 Ohio St\. 545">127 Ohio 545<\/a>/);
    assert.match(html, /href="#ohio-st\/127\/545@547"[^>]*title="Refers to 127 Ohio 545, at 547">Id\.<\/a>/);
  });

  test('a miss names the edition it looked in', async () => {
    const html = await render({});
    assert.match(html, /<span class="cite-unresolved" title="Read as 127 Ohio St\. 545\. No case found at this page in Ohio St\. vol\. 127">127 Ohio 545<\/span>/);
    assert.match(html, /title="Refers to 127 Ohio 545, at 547\. No case found at this page in Ohio St\. vol\. 127">Id\.<\/span>/);
    const [c] = citationsFromRust(RAW);
    assert.equal(
      heldVolumeMiss({ ...c, volumeHeld: true, resolvable: false }),
      'No case found at this page in Ohio St. vol. 127',
    );
  });
});
