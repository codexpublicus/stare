// Link-outs for citations stare.pub doesn't hold (#7, #9): a case from a
// volume it doesn't hold links to CourtListener and Google Scholar, a
// statute to its text, and a held volume with no case at the page gets a
// neutral note instead. The URLs come
// from Rust (stare::cite::case_links and external_url); these tests cover
// only how the site renders them.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  caseLookupLinks,
  checkCitation,
  citedCaseHtml,
  heldVolumeMiss,
  lookupLabel,
  orderCitedCases,
  renderParagraphHtml,
} from '../public/js/citations.js';
import { fakeDetect } from './fake-detect.js';

const CL = 'https://www.courtlistener.com/c/U.S./598/175/';
const SCHOLAR = 'https://scholar.google.com/scholar?hl=en&as_sdt=2006&q=%22598+U.S.+175%22';
const CASE_LINKS = [
  { source: 'courtlistener', kind: 'full_text', url: CL },
  { source: 'google_scholar', kind: 'search', url: SCHOLAR },
];

const NOT_HELD = { raw: '598 U.S. 175', slug: 'us', volume: 598, page: '175', resolvable: false, externalUrl: null, caseLinks: CASE_LINKS };
const HELD = { raw: '138 U.S. 529', slug: 'us', volume: 138, page: '529', resolvable: true, externalUrl: null, caseLinks: CASE_LINKS };
const STATUTE = { raw: 'Minn. Stat. § 609.185', slug: null, volume: null, page: null, resolvable: false, externalUrl: 'https://www.revisor.mn.gov/statutes/cite/609.185', caseLinks: [] };
const BARE = { raw: 'Id.', slug: null, volume: null, page: null, resolvable: false, externalUrl: null, caseLinks: [] };

// The manifest lists A.2d 31, but no case starts at page 950 of it.
const HELD_MISS = { raw: '31 A.2d 950', reporter: 'A.2d', slug: 'a2d', volume: 31, page: '950', volumeHeld: true, resolvable: false, externalUrl: null, caseLinks: CASE_LINKS };

const caseHref = (c) => `/#${c.slug}/${c.volume}/${c.page}-01`;

describe('checkCitation', () => {
  const cite = { raw: '31 A.2d 950', type: 'FullCaseCitation', harvard_slug: 'a2d', volume: 31, page: '950', reporter: 'A.2d', externalUrl: null, caseLinks: CASE_LINKS };

  test('a held volume with a case at the page resolves', async () => {
    const c = await checkCitation(cite, async () => true, async () => true);
    assert.equal(c.volumeHeld, true);
    assert.equal(c.resolvable, true);
  });

  test('a held volume with no case at the page is held but not resolvable', async () => {
    const c = await checkCitation(cite, async () => true, async () => false);
    assert.equal(c.volumeHeld, true);
    assert.equal(c.resolvable, false);
    assert.equal(c.slug, 'a2d');
  });

  test('an unchecked page (null) is not resolvable, and not a miss (#144)', async () => {
    const c = await checkCitation(cite, async () => true, async () => null);
    assert.equal(c.resolvable, false);
    assert.equal(c.pageUnknown, true);
    assert.equal(heldVolumeMiss(c), null);
  });

  test('a volume not held never checks the page', async () => {
    let pageChecks = 0;
    const c = await checkCitation(cite, async () => false, async () => { pageChecks++; return true; });
    assert.equal(c.volumeHeld, false);
    assert.equal(c.resolvable, false);
    assert.equal(pageChecks, 0);
  });
});

describe('caseLookupLinks', () => {
  test('offers the case links, in order, for a case stare.pub does not hold', () => {
    assert.deepEqual(caseLookupLinks(NOT_HELD).map(l => l.url), [CL, SCHOLAR]);
  });

  test('offers none for a case it holds, a held volume, a statute, or a citation without links', () => {
    assert.deepEqual(caseLookupLinks(HELD), []);
    assert.deepEqual(caseLookupLinks(HELD_MISS), []);
    assert.deepEqual(caseLookupLinks({ ...NOT_HELD, externalUrl: 'https://example.org/s' }), []);
    assert.deepEqual(caseLookupLinks(BARE), []);
    assert.deepEqual(caseLookupLinks({ ...BARE, caseLinks: undefined }), []);
  });

  test('drops links with an unknown source or a non-http(s) URL', () => {
    const links = [
      { source: 'courtlistener', kind: 'full_text', url: 'javascript:alert(1)' },
      { source: 'elsewhere', kind: 'search', url: 'https://example.org/' },
      { source: 'google_scholar', kind: 'search', url: SCHOLAR },
    ];
    assert.deepEqual(caseLookupLinks({ ...NOT_HELD, caseLinks: links }).map(l => l.source), ['google_scholar']);
  });

  test('labels each source', () => {
    assert.equal(lookupLabel(CASE_LINKS[0]), 'Not in stare.pub: may be at CourtListener');
    assert.equal(lookupLabel(CASE_LINKS[1]), 'Not in stare.pub: may be at Google Scholar');
  });
});

describe('inline citations', () => {
  test('a case stare.pub does not hold links to CourtListener, apart from its own links', () => {
    const text = 'See 598 U.S. 175 and 138 U.S. 529.';
    const occurrences = fakeDetect(text).map(({ raw, start, end }) => ({ raw, start, end }));
    const map = new Map([[NOT_HELD.raw, NOT_HELD], [HELD.raw, HELD]]);
    const html = renderParagraphHtml(text, 0, occurrences, map);
    assert.match(html,
      /<a class="cite-lookup" href="https:\/\/www\.courtlistener\.com\/c\/U\.S\.\/598\/175\/" target="_blank" rel="noopener noreferrer" title="Not in stare.pub: may be at CourtListener">598 U\.S\. 175<\/a>/);
    // stare.pub's own link keeps its class and has no target or rel.
    assert.match(html, /<a class="cite-link" href="#us\/138\/529"[^>]*>138 U\.S\. 529<\/a>/);
    assert.doesNotMatch(html, /class="cite-link[^"]*"[^>]*courtlistener/);
  });

  test('a held volume with no case at the page gets a neutral note, no link', () => {
    const text = 'See 31 A.2d 950.';
    const occurrences = [{ raw: '31 A.2d 950', start: 4, end: 15 }];
    const html = renderParagraphHtml(text, 0, occurrences, new Map([[HELD_MISS.raw, HELD_MISS]]));
    assert.equal(html, 'See <span class="cite-unresolved" title="No case found at this page in A.2d vol. 31">31 A.2d 950</span>.');
  });

  test('a case with no usable link stays unresolved', () => {
    const text = 'See 598 U.S. 175.';
    const occurrences = fakeDetect(text).map(({ raw, start, end }) => ({ raw, start, end }));
    const info = { ...NOT_HELD, caseLinks: [{ source: 'courtlistener', kind: 'full_text', url: 'data:text/html,x' }] };
    const html = renderParagraphHtml(text, 0, occurrences, new Map([[info.raw, info]]));
    assert.match(html, /<span class="cite-unresolved" title="Not yet indexed">598 U\.S\. 175<\/span>/);
  });
});

describe('citedCaseHtml', () => {
  test('a case not held: the citation unlinked, then labelled outside links', () => {
    const html = citedCaseHtml(NOT_HELD, caseHref);
    assert.match(html, /^<div class="cited-case cited-case-lookup">/);
    assert.match(html, /<span class="cited-status lookup">&#8599;<\/span>/);
    assert.match(html, /<span class="cited-case-unresolved">598 U\.S\. 175<\/span>/);
    assert.match(html,
      /<a class="cited-lookup-link" href="https:\/\/www\.courtlistener\.com\/c\/U\.S\.\/598\/175\/" target="_blank" rel="noopener noreferrer">Not in stare.pub: may be at CourtListener<\/a>/);
    assert.match(html,
      /<a class="cited-lookup-link" href="https:\/\/scholar\.google\.com\/scholar\?hl=en&amp;as_sdt=2006&amp;q=%22598\+U\.S\.\+175%22" target="_blank" rel="noopener noreferrer">or Google Scholar<\/a>/);
    assert.doesNotMatch(html, /cited-case-link/);
  });

  test('a held volume with no case at the page: a neutral note, no outside link', () => {
    assert.equal(heldVolumeMiss(HELD_MISS), 'No case found at this page in A.2d vol. 31');
    assert.equal(heldVolumeMiss(NOT_HELD), null);
    assert.equal(heldVolumeMiss(HELD), null);
    const html = citedCaseHtml(HELD_MISS, caseHref);
    assert.match(html, /<span class="cited-status no">&#10007;<\/span>/);
    assert.match(html, /<span class="cited-case-unresolved">31 A\.2d 950<\/span>/);
    assert.match(html, /<span class="cited-lookup cited-miss">No case found at this page in A\.2d vol\. 31<\/span>/);
    assert.doesNotMatch(html, /<a |courtlistener|scholar/);
  });

  test('a statute links to its text with no referrer', () => {
    const html = citedCaseHtml(STATUTE, caseHref);
    assert.match(html,
      /<a class="cited-case-link" href="https:\/\/www\.revisor\.mn\.gov\/statutes\/cite\/609\.185" target="_blank" rel="noopener noreferrer">Minn\. Stat\. § 609\.185<\/a>/);
    assert.doesNotMatch(html, /cited-lookup/);
  });

  test('a held case links into stare.pub with the rel the caller asks for', () => {
    assert.match(citedCaseHtml(HELD, caseHref, ''),
      /<a class="cited-case-link" href="\/#us\/138\/529-01" target="_blank">138 U\.S\. 529<\/a>/);
    assert.match(citedCaseHtml(HELD, caseHref),
      /<a class="cited-case-link" href="\/#us\/138\/529-01" target="_blank" rel="noopener">/);
  });

  test('a citation with nothing to link stays unresolved', () => {
    const html = citedCaseHtml(BARE, caseHref);
    assert.match(html, /<span class="cited-status no">&#10007;<\/span>\s*<span class="cited-case-unresolved">Id\.<\/span>/);
    assert.doesNotMatch(html, /<a /);
  });

  test('escapes the citation text', () => {
    assert.match(citedCaseHtml({ ...BARE, raw: '<b>&' }, caseHref), /&lt;b&gt;&amp;/);
  });
});

describe('orderCitedCases', () => {
  test('held, then statutes, then cases to look for elsewhere, then the rest', () => {
    const order = orderCitedCases([BARE, HELD_MISS, NOT_HELD, STATUTE, HELD]).map(c => c.raw);
    assert.deepEqual(order, [HELD.raw, STATUTE.raw, NOT_HELD.raw, BARE.raw, HELD_MISS.raw]);
  });
});
