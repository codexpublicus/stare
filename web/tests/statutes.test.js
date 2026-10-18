// Statutes, bare section references and held-volume misses, rendered
// through the same functions the reader, the sidebar and /check use. A
// statute stare.pub can't link says it is a statute, not "Not yet indexed";
// a bare § is neither linked, listed nor counted; and a case missing from a
// held volume (a reprint CAP redacted, as in 138 A.3d 1012) keeps its
// neutral note, with no outside link until something can tell the case
// exists (codexpublicus/citare#39, #143).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  SECTION_NOTE,
  STATUTE_NOTE,
  citationCounts,
  citationSummary,
  citedCaseHtml,
  isSectionReference,
  isStatute,
  orderCitedCases,
  processCitations,
  refersTo,
  renderTextHtml,
} from '../public/js/citations.js';

// The place-in-the-text attributes (#159) are tested in cite-nav.test.js;
// these tests read the rest of the markup.
const withoutPlaces = (html) => html.replace(/ data-cite-(?:group|form)="[^"]*"/g, '');

// A detected citation in the shape detectCitations returns, located in
// `text` by its raw string, the first at or after `from`.
function cite(text, raw, fields = {}, from = 0) {
  const at = text.indexOf(raw, from);
  assert.ok(at >= 0, `${raw} not in text`);
  return {
    raw, type: 'FullCaseCitation', harvard_slug: null, volume: null, page: null,
    reporter: null, year: null, start: at, end: at + raw.length,
    externalUrl: null, law: null, caseLinks: [], pin: null, antecedent: null, ...fields,
  };
}

const law = (code, section, jurisdiction = null) => ({ jurisdiction, code, subject: null, title: null, chapter: null, section });

const CL = 'https://www.courtlistener.com/c/A.2d/881/194/';
const SCHOLAR = 'https://scholar.google.com/scholar?hl=en&as_sdt=2006&q=%22881+A.2d+194%22';

// Brooks v. Powers, 138 A.3d 1012, cites Martel by both reporters. CAP holds
// 275 Conn. 38, but a2d/881 has no case at page 194: CAP redacted the
// Atlantic Reporter's reprint of it.
const TEXT = 'Martel v. Metropolitan District Commission, 275 Conn. 38, 881 A.2d 194 (2005). '
  + 'See N.C. Gen. Stat. § 1-289; Minn. Stat. § 609.185; Id. § 609.19. '
  + 'Under General Statutes § 52-584, the action is barred. See 68 Fordham L.Rev. 1581.';

function detected() {
  const minn = cite(TEXT, 'Minn. Stat. § 609.185', {
    type: 'FullLawCitation', harvard_slug: null, law: law('Minn. Stat.', '609.185', 'Minnesota'),
    externalUrl: 'https://www.revisor.mn.gov/statutes/cite/609.185',
  });
  return [
    cite(TEXT, '275 Conn. 38', { harvard_slug: 'conn', volume: 275, page: '38', reporter: 'Conn.' }),
    cite(TEXT, '881 A.2d 194', {
      harvard_slug: 'a2d', volume: 881, page: '194', reporter: 'A.2d',
      caseLinks: [
        { source: 'courtlistener', kind: 'full_text', url: CL },
        { source: 'google_scholar', kind: 'search', url: SCHOLAR },
      ],
    }),
    cite(TEXT, 'N.C. Gen. Stat. § 1-289', { type: 'FullLawCitation', law: law('N.C. Gen. Stat.', '1-289') }),
    minn,
    cite(TEXT, 'Id.', { type: 'IdCitation', pin: '§ 609.19', antecedent: { ...minn } }),
    cite(TEXT, '§', { type: 'UnknownCitation' }, TEXT.indexOf('General Statutes')),
    cite(TEXT, '68 Fordham L.Rev. 1581', { type: 'FullJournalCitation' }),
  ];
}

async function render() {
  const held = new Set(['conn/275', 'a2d/881']);
  const cases = new Set(['conn/275/38']);
  const { unique, occurrencesByOpinion } = await processCitations(
    { casebody: { opinions: [{ text: TEXT }] } },
    async (slug, volume) => held.has(`${slug}/${volume}`),
    async () => detected(),
    async (slug, volume, page) => cases.has(`${slug}/${volume}/${page}`),
  );
  const map = new Map(unique.map(c => [c.key, c]));
  return { unique, html: renderTextHtml(TEXT, occurrencesByOpinion[0], map).join('\n') };
}

// The element wrapping `raw` in `html`.
function tagFor(html, raw) {
  html = withoutPlaces(html);
  const re = new RegExp(`<(a|span) [^>]*>${raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</\\1>`);
  const m = html.match(re);
  assert.ok(m, `no element for ${raw} in ${html}`);
  return m[0];
}

describe('statutes', () => {
  test('a recognized statute with no link says so, never "Not yet indexed"', async () => {
    const { html } = await render();
    assert.equal(tagFor(html, 'N.C. Gen. Stat. § 1-289'),
      `<span class="cite-statute" title="${STATUTE_NOTE}">N.C. Gen. Stat. § 1-289</span>`);
    for (const raw of ['N.C. Gen. Stat. § 1-289', 'Id.', '§']) {
      assert.doesNotMatch(tagFor(html, raw), /Not yet indexed/);
    }
  });

  test('a statute with a link still links to its text', async () => {
    const { html } = await render();
    assert.match(tagFor(html, 'Minn. Stat. § 609.185'),
      /^<a class="cite-link cite-external" href="https:\/\/www\.revisor\.mn\.gov\/statutes\/cite\/609\.185"/);
  });

  test('an Id. to another section of a statute is a statute too', async () => {
    const { unique, html } = await render();
    assert.equal(tagFor(html, 'Id.'),
      `<span class="cite-statute" title="Refers to Minn. Stat. § 609.185, § 609.19. ${STATUTE_NOTE}">Id.</span>`);
    assert.ok(isStatute(unique.find(c => c.raw === 'Id.')));
  });

  test('the sidebar lists an unlinked statute with its note, after linked ones', async () => {
    const { unique } = await render();
    const order = orderCitedCases(unique).map(c => c.raw);
    assert.deepEqual(order, ['275 Conn. 38', 'Minn. Stat. § 609.185', 'N.C. Gen. Stat. § 1-289', 'Id.', '881 A.2d 194', '68 Fordham L.Rev. 1581']);
    const html = citedCaseHtml(unique.find(c => c.raw === 'N.C. Gen. Stat. § 1-289'), () => '');
    assert.match(html, /<span class="cited-status statute">&#167;<\/span>/);
    assert.match(html, new RegExp(`<span class="cited-lookup cited-miss">${STATUTE_NOTE}</span>`));
    assert.doesNotMatch(html, /<a /);
  });
});

describe('bare section references', () => {
  test('render quietly, with no link and no case wording', async () => {
    const { html } = await render();
    assert.match(html, new RegExp(`General Statutes <span class="cite-section" title="${SECTION_NOTE}">§</span> 52-584`));
  });

  test('are neither listed nor counted', async () => {
    const { unique } = await render();
    const section = unique.find(isSectionReference);
    assert.ok(section);
    assert.equal(citedCaseHtml(section, () => ''), '');
    assert.ok(!orderCitedCases(unique).some(isSectionReference));
  });
});

describe('counts', () => {
  test('separate cases from statutes, leave out section references', async () => {
    const { unique } = await render();
    assert.deepEqual(citationCounts(unique), { cases: 2, resolvable: 1, statutes: 3, other: 1, review: 0 });
    assert.equal(citationSummary(unique), '2 case citations found (1 resolvable), 3 statutes, 1 other');
  });

  test('say only what there is', () => {
    assert.equal(citationSummary([{ raw: '138 U.S. 529', type: 'FullCaseCitation', resolvable: true }]),
      '1 case citation found (1 resolvable)');
    assert.equal(citationSummary([]), '0 case citations found (0 resolvable)');
  });
});

describe('a case missing from a volume stare.pub holds', () => {
  test('keeps the neutral note and links nowhere', async () => {
    const { unique, html } = await render();
    assert.equal(tagFor(html, '881 A.2d 194'),
      '<span class="cite-unresolved" title="No case found at this page in A.2d vol. 881">881 A.2d 194</span>');
    const entry = citedCaseHtml(unique.find(c => c.raw === '881 A.2d 194'), () => '');
    assert.match(entry, /<span class="cited-lookup cited-miss">No case found at this page in A\.2d vol\. 881<\/span>/);
    assert.doesNotMatch(entry, /<a |courtlistener|scholar/);
  });

  test('its parallel citation in a held volume still links into stare.pub', async () => {
    const { html } = await render();
    assert.match(tagFor(html, '275 Conn. 38'), /^<a class="cite-link" href="#conn\/275\/38"/);
  });
});

describe('statutes and pin cites', () => {
  test('a statute is never looked up as a case, so it never gets a page pin', async () => {
    const text = 'See N.Y. Penal Law § 125.25.';
    const nyPenal = cite(text, 'N.Y. Penal Law § 125.25', {
      type: 'FullLawCitation', harvard_slug: 'ny', volume: 125, page: '25', pin: '26',
      law: law('N.Y. Penal Law', '125.25', 'New York'),
    });
    const lookups = [];
    const { unique, occurrencesByOpinion } = await processCitations(
      { casebody: { opinions: [{ text }] } },
      async (slug, volume) => { lookups.push(`${slug}/${volume}`); return true; },
      async () => [nyPenal],
      async () => true,
    );
    assert.deepEqual(lookups, []);
    const html = renderTextHtml(text, occurrencesByOpinion[0], new Map(unique.map(c => [c.key, c]))).join('');
    assert.doesNotMatch(html, /href="#|@/);
    assert.match(html, /class="cite-statute"/);
  });
});

describe('an Id. to a statute', () => {
  test('names a numeric pin as a section, not a page', () => {
    const info = {
      raw: 'Id.', type: 'IdCitation', pin: '52-577', law: law('Conn. Gen. Stat.', '52-584', 'Connecticut'),
      antecedent: { raw: 'General Statutes § 52-584' },
    };
    assert.equal(refersTo(info), 'Refers to General Statutes § 52-584, § 52-577');
  });
});
