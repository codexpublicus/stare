// #212: at a page several cases start on, with nothing else to say which one a citation
// means, the citing text's case name picks it (stare::byname::pick, through the WASM),
// and the citation says so. The cases' names are read by range requests out of the
// volume's zip (casenames.js, stare::ziprange).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  byNameLabel,
  checkCitations,
  citedGroupHtml,
  groupCitations,
  occurrence,
  pageResult,
  renderTextHtml,
} from '../public/js/citations.js';
import { readCaseNames, zipDirectory } from '../public/js/casenames.js';
import { reconcile, wasm } from './wasm-node.js';

const withoutPlaces = (html) => html.replace(/ data-cite-(?:group|place|form)="[^"]*"/g, '');

function cite(text, raw, fields = {}) {
  const at = text.indexOf(raw);
  assert.ok(at >= 0, `${raw} not in text`);
  return {
    raw, type: 'FullCaseCitation', harvard_slug: null, slug: null, volume: null, page: null,
    reporter: null, correctedReporter: null, official: false, year: null, start: at,
    end: at + raw.length, externalUrl: null, law: null, caseLinks: [], caseName: null,
    historyName: null, pin: null, antecedent: null, parallelTo: null, ...fields,
  };
}

function tagFor(html, raw) {
  const re = new RegExp(`<(a|span) [^>]*>${raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</\\1>`);
  const m = html.match(re);
  assert.ok(m, `no element for ${raw} in ${html}`);
  return m[0];
}

// The cases at 261 Conn. 941 and 808 A.2d 1132 in index v2026.10.22: Conn.'s own three,
// and A.2d's three CourtListener aliases into Conn. 261, two of them at 941.
const own = (caseFile) => ({ page: '941', source: 'cap', case_file: caseFile });
const alias = (caseFile, n) => ({ page: '1132', source: 'cap', reporter: 'conn', folder: '261', case_file: caseFile, via: `cl:${n}` });
const AT_CONN = pageResult([own('0941-01'), own('0941-02'), own('0941-03')], 'conn', 261, '941');
const AT_A2D = pageResult([alias('0938-02', 7899662), alias('0941-01', 7899672), alias('0941-02', 7899673)], 'a2d', 808, '1132');
const NAMES = {
  'conn/261/0938-02': ['Dacruz v. State Farm Fire & Casualty Co.', '2002-09-12'],
  'conn/261/0941-01': ['Marshall v. Marshall', '2002-09-12'],
  'conn/261/0941-02': ['Segreto v. City of Bristol', '2002-09-12'],
  'conn/261/0941-03': ['State v. Nicholson', '2002-09-12'],
};
const read = async (c) => {
  const [name, date] = NAMES[`${c.ref.reporter}/${c.ref.folder}/${c.ref.caseFile}`];
  return { names: [name], date };
};

async function check(text, detected, readNames = read) {
  const checked = await checkCitations(
    detected,
    async (slug, volume) => ['conn/261', 'a2d/808'].includes(`${slug}/${volume}`),
    async (slug, volume, page) => ({ 'conn/261/941': AT_CONN, 'a2d/808/1132': AT_A2D })[`${slug}/${volume}/${page}`] || false,
    reconcile,
    readNames,
  );
  const groups = groupCitations(detected, checked);
  const map = new Map(checked.map(c => [c.key, c]));
  const html = withoutPlaces(renderTextHtml(text, detected.map(occurrence), map).join('\n'));
  return { checked, groups, html, entry: (raw) => checked.find(c => c.raw === raw) };
}

const href = (c) => `#${c.slug}/${c.volume}/${c.page}`;

describe('a page several cases start on, picked by the citing text\'s case name', () => {
  test('Brooks v. Powers: a run whose printings share two cases opens the one the text names', async () => {
    const text = 'Segreto v. Bristol, 71 Conn. App. 844, cert. denied, 261 Conn. 941, 808 A.2d 1132 (2002).';
    const conn = cite(text, '261 Conn. 941', { slug: 'conn', volume: 261, page: '941', reporter: 'Conn.', official: true, year: 2002, historyName: 'Segreto v. Bristol' });
    const a2d = cite(text, '808 A.2d 1132', { slug: 'a2d', volume: 808, page: '1132', reporter: 'A.2d', year: 2002, historyName: 'Segreto v. Bristol', parallelTo: '261 Conn. 941' });
    const { groups, html, entry } = await check(text, [conn, a2d]);
    assert.equal(entry('261 Conn. 941').seq, 2);
    assert.deepEqual(entry('261 Conn. 941').byName, { among: 2, shared: true });
    // The A.2d printing opens Segreto through the alias that names it, with its label.
    assert.deepEqual(entry('808 A.2d 1132').aliasOf, { slug: 'conn', folder: '261', caseFile: '0941-02' });
    assert.equal(entry('808 A.2d 1132').via, 'cl:7899673');
    assert.equal(groups.length, 1);
    assert.match(tagFor(html, '261 Conn. 941'),
      /^<a class="cite-link" href="#conn\/261\/941-02" [^>]*data-by-name="2" title="261 Conn\. 941\. Matched by case name among the 2 cases its parallel citations share"/);
    assert.match(citedGroupHtml(groups[0], href),
      /<span class="cited-lookup cited-by-name">Matched by case name among the 2 cases its parallel citations share<\/span>/);
  });

  test('a citation alone opens the case its name matches, labelled with the count at the page', async () => {
    const text = 'State v. Nicholson, 261 Conn. 941 (2002).';
    const conn = cite(text, '261 Conn. 941', { slug: 'conn', volume: 261, page: '941', reporter: 'Conn.', year: 2002, caseName: 'State v. Nicholson' });
    const { html, entry } = await check(text, [conn]);
    assert.equal(entry('261 Conn. 941').seq, 3);
    assert.equal(byNameLabel(entry('261 Conn. 941')), 'Matched by case name among the 3 cases on this page');
    assert.match(tagFor(html, '261 Conn. 941'), /href="#conn\/261\/941-03"/);
  });

  test('the page\'s first case, matched by name, keeps its link and says why', async () => {
    const text = 'Marshall v. Marshall, 261 Conn. 941.';
    const conn = cite(text, '261 Conn. 941', { slug: 'conn', volume: 261, page: '941', reporter: 'Conn.', caseName: 'Marshall v. Marshall' });
    const { html, entry } = await check(text, [conn]);
    assert.equal(entry('261 Conn. 941').seq, null);
    assert.match(tagFor(html, '261 Conn. 941'), /href="#conn\/261\/941" [^>]*data-by-name="3"/);
  });

  test('no clear match, another year, a failed read or no name: the page\'s first, as before', async () => {
    for (const [fields, readNames] of [
      [{ caseName: 'Doe v. Roe' }, read],
      [{ caseName: 'Segreto v. Bristol', year: 1999 }, read],
      [{ caseName: 'Segreto v. Bristol' }, async () => { throw new Error('offline'); }],
      [{}, read],
    ]) {
      const text = 'See 261 Conn. 941.';
      const conn = cite(text, '261 Conn. 941', { slug: 'conn', volume: 261, page: '941', reporter: 'Conn.', ...fields });
      const { html, entry } = await check(text, [conn], readNames);
      assert.equal(entry('261 Conn. 941').byName, undefined, JSON.stringify(fields));
      assert.match(tagFor(html, '261 Conn. 941'), /href="#conn\/261\/941" (?![^>]*data-by-name)/);
    }
  });

  test('a short form and a printing resolved through its partner follow the picked case', async () => {
    const text = 'Segreto v. Bristol, 261 Conn. 941, 999 A.2d 1 (2002). Id.';
    const conn = cite(text, '261 Conn. 941', { slug: 'conn', volume: 261, page: '941', reporter: 'Conn.', official: true, caseName: 'Segreto v. Bristol' });
    const other = cite(text, '999 A.2d 1', { slug: 'a2d', volume: 999, page: '1', reporter: 'A.2d', caseName: 'Segreto v. Bristol', parallelTo: '261 Conn. 941' });
    const id = cite(text, 'Id.', { type: 'IdCitation', antecedent: conn });
    const { html, entry, groups } = await check(text, [conn, other, id]);
    // Its partner misses, so nothing narrowed the page's three cases.
    assert.deepEqual(entry('261 Conn. 941').byName, { among: 3, shared: false });
    assert.equal(entry('999 A.2d 1').partner, '261 Conn. 941');
    assert.equal(entry('999 A.2d 1').seq, 2);
    assert.match(tagFor(html, 'Id.'), /href="#conn\/261\/941-02"/);
    assert.equal(groups.length, 1);
  });
});

// State v. Gordon, as Conn. App. opinions cite it (D90): the U.S. Reports page has twelve
// orders, and CourtListener's aliases at the S. Ct. and L. Ed. pages, in index
// v2026.10.22, share three of them, none of them Connecticut v. Gordon.
const US_NAMES = [
  'Leicht v. Florida', 'Connecticut v. Gordon', "Montana Wilderness Ass'n v. United States Forest Service",
  'Wright Line v. National Labor Relations Board', 'Gomez v. United States', 'Siegel v. United States',
  'Bruschi v. United States', 'Catalina v. City of Columbus', 'Truck Drivers & Helpers Local Union No. 728 v. Allen',
  'F. W. Woolworth Co. v. National Labor Relations Board', 'Watkins v. United States', 'Spieler v. United States',
];
const usFile = (n) => `0989-${String(n).padStart(2, '0')}`;
const AT_US = pageResult(US_NAMES.map((_, i) => ({ page: '989', source: 'cap', case_file: usFile(i + 1) })), 'us', 455, '989');
const usAlias = (page, caseFile, n) => ({ page, source: 'cap', reporter: 'us', folder: '455', case_file: caseFile, via: `cl:${n}` });
const AT_SCT = pageResult([
  usAlias('1612', '0989-02', 9037656), usAlias('1612', '0989-03', 9037657), usAlias('1612', '0989-05', 9037659),
  usAlias('1612', '0989-06', 9037660), usAlias('1612', '0989-07', 9037661),
], 's-ct', 102, '1612');
const AT_LED = pageResult([
  usAlias('848', '0988-08', 9037653), usAlias('848', '0989-05', 9037659),
  usAlias('848', '0989-06', 9037660), usAlias('848', '0989-07', 9037661),
], 'l-ed-2d', 71, '848');
const US_READ = async (c) => {
  const file = c.ref.caseFile;
  const name = file === '0988-08' ? 'Rushen v. Taylor' : US_NAMES[parseInt(file.slice(5), 10) - 1];
  return { names: [name], date: '1982-03-01' };
};

async function checkGordon(text, detected) {
  const pages = { 'us/455/989': AT_US, 's-ct/102/1612': AT_SCT, 'l-ed-2d/71/848': AT_LED };
  const checked = await checkCitations(
    detected,
    async (slug, volume) => ['us/455', 's-ct/102', 'l-ed-2d/71'].includes(`${slug}/${volume}`),
    async (slug, volume, page) => pages[`${slug}/${volume}/${page}`] || false,
    reconcile,
    US_READ,
  );
  const groups = groupCitations(detected, checked);
  const map = new Map(checked.map(c => [c.key, c]));
  const html = withoutPlaces(renderTextHtml(text, detected.map(occurrence), map).join('\n'));
  return { checked, groups, html, entry: (raw) => checked.find(c => c.raw === raw) };
}

function gordon(name = 'State v. Gordon') {
  const text = `${name}, 185 Conn. 402, 441 A.2d 119 (1981), cert. denied, 455 U.S. 989, 102 S. Ct. 1612, 71 L. Ed. 2d 848 (1982).`;
  const fields = { year: 1982, historyName: name };
  return {
    text,
    detected: [
      cite(text, '455 U.S. 989', { slug: 'us', volume: 455, page: '989', reporter: 'U.S.', official: true, ...fields }),
      cite(text, '102 S. Ct. 1612', { slug: 's-ct', volume: 102, page: '1612', reporter: 'S. Ct.', parallelTo: '455 U.S. 989', ...fields }),
      cite(text, '71 L. Ed. 2d 848', { slug: 'l-ed-2d', volume: 71, page: '848', reporter: 'L. Ed. 2d', parallelTo: '102 S. Ct. 1612', ...fields }),
    ],
  };
}

describe('a run whose shared cases miss the name, decided on the official page (D90)', () => {
  test('State v. Gordon: every printing opens Connecticut v. Gordon, and says why', async () => {
    const { text, detected } = gordon();
    const { groups, html, entry } = await checkGordon(text, detected);
    const note = "Matched by case name among the 12 cases on the official page, 455 U.S. 989; the cases its parallel citations share don't include it";
    assert.deepEqual(entry('455 U.S. 989').byName, { among: 12, shared: false, official: '455 U.S. 989' });
    for (const raw of ['455 U.S. 989', '102 S. Ct. 1612', '71 L. Ed. 2d 848']) {
      assert.equal(entry(raw).slug, 'us', raw);
      assert.equal(entry(raw).seq, 2, raw);
      assert.equal(byNameLabel(entry(raw)), note, raw);
    }
    // S. Ct.'s own alias names the case; L. Ed.'s data doesn't, so it has no via.
    assert.equal(entry('102 S. Ct. 1612').via, 'cl:9037656');
    assert.equal(entry('71 L. Ed. 2d 848').via, null);
    assert.equal(groups.length, 1);
    assert.match(tagFor(html, '455 U.S. 989'), /^<a class="cite-link" href="#us\/455\/989-02" [^>]*data-by-name="12"/);
    assert.match(tagFor(html, '71 L. Ed. 2d 848'), /href="#us\/455\/989-02"/);
    assert.match(citedGroupHtml(groups[0], href), /<span class="cited-lookup cited-by-name">Matched by case name among the 12 cases on the official page, 455 U\.S\. 989; [^<]*<\/span>/);
  });

  test('a shared case the name fits is picked among the shared cases, as before', async () => {
    const { text, detected } = gordon('Gomez v. United States');
    const { entry } = await checkGordon(text, detected);
    assert.deepEqual(entry('455 U.S. 989').byName, { among: 3, shared: true });
    assert.equal(entry('455 U.S. 989').seq, 5);
  });

  test('a name two cases on the page fit, or none, keeps the run\'s narrowing', async () => {
    for (const name of ['Doe v. Roe', 'United States v. Watkins Spieler']) {
      const { text, detected } = gordon(name);
      const { entry } = await checkGordon(text, detected);
      assert.equal(entry('455 U.S. 989').byName, undefined, name);
      assert.equal(entry('455 U.S. 989').seq, 5, name);
      assert.equal(entry('71 L. Ed. 2d 848').via, 'cl:9037659', name);
    }
  });

  test('without an official printing in the run, nothing is matched on a whole page', async () => {
    const { text, detected } = gordon();
    detected[0].official = false;
    const { entry } = await checkGordon(text, detected);
    assert.equal(entry('455 U.S. 989').byName, undefined);
    assert.equal(entry('455 U.S. 989').seq, 5);
  });
});

// State v. Shabazz, as Conn. opinions cite it (D98 (1)): 525 U.S. 1179 has fifteen cert.
// denials; in index v2026.10.22, 119 S. Ct. 1116 has aliases to seven of them (Shabazz
// among them) and 143 L. Ed. 2d 111 one, to Compagnie Euralair, so the run's printings
// share Euralair alone.
const SHABAZZ_NAMES = [
  'Horvath v. Ohio State Teachers Retirement Board', 'Onstine v. Ramaley', 'Shabazz v. Connecticut',
  'Compagnie Euralair, S. A. v. General Electric Co.', 'Schap v. United States', 'Idarecis v. United States',
  'Andonian v. United States', 'Kirk v. United States', 'Dayton v. United States', 'Walden v. United States',
  'Hartbarger v. United States', 'Hudson v. United States', 'Smith v. United States', 'Bolin v. Nevada',
  'Davis v. Alabama',
];
const shabazzFile = (n) => `1179-${String(n).padStart(2, '0')}`;
const AT_US_525 = pageResult(SHABAZZ_NAMES.map((_, i) => ({ page: '1179', source: 'cap', case_file: shabazzFile(i + 1) })), 'us', 525, '1179');
const us525Alias = (page, n, cluster) => ({ page, source: 'cap', reporter: 'us', folder: '525', case_file: shabazzFile(n), via: `cl:${cluster}` });
const AT_SCT_119 = pageResult([
  us525Alias('1116', 3, 9183938), us525Alias('1116', 4, 9183940), us525Alias('1116', 5, 9183941),
  us525Alias('1116', 6, 9183943), us525Alias('1116', 7, 9183945), us525Alias('1116', 8, 9183947),
  us525Alias('1116', 9, 9183949),
], 's-ct', 119, '1116');
const AT_LED_143 = pageResult([us525Alias('111', 4, 9183940)], 'l-ed-2d', 143, '111');

async function checkShabazz(name = 'State v. Shabazz', official = true) {
  const text = `${name}, 246 Conn. 746, 759, 719 A.2d 440 (1998), cert. denied, 525 U.S. 1179, 119 S. Ct. 1116, 143 L. Ed. 2d 111 (1999).`;
  const fields = { year: 1999, historyName: name };
  const detected = [
    cite(text, '525 U.S. 1179', { slug: 'us', volume: 525, page: '1179', reporter: 'U.S.', official, ...fields }),
    cite(text, '119 S. Ct. 1116', { slug: 's-ct', volume: 119, page: '1116', reporter: 'S. Ct.', parallelTo: '525 U.S. 1179', ...fields }),
    cite(text, '143 L. Ed. 2d 111', { slug: 'l-ed-2d', volume: 143, page: '111', reporter: 'L. Ed. 2d', parallelTo: '119 S. Ct. 1116', ...fields }),
  ];
  const pages = { 'us/525/1179': AT_US_525, 's-ct/119/1116': AT_SCT_119, 'l-ed-2d/143/111': AT_LED_143 };
  const checked = await checkCitations(
    detected,
    async (slug, volume) => ['us/525', 's-ct/119', 'l-ed-2d/143'].includes(`${slug}/${volume}`),
    async (slug, volume, page) => pages[`${slug}/${volume}/${page}`] || false,
    reconcile,
    async (c) => ({ names: [SHABAZZ_NAMES[parseInt(c.ref.caseFile.slice(5), 10) - 1]], date: '1999-03-01' }),
  );
  const groups = groupCitations(detected, checked);
  const map = new Map(checked.map(c => [c.key, c]));
  const html = withoutPlaces(renderTextHtml(text, detected.map(occurrence), map).join('\n'));
  return { groups, html, entry: (raw) => checked.find(c => c.raw === raw) };
}

describe('a run sharing one case the name clearly isn\'t, decided on the official page (D98 (1))', () => {
  test('State v. Shabazz: every printing opens Shabazz v. Connecticut, and says why', async () => {
    const { groups, html, entry } = await checkShabazz();
    const note = "Matched by case name among the 15 cases on the official page, 525 U.S. 1179; the case its parallel citations share doesn't fit the name";
    assert.deepEqual(entry('525 U.S. 1179').byName, { among: 15, shared: false, official: '525 U.S. 1179', sharesOne: true });
    for (const raw of ['525 U.S. 1179', '119 S. Ct. 1116', '143 L. Ed. 2d 111']) {
      assert.equal(entry(raw).slug, 'us', raw);
      assert.equal(entry(raw).seq, 3, raw);
      assert.equal(byNameLabel(entry(raw)), note, raw);
    }
    // S. Ct.'s own alias names Shabazz; L. Ed.'s one alias is Euralair's, so it has no via.
    assert.equal(entry('119 S. Ct. 1116').via, 'cl:9183938');
    assert.equal(entry('143 L. Ed. 2d 111').via, null);
    assert.equal(groups.length, 1);
    assert.match(tagFor(html, '525 U.S. 1179'), /^<a class="cite-link" href="#us\/525\/1179-03" [^>]*data-by-name="15"/);
    assert.match(tagFor(html, '143 L. Ed. 2d 111'), /href="#us\/525\/1179-03"/);
    assert.match(citedGroupHtml(groups[0], href), /<span class="cited-lookup cited-by-name">Matched by case name among the 15 cases on the official page, 525 U\.S\. 1179; the case its parallel citations share doesn&#39;t fit the name<\/span>/);
  });

  test('a name the shared case fits, even partly, keeps it', async () => {
    for (const name of ['Compagnie Euralair v. General Electric', 'Euralair v. Shabazz']) {
      const { entry } = await checkShabazz(name);
      assert.equal(entry('525 U.S. 1179').byName, undefined, name);
      assert.equal(entry('525 U.S. 1179').seq, 4, name);
      assert.equal(entry('143 L. Ed. 2d 111').via, 'cl:9183940', name);
    }
  });

  test('a name nothing on the page fits, one with no telling words, or no official printing: Euralair stands', async () => {
    for (const [name, official] of [['Doe v. Roe', true], ['State v.', true], ['State v. Shabazz', false]]) {
      const { entry } = await checkShabazz(name, official);
      assert.equal(entry('525 U.S. 1179').byName, undefined, name);
      assert.equal(entry('525 U.S. 1179').seq, 4, name);
    }
  });
});

// A zip read the way data.stare.pub serves one to a Range request.
function rangeServer(bytes, log = []) {
  return async (url, range) => {
    log.push(range);
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start; let end;
    if (m[1] === '') { start = Math.max(bytes.length - parseInt(m[2], 10), 0); end = bytes.length; }
    else { start = parseInt(m[1], 10); end = m[2] === '' ? bytes.length : parseInt(m[2], 10) + 1; }
    return { bytes: bytes.slice(start, end), start };
  };
}

describe('case names read out of a zip by range requests', () => {
  const zip = new Uint8Array(readFileSync(new URL('../../crates/stare/tests/fixtures/a2d-31.zip', import.meta.url)));

  test('the directory from the tail, then one entry', async () => {
    const log = [];
    const deps = { fetchRange: rangeServer(zip, log), wasm, fresh: true };
    const ref = { source: 'cap', reporter: 'a2d', folder: '31', caseFile: '0657-02' };
    const names = await readCaseNames({ id: 'a2d/31/657-2', ref }, deps);
    assert.deepEqual(names.names[0], 'Waterman v. Railway Express Agency, Inc.');
    assert.equal(names.date, '1943-05-11');
    assert.equal(log[0], 'bytes=-65536');
    assert.equal(log.length, 2);
    // The bytes fetched are a small part of the zip.
    assert.ok(zip.length > 200000);
  });

  test('a directory that starts before the tail is read from where it starts', async () => {
    // A server that sends only the last 100 bytes of whatever is asked from the end.
    const serve = rangeServer(zip);
    const short = async (url, range) => (range.startsWith('bytes=-') ? serve(url, 'bytes=-100') : serve(url, range));
    const entries = await zipDirectory('x', { fetchRange: short, wasm });
    assert.ok(entries.some(e => e.name === 'json/0657-01.json'));
  });

  test('a CourtListener record is read whole', async () => {
    const ref = { source: 'cl', cluster_id: 1, hash: '0123456789abcdef' };
    const names = await readCaseNames({ ref }, {
      fresh: true,
      fetchClRecord: async () => ({ name: 'A v. B', name_abbreviation: 'A v. B', decision_date: '2001-02-03' }),
    });
    assert.deepEqual(names, { names: ['A v. B', 'A v. B'], date: '2001-02-03' });
  });
});
