// What the search boxes suggest as a citation is typed (#248), from data the site already
// has: reporters from /reporters.json, volumes from the index manifest (manifest.js), and
// the pages cases start on from a volume's .idx.gz (idx.js). Nothing here touches the DOM
// or the network; searchbox.js does both and calls in here.
//
// A query is read in either order a citation is typed in: the citation as written,
// volume first (`32 Misc. 426`), or reporter first, as in the slug form (`misc 32 426`,
// `Misc. 32 426`). What the box suggests depends on how far the typing has got: the
// reporter while its name is being typed, then whether the index holds the volume, then
// the pages in that volume where cases start.

import { hasAliasVolume, holdsVolume } from './manifest.js';
import { pageKey } from './pagekey.js';
import { hasScans } from './scans.js';

// Letters and digits only, lowercased: `N.Y. Misc.` is `nymisc`, `A.2d` is `a2d`.
export const compact = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// The words of a name, lowercased: `New York Miscellaneous Reports` is
// `new york miscellaneous reports`, `N.Y. Misc.` is `n y misc`.
export const words = (s) => String(s ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * The reporters a query can suggest, from reporters.json (`stare-site export-reporters`):
 * one per slug with a name, `{ slug, abbr, fullName, start, end, count, keys, fulls }`.
 * `abbr` is its first name (`Misc.`), `fullName` its first edition's reporter (`New York
 * Miscellaneous Reports`), `start` and `end` the editions' first and last years (`end`
 * null when one is still running), `count` the volumes reporters.json says the index
 * held when the site was built. `keys` are its names, its variations and the slug,
 * `fulls` its editions' full names, each as `{ c, w }` (compact form and words).
 */
export function buildReporterIndex(map) {
  const out = [];
  for (const [slug, r] of Object.entries(map?.reporters || {})) {
    const names = Array.isArray(r?.names) ? r.names.filter((n) => typeof n === 'string' && n) : [];
    if (!names.length) continue;
    const variations = Array.isArray(r.variations) ? r.variations.filter((n) => typeof n === 'string') : [];
    const editions = Array.isArray(r.editions) ? r.editions : [];
    const starts = editions.map((e) => e?.start_year).filter(Number.isSafeInteger);
    const ends = editions.map((e) => e?.end_year);
    const fullNames = [...new Set(editions.map((e) => e?.reporter).filter((n) => typeof n === 'string' && n))];
    const form = (s) => ({ c: compact(s), w: words(s) });
    out.push({
      slug,
      abbr: names[0],
      fullName: fullNames[0] || '',
      start: starts.length ? Math.min(...starts) : null,
      end: ends.length && ends.every(Number.isSafeInteger) ? Math.max(...ends) : null,
      count: Number.isSafeInteger(r.volumes?.count) ? r.volumes.count : 0,
      keys: [...names, ...variations, slug].map(form),
      fulls: fullNames.map(form),
    });
  }
  return out;
}

// How many unmatched words are left when every query word starts a word of `target`,
// in order (`n y misc` in `new york miscellaneous reports` leaves 1), or -1 when they
// don't all.
function wordMatch(query, target) {
  let j = 0;
  for (const q of query) {
    while (j < target.length && !target[j].startsWith(q)) j += 1;
    if (j === target.length) return -1;
    j += 1;
  }
  return target.length - query.length;
}

// How well `query` ({ c, w }) matches a name: 0 the same letters and digits, 1 their
// start, 2 the start of each word in order; null for no match. `residual` is how much of
// the name is left over.
function matchName(query, name) {
  if (!query.c) return null;
  if (name.c === query.c) return { score: 0, residual: 0 };
  if (name.c.startsWith(query.c)) return { score: 1, residual: name.c.length - query.c.length };
  const rest = wordMatch(query.w, name.w);
  return rest < 0 ? null : { score: 2, residual: rest };
}

// A reporter's best match for `query`: its names, variations and slug first, then its
// full names a step behind (`Misc` before `Miscellaneous Reports`).
function matchReporter(query, r) {
  let best = null;
  const consider = (m, penalty) => {
    if (!m) return;
    const score = m.score + penalty;
    if (!best || score < best.score || (score === best.score && m.residual < best.residual)) {
      best = { score, residual: m.residual };
    }
  };
  for (const k of r.keys) consider(matchName(query, k), 0);
  for (const f of r.fulls) consider(matchName(query, f), 1);
  return best;
}

/**
 * The reporters `text` names, best first, at most `limit`: those the index holds volumes
 * of before those it holds none of, and in each, an exact abbreviation or variation,
 * then those it starts, then names whose words it starts (`N.Y. Misc.` finds `New York
 * Miscellaneous Reports`). Within those, the reporters with more volumes in the index
 * come first (`count(slug)`, the live manifest's, or reporters.json's when it has
 * none); among word matches, the one with fewer words left over first. Each result is
 * the index's entry with `score` and `volumes` added.
 */
export function rankReporters(index, text, count = null, limit = 8) {
  const query = { c: compact(text), w: words(text) };
  if (!query.c) return [];
  const volumesOf = (r) => {
    const n = count ? count(r.slug) : null;
    return Number.isSafeInteger(n) ? n : r.count;
  };
  const hits = [];
  for (const r of index) {
    const m = matchReporter(query, r);
    if (m) hits.push({ ...r, score: m.score, residual: m.residual, volumes: volumesOf(r) });
  }
  hits.sort((a, b) => (a.volumes > 0 ? 0 : 1) - (b.volumes > 0 ? 0 : 1)
    || a.score - b.score
    || (a.score >= 2 ? a.residual - b.residual : 0)
    || b.volumes - a.volumes
    || a.abbr.length - b.abbr.length
    || a.abbr.localeCompare(b.abbr));
  return limit === null ? hits : hits.slice(0, limit);
}

/**
 * The reporter `text` names exactly (an abbreviation, a variation or the slug, ignoring
 * case, spaces and periods), the one with the most volumes when several share it; or
 * null.
 */
export function exactReporter(index, text, count = null) {
  return rankReporters(index, text, count, null).find((r) => r.score === 0) || null;
}

// A volume as typed after a reporter: a number, or a CAP folder of a split volume (`138-2`).
const VOLUME = /^\d+(?:-\d+)?$/;
// A page as typed: digits, and a case's sequence after a hyphen (`426-01`).
const PAGE = /^\d+(?:-\d+)?$/;

/**
 * What a box's text says so far: `{ order, volume, reporter, page, spaceAfter }`.
 * `order` is `cite` for the citation as written (`32 Misc. 426`) or `reporter` for
 * reporter first (`misc 32 426`, `Misc. 32 426`, `misc/32/426`); `volume` and `page`
 * are the digits typed (`page` can end in `-<seq>`), or null; `reporter` is the
 * reporter's text, or ''. `spaceAfter` is whether the text ends in a space, which says
 * the last word is finished. Anything after the page is ignored.
 */
export function parseQuery(text) {
  const raw = String(text ?? '');
  const s = raw.trim();
  const out = { order: 'cite', volume: null, reporter: '', page: null, spaceAfter: /\s$/.test(raw) };
  if (!s) return out;
  let tokens = s.split(/\s+/);
  if (tokens.length === 1 && s.includes('/')) {
    tokens = s.split('/').filter(Boolean);
    out.spaceAfter = s.endsWith('/');
  }
  tokens = tokens.map((t) => t.replace(/,+$/, '')).filter(Boolean);
  let i = 0;
  const reporter = [];
  if (/^\d+$/.test(tokens[0])) {
    out.volume = tokens[0];
    i = 1;
    while (i < tokens.length && !PAGE.test(tokens[i])) reporter.push(tokens[i++]);
    if (i < tokens.length) out.page = tokens[i];
  } else {
    out.order = 'reporter';
    while (i < tokens.length && !VOLUME.test(tokens[i])) reporter.push(tokens[i++]);
    if (i < tokens.length) out.volume = tokens[i++];
    if (i < tokens.length && PAGE.test(tokens[i])) out.page = tokens[i];
  }
  out.reporter = reporter.join(' ');
  return out;
}

/**
 * Which suggestions a parsed query (parseQuery) wants: `none` (no reporter typed yet),
 * `reporter` (the reporter is still being typed), `volume` (a reporter and a volume,
 * no page) or `page`.
 */
export function stageOf(q) {
  if (!q.reporter) return 'none';
  if (q.page !== null) return 'page';
  if (q.volume === null) return 'reporter';
  if (q.order === 'cite' && !q.spaceAfter) return 'reporter';
  return 'volume';
}

/** A citation as written: `32 Misc. 426`, or `32 Misc.` with no page. */
export function citeText(abbr, volume, page = null) {
  return page === null || page === undefined || page === '' ? `${volume} ${abbr}` : `${volume} ${abbr} ${page}`;
}

// The volume numbers the index holds for `slug`: its folders that are numbers, and the
// numbers of the volumes CAP split.
function heldNumbers(manifest, slug) {
  const nums = new Set();
  for (const v of manifest?.reporters?.[slug] || []) if (/^\d+$/.test(v)) nums.add(parseInt(v, 10));
  for (const v of Object.keys(manifest?.parts?.[slug] || {})) if (/^\d+$/.test(v)) nums.add(parseInt(v, 10));
  return [...nums].sort((a, b) => a - b);
}

/**
 * Whether the index holds `volume` of `slug`, from the manifest: `{ held, aliasOnly,
 * scans, nearest }`. `aliasOnly` is a volume whose index file has only parallel
 * citations into other volumes (manifest.js, `aliases`); `scans` whether CAP published
 * page scans of it (scans.js). When it isn't held, `nearest` lists up to `n` held
 * volumes closest to it, in order, each `{ volume, scans }`; otherwise it's empty.
 */
export function volumeStatus(manifest, slug, volume, n = 4) {
  const v = String(volume);
  const held = !!manifest && holdsVolume(manifest, slug, v);
  const aliasOnly = !held && !!manifest && hasAliasVolume(manifest, slug, v);
  const out = { held, aliasOnly, scans: hasScans(slug, v), nearest: [] };
  if (held || aliasOnly) return out;
  const want = parseInt(v, 10);
  if (!Number.isSafeInteger(want)) return out;
  out.nearest = heldNumbers(manifest, slug)
    .map((x) => ({ x, d: Math.abs(x - want) }))
    .sort((a, b) => a.d - b.d || a.x - b.x)
    .slice(0, n)
    .map(({ x }) => x)
    .sort((a, b) => a - b)
    .map((x) => ({ volume: String(x), scans: hasScans(slug, String(x)) }));
  return out;
}

// A case file's sequence, after its name's last hyphen (`0426-02` is 2).
const seqOf = (file) => parseInt(String(file).slice(String(file).lastIndexOf('-') + 1), 10) || 1;

/**
 * The cases a page opens, as the resolver picks them (resolve.js, `resolveEntries`),
 * from the index's entries there: the volume's own CAP cases in the first entry's
 * folder (`{ kind: 'cap', seq, folder, caseFile }`), or the case a parallel citation
 * names (`{ kind: 'alias', reporter, folder }`), or CourtListener's records
 * (`{ kind: 'cl', seq }`).
 */
export function casesAt(entries) {
  const first = entries[0];
  if (!first) return [];
  if (first.source === 'cap' && first.reporter) {
    return [{ kind: 'alias', reporter: first.reporter, folder: first.folder || null, seq: null }];
  }
  if (first.source === 'cap') {
    const folder = first.folder || null;
    return entries
      .filter((e) => e.source === 'cap' && !e.reporter && (e.folder || null) === folder)
      .map((e) => ({ kind: 'cap', seq: seqOf(e.case_file), folder, caseFile: e.case_file }));
  }
  return entries.filter((e) => e.source === 'cl').map((_, i) => ({ kind: 'cl', seq: i + 1 }));
}

/**
 * The pages to suggest for the digits typed (`typed`, `4` or `426`, a `-<seq>` ignored)
 * from a volume's index entries (idx.js; labelled pages left out): the pages starting
 * with those digits, in order, or, when no case starts on one, the pages either side of
 * the number typed (a pin cite into a case). Each is `{ page, cases }` (casesAt), and
 * there are at most `limit` cases across them.
 */
export function pageSuggestions(entries, typed, limit = 8) {
  const digits = String(typed ?? '').replace(/-\d*$/, '');
  if (!/^\d+$/.test(digits)) return [];
  const byPage = new Map();
  for (const e of entries || []) {
    if (typeof e.page !== 'number' && !/^\d+$/.test(String(e.page))) continue;
    const p = Number(e.page);
    if (!byPage.has(p)) byPage.set(p, []);
    byPage.get(p).push(e);
  }
  const pages = [...byPage.keys()].sort((a, b) => a - b);
  let picked = pages.filter((p) => String(p).startsWith(String(Number(digits))));
  if (!picked.length) {
    const want = Number(digits);
    const below = pages.filter((p) => p <= want).slice(-1);
    const above = pages.filter((p) => p > want).slice(0, 1);
    picked = [...below, ...above];
  }
  const out = [];
  let n = 0;
  for (const page of picked) {
    if (n >= limit) break;
    const cases = casesAt(byPage.get(page)).slice(0, limit - n);
    n += cases.length;
    out.push({ page, cases });
  }
  return out;
}

/**
 * The citation a box's text names, for submitting text no other parser reads
 * (`Misc. 32 426`, reporter first with an abbreviation): `{ reporter, volume, page,
 * seq }`, with the reporter named exactly (exactReporter), or null.
 */
export function citeFromQuery(index, text, count = null) {
  const q = parseQuery(text);
  if (!q.reporter || q.volume === null || q.page === null) return null;
  const r = exactReporter(index, q.reporter, count);
  if (!r) return null;
  const m = /^(\d+)(?:-(\d+))?$/.exec(q.page);
  const page = m && pageKey(m[1]);
  if (page === null || page === undefined) return null;
  return { reporter: r.slug, volume: q.volume, page, seq: m[2] ? parseInt(m[2], 10) : null };
}

/**
 * What a box is filled with for the case shown (#248): the citation as written (the
 * case's first citation, `32 Misc. 426`), or the slug form (`misc 32 426-01`) when it
 * has none. `target` is the case itself, `{ reporter, volume, page, seq }` from the
 * page's hash, which the box submits while its text is unchanged (keptTarget), so a
 * page several cases start on reopens the same one.
 */
export function prefill(cite, target) {
  const t = target ? { reporter: target.reporter, volume: target.volume, page: target.page, seq: target.seq || null } : null;
  const text = typeof cite === 'string' && cite.trim() ? cite.trim()
    : t ? `${t.reporter} ${t.volume} ${t.page}-${String(t.seq || 1).padStart(2, '0')}` : '';
  return { text, target: t };
}

/** The case a prefill (prefill) still names: its target while `text` is unchanged, else null. */
export function keptTarget(filled, text) {
  if (!filled?.target || !filled.text) return null;
  return String(text ?? '').trim() === filled.text ? filled.target : null;
}
