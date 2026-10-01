import { test } from 'node:test';
import assert from 'node:assert/strict';

import { atomFeed } from '../src/lib/feed.js';

const RELEASES = [
  { version: 'v2026.10.02.1', date: '2026-10-02', groups: [
    { title: 'Features', items: ['web: show <b>this</b> & that'], more: 0 },
  ] },
  { version: 'v2026.10.01.1', date: '2026-10-01', groups: [
    { title: 'Fixes', items: ['a fix'], more: 0 },
  ] },
];

test('one entry per release, newest first, linking to its place on /updates', () => {
  const xml = atomFeed(RELEASES, { site: 'https://stare.pub' });
  assert.match(xml, /^<\?xml version="1\.0" encoding="utf-8"\?>\n<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
  const entries = [...xml.matchAll(/<entry>[\s\S]*?<\/entry>/g)].map(m => m[0]);
  assert.equal(entries.length, 2);
  assert.match(entries[0], /<title>v2026\.10\.02\.1<\/title>/);
  assert.match(entries[0], /<link href="https:\/\/stare\.pub\/updates#v2026\.10\.02\.1"\/>/);
  assert.match(entries[0], /<id>tag:stare\.pub,2026:release\/v2026\.10\.02\.1<\/id>/);
  assert.match(entries[0], /<updated>2026-10-02T00:00:00Z<\/updated>/);
  assert.match(xml, /<feed[\s\S]*?<updated>2026-10-02T00:00:00Z<\/updated>/);
});

test('item text is escaped, so a change log line can never inject markup', () => {
  const xml = atomFeed(RELEASES, { site: 'https://stare.pub' });
  assert.ok(!xml.includes('<b>this</b>'));
  assert.ok(xml.includes('&amp;lt;b&amp;gt;this&amp;lt;/b&amp;gt; &amp;amp; that'));
});

test('a feed with no releases is still valid, dated by the fallback', () => {
  const xml = atomFeed([], { site: 'https://stare.pub', fallbackDate: '2026-09-30' });
  assert.ok(!xml.includes('<entry>'));
  assert.match(xml, /<updated>2026-09-30T00:00:00Z<\/updated>/);
});
