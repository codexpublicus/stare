// The search page's plain logic (search.astro, searchpage.js does the DOM): the URL's
// state, the filters handed to the reference client, year ranges, and how a result card
// reads. Nothing here fetches; web/tests/searchquery.test.js covers it.
//
// The ranking is stare-builder's reference client, vendored unchanged
// (src/vendor/stare-search/, src/lib/searchvendor.js). The client filters on a year range
// itself (`year_from` and `year_to`, the union of the years' keys); the page closes the
// range at the years facets.json says exist, so the client reads only those years' keys.

export const PAGE_SIZE = 20;
// Past this many pages the links stop; a query that broad is better narrowed.
export const MAX_PAGE = 250;
const MAX_QUERY = 500;
const YEAR = /^\d{4}$/;
// Facet keys are short codes (`nyappdiv`, `cap-8800`) or, for a CourtListener
// jurisdiction, its name (`United States`).
const FACET_KEY = /^[\p{L}\p{N}][\p{L}\p{N} .,'&()/-]{0,99}$/u;

const clean = (v) => (typeof v === 'string' ? v.trim() : '');

/** The search state a URL's query string names, with anything malformed dropped. */
export function parseSearchState(search) {
  const p = new URLSearchParams(search);
  const q = clean(p.get('q')).replace(/\s+/g, ' ').slice(0, MAX_QUERY);
  const facet = (name) => {
    const v = clean(p.get(name));
    return FACET_KEY.test(v) ? v : '';
  };
  const year = (name) => {
    const v = clean(p.get(name));
    return YEAR.test(v) ? v : '';
  };
  let from = year('from');
  let to = year('to');
  if (from && to && from > to) [from, to] = [to, from];
  const n = Number(clean(p.get('page')) || 1);
  const page = Number.isSafeInteger(n) && n >= 1 ? Math.min(n, MAX_PAGE) : 1;
  return { q, jurisdiction: facet('jurisdiction'), court: facet('court'), from, to, page };
}

/** The query string for a state: `?q=...&court=...`, only the parts that are set. */
export function searchString(state) {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.jurisdiction) p.set('jurisdiction', state.jurisdiction);
  if (state.court) p.set('court', state.court);
  if (state.from) p.set('from', state.from);
  if (state.to) p.set('to', state.to);
  if (state.page > 1) p.set('page', String(state.page));
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Whether two states ask the same query (the page aside). */
export function sameQuery(a, b) {
  return a.q === b.q && a.jurisdiction === b.jurisdiction && a.court === b.court
    && a.from === b.from && a.to === b.to;
}

/**
 * The reference client's `filters` for a state: `jurisdiction`, `court`, and `year` for
 * one year, or `year_from` and `year_to` for a range, closed at the first and last years
 * the index (or the court) has. `facets` is facets.json once read; a range needs it, to
 * know which years exist, and a range covering every one of them is no filter at all.
 */
export function clientFilters(state, facets = null) {
  const f = {};
  if (state.jurisdiction) f.jurisdiction = state.jurisdiction;
  if (state.court) f.court = state.court;
  const { from, to } = state;
  if (from && from === to) {
    f.year = from;
  } else if (from || to) {
    if (!facets) throw new Error('a year range needs facets.json');
    const years = facets.years.map((y) => y.key).sort();
    const court = state.court ? facets.courts.find((c) => c.key === state.court) : null;
    const span = court?.years ?? [years[0], years[years.length - 1]];
    const lo = from && from > span[0] ? from : span[0];
    const hi = to && to < span[1] ? to : span[1];
    if (lo !== span[0] || hi !== span[1]) {
      if (lo === hi) f.year = lo;
      else {
        f.year_from = lo;
        f.year_to = hi;
      }
    }
  }
  return f;
}

// A reader route (`a2d/142/148-02`, `cal-app-4th/15/supp.%201`): slug, volume, page,
// as the card's `r` gives it and the reader's hash takes it.
const ROUTE = /^[a-z0-9][a-z0-9-]*\/\d[0-9a-z-]*\/[0-9A-Za-z.%-]+$/;

/** The reader's link for a card's route, or null for one that isn't a route. */
export function caseHref(route) {
  return typeof route === 'string' && ROUTE.test(route) ? `/#${route}` : null;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

/** A card's date as precise as it is: `May 29, 1928`, `May 1882`, `1882`. */
export function formatDate(d) {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(typeof d === 'string' ? d : '');
  if (!m) return typeof d === 'string' ? d : '';
  const [, y, mo, day] = m;
  const month = mo ? MONTHS[Number(mo) - 1] : null;
  if (!month) return y;
  return day ? `${month} ${Number(day)}, ${y}` : `${month} ${y}`;
}

/** A card's fields as strings, from the client's parsed card. */
export function cardFields(card) {
  const s = (v) => (typeof v === 'string' ? v : '');
  return { name: s(card?.n), citation: s(card?.c), court: s(card?.ct), date: s(card?.d), route: s(card?.r) };
}

/** The number of result pages for `total` matches. */
export function pageCount(total) {
  return Math.min(MAX_PAGE, Math.max(1, Math.ceil(total / PAGE_SIZE)));
}

const num = (n) => n.toLocaleString('en-US');
const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;

/**
 * A result's count, plainly: `137 matches`, `1 match`, or `Top 4,352 matches` when the
 * count is the best of what the rank tiers read rather than every match (below the
 * client's read caps, a common word's tiers hold only the top of its postings). Empty for
 * no match, or a query with no word to search for.
 */
export function countText({ total, exact, tokens }) {
  if (!tokens.length || !total) return '';
  return exact ? plural(total, 'match', 'matches') : `Top ${plural(total, 'match', 'matches')}`;
}

/** The status line for a page of a result: `137 matches, page 2 of 7`. */
export function statusText(result, page) {
  if (!result.tokens.length) return 'Nothing to search for';
  if (!result.total) return 'No matches';
  const pages = pageCount(result.total);
  return pages > 1 ? `${countText(result)}, page ${page} of ${num(pages)}` : countText(result);
}

/**
 * The note under the count, or '': why the count isn't every match, or that the results
 * have all but one of the words.
 */
export function noteText({ total, exact, relaxed, tokens }) {
  if (!tokens.length || !total) return '';
  if (relaxed) return 'No decision has every word, so these have all but one.';
  if (!exact) return 'Some of these words are in a great many decisions, so these are the best matches found, not every one.';
  return '';
}

/**
 * What the live region says once per result set: the count and the page, or that
 * nothing matched.
 */
export function summaryText(result, page) {
  if (!result.tokens.length) return 'Every word in that query is too common to search for. Try more specific words.';
  if (!result.total) return 'No decisions match.';
  const pages = pageCount(result.total);
  const where = pages > 1 ? ` Page ${page} of ${num(pages)}.` : '';
  const note = noteText(result);
  return `${countText(result)}.${where}${note ? ` ${note}` : ''}`;
}

// The search tokenizer's folding (src/vendor/stare-search/tokenize.mjs `normalize`), for
// marking a case name's words; the ranking never sees it. searchquery.test.js checks it
// against the vendored tokenizer.
const DOTTED = /\b(?:[a-z]\.){2,}[a-z0-9]*/g;
function fold(text) {
  let s = String(text).normalize('NFKD').replace(/[^\x00-\x7f]/g, '').toLowerCase();
  s = s.replace(DOTTED, (m) => m.replaceAll('.', ''));
  return s.replace(/'s\b/g, '').replace(/(?<=\d),(?=\d{3})/g, '');
}
const foldedWords = (text) => fold(text).split(/[^a-z0-9]+/).filter(Boolean);

/**
 * A case name cut into runs, `{ text, hit }` each, `hit` for a word the query's tokens
 * (the client's `tokens`) matched, so the page can mark them.
 */
export function nameSegments(name, tokens) {
  const want = new Set(tokens);
  const out = [];
  if (!want.size) return name ? [{ text: name, hit: false }] : [];
  for (const part of String(name).split(/([\p{L}\p{N}](?:[\p{L}\p{N}'\u2019.]|,(?=\d{3}))*)/u)) {
    if (!part) continue;
    const hit = /^[\p{L}\p{N}]/u.test(part) && foldedWords(part.replace(/\u2019/g, "'")).some((w) => want.has(w));
    const prev = out[out.length - 1];
    if (prev && prev.hit === hit && !hit) prev.text += part;
    else out.push({ text: part, hit });
  }
  return out;
}

/** The query's words the search left out (stopwords, single letters), in order, once each. */
export function droppedWords(q, tokens) {
  const kept = new Set(tokens);
  const out = [];
  for (const w of foldedWords(q)) if (!kept.has(w) && !out.includes(w)) out.push(w);
  return out;
}

// A citation as typed: `347 U.S. 483`, `31 A.2d 647, 650 (1943)`, or a reader slug's
// `a2d 31 647` and `a2d/31/647`.
const CITED = /^\d{1,4}\s+[A-Za-z][A-Za-z0-9.' &]{0,40}?\s+\d{1,5}(?:\s*,\s*\d{1,5})?(?:\s*\([^)]{0,40}\))?$/;
const SLUG = /^[a-z][a-z0-9-]{0,30}[\s/]+\d{1,4}(?:-\d+)?[\s/]+\d{1,5}(?:-\d{1,2})?$/i;

/** Whether a query reads like a citation, worth offering to open in the reader. */
export function looksLikeCitation(q) {
  const t = String(q).trim();
  return CITED.test(t) || SLUG.test(t);
}

/**
 * The filters a state has, as chips: `{ key, label, text }`, `key` the state's field to
 * clear (`years` clears from and to). Names come from facets.json when it's in, else from
 * `hint` (`{ court }`, a result card's court), else the key.
 */
export function filterChips(state, facets = null, hint = {}) {
  const out = [];
  if (state.jurisdiction) {
    const j = facets?.jurisdictions?.find((x) => x.key === state.jurisdiction);
    out.push({ key: 'jurisdiction', label: 'Jurisdiction', text: j?.name || state.jurisdiction });
  }
  if (state.court) {
    const c = facets?.courts?.find((x) => x.key === state.court);
    out.push({ key: 'court', label: 'Court', text: c?.name || hint.court || state.court });
  }
  const { from, to } = state;
  if (from || to) {
    let text;
    if (from && from === to) text = from;
    else if (from && to) text = `${from} to ${to}`;
    else if (from) text = `${from} and later`;
    else text = `${to} and earlier`;
    out.push({ key: 'years', label: 'Decided', text });
  }
  return out;
}

/** Whether a state has any filter. */
export const hasFilters = (state) => Boolean(state.jurisdiction || state.court || state.from || state.to);

/**
 * Decisions a year, from facets.json's `years`, in at most `max` bins of whole years over
 * `[lo, hi]`: `[{ from, to, decisions }]`, years as numbers.
 */
export function yearBins(years, lo, hi, max = 60) {
  const a = Number(lo);
  const b = Number(hi);
  if (!(b >= a)) return [];
  const width = Math.max(1, Math.ceil((b - a + 1) / max));
  const bins = [];
  for (let y = a; y <= b; y += width) bins.push({ from: y, to: Math.min(b, y + width - 1), decisions: 0 });
  for (const { key, decisions } of years) {
    const y = Number(key);
    if (y < a || y > b) continue;
    bins[Math.floor((y - a) / width)].decisions += decisions || 0;
  }
  return bins;
}

/**
 * The page numbers to link: the first, the last, and two either side of the current one,
 * with null for a gap (a gap of one page is that page).
 */
export function pageLinks(page, pages) {
  const set = new Set([1, pages]);
  for (let p = page - 2; p <= page + 2; p++) if (p >= 1 && p <= pages) set.add(p);
  const sorted = [...set].sort((a, b) => a - b);
  const out = [];
  sorted.forEach((p, i) => {
    const gap = i ? p - sorted[i - 1] : 1;
    if (gap === 2) out.push(p - 1);
    else if (gap > 2) out.push(null);
    out.push(p);
  });
  return out;
}
