// Parallel citations (#160): a run citare reads as one decision (`128 Neb. 783, 260
// N.W. 287`) resolves through the printing stare.pub holds, labelled as inferred from
// the citing text; members that open different cases are flagged for review; and the
// official reporter's printing is the one listed first. Rendered through the same
// functions the reader, the sidebar and /check use, with the rules from the WASM
// (stare::parallel::reconcile), as the site has them.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  checkCitations,
  citationSummary,
  citedGroupHtml,
  citedForms,
  citeCategory,
  groupCitations,
  occurrence,
  pageResult,
  renderTextHtml,
} from '../public/js/citations.js';
import { reconcile } from './wasm-node.js';

const VECTORS = JSON.parse(readFileSync(
  new URL('../../crates/stare/tests/fixtures/parallel-reconcile.json', import.meta.url),
)).vectors;

// The rules are Rust's, tested there on these vectors; this checks they cross the WASM
// boundary in the shape checkCitations reads (`partner` null, not missing, and so on).
describe('the WASM export reconcile_parallels', () => {
  for (const v of VECTORS) {
    test(v.name, async () => assert.deepEqual(await reconcile(v.printings), v.verdicts));
  }
});

const withoutPlaces = (html) => html.replace(/ data-cite-(?:group|place|form)="[^"]*"/g, '');

// A detected citation in the shape detectCitations returns, located in `text` by its
// raw string.
function cite(text, raw, fields = {}) {
  const at = text.indexOf(raw);
  assert.ok(at >= 0, `${raw} not in text`);
  return {
    raw, type: 'FullCaseCitation', harvard_slug: null, slug: null, volume: null, page: null,
    reporter: null, correctedReporter: null, official: false, year: null, start: at,
    end: at + raw.length, externalUrl: null, law: null, caseLinks: [], caseName: null, pin: null,
    antecedent: null, parallelTo: null, ...fields,
  };
}

const NEB = { slug: 'neb', volume: 128, page: '783', reporter: 'Neb.', official: true };
const NW = { slug: 'n-w', volume: 260, page: '287', reporter: 'N.W.' };
const LINKS = [{ source: 'courtlistener', kind: 'full_text', url: 'https://www.courtlistener.com/c/N.W./260/287/' }];

// Check `detected` as /check does, with `held` the volumes stare.pub holds and `cases`
// what a page lookup finds (true, an alias, or null for an index that can't be read).
async function check(text, detected, { held = [], cases = {} } = {}) {
  const checked = await checkCitations(
    detected,
    async (slug, volume) => held.includes(`${slug}/${volume}`),
    async (slug, volume, page) => {
      const key = `${slug}/${volume}/${page}`;
      return key in cases ? cases[key] : false;
    },
    reconcile,
  );
  const groups = groupCitations(detected, checked);
  const map = new Map(checked.map(c => [c.key, c]));
  const html = withoutPlaces(renderTextHtml(text, detected.map(occurrence), map).join('\n'));
  const entry = (raw) => checked.find(c => c.raw === raw);
  return { checked, groups, html, entry };
}

function tagFor(html, raw) {
  const re = new RegExp(`<(a|span) [^>]*>${raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</\\1>`);
  const m = html.match(re);
  assert.ok(m, `no element for ${raw} in ${html}`);
  return m[0];
}

describe('a member stare.pub doesn\'t hold', () => {
  const text = 'Pettegrew v. Pettegrew, 128 Neb. 783, 260 N.W. 287 (1935). Id. at 790.';
  const neb = cite(text, '128 Neb. 783', NEB);
  const nw = cite(text, '260 N.W. 287', { ...NW, caseLinks: LINKS, parallelTo: '128 Neb. 783' });
  const id = cite(text, 'Id.', { type: 'IdCitation', pin: '790', antecedent: nw });
  const detected = [neb, nw, id];
  const opts = { held: ['neb/128'], cases: { 'neb/128/783': true } };

  test('resolves through the printing it holds, labelled as inferred', async () => {
    const { html, entry } = await check(text, detected, opts);
    assert.match(tagFor(html, '260 N.W. 287'),
      /^<a class="cite-link" href="#neb\/128\/783" [^>]*data-partner="128 Neb\. 783" title="260 N\.W\. 287\. Reported at 128 Neb\. 783, inferred from the citing text">/);
    assert.equal(entry('260 N.W. 287').partner, '128 Neb. 783');
    assert.doesNotMatch(html, /courtlistener/, 'not a link-out');
  });

  test('a short form to it follows it', async () => {
    const { html } = await check(text, detected, opts);
    assert.match(tagFor(html, 'Id.'), /href="#neb\/128\/783@790"/);
  });

  test('is one sidebar entry with the held printing first, and counts as a hit', async () => {
    const { checked, groups } = await check(text, detected, opts);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].primary.raw, '128 Neb. 783');
    assert.equal(groups[0].category, 'held');
    assert.match(citedGroupHtml(groups[0], (c) => `#${c.slug}/${c.volume}/${c.page}`),
      /Also cited as 260 N\.W\. 287 <span class="cited-form-count"[^>]*>\(1×\)<\/span> <span class="cited-also-note">Reported at 128 Neb\. 783, inferred from the citing text<\/span>/);
    // One case, cited at two places: the run, and the Id. (#198). Each form
    // counts its own: the run once for each printing, the Id. once (D72).
    assert.deepEqual(citedForms(groups[0]).map(f => [f.member.raw, f.count]),
      [['128 Neb. 783', 1], ['260 N.W. 287', 1], ['Id.', 1]]);
    assert.equal(groups[0].count, 2);
    assert.equal(checked.length, 3);
    assert.equal(citationSummary(groups), '1 cited case found (1 resolvable)');
  });

  test('without a partner in the text, it still links out', async () => {
    const t = 'See 260 N.W. 287 (Neb. 1935).';
    const { html, entry } = await check(t, [cite(t, '260 N.W. 287', { ...NW, caseLinks: LINKS })], opts);
    assert.equal(entry('260 N.W. 287').resolvable, false);
    assert.match(tagFor(html, '260 N.W. 287'), /^<a class="cite-lookup" href="https:\/\/www\.courtlistener\.com\//);
  });
});

describe('a reprint page CAP redacted in a volume stare.pub holds', () => {
  const text = 'Smith v. Jones, 150 Pa. Super. 1, 31 A.2d 650 (1943).';
  const pa = cite(text, '150 Pa. Super. 1', { slug: 'pa-super', volume: 150, page: '1', reporter: 'Pa. Super.', official: true });
  const a2d = cite(text, '31 A.2d 650', { slug: 'a2d', volume: 31, page: '650', reporter: 'A.2d', parallelTo: '150 Pa. Super. 1' });

  test('resolves through its partner, not as a miss', async () => {
    const { html, groups } = await check(text, [pa, a2d],
      { held: ['pa-super/150', 'a2d/31'], cases: { 'pa-super/150/1': true } });
    assert.match(tagFor(html, '31 A.2d 650'), /href="#pa-super\/150\/1"[^>]*title="31 A\.2d 650\. Reported at 150 Pa\. Super\. 1, inferred from the citing text"/);
    assert.doesNotMatch(html, /No case found/);
    assert.equal(groups.length, 1);
  });

  test('an index that can\'t be read stays unchecked', async () => {
    const { html, entry } = await check(text, [pa, a2d],
      { held: ['pa-super/150', 'a2d/31'], cases: { 'pa-super/150/1': true, 'a2d/31/650': null } });
    assert.equal(entry('31 A.2d 650').partner, undefined);
    assert.match(tagFor(html, '31 A.2d 650'), /class="cite-unresolved cite-unknown"/);
  });
});

describe('both printings held', () => {
  test('the official reporter\'s is listed first, whatever the order in the text', async () => {
    const text = 'Pettegrew v. Pettegrew, 260 N.W. 287, 128 Neb. 783 (1935).';
    const nw = cite(text, '260 N.W. 287', NW);
    const neb = cite(text, '128 Neb. 783', { ...NEB, parallelTo: '260 N.W. 287' });
    const alias = { via: 'cl:8077312', target: { slug: 'neb', folder: '128', caseFile: '0783-01' } };
    const { groups, html } = await check(text, [nw, neb],
      { held: ['neb/128', 'n-w/260'], cases: { 'neb/128/783': true, 'n-w/260/287': alias } });
    assert.equal(groups.length, 1);
    assert.equal(groups[0].primary.raw, '128 Neb. 783');
    // The alias keeps its own label: data, not the citing text.
    assert.match(tagFor(html, '260 N.W. 287'), /title="260 N\.W\. 287\. Resolved through CourtListener&#39;s citation metadata"/);
    assert.doesNotMatch(html, /inferred/);
  });
});

describe('members that open different cases', () => {
  const text = 'Smith v. Jones, 345 Pa. 1, 31 A.2d 650, 99 N.W. 1 (1943).';
  const pa = cite(text, '345 Pa. 1', { slug: 'pa', volume: 345, page: '1', reporter: 'Pa.', official: true });
  const a2d = cite(text, '31 A.2d 650', { slug: 'a2d', volume: 31, page: '650', reporter: 'A.2d', parallelTo: '345 Pa. 1' });
  const nw = cite(text, '99 N.W. 1', { slug: 'n-w', volume: 99, page: '1', reporter: 'N.W.', caseLinks: LINKS, parallelTo: '345 Pa. 1' });
  const opts = { held: ['pa/345', 'a2d/31'], cases: { 'pa/345/1': true, 'a2d/31/650': true } };

  test('are both shown, apart, and flagged for review', async () => {
    const { groups, html, checked } = await check(text, [pa, a2d, nw], opts);
    const listed = groups.map(g => g.primary.raw);
    assert.deepEqual(listed, ['345 Pa. 1', '31 A.2d 650', '99 N.W. 1']);
    assert.deepEqual(groups.map(g => g.category), ['review', 'review', 'elsewhere']);
    assert.match(tagFor(html, '345 Pa. 1'),
      /^<a class="cite-link cite-review" href="#pa\/345\/1"[^>]*title="345 Pa\. 1\. Cited in parallel with 31 A\.2d 650, which opens a different case; needs review"/);
    assert.match(citedGroupHtml(groups[1], () => '#'),
      /<span class="cited-lookup cited-review">Cited in parallel with 345 Pa\. 1, which opens a different case; needs review<\/span>/);
    assert.equal(checked.length, 3);
    assert.equal(citationSummary(groups), '3 cited cases found (2 resolvable), 1 needs review');
    // Each case flagged counts the run's place once.
    assert.deepEqual(groups.map(g => g.count), [1, 1, 1]);
    assert.equal(citeCategory(checked[0]), 'review');
  });

  test('nothing resolves through them', async () => {
    const { entry, html } = await check(text, [pa, a2d, nw], opts);
    assert.equal(entry('99 N.W. 1').resolvable, false);
    assert.match(tagFor(html, '99 N.W. 1'), /^<a class="cite-lookup"/);
  });
});

// #204: where several decisions start at a page, a member is compared against every one
// of them, and opens the one its run shares.
describe('a page several decisions start on', () => {
  const VIA = (n) => `cl:${n}`;
  const alias = (reporter, folder, caseFile, n) => ({ page: '287', source: 'cap', reporter, folder, case_file: caseFile, via: VIA(n) });
  const own = (page, caseFile) => ({ page, source: 'cap', case_file: caseFile });

  test('a reprint whose partner is the second decision there resolves to it, not flagged', async () => {
    const text = 'Pettegrew v. Pettegrew, 128 Neb. 783, 260 N.W. 287 (1935). Id. at 790.';
    const neb = cite(text, '128 Neb. 783', NEB);
    const nw = cite(text, '260 N.W. 287', { ...NW, parallelTo: '128 Neb. 783' });
    const id = cite(text, 'Id.', { type: 'IdCitation', pin: '790', antecedent: nw });
    const atNw = pageResult(
      [alias('iowa', '219', '0500-01', 1), alias('neb', '128', '0783-01', 8077312)], 'n-w', 260, '287');
    const { groups, html, entry } = await check(text, [neb, nw, id],
      { held: ['neb/128', 'n-w/260'], cases: { 'neb/128/783': true, 'n-w/260/287': atNw } });
    assert.equal(entry('260 N.W. 287').conflicts, undefined);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].primary.raw, '128 Neb. 783');
    // It opens the Nebraska case, through the alias that names it, with that alias's label.
    assert.match(tagFor(html, '260 N.W. 287'),
      /^<a class="cite-link" href="#neb\/128\/783" [^>]*data-via="cl:8077312" title="260 N\.W\. 287\. Resolved through CourtListener&#39;s citation metadata"/);
    assert.match(tagFor(html, 'Id.'), /href="#neb\/128\/783@790"/);
  });

  test('the official page\'s second decision, when it is the one the run shares', async () => {
    const text = 'Ray v. Bruce, 163 Md. 481, 163 A. 183 (1932).';
    const md = cite(text, '163 Md. 481', { slug: 'md', volume: 163, page: '481', reporter: 'Md.', official: true });
    const a = cite(text, '163 A. 183', { slug: 'a', volume: 163, page: '183', reporter: 'A.', parallelTo: '163 Md. 481' });
    const atMd = pageResult([own('481', '0481-01'), own('481', '0481-02')], 'md', 163, '481');
    const atA = pageResult([{ ...alias('md', '163', '0481-02', 42), page: '183' }], 'a', 163, '183');
    const { groups, html, entry } = await check(text, [md, a],
      { held: ['md/163', 'a/163'], cases: { 'md/163/481': atMd, 'a/163/183': atA } });
    assert.equal(entry('163 Md. 481').conflicts, undefined);
    assert.equal(entry('163 Md. 481').seq, 2);
    assert.equal(groups.length, 1);
    assert.match(tagFor(html, '163 Md. 481'), /^<a class="cite-link" href="#md\/163\/481-02"/);
    assert.match(citedGroupHtml(groups[0], (c) => `#${c.slug}/${c.volume}/${c.page}`), /Also cited as 163 A\. 183/);
  });

  test('pages with no decision in common are still flagged', async () => {
    const text = 'Smith v. Jones, 345 Pa. 1, 31 A.2d 650 (1943).';
    const pa = cite(text, '345 Pa. 1', { slug: 'pa', volume: 345, page: '1', reporter: 'Pa.', official: true });
    const a2d = cite(text, '31 A.2d 650', { slug: 'a2d', volume: 31, page: '650', reporter: 'A.2d', parallelTo: '345 Pa. 1' });
    const atPa = pageResult([own('1', '0001-01'), own('1', '0001-02')], 'pa', 345, '1');
    const atA2d = pageResult([own('650', '0650-01'), own('650', '0650-02')], 'a2d', 31, '650');
    const { groups, entry } = await check(text, [pa, a2d],
      { held: ['pa/345', 'a2d/31'], cases: { 'pa/345/1': atPa, 'a2d/31/650': atA2d } });
    assert.deepEqual(entry('345 Pa. 1').conflicts, ['31 A.2d 650']);
    assert.equal(groups.length, 2);
  });
});
