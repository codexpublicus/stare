// Short forms (#120): a short case citation, Id., or supra is looked up
// through the full citation citare ties it to, never at its pin page, and
// every occurrence gets its own antecedent's status. Rendered through the
// same functions the reader, the sidebar and /check use.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  NO_ANTECEDENT,
  checkCitation,
  citedCaseHtml,
  processCitations,
  renderTextHtml,
} from '../public/js/citations.js';

// The place-in-the-text attributes (#159) are tested in cite-nav.test.js;
// these tests read the rest of the markup.
const withoutPlaces = (html) => html.replace(/ data-cite-(?:group|form)="[^"]*"/g, '');

// A detected citation in the shape detectCitations returns, located in
// `text` by its raw string (the nth occurrence).
function cite(text, raw, fields = {}, nth = 0) {
  let at = -1;
  for (let i = 0; i <= nth; i++) at = text.indexOf(raw, at + 1);
  assert.ok(at >= 0, `${raw} not in text`);
  return {
    raw, type: 'FullCaseCitation', harvard_slug: null, volume: null, page: null,
    reporter: null, year: null, start: at, end: at + raw.length,
    externalUrl: null, caseLinks: [], pin: null, antecedent: null, ...fields,
  };
}

const ROE = { harvard_slug: 'p2d', volume: 997, page: '1021', reporter: 'P.2d' };
const ROE_TEXT = 'Roe v. Board of County Commissioners, 997 P.2d 1021 (Wyo. 2000). Roe, 997 P.2d at 1023.';

// Run processCitations over one opinion with `detected` standing in for the
// WASM, and render it as the reader does: the map keyed by `key`.
async function render(text, detected, { held = () => true, cases = {} } = {}) {
  const pageChecks = [];
  const pageCheck = async (slug, volume, page) => {
    pageChecks.push(`${slug}/${volume}/${page}`);
    return Boolean(cases[`${slug}/${volume}/${page}`]);
  };
  const check = async (slug, volume) => held(slug, volume);
  const { unique, occurrencesByOpinion } = await processCitations(
    { casebody: { opinions: [{ text }] } }, check, async () => detected, pageCheck,
  );
  const map = new Map(unique.map(c => [c.key, c]));
  const html = renderTextHtml(text, occurrencesByOpinion[0], map).join('\n');
  return { unique, html, pageChecks };
}

// The opening tag of the element wrapping `raw` in `html`, the nth one.
function tagFor(html, raw, nth = 0) {
  html = withoutPlaces(html);
  const re = new RegExp(`<(a|span) [^>]*>${raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</\\1>`, 'g');
  const all = [...html.matchAll(re)];
  assert.ok(all[nth], `no element for ${raw} in ${html}`);
  return all[nth][0];
}

describe('short case citations', () => {
  test('link to their antecedent, not to the case that starts at the pin page', async () => {
    const full = cite(ROE_TEXT, '997 P.2d 1021', ROE);
    const short = cite(ROE_TEXT, '997 P.2d at 1023', {
      type: 'ShortCaseCitation', harvard_slug: 'p2d', volume: 997, reporter: 'P.2d', pin: '1023',
      antecedent: { ...full, pin: undefined, antecedent: undefined },
    });
    // Burnett v. State starts at 1023, the pin page.
    const { html, pageChecks } = await render(ROE_TEXT, [full, short], {
      cases: { 'p2d/997/1021': true, 'p2d/997/1023': true },
    });
    const a = tagFor(html, '997 P.2d at 1023');
    // It links to the antecedent's case, at the pin page (#124).
    assert.match(a, /href="#p2d\/997\/1021@1023"/);
    assert.match(a, /data-pin="1023"/);
    assert.match(a, /title="Refers to 997 P.2d 1021, at 1023"/);
    assert.ok(!pageChecks.includes('p2d/997/1023'), 'the pin page is never looked up');
    // The antecedent is looked up once, for both.
    assert.deepEqual(pageChecks, ['p2d/997/1021']);
  });

  test('inherit a link-out when stare.pub lacks the antecedent\'s volume', async () => {
    const text = 'Axon Enterprise, Inc. v. FTC, 598 U.S. 175 (2023). Axon, 598 U.S. at 180.';
    const links = [{ source: 'courtlistener', kind: 'full_text', url: 'https://www.courtlistener.com/c/U.S./598/175/' }];
    const full = cite(text, '598 U.S. 175', { harvard_slug: 'us', volume: 598, page: '175', reporter: 'U.S.', caseLinks: links });
    const short = cite(text, '598 U.S. at 180', {
      type: 'ShortCaseCitation', harvard_slug: 'us', volume: 598, reporter: 'U.S.', pin: '180', antecedent: full,
    });
    const { unique, html } = await render(text, [full, short], { held: () => false });
    const a = tagFor(html, '598 U.S. at 180');
    assert.match(a, /class="cite-lookup"/);
    assert.match(a, /href="https:\/\/www\.courtlistener\.com\/c\/U\.S\.\/598\/175\/"/);
    assert.match(a, /title="Refers to 598 U\.S\. 175, at 180\. Not in stare\.pub: may be at CourtListener"/);

    const sidebar = citedCaseHtml(unique.find(c => c.raw === '598 U.S. at 180'), () => '#');
    assert.match(sidebar, /cited-status lookup/);
    assert.match(sidebar, /Refers to 598 U\.S\. 175</);
  });
});

describe('Id. and supra', () => {
  const text = 'See Lyon, 31 A.2d 647 (1943). Id. at 650. Roe v. Wade, 410 U.S. 113 (1973). Id. at 120. ' +
    'Lyon, supra, at 649.';
  const lyon = cite(text, '31 A.2d 647', { harvard_slug: 'a2d', volume: 31, page: '647', reporter: 'A.2d' });
  const roe = cite(text, '410 U.S. 113', { harvard_slug: 'us', volume: 410, page: '113', reporter: 'U.S.' });
  const detected = [
    lyon,
    cite(text, 'Id.', { type: 'IdCitation', pin: '650', antecedent: lyon }, 0),
    roe,
    cite(text, 'Id.', { type: 'IdCitation', pin: '120', antecedent: roe }, 1),
    cite(text, 'supra', { type: 'SupraCitation', pin: '649', antecedent: lyon }),
  ];

  test('each Id. resolves to its own antecedent', async () => {
    const { unique, html } = await render(text, detected, { cases: { 'a2d/31/647': true, 'us/410/113': true } });
    assert.match(tagFor(html, 'Id.', 0), /href="#a2d\/31\/647@650"[^>]*data-pin="650"[^>]*title="Refers to 31 A\.2d 647, at 650"/);
    assert.match(tagFor(html, 'Id.', 1), /href="#us\/410\/113@120"[^>]*data-pin="120"[^>]*title="Refers to 410 U\.S\. 113, at 120"/);
    // Two entries, one per antecedent.
    assert.equal(unique.filter(c => c.raw === 'Id.').length, 2);
  });

  test('a supra links to the case it names', async () => {
    const { html } = await render(text, detected, { cases: { 'a2d/31/647': true, 'us/410/113': true } });
    assert.match(tagFor(html, 'supra'), /href="#a2d\/31\/647@649"[^>]*title="Refers to 31 A\.2d 647, at 649"/);
  });

  test('an Id. whose antecedent is a held-volume miss says what it refers to', async () => {
    const { html } = await render(text, detected, { cases: { 'us/410/113': true } });
    assert.match(tagFor(html, 'Id.', 0),
      /class="cite-unresolved" title="Refers to 31 A\.2d 647, at 650\. No case found at this page in A\.2d vol\. 31"/);
    assert.match(tagFor(html, 'Id.', 1), /href="#us\/410\/113@120"/);
  });
});

describe('a short form with no antecedent', () => {
  const text = 'Id. at 5. See also 997 P.2d at 1023.';
  const detected = [
    cite(text, 'Id.', { type: 'IdCitation', pin: '5' }),
    cite(text, '997 P.2d at 1023', { type: 'ShortCaseCitation', harvard_slug: 'p2d', volume: 997, reporter: 'P.2d', pin: '1023' }),
  ];

  test('is shown as such, never looked up, and never "Not yet indexed"', async () => {
    const { unique, html, pageChecks } = await render(text, detected, { cases: { 'p2d/997/1023': true } });
    assert.deepEqual(pageChecks, []);
    for (const raw of ['Id.', '997 P.2d at 1023']) {
      const el = tagFor(html, raw);
      assert.match(el, /class="cite-unresolved cite-no-antecedent"/);
      assert.ok(el.includes(`title="${NO_ANTECEDENT.replace("'", '&#39;')}"`), el);
    }
    assert.ok(!html.includes('Not yet indexed'));
    const sidebar = unique.map(c => citedCaseHtml(c, () => '#')).join('');
    assert.match(sidebar, /cited-status none/);
    assert.ok(!sidebar.includes('cited-status ok'));
  });

  test('checkCitation never falls back to the pin page', async () => {
    let checked = 0;
    const c = await checkCitation(detected[1], async () => { checked++; return true; }, async () => { checked++; return true; });
    assert.equal(checked, 0);
    assert.equal(c.resolvable, false);
    assert.equal(c.noAntecedent, true);
    assert.equal(c.page, null);
  });
});

describe('an Id. to a statute', () => {
  const text = 'See 42 U.S.C. § 1983. Id. Then Id. § 1985.';
  const usc = cite(text, '42 U.S.C. § 1983', { type: 'FullLawCitation', externalUrl: 'https://www.law.cornell.edu/uscode/text/42/1983' });
  const detected = [
    usc,
    cite(text, 'Id.', { type: 'IdCitation', antecedent: usc }, 0),
    cite(text, 'Id.', { type: 'IdCitation', pin: '§ 1985', antecedent: usc }, 1),
  ];

  test('links to its text without a pin, and not with one', async () => {
    const { html } = await render(text, detected);
    assert.match(tagFor(html, 'Id.', 0), /class="cite-link cite-external" href="https:\/\/www\.law\.cornell\.edu\/uscode\/text\/42\/1983"/);
    assert.match(tagFor(html, 'Id.', 1), /<span class="cite-unresolved" title="Refers to 42 U\.S\.C\. § 1983, § 1985"/);
  });
});
