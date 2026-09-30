// Parses the CHANGELOG.md that git-cliff writes from cliff.toml into plain data
// for /about's "What's new". Only the shapes cliff.toml emits are recognized:
//
//   ## [v2026.09.30.1](https://github.com/.../releases/tag/v2026.09.30.1) - 2026-09-30
//   ## Unreleased
//   ### Features
//   - web: some change ([abc1234](https://github.com/.../commit/...)) ([#58](...))
//
// Item text is split into segments ({ text } or { text, href }) so the page can
// render links as elements; nothing here produces HTML. Only links into this
// repo on GitHub (every link cliff.toml writes) are kept as links; anything else,
// such as a link typed into a commit subject, renders as its text.

const RELEASE_HEADING = /^##\s+\[([^\]]+)\]\((https:\/\/github\.com\/codexpublicus\/stare\/[^)\s]+)\)(?:\s+-\s+(\d{4}-\d{2}-\d{2}))?\s*$/;
const UNRELEASED_HEADING = /^##\s+Unreleased\s*$/i;
const GROUP_HEADING = /^###\s+(.+?)\s*$/;
const ITEM = /^[-*]\s+(.+?)\s*$/;
const REPO_PREFIX = 'https://github.com/codexpublicus/stare/';
const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

export function inlineSegments(text) {
  const segments = [];
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    if (match.index > last) segments.push({ text: text.slice(last, match.index) });
    const [, label, href] = match;
    segments.push(href.startsWith(REPO_PREFIX) ? { text: label, href } : { text: label });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last) });
  return segments;
}

// Returns releases newest first, as written: [{ version, href, date, groups:
// [{ title, items: [segments], more }] }]. The Unreleased section, if any, is
// skipped unless includeUnreleased is set; a release with no items is dropped.
// maxItems caps each group's items; `more` counts the ones cut.
export function parseChangelog(markdown, { limit = Infinity, includeUnreleased = false, maxItems = Infinity } = {}) {
  const releases = [];
  let release = null;
  let group = null;

  for (const raw of String(markdown ?? '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m;
    if ((m = RELEASE_HEADING.exec(line))) {
      release = { version: m[1], href: m[2], date: m[3] ?? null, groups: [] };
      releases.push(release);
      group = null;
    } else if (UNRELEASED_HEADING.test(line)) {
      release = includeUnreleased ? { version: 'Unreleased', href: null, date: null, groups: [] } : null;
      if (release) releases.push(release);
      group = null;
    } else if (/^#{1,2}\s/.test(line)) {
      // Any other top-level heading ends the current release.
      release = null;
      group = null;
    } else if (release && (m = GROUP_HEADING.exec(line))) {
      group = { title: m[1], items: [] };
      release.groups.push(group);
    } else if (group && (m = ITEM.exec(line))) {
      group.items.push(inlineSegments(m[1]));
    }
  }

  return releases
    .map(r => ({
      ...r,
      groups: r.groups
        .filter(g => g.items.length)
        .map(g => ({ title: g.title, items: g.items.slice(0, maxItems), more: Math.max(0, g.items.length - maxItems) })),
    }))
    .filter(r => r.groups.length)
    .slice(0, limit);
}
