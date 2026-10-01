// The Atom feed of site releases (/updates.xml), from the same parsed CHANGELOG.md
// as /updates. Each release is one entry linking to its section on /updates.

const escape = (text) => String(text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const stamp = (date) => `${date}T00:00:00Z`;

function entryHtml(release) {
  return release.groups
    .map(g => `<h3>${escape(g.title)}</h3><ul>${g.items.map(i => `<li>${escape(i)}</li>`).join('')}</ul>`)
    .join('');
}

// releases: parseChangelog() output, newest first. fallbackDate (YYYY-MM-DD) dates
// a feed with no releases yet.
export function atomFeed(releases, { site, fallbackDate = '1970-01-01' }) {
  const dated = releases.filter(r => r.date);
  const updated = stamp(dated[0]?.date ?? fallbackDate);
  const entries = dated.map(r => [
    '  <entry>',
    `    <title>${escape(r.version)}</title>`,
    `    <link href="${escape(`${site}/updates#${r.version}`)}"/>`,
    `    <id>tag:stare.pub,${r.date.slice(0, 4)}:release/${escape(r.version)}</id>`,
    `    <updated>${stamp(r.date)}</updated>`,
    `    <content type="html">${escape(entryHtml(r))}</content>`,
    '  </entry>',
  ].join('\n'));
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    '  <title>stare.pub updates</title>',
    `  <link href="${escape(`${site}/updates`)}"/>`,
    `  <link rel="self" href="${escape(`${site}/updates.xml`)}"/>`,
    '  <id>tag:stare.pub,2026:updates</id>',
    `  <updated>${updated}</updated>`,
    '  <author><name>Codex Publicus</name></author>',
    ...entries,
    '</feed>',
    '',
  ].join('\n');
}
