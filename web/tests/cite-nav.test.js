// From a cited case to the places the text cites it, and the list filter
// (#159): one list entry per cited case, with its full citations, parallel
// citations and short forms together; the attributes the text's citations
// carry; the filter's matching; the `~c=` fragment; and footnotes found in
// CAP's HTML. citenav.js, which drives these in the browser, is covered by
// the e2e suite.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  caseIdentity,
  citationsFromRust,
  citeCategory,
  citedGroupHtml,
  citedListHtml,
  filterTokens,
  groupCitations,
  matchesFilter,
  processCitations,
  renderTextHtml,
  searchText,
} from '../public/js/citations.js';
import { footnoteParagraphs } from '../public/js/pages.js';
import { caseHash, parseHash } from '../public/js/router.js';
import { reconcile } from './wasm-node.js';

// A detected citation in the shape detectCitations returns, located in
// `text` by its raw string (the nth occurrence).
function cite(text, raw, fields = {}, nth = 0) {
  let at = -1;
  for (let i = 0; i <= nth; i++) at = text.indexOf(raw, at + 1);
  assert.ok(at >= 0, `${raw} not in text`);
  return {
    raw, type: 'FullCaseCitation', harvard_slug: null, slug: null, volume: null, page: null,
    reporter: null, year: null, start: at, end: at + raw.length,
    externalUrl: null, caseLinks: [], pin: null, antecedent: null, caseName: null, parallelTo: null, ...fields,
  };
}

// processCitations over one opinion, with `detected` standing in for citare and
// the WASM's reconciliation for parallel runs; `cases` are the `slug/volume/page`s
// with a case (true) or an alias there.
async function run(text, detected, cases = {}) {
  const check = async () => true;
  const pageCheck = async (slug, volume, page) => cases[`${slug}/${volume}/${page}`] || false;
  const out = await processCitations({ casebody: { opinions: [{ text }] } }, check, async () => detected, pageCheck, reconcile);
  const map = new Map(out.unique.map(c => [c.key, c]));
  return { ...out, html: renderTextHtml(text, out.occurrencesByOpinion[0], map).join('\n') };
}

const BARNEY = { slug: 'us', harvard_slug: 'us', volume: 138, page: '529', reporter: 'U.S.', caseName: 'Barney v. Oelrichs' };
const LYON = { slug: 'a2d', harvard_slug: 'a2d', volume: 31, page: '647', reporter: 'A.2d', caseName: "D'Elia & Marks Co. v. Lyon" };

describe('one entry per cited case', () => {
  const text = "See D'Elia & Marks Co. v. Lyon, 31 A.2d 647 (1943). Barney v. Oelrichs, 138 U.S. 529 (1891). "
    + 'Id. at 533. Lyon, supra, at 649. Barney, 138 U.S. at 531. Id. at 534.';
  const lyon = cite(text, '31 A.2d 647', LYON);
  const barney = cite(text, '138 U.S. 529', BARNEY);
  const detected = [
    lyon,
    barney,
    cite(text, 'Id.', { type: 'IdCitation', pin: '533', antecedent: barney }),
    cite(text, 'supra', { type: 'SupraCitation', pin: '649', antecedent: lyon }),
    cite(text, '138 U.S. at 531', { type: 'ShortCaseCitation', pin: '531', antecedent: barney }),
    cite(text, 'Id.', { type: 'IdCitation', pin: '534', antecedent: barney }, 1),
  ];
  const cases = { 'a2d/31/647': true, 'us/138/529': true };

  test('gathers Id., supra and short cites under the case they refer to, counting every place', async () => {
    const { groups } = await run(text, detected, cases);
    assert.deepEqual(groups.map(g => [g.primary.raw, g.count, g.members.length]), [
      ['31 A.2d 647', 2, 2],
      ['138 U.S. 529', 4, 3],
    ]);
    assert.ok(groups.every(g => g.category === 'held'));
  });

  test('marks each place in the text with its case, and short forms as such', async () => {
    const { html, groups } = await run(text, detected, cases);
    const [g0, g1] = groups.map(g => g.id);
    const places = [...html.matchAll(/<a data-cite-group="(g\d+)" data-cite-place="(\d+)"( data-cite-form="short")? class="cite-link"[^>]*>([^<]*)<\/a>/g)]
      .map(m => [m[1], Number(m[2]), !!m[3], m[4]]);
    assert.deepEqual(places, [
      [g0, 0, false, '31 A.2d 647'],
      [g1, 1, false, '138 U.S. 529'],
      [g1, 2, true, 'Id.'],
      [g0, 3, true, 'supra'],
      [g1, 4, true, '138 U.S. at 531'],
      [g1, 5, true, 'Id.'],
    ]);
  });

  test('the list entry keeps the citation\'s own entry, and has the count and step controls', async () => {
    const { groups } = await run(text, detected, cases);
    const html = citedListHtml(groups, (c) => `/#${c.slug}/${c.volume}/${c.page}`);
    const entries = html.match(/<div class="cited-entry"[\s\S]*?\n {6}<\/div>/g);
    assert.equal(entries.length, 2);
    assert.match(entries[1], /<a class="cited-case-link" href="\/#us\/138\/529" target="_blank" rel="noopener">138 U\.S\. 529<\/a>/);
    assert.match(entries[1], /<span class="cited-count">4×<\/span> in text/);
    assert.match(entries[1], /aria-label="Show where the text cites 138 U\.S\. 529: 4 places"/);
    assert.match(entries[1], /<button type="button" class="cited-prev"[^>]*title="Previous \(\[\)"/);
    assert.match(entries[1], /<span class="cited-step" hidden>/);
    assert.match(entries[1], /data-cite-search="[^"]*barney v oelrichs[^"]*"/);
    assert.doesNotMatch(html, /Refers to/, 'the short forms have no entries of their own');
  });

  test('a case cited once has a count of one', async () => {
    const t = 'See Barney v. Oelrichs, 138 U.S. 529 (1891).';
    const { groups } = await run(t, [cite(t, '138 U.S. 529', BARNEY)], cases);
    assert.equal(groups.length, 1);
    assert.match(citedGroupHtml(groups[0], () => '#'), /aria-label="Show where the text cites 138 U\.S\. 529: 1 place"/);
  });
});

describe('what goes in one entry', () => {
  test('a parallel citation joins the case it follows, and is listed with it', async () => {
    const text = 'People v. Smith, 123 Ill. 2d 45, 524 N.E.2d 1 (1988). Id. at 3.';
    const first = cite(text, '123 Ill. 2d 45', { slug: 'ill-2d', volume: 123, page: '45', reporter: 'Ill. 2d', caseName: 'People v. Smith' });
    const second = cite(text, '524 N.E.2d 1', { slug: 'ne2d', volume: 524, page: '1', reporter: 'N.E.2d', caseName: 'People v. Smith', parallelTo: '123 Ill. 2d 45' });
    const { groups, html } = await run(text, [first, second, cite(text, 'Id.', { type: 'IdCitation', pin: '3', antecedent: second })],
      { 'ne2d/524/1': true });
    // The two printings are one place in the text, highlighted together.
    assert.deepEqual([...html.matchAll(/data-cite-place="(\d+)"[^>]*>([^<]*)</g)].map(m => [m[1], m[2]]),
      [['0', '123 Ill. 2d 45'], ['0', '524 N.E.2d 1'], ['2', 'Id.']]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].primary.raw, '524 N.E.2d 1', 'the one stare.pub holds is shown');
    // The parallel run is one place, the Id. another (#198).
    assert.equal(groups[0].count, 2);
    // No case starts at the other's page in a volume stare.pub holds, so it
    // resolves through its partner (#160), and says so.
    assert.match(citedGroupHtml(groups[0], () => '#'),
      /<div class="cited-also">Also cited as 123 Ill\. 2d 45 <span class="cited-also-note">Reported at 524 N\.E\.2d 1, inferred from the citing text<\/span><\/div>/);
  });

  test('two citations that open the same case meet, an alias among them, and keep its label', async () => {
    const text = 'Pettegrew v. Pettegrew, 128 Neb. 783 (1935); see 260 N.W. 287.';
    const neb = cite(text, '128 Neb. 783', { slug: 'neb', volume: 128, page: '783', reporter: 'Neb.' });
    const nw = cite(text, '260 N.W. 287', { slug: 'n-w', volume: 260, page: '287', reporter: 'N.W.' });
    const alias = { via: 'cl:8077312', target: { slug: 'neb', folder: '128', caseFile: '0783-01' } };
    const { groups } = await run(text, [neb, nw], { 'neb/128/783': true, 'n-w/260/287': alias });
    assert.equal(groups.length, 1);
    assert.equal(groups[0].count, 2);
    const nwEntry = groups[0].members.find(m => m.raw === '260 N.W. 287');
    assert.equal(caseIdentity(nwEntry), 'neb/128/783');
    assert.equal(nwEntry.via, 'cl:8077312');
    // Listed under 128 Neb. 783, the alias keeps its label.
    assert.match(citedGroupHtml(groups[0], () => '#'),
      /Also cited as 260 N\.W\. 287 <span class="cited-also-note">Resolved through CourtListener&#39;s citation metadata<\/span>/);
  });

  test('an alias shown as the entry still says where its link came from', async () => {
    const text = 'Pettegrew, 260 N.W. 287 (1935).';
    const alias = { via: 'cl:8077312', target: { slug: 'neb', folder: '128', caseFile: '0783-01' } };
    const { groups } = await run(text, [cite(text, '260 N.W. 287', { slug: 'n-w', volume: 260, page: '287', reporter: 'N.W.' })],
      { 'n-w/260/287': alias });
    const html = citedGroupHtml(groups[0], () => '#');
    assert.match(html, /<span class="cited-lookup cited-via">Resolved through CourtListener&#39;s citation metadata<\/span>/);
    assert.doesNotMatch(html, /verified/i);
  });

  test('a short form with no antecedent, and an Id. to another section, stay apart', async () => {
    const text = 'Id. at 5. See 42 U.S.C. § 1983. Id. Id. § 1985.';
    const usc = cite(text, '42 U.S.C. § 1983', { type: 'FullLawCitation', externalUrl: 'https://www.law.cornell.edu/uscode/text/42/1983', law: { code: 'U.S.C.' } });
    const detected = [
      cite(text, 'Id.', { type: 'IdCitation', pin: '5' }),
      usc,
      cite(text, 'Id.', { type: 'IdCitation', antecedent: usc }, 1),
      cite(text, 'Id.', { type: 'IdCitation', pin: '§ 1985', antecedent: usc }, 2),
    ];
    const { groups } = await run(text, detected);
    assert.deepEqual(groups.map(g => [g.primary.raw, g.count, g.category]), [
      ['Id.', 1, 'unresolved'],
      ['42 U.S.C. § 1983', 2, 'statute'],
      ['Id.', 1, 'statute'],
    ]);
  });

  test('spellings of one unresolved citation are one entry; another citation is not (#198)', () => {
    const miss = (raw, page) => ({ raw, key: raw, type: 'FullCaseCitation', slug: 'a2d', volume: 31, page, volumeHeld: true });
    const groups = groupCitations(null, [miss('31 A.2d 950', '950'), miss('31 A. 2d 950', '950'), miss('31 A.2d 951', '951')]);
    assert.deepEqual(groups.map(g => g.members.map(m => m.raw)), [['31 A.2d 950', '31 A. 2d 950'], ['31 A.2d 951']]);
    assert.equal(groups[0].count, null, 'no count without the detected citations');
  });

  test('without counts an entry has no step controls', () => {
    const [g] = groupCitations(null, [{ raw: '1 A.2d 1', key: '1 A.2d 1', type: 'FullCaseCitation', resolvable: true, slug: 'a2d', volume: 1, page: '1' }]);
    assert.doesNotMatch(citedGroupHtml(g, () => '#'), /cited-nav/);
  });
});

describe('status categories', () => {
  for (const [c, category] of [
    [{ resolvable: true }, 'held'],
    [{ type: 'FullLawCitation' }, 'statute'],
    [{ externalUrl: 'https://example.org/' }, 'statute'],
    [{ volumeHeld: true, volume: 1, slug: 'a2d' }, 'unresolved'],
    [{ volumeHeld: true, pageUnknown: true, volume: 1, slug: 'a2d' }, 'unresolved'],
    [{ noAntecedent: true, type: 'IdCitation' }, 'unresolved'],
    [{ caseLinks: [{ source: 'courtlistener', url: 'https://www.courtlistener.com/' }] }, 'elsewhere'],
  ]) {
    test(`${JSON.stringify(c)} → ${category}`, () => assert.equal(citeCategory(c), category));
  }
});

describe('the filter', () => {
  const entry = searchText("31 A.2d 647 A.2d D'Elia & Marks Co. v. Lyon");
  const match = (q) => matchesFilter(entry, filterTokens(q));

  test('ignores case and punctuation', () => {
    assert.ok(match('a.2d'));
    assert.ok(match('A2D'));
    assert.ok(match('31 a.2d 647'));
    assert.ok(match('delia'));
    assert.ok(match("d'elia marks"));
    assert.ok(match('LYON'));
  });

  test('needs every word', () => {
    assert.ok(!match('lyon barney'));
    assert.ok(!match('a3d'));
  });

  test('an empty query matches everything', () => {
    assert.ok(match(''));
    assert.ok(match('  '));
  });
});

describe('case names and parallels from the WASM', () => {
  test('citationsFromRust reads case_name and parallel_of', () => {
    const base = { citation_type: 'FullCaseCitation', span: [0, 1], case_links: [] };
    const out = citationsFromRust([
      { ...base, matched_text: '123 Ill. 2d 45', case_name: 'People v. Smith' },
      { ...base, matched_text: '524 N.E.2d 1', case_name: 'People v. Smith', parallel_of: 0 },
      { ...base, matched_text: '410 U.S. 113' },
    ]);
    assert.deepEqual(out.map(c => [c.caseName, c.parallelTo]), [
      ['People v. Smith', null],
      ['People v. Smith', '123 Ill. 2d 45'],
      [null, null],
    ]);
  });
});

describe('the ~c= fragment', () => {
  test('parseHash reads a place in the text', () => {
    assert.deepEqual(parseHash('#a2d/31/647-01~c=3'),
      { reporter: 'a2d', volume: '31', page: 647, seq: 1, pin: null, cite: 3 });
    assert.equal(parseHash('#a2d/31/647-01@648~c=12').cite, 12);
    assert.equal(parseHash('#a2d/31/647-01~c=0'), null);
    assert.equal(parseHash('#a2d/31/647-01~c='), null);
  });

  test('caseHash writes one', () => {
    assert.equal(caseHash('a2d', '31', 647, 1, null, 3), '#a2d/31/647-01~c=3');
    assert.equal(caseHash('p2d', '997', 1021, null, '1023'), '#p2d/997/1021-01@1023');
  });
});

describe('footnotes', () => {
  // A stand-in for the parsed CAP HTML, real enough for footnoteParagraphs.
  const el = (tag, attrs, ...children) => {
    const node = {
      nodeType: 1, tagName: tag.toUpperCase(), childNodes: children,
      classList: { contains: (c) => (attrs.class || '').split(' ').includes(c) },
      getAttribute: (k) => attrs[k] ?? null,
      querySelectorAll: (sel) => {
        const [want, cls] = sel.split('.');
        const out = [];
        const visit = (n) => {
          for (const c of n.childNodes || []) {
            if (c.nodeType !== 1) continue;
            if (c.tagName === want.toUpperCase() && (!cls || c.classList.contains(cls))) out.push(c);
            visit(c);
          }
        };
        visit(node);
        return out;
      },
    };
    return node;
  };
  const txt = (s) => ({ nodeType: 3, nodeValue: s });

  test('finds each footnote paragraph in the opinion text, with its number', () => {
    const article = el('article', { class: 'opinion' },
      el('p', {}, txt('The court held so.'), el('a', { class: 'footnotemark', href: '#footnote_1_2' }, txt('1'))),
      el('aside', { class: 'footnote', 'data-label': '1' },
        el('a', { href: '#ref_footnote_1_2' }, txt('1')),
        el('p', {}, txt('See '), el('em', {}, txt('Roe v. Wade,')), txt(' 410 U.S. 113.')),
        el('p', {}, txt('A second paragraph of it, '), el('a', { class: 'page-label', 'data-label': '12' }, txt('*12')), txt('continued.'))),
      el('aside', { class: 'footnote', 'data-label': '2' },
        el('a', { href: '#ref_footnote_1_3' }, txt('2')), txt('Unwrapped note.')));
    const doc = { querySelectorAll: (sel) => (sel === 'article.opinion' ? [article] : []) };
    const text = 'The court held so.\nSee Roe v. Wade, 410 U.S. 113.\nA second paragraph of it, continued.\nUnwrapped note.';
    assert.deepEqual(footnoteParagraphs('', [{ text }], () => doc), [[
      { paragraph: 1, label: '1' },
      { paragraph: 2, label: '1' },
      { paragraph: 3, label: '2' },
    ]]);
  });

  test('an opinion with no footnotes has none', () => {
    const doc = { querySelectorAll: () => [] };
    assert.deepEqual(footnoteParagraphs('', [{ text: 'Plain.' }], () => doc), [[]]);
  });
});
