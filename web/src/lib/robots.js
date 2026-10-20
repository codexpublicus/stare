// robots.txt for stare.pub, rendered by src/pages/robots.txt.js at build time
// from the curated case list (codexpublicus/stare#171, ruling D44).
//
// Every case has one permanent page under CASE_PREFIX, and joining or leaving
// the curated set never changes that URL. robots.txt disallows CASE_PREFIX and
// allows each curated case (or a whole reporter or volume) by the longer, more
// specific rule; the sitemap lists the same cases. A change to the set changes
// those two files and nothing else.
//
// The list is src/data/curated.json, an array of entries:
//   { "path": "a2d/31/647" }                  one case: Allow /c/a2d/31/647/
//   { "path": "a2d/31/647", "lastmod": "…" }  with the record's date, for the sitemap
//   { "path": "a2d/31/" }                     a whole volume (or "a2d/", a reporter)
// A case covered by a subpath entry isn't listed in robots.txt again, but stays
// in the sitemap. Choosing the set is #172; until then it's empty.

export const SITE = 'https://stare.pub';
export const CASE_PREFIX = '/c/';

// Google reads the first 500 KiB of robots.txt and ignores the rest. Past about
// 10,000 single-case lines, allow subpaths instead of listing cases.
export const ROBOTS_MAX_BYTES = 500 * 1024;

// A case is <slug>/<volume>/<page>; a subpath is <slug>/ or <slug>/<volume>/.
// Lowercase letters, digits, dots and hyphens only, so no line can carry
// robots.txt's `*` or `$` or a character a crawler would percent-encode.
const SEGMENT = '[a-z0-9][a-z0-9.-]*';
const CASE = new RegExp(`^${SEGMENT}/${SEGMENT}/${SEGMENT}$`);
const SUBPATH = new RegExp(`^${SEGMENT}/(?:${SEGMENT}/)?$`);

// Checks the list and returns it split into cases and subpaths, each sorted and
// without duplicates. Throws naming the first bad entry.
export function curatedSet(list) {
  if (!Array.isArray(list)) throw new Error('curated.json: not an array');
  const cases = new Map();
  const subpaths = new Set();
  list.forEach((entry, i) => {
    const path = entry?.path;
    if (typeof path === 'string' && SUBPATH.test(path)) {
      if (entry.lastmod !== undefined) throw new Error(`curated.json[${i}]: a subpath (${path}) has no lastmod`);
      subpaths.add(path);
      return;
    }
    if (typeof path !== 'string' || !CASE.test(path)) throw new Error(`curated.json[${i}]: bad path ${JSON.stringify(path)}`);
    if (entry.lastmod !== undefined && Number.isNaN(Date.parse(entry.lastmod))) {
      throw new Error(`curated.json[${i}]: bad lastmod ${entry.lastmod} for ${path}`);
    }
    if (cases.has(path)) throw new Error(`curated.json[${i}]: ${path} is listed twice`);
    cases.set(path, entry.lastmod ?? null);
  });
  return {
    cases: [...cases].sort(([a], [b]) => a.localeCompare(b)).map(([path, lastmod]) => ({ path, lastmod })),
    subpaths: [...subpaths].sort(),
  };
}

// A case's page: a directory URL like the site's other pages, so `Allow:
// /c/a2d/31/647/` can't also match /c/a2d/31/6470/.
export const casePath = (path) => `${CASE_PREFIX}${path}/`;

// The Allow rules for a curated set: every subpath, and every case no subpath
// already covers.
export function curatedAllows({ cases, subpaths }) {
  const covers = (path) => subpaths.some((s) => path.startsWith(s));
  const out = [
    ...subpaths.filter((s) => !subpaths.some((t) => t !== s && s.startsWith(t))).map((s) => `${CASE_PREFIX}${s}`),
    ...cases.filter(({ path }) => !covers(path)).map(({ path }) => casePath(path)),
  ];
  return out.sort();
}

// The sitemap entries for the curated cases.
export const curatedSitemapEntries = ({ cases }) =>
  cases.map(({ path, lastmod }) => ({ loc: `${SITE}${casePath(path)}`, lastmod }));

const HEADER = `# robots.txt for stare.pub (codexpublicus/stare#171).
#
# The site's pages may be crawled. Every case page lives under /c/, which is
# not crawled except for a curated set of cases, each allowed below by name
# or by its reporter or volume; sitemap.xml lists the site pages and those
# cases with the date each last changed. A case's URL never changes when it
# joins or leaves the set. Anyone with a link can open any case page. To
# resolve citations in bulk, read the static index and case files described
# in /llms.txt instead of crawling pages.
#
# As a condition of accessing this website, you agree to abide by the
# following content signals:
#
# (a)  If a content-signal = yes, you may collect content for the
#      corresponding use.
# (b)  If a content-signal = no, you may not collect content for the
#      corresponding use.
# (c)  If the website operator does not include a content signal for a
#      corresponding use, the website operator neither grants nor restricts
#      permission via content signal with respect to the corresponding use.
#
# The content signals and their meanings are:
#
# search:   building a search index and providing search results (e.g.,
#           returning hyperlinks and short excerpts from your website's
#           contents). Search does not include providing AI-generated
#           search summaries.
# ai-input: inputting content into one or more AI models (e.g., retrieval
#           augmented generation, grounding, or other real-time taking of
#           content for generative AI search answers).
# ai-train: training or fine-tuning AI models.
#
# ANY RESTRICTIONS EXPRESSED VIA CONTENT SIGNALS ARE EXPRESS RESERVATIONS OF
# RIGHTS UNDER ARTICLE 4 OF THE EUROPEAN UNION DIRECTIVE 2019/790 ON
# COPYRIGHT AND RELATED RIGHTS IN THE DIGITAL SINGLE MARKET.
`;

// The whole file. Throws if it would pass Google's size limit.
export function renderRobots(set) {
  const text = [
    HEADER,
    'User-agent: *',
    'Content-Signal: search=yes, ai-input=yes',
    'Allow: /',
    `Disallow: ${CASE_PREFIX}`,
    ...curatedAllows(set).map((path) => `Allow: ${path}`),
    '',
    `Sitemap: ${SITE}/sitemap.xml`,
    '',
  ].join('\n');
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > ROBOTS_MAX_BYTES) {
    throw new Error(`robots.txt is ${bytes} bytes, past the ${ROBOTS_MAX_BYTES} crawlers read; allow reporters or volumes in curated.json instead of single cases`);
  }
  return text;
}
