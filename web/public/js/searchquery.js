// The search page's plain logic (search.astro, searchpage.js does the DOM): the URL's
// state, the filters handed to the reference client, year ranges, and how a result card
// reads. Nothing here fetches; web/tests/searchquery.test.js covers it.
//
// The ranking is stare-builder's reference client, vendored unchanged
// (src/vendor/stare-search/, src/lib/searchvendor.js). The one thing the page adds is a
// year range: the format has a `year` key per year and a `court_year` key per court and
// year (docs/search-index.md in stare-builder, "Facets"), and the client filters on one
// of each. A range is the union of those keys, which `rangeDataset` answers for a
// made-up key (`1920..1929`, `ny/1920..1929`) as one bitmap, so the client's own facet
// step reads it like any other.

export const PAGE_SIZE = 20;
// Past this many pages the links stop; a query that broad is better narrowed.
export const MAX_PAGE = 250;
const MAX_QUERY = 500;
const YEAR = /^\d{4}$/;
// Facet keys are short codes (`nyappdiv`, `cap-8800`) or, for a CourtListener
// jurisdiction, its name (`United States`).
const FACET_KEY = /^[\p{L}\p{N}][\p{L}\p{N} .,'&()/-]{0,99}$/u;
const RANGE_KEY = /^(?:(.+)\/)?(\d{4})\.\.(\d{4})$/;

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
 * The years a range covers, of those the index has (`years`, facets.json's keys, sorted),
 * between `from` and `to` (either may be empty for an open end); for a court, only the
 * years it has decisions in (`courtYears`, its first and last).
 */
export function yearsBetween(years, from, to, courtYears = null) {
  let lo = from || '0000';
  let hi = to || '9999';
  if (courtYears) {
    if (courtYears[0] > lo) lo = courtYears[0];
    if (courtYears[1] < hi) hi = courtYears[1];
  }
  return years.filter((y) => y >= lo && y <= hi);
}

/**
 * The reference client's `filters` for a state: `jurisdiction`, `court`, and `year`, one
 * year as the format's own key, or a range as `<from>..<to>` for rangeDataset. `facets`
 * is facets.json once read; a range needs it, to know which years exist, and a range
 * covering every year the index (or the court) has is no filter at all.
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
    if (lo !== span[0] || hi !== span[1]) f.year = lo === hi ? lo : `${lo}..${hi}`;
  }
  return f;
}

/**
 * A roaring bitmap of sorted, distinct u32 values, in the portable serialization
 * (array and bitmap containers, no runs) that roaringbuckets' decodeRoaring reads.
 */
export function encodeRoaring(values) {
  const containers = [];
  let i = 0;
  while (i < values.length) {
    const key = values[i] >>> 16;
    let j = i;
    while (j < values.length && values[j] >>> 16 === key) j++;
    containers.push({ key, lows: values.slice(i, j) });
    i = j;
  }
  const n = containers.length;
  const sizes = containers.map((c) => (c.lows.length > 4096 ? 8192 : c.lows.length * 2));
  const header = 8 + n * 8;
  const out = new Uint8Array(header + sizes.reduce((a, b) => a + b, 0));
  const view = new DataView(out.buffer);
  view.setUint32(0, 12346, true);
  view.setUint32(4, n, true);
  let offset = header;
  containers.forEach((c, k) => {
    view.setUint16(8 + k * 4, c.key, true);
    view.setUint16(8 + k * 4 + 2, c.lows.length - 1, true);
    view.setUint32(8 + n * 4 + k * 4, offset, true);
    if (c.lows.length > 4096) {
      for (const v of c.lows) {
        const low = v & 0xffff;
        out[offset + (low >>> 3)] |= 1 << (low & 7);
      }
    } else {
      c.lows.forEach((v, m) => view.setUint16(offset + m * 2, v & 0xffff, true));
    }
    offset += sizes[k];
  });
  return out;
}

/**
 * `ds` (a roaringbuckets Dataset) with year ranges: `searchExact('year', '1920..1929')`
 * and `searchExact('court_year', 'ny/1920..1929')` answer one entry, the union of the
 * years' own keys that exist (`years`, sorted; for a court, within `courtYears(court)`).
 * Every other call goes to `ds` as it is. `decode` is the client's decodeRoaring.
 */
export function rangeDataset(ds, { years, courtYears = () => null, decode }) {
  return {
    searchPrefix: (dimension, prefix) => ds.searchPrefix(dimension, prefix),
    async searchExact(dimension, key) {
      const m = (dimension === 'year' || dimension === 'court_year') ? RANGE_KEY.exec(key) : null;
      if (!m) return ds.searchExact(dimension, key);
      const [, court, from, to] = m;
      const span = yearsBetween(years, from, to, court ? courtYears(court) : null);
      const keys = span.map((y) => (court ? `${court}/${y}` : y));
      const found = await Promise.all(keys.map((k) => ds.searchExact(dimension, k)));
      const ids = new Set();
      for (const entries of found) {
        if (entries.length) for (const id of decode(entries[0].bitmapBytes)) ids.add(id);
      }
      if (!ids.size) return [];
      const sorted = Uint32Array.from(ids).sort();
      return [{ key, bitmapBytes: encodeRoaring(sorted) }];
    },
  };
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

const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * What the live region says about a result: how many matched, which page, and whether
 * the count is every match or the best of the ones read (the rank tiers, below the
 * client's read caps, see only the top of a common word's postings).
 */
export function summaryText({ total, exact, relaxed, tokens }, page) {
  if (!tokens.length) return 'Every word in that query is too common to search for. Try more specific words.';
  if (!total) return 'No decisions match.';
  const pages = pageCount(total);
  const count = exact
    ? plural(total, 'decision matches', 'decisions match')
    : `The best ${plural(total, 'match', 'matches')} found`;
  const relax = relaxed ? ' No decision has every word; these have all but one.' : '';
  const where = pages > 1 ? ` Page ${page} of ${pages.toLocaleString('en-US')}.` : '';
  return `${count}.${relax}${where}`;
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
