// The Atom feed of site releases, built from CHANGELOG.md like /updates.
import { parseChangelog } from '../lib/changelog.js';
import { atomFeed } from '../lib/feed.js';
import changelog from '../../../CHANGELOG.md?raw';

export function GET() {
  const xml = atomFeed(parseChangelog(changelog), {
    site: 'https://stare.pub',
    fallbackDate: import.meta.env.PUBLIC_BUILD_DATE || '2026-09-30',
  });
  return new Response(xml, { headers: { 'Content-Type': 'application/atom+xml; charset=utf-8' } });
}
