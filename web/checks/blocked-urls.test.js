// No content blocker's list blocks anything stare.pub serves (#265). v2026.10.26.5 shipped
// js/pageview.js, which EasyPrivacy's `/pageview.js` blocks, and the reader stayed on
// "Loading..." for everyone running uBlock Origin. web/tests/script-names.test.js keeps
// out the words we know of; this runs every URL in the build, and the index and data
// hosts' path patterns, through a real matcher against the lists themselves, so a rule
// nobody predicted fails the build instead of the site.
//
// The matcher is Ghostery's (@ghostery/adblocker), a maintained engine for the same
// filter syntax as Brave's adblock-rust, which the #258 audit used; it is plain
// JavaScript, so nothing native is built for it. The lists come from filterlists.js,
// fetched at most daily and cached.
//
// Cloudflare Web Analytics' beacon (static.cloudflareinsights.com/beacon.min.js) isn't
// checked, and is expected to be blocked: EasyPrivacy lists it. Cloudflare adds its tag to
// each HTML response at the edge, so it's in no file in web/dist, and the boot guard
// (src/lib/bootguard.js) ignores another host's script failing to load.
//
// Needs the build (`npm --prefix web run build`, into web/dist, or $STARE_DIST) and the
// network the first time each day. Run it with `mise run check-blockers`; CI runs it
// after the build (.github/actions/build-site).
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { FiltersEngine, Request } from '@ghostery/adblocker';

import { loadFilterLists } from './filterlists.js';
import { SITE, buildReporters, dataUrls, distUrls } from './siteurls.js';

const DIST = process.env.STARE_DIST || fileURLToPath(new URL('../dist/', import.meta.url));
const OPTIONS = { debug: true, loadCosmeticFilters: false, loadGenericCosmeticsFilters: false, loadCSPFilters: false };

let lists;
let engine;
const perList = new Map();

before(async () => {
  assert.ok(existsSync(DIST), `no build at ${DIST}; run npm --prefix web run build first`);
  lists = await loadFilterLists();
  engine = FiltersEngine.parse(lists.map((l) => l.text).join('\n'), OPTIONS);
});

const request = ({ url, type }) => Request.fromRawDetails({ url, type, sourceUrl: SITE });

// Which lists block `entry` on their own, and by which rule; for the failure message.
function blamed(entry) {
  return lists.flatMap(({ name, text }) => {
    // Unoptimized, so the rule shown is the list's own line rather than several fused.
    if (!perList.has(name)) perList.set(name, FiltersEngine.parse(text, { ...OPTIONS, enableOptimizations: false }));
    const r = perList.get(name).match(request(entry));
    return r.match ? [`${name}: ${r.filter?.toString() ?? '?'}`] : [];
  });
}

function blocked(entries) {
  return entries
    .filter((e) => engine.match(request(e)).match)
    .map((e) => `${e.type} ${e.url} (${e.from}) blocked by ${blamed(e).join(', ') || 'the lists together'}`);
}

test('the lists block what a blocker would: /js/pageview.js, and an ad server', () => {
  // If a list failed to parse or came back empty, everything would pass; these must not.
  assert.equal(engine.match(request({ url: `${SITE}js/pageview.js`, type: 'script' })).match, true);
  assert.equal(engine.match(request({ url: 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', type: 'script' })).match, true);
  for (const l of lists) assert.ok(l.text.length > 10_000, `${l.name} is only ${l.text.length} bytes`);
});

test('nothing in the build is blocked', () => {
  const entries = distUrls(DIST);
  assert.ok(entries.some((e) => e.url === `${SITE}js/main.js`), 'js/main.js is not in the build');
  assert.deepEqual(blocked(entries), []);
});

test('nothing on the index and data hosts is blocked, for any reporter', () => {
  const entries = dataUrls(buildReporters(DIST));
  assert.ok(entries.length > 1000);
  assert.deepEqual(blocked(entries), []);
});
