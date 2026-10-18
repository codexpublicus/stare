// Checks for the crawler-facing files in public/ (codexpublicus/stare#171,
// #161): robots.txt and llms.txt. The build runs them on dist/ and fails on a
// problem (astro.config.mjs), and web/tests/crawlfiles.test.js runs them on
// public/.

// RFC 9309's fields plus Sitemap, and Content-Signal from Cloudflare's Content
// Signals Policy (contentsignals.org), which goes inside a User-agent group.
const ROBOTS_FIELDS = new Set(['user-agent', 'allow', 'disallow', 'sitemap', 'content-signal']);
const SIGNALS = new Set(['search', 'ai-input', 'ai-train']);

// Parses robots.txt into its groups and sitemaps, throwing on a line a crawler
// would drop: an unknown field, a rule outside a group, a relative sitemap, or a
// content signal that isn't `name=yes|no`.
export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let group = null;
  let lastWasAgent = false;
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) throw new Error(`robots.txt:${i + 1}: not a field: ${raw}`);
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (!ROBOTS_FIELDS.has(field)) throw new Error(`robots.txt:${i + 1}: unknown field ${m[1]}`);
    if (field === 'sitemap') {
      if (!/^https:\/\//.test(value)) throw new Error(`robots.txt:${i + 1}: sitemap must be an absolute URL`);
      sitemaps.push(value);
      return;
    }
    if (field === 'user-agent') {
      if (!lastWasAgent) groups.push(group = { agents: [], allow: [], disallow: [], signals: null });
      group.agents.push(value);
      lastWasAgent = true;
      return;
    }
    lastWasAgent = false;
    if (!group) throw new Error(`robots.txt:${i + 1}: ${m[1]} before any User-agent`);
    if (field === 'content-signal') {
      group.signals = Object.fromEntries(value.split(',').map((pair) => {
        const [name, setting] = pair.split('=').map((s) => s.trim());
        if (!SIGNALS.has(name) || !['yes', 'no'].includes(setting)) {
          throw new Error(`robots.txt:${i + 1}: bad content signal ${pair.trim()}`);
        }
        return [name, setting];
      }));
      return;
    }
    if (value && !value.startsWith('/')) throw new Error(`robots.txt:${i + 1}: path must start with /`);
    group[field].push(value);
  });
  return { groups, sitemaps };
}

// RFC 9309's matching for one agent's group: the longest matching rule wins, and
// Allow wins a tie. Enough to check what the file says about a path.
export function isAllowed(group, path) {
  const longest = (rules) => Math.max(-1, ...rules.filter((r) => r && path.startsWith(r)).map((r) => r.length));
  return longest(group.allow) >= longest(group.disallow);
}

// Parses llms.txt in llmstxt.org's shape: an H1 title, a blockquote summary,
// then H2 sections whose link lists are `- [name](url)` with optional notes.
// Returns the title, summary and each section's links.
export function parseLlmsTxt(text) {
  const lines = text.split('\n');
  const title = lines[0].match(/^# (\S.*)$/)?.[1];
  if (!title) throw new Error('llms.txt: the first line must be an H1 title');
  const quote = lines.findIndex((l) => l.trim() !== '' && !l.startsWith('# '));
  if (quote < 0 || !lines[quote].startsWith('> ')) throw new Error('llms.txt: the title must be followed by a > summary');
  if (lines.some((l, i) => i > 0 && /^# /.test(l))) throw new Error('llms.txt: only one H1');
  const sections = [];
  for (const line of lines) {
    const h2 = line.match(/^## (\S.*)$/);
    if (h2) { sections.push({ name: h2[1], links: [] }); continue; }
    const link = line.match(/^- \[([^\]]+)\]\(([^)\s]+)\)/);
    if (link && sections.length) {
      if (!/^https:\/\//.test(link[2])) throw new Error(`llms.txt: link ${link[2]} must be absolute https`);
      sections.at(-1).links.push({ name: link[1], url: link[2] });
    }
  }
  if (sections.length === 0) throw new Error('llms.txt: no ## sections');
  return { title, summary: lines[quote].slice(2), sections };
}
