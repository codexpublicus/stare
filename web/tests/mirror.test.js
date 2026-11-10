// A self-hosted copy of stare.pub (#231, D119): how the reader tells a copy from stare.pub
// (sources.js), what it reads there, and how it says so (mirror.js). The kit's server rules
// are tested against real servers in scripts/mirror-kit/servers.test.mjs.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import {
  DATA_URL, INDEX_URL, MIRROR, detectMirror, hasFeature, isUpstreamHost, localDataUrl,
  mirrorBases, mirrorHasFeature, parseMirror, upstreamUrl, zipUrl,
} from '../public/js/sources.js';
import {
  NotInCopyError, keyMissNote, mirrorDetail, notInCopyHtml, showMirror,
} from '../public/js/mirror.js';
import { addLinks } from '../src/lib/caseroute.js';

const root = new URL('../../', import.meta.url);
const README = readFileSync(new URL('mirror-kit/README.md', root), 'utf8');
const SCHEMA = JSON.parse(readFileSync(new URL('schemas/mirror.v1.schema.json', root), 'utf8'));

// The mirror.json in the kit's README, which the release process writes and the schema describes.
const EXAMPLE = JSON.parse(README.match(/```json\n(\{\s*"format": "stare-mirror"[\s\S]*?)\n```/)[1]);

const TIER1 = parseMirror(EXAMPLE);
const TIER2 = parseMirror({
  ...EXAMPLE,
  tiers: [1, 2],
  components: { ...EXAMPLE.components, cap: { version: '2024-03-01' }, cl: { version: '2026-09-30' }, search: { version: 'v2026.11.05.3' } },
});
const TIER4 = parseMirror({
  ...EXAMPLE,
  components: { ...EXAMPLE.components, cap: { version: 'x' }, 'pdf/a2d': { version: '2026-10-01' }, 'cap-raw/a2d': { version: '2024-03-01' } },
});

// A fetch that answers once with `status`, `type` and `body`, recording what it was asked.
function fakeFetch(status, type, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? type : null) },
      text: async () => body,
    };
  };
  fn.calls = calls;
  return fn;
}

describe('which hosts are stare.pub', () => {
  test('stare.pub, its subdomains and the Workers previews keep the upstream hosts', () => {
    for (const h of ['stare.pub', 'STARE.PUB', 'www.stare.pub', 'idx.stare.pub', 'stare.pub.',
      'main-stare-pub.nick-441.workers.dev', '4f2a9c1e-stare-pub.nick-441.workers.dev',
      'stare-pub.nick-441.workers.dev']) {
      assert.ok(isUpstreamHost(h), h);
    }
  });

  test('every other host is a candidate copy', () => {
    for (const h of ['localhost', '127.0.0.1', 'mirror.example.org', 'stare.pub.example.org',
      'notstare.pub', 'evil-stare.pub.attacker.dev', 'stare-pub.someone.workers.dev',
      'main-stare-pub.other.workers.dev', '', null]) {
      assert.ok(!isUpstreamHost(h), String(h));
    }
  });

  test("the head script's preconnect filter uses the same hosts", () => {
    const run = (hostname) => {
      const added = [];
      const doc = { location: { hostname }, createElement: () => ({}), head: { appendChild: (l) => added.push(l) } };
      addLinks([{ rel: 'preconnect', href: 'https://idx.stare.pub' }, { rel: 'modulepreload', href: '/x.js' }], doc);
      return added.map((l) => l.rel);
    };
    for (const h of ['stare.pub', 'main-stare-pub.nick-441.workers.dev', 'mirror.example.org', 'localhost', 'notstare.pub']) {
      assert.deepEqual(run(h), isUpstreamHost(h) ? ['preconnect', 'modulepreload'] : ['modulepreload'], h);
    }
  });
});

describe('reading mirror.json', () => {
  test('a copy\'s file is read once from /mirror/mirror.json, revalidated', async () => {
    const fetch = fakeFetch(200, 'application/json; charset=utf-8', JSON.stringify(EXAMPLE));
    const m = await detectMirror('http://mirror.local:8080', fetch);
    assert.equal(fetch.calls.length, 1);
    assert.equal(fetch.calls[0].url, 'http://mirror.local:8080/mirror/mirror.json');
    assert.equal(fetch.calls[0].init.cache, 'no-cache');
    assert.equal(m.release, 'v2026.11.10');
    assert.equal(m.data_date, '2026-11-08');
    assert.deepEqual(m.tiers, [1]);
    assert.equal(m.upstream, 'https://stare.pub');
    assert.deepEqual(Object.keys(m.components).sort(), ['crk', 'index', 'kit', 'pdf-manifest', 'site']);
  });

  test('a development server\'s fallback page with a 200 is not a copy', async () => {
    const html = '<!doctype html><html><body>the reader</body></html>';
    assert.equal(await detectMirror('http://localhost:4321', fakeFetch(200, 'text/html; charset=utf-8', html)), null);
    // Nor when the server labels it something else: the body still isn't JSON.
    assert.equal(await detectMirror('http://localhost:4321', fakeFetch(200, 'application/json', html)), null);
    assert.equal(await detectMirror('http://localhost:4321', fakeFetch(200, null, html)), null);
  });

  test('a missing file, a failure or a timeout is not a copy', async () => {
    assert.equal(await detectMirror('http://h', fakeFetch(404, 'text/plain', 'Not found')), null);
    assert.equal(await detectMirror('http://h', fakeFetch(500, 'application/json', JSON.stringify(EXAMPLE))), null);
    assert.equal(await detectMirror('http://h', async () => { throw new TypeError('offline'); }), null);
    const hangs = (url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    assert.equal(await detectMirror('http://h', hangs, 20), null);
    assert.equal(await detectMirror('http://h', undefined), null);
  });

  test('only a stare-mirror file at a 1.x format version counts', async () => {
    const bad = [
      null, [], 'stare-mirror', {},
      { ...EXAMPLE, format: 'stare-mirror-release' },
      { ...EXAMPLE, format_version: '2.0.0' },
      { ...EXAMPLE, format_version: '1.0' },
      { ...EXAMPLE, format_version: 1 },
    ];
    for (const raw of bad) {
      assert.equal(parseMirror(raw), null, JSON.stringify(raw));
      assert.equal(await detectMirror('http://h', fakeFetch(200, 'application/json', JSON.stringify(raw))), null);
    }
    assert.ok(parseMirror({ ...EXAMPLE, format_version: '1.7.2', extra: true }));
  });

  test('the upstream is always stare.pub, whatever the file says', () => {
    assert.equal(parseMirror({ ...EXAMPLE, upstream: 'https://evil.example' }).upstream, 'https://stare.pub');
  });

  test("the README's example is a file the schema describes", () => {
    assert.equal(SCHEMA.$id, 'https://stare.pub/schemas/mirror.v1.schema.json');
    for (const k of SCHEMA.required) assert.ok(k in EXAMPLE, k);
    assert.equal(EXAMPLE.format, SCHEMA.properties.format.const);
    assert.match(EXAMPLE.format_version, new RegExp(SCHEMA.properties.format_version.pattern));
    assert.match(EXAMPLE.release, new RegExp(SCHEMA.properties.release.pattern));
    assert.match(EXAMPLE.data_date, new RegExp(SCHEMA.properties.data_date.pattern));
    for (const id of Object.keys(EXAMPLE.components)) {
      assert.match(id, new RegExp(SCHEMA.properties.components.propertyNames.pattern), id);
    }
  });
});

describe('what a copy reads', () => {
  test('in Node (no location), the module keeps stare.pub\'s hosts', () => {
    assert.equal(MIRROR, null);
    assert.equal(INDEX_URL, 'https://idx.stare.pub');
    assert.equal(DATA_URL, 'https://data.stare.pub');
    assert.equal(zipUrl('a2d', '31'), 'https://data.stare.pub/cap/a2d/31.zip');
    for (const f of ['text', 'search', 'pages', 'raw-scans']) assert.ok(hasFeature(f), f);
  });

  test("a copy's bases are its own /mirror/idx and /mirror/data, never static.case.law", () => {
    assert.deepEqual(mirrorBases('http://mirror.local:8080/k/us/x/'), {
      INDEX_URL: 'http://mirror.local:8080/mirror/idx',
      DATA_URL: 'http://mirror.local:8080/mirror/data',
      ZIP_URL: 'http://mirror.local:8080/mirror/data/cap',
      TAR_URL: 'http://mirror.local:8080/mirror/data/cap',
      PDF_URL: 'http://mirror.local:8080/mirror/data/pdf',
    });
  });

  // The module as a page on a copy loads it: location set, mirror.json answered. A fresh
  // instance (the query string), so the one the other tests import is untouched.
  async function loadOn(origin, answer) {
    const saved = { location: globalThis.location, fetch: globalThis.fetch };
    const url = new URL(origin);
    globalThis.location = { origin: url.origin, hostname: url.hostname, protocol: url.protocol, pathname: '/' };
    globalThis.fetch = answer;
    try {
      return await import(`../public/js/sources.js?on=${encodeURIComponent(origin)}&n=${Math.random()}`);
    } finally {
      globalThis.location = saved.location;
      globalThis.fetch = saved.fetch;
    }
  }

  test('on a copy, every URL the reader builds is the copy\'s, settled before any import runs', async () => {
    const s = await loadOn('http://pi.local:8080', fakeFetch(200, 'application/json', JSON.stringify(EXAMPLE)));
    assert.equal(s.MIRROR.release, 'v2026.11.10');
    assert.equal(s.INDEX_URL, 'http://pi.local:8080/mirror/idx');
    assert.equal(s.DATA_URL, 'http://pi.local:8080/mirror/data');
    assert.equal(s.indexUrl('manifest.json'), 'http://pi.local:8080/mirror/idx/manifest.json');
    assert.equal(s.zipUrl('a2d', '31'), 'http://pi.local:8080/mirror/data/cap/a2d/31.zip');
    assert.equal(s.pdfUrl('a2d', '31', 3), 'http://pi.local:8080/mirror/data/pdf/us/a2d/31.pdf#page=3');
    assert.equal(s.pdfManifestUrl('pr', '1'), 'http://pi.local:8080/mirror/data/pdf/pr/pr/1.json');
    assert.equal(s.tarUrl('a2d', '31'), 'http://pi.local:8080/mirror/data/cap/a2d/31.tar');
    assert.equal(s.tarCsvUrl('a2d', '31'), 'http://pi.local:8080/mirror/data/cap/a2d/31.tar.csv');
    assert.equal(s.clRecordUrl(4893133, '62f253f296600fb7'), 'http://pi.local:8080/mirror/data/cl/c/4893133/62f253f296600fb7.json.gz');
    // Tier 1: lookup only.
    assert.ok(!s.hasFeature('text'));
    assert.ok(!s.hasFeature('search'));
  });

  test('on stare.pub or a preview, mirror.json is never asked for', async () => {
    for (const origin of ['https://stare.pub', 'https://main-stare-pub.nick-441.workers.dev']) {
      const fetch = fakeFetch(200, 'application/json', JSON.stringify(EXAMPLE));
      const s = await loadOn(origin, fetch);
      assert.equal(fetch.calls.length, 0, origin);
      assert.equal(s.MIRROR, null);
      assert.equal(s.INDEX_URL, 'https://idx.stare.pub');
    }
  });

  test('on another host without a copy\'s file, the reader reads stare.pub as before', async () => {
    for (const answer of [
      fakeFetch(404, 'text/html', '<h1>404</h1>'),
      fakeFetch(200, 'text/html', '<!doctype html><title>stare.pub</title>'),
      fakeFetch(200, 'application/json', '{"format":"something-else"}'),
    ]) {
      const s = await loadOn('http://localhost:4321', answer);
      assert.equal(answer.calls.length, 1);
      assert.equal(s.MIRROR, null);
      assert.equal(s.DATA_URL, 'https://data.stare.pub');
      assert.equal(s.zipUrl('a2d', '31'), 'https://data.stare.pub/cap/a2d/31.zip');
    }
  });

  test('absolute stare.pub data URLs read out of data files resolve to the copy', async () => {
    // On stare.pub they're unchanged.
    assert.equal(localDataUrl('https://data.stare.pub/crk/errata.json'), 'https://data.stare.pub/crk/errata.json');
    const s = await loadOn('http://pi.local', fakeFetch(200, 'application/json', JSON.stringify(EXAMPLE)));
    // The ledger's latest.json names its errata list absolutely.
    assert.equal(s.localDataUrl('https://data.stare.pub/crk/errata.json'), 'http://pi.local/mirror/data/crk/errata.json');
    assert.equal(s.localDataUrl('https://idx.stare.pub/v/v2026.11.05.3/manifest.json'), 'http://pi.local/mirror/idx/v/v2026.11.05.3/manifest.json');
    assert.equal(s.localDataUrl('https://data.stare.pub'), 'http://pi.local/mirror/data');
    // Not a prefix match on the host name, and other hosts pass through.
    assert.equal(s.localDataUrl('https://data.stare.pub.evil/x'), 'https://data.stare.pub.evil/x');
    assert.equal(s.localDataUrl('https://www.courtlistener.com/opinion/1/'), 'https://www.courtlistener.com/opinion/1/');
  });
});

describe('features by component', () => {
  test('tier 1 has none of the text, search, pages or raw scans', () => {
    for (const f of ['text', 'search', 'pages', 'raw-scans']) assert.ok(!mirrorHasFeature(TIER1, f), f);
  });

  test('cap or cl is text; search is search; pdf/ is pages; cap-raw/ is raw scans', () => {
    assert.ok(mirrorHasFeature(TIER2, 'text'));
    assert.ok(mirrorHasFeature(TIER2, 'search'));
    assert.ok(!mirrorHasFeature(TIER2, 'pages'));
    assert.ok(mirrorHasFeature(parseMirror({ ...EXAMPLE, components: { cl: { version: 'x' } } }), 'text'));
    assert.ok(mirrorHasFeature(TIER4, 'pages'));
    assert.ok(mirrorHasFeature(TIER4, 'raw-scans'));
    assert.ok(!mirrorHasFeature(TIER4, 'search'));
    // `pdf-manifest` is tier 1's index of the PDFs, not the PDFs.
    assert.ok(!mirrorHasFeature(parseMirror({ ...EXAMPLE, components: { 'pdf-manifest': { version: 'x' } } }), 'pages'));
    assert.throws(() => mirrorHasFeature(TIER1, 'teleport'));
  });

  test('stare.pub has everything', () => {
    for (const f of ['text', 'search', 'pages', 'raw-scans']) assert.ok(mirrorHasFeature(null, f), f);
  });
});

describe('what a copy says', () => {
  test('the banner names the release and the data date, and claims nothing more', () => {
    assert.equal(mirrorDetail(TIER1), 'release v2026.11.10, data from 2026-11-08');
    assert.equal(mirrorDetail(parseMirror({ ...EXAMPLE, data_date: undefined })), 'release v2026.11.10');
    assert.equal(mirrorDetail(null), '');
  });

  test('a missing feature links to the same page on stare.pub', () => {
    assert.equal(upstreamUrl('/#a2d/31/647-01'), 'https://stare.pub/#a2d/31/647-01');
    assert.equal(upstreamUrl('search?q=x'), 'https://stare.pub/search?q=x');
    const e = new NotInCopyError('text', '/#a2d/31/647-01');
    assert.equal(e.message, 'Text not in this copy.');
    assert.equal(e.href, 'https://stare.pub/#a2d/31/647-01');
    assert.equal(new NotInCopyError('pages').message, 'Pages not in this copy.');
    assert.match(new NotInCopyError('search').message, /^Search needs tier 2/);
    const html = notInCopyHtml(new NotInCopyError('raw-scans', '/#a2d/31/647-01~v=scans&p=2'));
    assert.match(html, /Raw scans not in this copy\./);
    assert.match(html, /href="https:\/\/stare\.pub\/#a2d\/31\/647-01~v=scans&amp;p=2"/);
  });

  test("a key the copy's ledger lacks says how old the copy's data is", () => {
    assert.equal(keyMissNote(TIER1), 'This copy’s data is from 2026-11-08; try stare.pub.');
    assert.equal(keyMissNote(null), '');
  });

  // Just enough DOM for showMirror.
  function fakeDocument(ids = []) {
    const el = (tag) => ({
      tagName: tag, children: [], attrs: {}, className: '', textContent: '', href: '', rel: '',
      setAttribute(k, v) { this.attrs[k] = v; },
      append(...n) { this.children.push(...n); },
      appendChild(n) { this.children.push(n); return n; },
      insertBefore(n) { this.children.unshift(n); return n; },
      get firstChild() { return this.children[0] || null; },
      get text() { return this.children.length ? this.children.map((c) => c.text ?? '').join('') : this.textContent; },
    });
    const body = el('body');
    const head = el('head');
    const byId = Object.fromEntries(ids.map((id) => [id, el('div')]));
    const footerLine = el('p');
    return {
      body, head, byId, footerLine,
      createElement: el,
      createTextNode: (t) => ({ textContent: t, text: t }),
      getElementById: (id) => byId[id] || null,
      querySelector: (sel) => {
        if (sel === '[data-mirror-banner]') return [body, ...Object.values(byId)].flatMap((p) => p.children).find((c) => c.attrs && 'data-mirror-banner' in c.attrs) || null;
        if (sel === 'link[rel="canonical"]') return head.children.find((c) => c.rel === 'canonical') || null;
        return null;
      },
      querySelectorAll: (sel) => (sel === '.site-footer-line' ? [footerLine] : []),
    };
  }

  test('on a copy, the header and footer say "A mirror of stare.pub", and the canonical link is stare.pub\'s', () => {
    const doc = fakeDocument();
    doc.head.querySelector = (sel) => doc.querySelector(sel);
    assert.ok(showMirror(doc, TIER1, { pathname: '/about/' }));
    const [banner] = doc.body.children;
    assert.equal(banner.text, 'A mirror of stare.pub (release v2026.11.10, data from 2026-11-08)');
    assert.equal(banner.children[1].href, 'https://stare.pub');
    assert.doesNotMatch(banner.text, /verif/i);
    assert.equal(doc.footerLine.children[0].text, banner.text);
    assert.equal(doc.head.children.find((c) => c.rel === 'canonical').href, 'https://stare.pub/about/');
    // Once only.
    assert.equal(showMirror(doc, TIER1, { pathname: '/about/' }), false);
  });

  test("the reader's two screens each get the banner", () => {
    const doc = fakeDocument(['landing', 'resolved']);
    doc.head.querySelector = (sel) => doc.querySelector(sel);
    showMirror(doc, TIER1, { pathname: '/' });
    assert.equal(doc.body.children.length, 0);
    assert.match(doc.byId.landing.children[0].text, /^A mirror of stare\.pub/);
    assert.match(doc.byId.resolved.children[0].text, /^A mirror of stare\.pub/);
  });

  test('on stare.pub, nothing changes', () => {
    const doc = fakeDocument();
    assert.equal(showMirror(doc, null, { pathname: '/' }), false);
    assert.equal(doc.body.children.length, 0);
    assert.equal(doc.head.children.length, 0);
  });
});

// D146's build check gains a rule (#231): /mirror/ is a copy's data, so the site never
// ships a file there. A copy's server maps /mirror/ to the data and would never serve it,
// and on stare.pub a /mirror/mirror.json would make the reader think it was on a copy if
// the host check ever let it through.
test('the site ships nothing under /mirror/', () => {
  for (const dir of ['web/public/mirror', 'web/dist/mirror']) {
    assert.ok(!existsSync(new URL(dir, root)), `${dir} must not exist`);
  }
});

test('the release keys are published where the kit says', () => {
  const pub = (name) => readFileSync(new URL(`web/public/.well-known/${name}`, root), 'utf8');
  const release = pub('stare-release-key.pub');
  const recovery = pub('stare-recovery-key.pub');
  assert.match(release, /^untrusted comment: minisign public key F2EE19D68B85B86E\nRWRuuIWL1hnu8l81OQ\/pyqka6QPtVyiesfn6wIr4CtHdhnBChGViuSa0\n$/);
  assert.match(recovery, /^untrusted comment: minisign public key 6882DE6FA53FD7D1\nRWTR1z\+lb96CaCdVkipBJO\+O6KJyVIZkYQz2syiFItetSW\+S74fWeKrF\n$/);
  for (const key of [release, recovery]) assert.ok(README.includes(key.trim()), 'the kit README repeats each key');
  const headers = readFileSync(new URL('web/public/_headers', root), 'utf8');
  for (const name of ['stare-release-key.pub', 'stare-recovery-key.pub']) {
    assert.match(headers, new RegExp(`/\\.well-known/${name.replace('.', '\\.')}\\n  Content-Type: text/plain; charset=utf-8`));
  }
});
