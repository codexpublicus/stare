// The search page (search.astro): a query in the URL (`/search/?q=...&court=...&from=...`),
// run with stare-builder's reference client over the live index build's search tree on
// idx.stare.pub (docs/search-index.md in stare-builder), 20 result cards a page.
//
// Nothing is fetched until there is a query, or the filters are opened. Then, once a page:
// - the index manifest (manifest.js, the reader's), for the live build's `base`, unless the
//   build pinned a tree (PUBLIC_SEARCH_TREE, for the dev server and local measurements);
// - the search client (searchclient-path.js), one module, and the tree's manifest.json, in
//   parallel. A build with no search/ answers 404, and the page says search isn't
//   available for it yet;
// - facets.json, only for the filters (the court and jurisdiction lists, and which years
//   exist for a year range).
// Each query then costs what the client reads for it: the words' term shards, a facet's
// shard, low.bin when the top tiers can't fill a page, and the page's cards in one
// multi-range request. A query's ranking is kept, so the next page reads only its cards.
// Pages and new queries change the URL with pushState and run in place; Back and Forward
// run the URL they land on.

import { SEARCH_CLIENT_URL } from './searchclient-path.js';
import { indexUrl } from './sources.js';
import {
  PAGE_SIZE, caseHref, cardFields, clientFilters, formatDate, pageCount, pageLinks,
  parseSearchState, rangeDataset, sameQuery, searchString, summaryText,
} from './searchquery.js';

const form = document.getElementById('search-form');
const input = document.getElementById('search-q');
const button = document.getElementById('search-btn');
const filters = document.getElementById('search-filters');
const jurisdictionSel = document.getElementById('search-jurisdiction');
const courtSel = document.getElementById('search-court');
const fromInput = document.getElementById('search-from');
const toInput = document.getElementById('search-to');
const filterNote = document.getElementById('search-filter-note');
const statusEl = document.getElementById('search-status');
const heading = document.getElementById('search-results-heading');
const list = document.getElementById('search-results');
const pagesNav = document.getElementById('search-pages');

const pinnedTree = document.body.dataset.searchTree || '';

// Thrown when the index build has no search tree; shown as a note, not an error.
class NoTree extends Error {}

let basePromise = null;
let treePromise = null;
let facetsPromise = null;
let facets = null;
// The last query's result: its state and the client's ranking, so another page of it
// reads only that page's cards.
let last = null;
// Each run checks it's still the latest before it touches the page.
let runId = 0;

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.classList.toggle('search-error', kind === 'error');
  statusEl.classList.toggle('search-note', kind === 'note');
}

// The tree's URL: `https://idx.stare.pub/v/<version>/search`.
function treeBase() {
  if (!basePromise) {
    basePromise = (async () => {
      if (pinnedTree) return pinnedTree.replace(/\/$/, '');
      const { loadManifest } = await import('./manifest.js');
      const m = await loadManifest();
      if (m.unreachable) throw new Error('Couldn’t reach the index');
      if (!m.base) throw new NoTree();
      return indexUrl(`${m.base}search`);
    })();
    basePromise.catch(() => { basePromise = null; });
  }
  return basePromise;
}

// The client and the opened tree, once a page.
function openTree() {
  if (!treePromise) {
    treePromise = (async () => {
      const base = await treeBase();
      const [client, raw] = await Promise.all([
        import(SEARCH_CLIENT_URL).catch((e) => {
          throw Object.assign(new Error('The search client couldn’t load. A content blocker may be stopping it'), { cause: e });
        }),
        fetch(`${base}/manifest.json`).then(async (res) => {
          if (res.status === 404 || res.status === 403) throw new NoTree();
          if (!res.ok) throw new Error(`The search index answered ${res.status}`);
          return res.json();
        }),
      ]);
      let s;
      try {
        // fetch bound to the window: the client calls it as `s.fetch(...)`, which a browser
        // refuses for the unbound global ("Illegal invocation").
        s = await client.openSearch(base, { manifest: raw, fetch: (url, init) => globalThis.fetch(url, init) });
      } catch (e) {
        throw Object.assign(new Error('This search index is in a format this page doesn’t read'), { cause: e });
      }
      return { client, s, base };
    })();
    // A failure other than a missing tree can be a blip; let the next query try again.
    treePromise.catch((e) => { if (!(e instanceof NoTree)) treePromise = null; });
  }
  return treePromise;
}

// facets.json, for the filters; once a page.
function loadFacets() {
  if (!facetsPromise) {
    facetsPromise = (async () => {
      const base = await treeBase();
      const res = await fetch(`${base}/facets.json`);
      if (res.status === 404 || res.status === 403) throw new NoTree();
      if (!res.ok) throw new Error(`The search index answered ${res.status}`);
      facets = await res.json();
      return facets;
    })();
    facetsPromise.catch(() => { facetsPromise = null; });
  }
  return facetsPromise;
}

function option(value, label, selected) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  if (selected) o.selected = true;
  return o;
}

// The filter lists, from facets.json when it's in; until then each holds "Any" and the
// URL's value, so the form still submits it.
function fillFilters(state) {
  const jur = state.jurisdiction;
  const court = state.court;
  if (!facets) {
    jurisdictionSel.replaceChildren(option('', 'Any', !jur), ...(jur ? [option(jur, jur, true)] : []));
    courtSel.replaceChildren(option('', 'Any', !court), ...(court ? [option(court, court, true)] : []));
    return;
  }
  const jurs = [...facets.jurisdictions].sort((a, b) => (a.name || a.key).localeCompare(b.name || b.key));
  jurisdictionSel.replaceChildren(option('', 'Any', !jur),
    ...jurs.map((j) => option(j.key, j.name || j.key, j.key === jur)));
  const courts = facets.courts
    .filter((c) => !jur || c.jurisdiction === jur || c.key === court)
    .sort((a, b) => (a.name || a.key).localeCompare(b.name || b.key));
  courtSel.replaceChildren(option('', 'Any', !court),
    ...courts.map((c) => option(c.key, `${c.name || c.key}${c.years ? ` (${c.years[0]}–${c.years[1]})` : ''}`, c.key === court)));
}

function fillForm(state) {
  input.value = state.q;
  fromInput.value = state.from;
  toInput.value = state.to;
  fillFilters(state);
  if (state.jurisdiction || state.court || state.from || state.to) filters.open = true;
}

function formState() {
  return parseSearchState(searchString({
    q: input.value,
    jurisdiction: jurisdictionSel.value,
    court: courtSel.value,
    from: fromInput.value.trim(),
    to: toInput.value.trim(),
    page: 1,
  }));
}

function card(fields) {
  const li = document.createElement('li');
  li.className = 'search-card';
  const title = document.createElement('h3');
  title.className = 'search-card-name';
  const href = caseHref(fields.route);
  const name = fields.name || fields.citation || 'Untitled decision';
  if (href) {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = name;
    title.append(a);
  } else {
    title.textContent = name;
  }
  const meta = document.createElement('p');
  meta.className = 'search-card-meta';
  const parts = [
    ['search-card-cite', fields.citation],
    ['search-card-court', fields.court],
    ['search-card-date', formatDate(fields.date)],
  ].filter(([, text]) => text);
  parts.forEach(([cls, text], i) => {
    if (i) meta.append(' · ');
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    meta.append(span);
  });
  li.append(title, meta);
  return li;
}

function renderPages(state, total) {
  const pages = pageCount(total);
  if (pages <= 1) {
    pagesNav.hidden = true;
    pagesNav.replaceChildren();
    return;
  }
  const link = (page, text, label) => {
    const a = document.createElement('a');
    a.href = `/search/${searchString({ ...state, page })}`;
    a.textContent = text;
    a.dataset.page = String(page);
    if (label) a.setAttribute('aria-label', label);
    if (page === state.page) a.setAttribute('aria-current', 'page');
    return a;
  };
  const items = [];
  if (state.page > 1) items.push(link(state.page - 1, 'Previous', `Previous page, ${state.page - 1}`));
  for (const p of pageLinks(state.page, pages)) {
    if (p === null) {
      const gap = document.createElement('span');
      gap.className = 'search-pages-gap';
      gap.textContent = '…';
      gap.setAttribute('aria-hidden', 'true');
      items.push(gap);
    } else {
      items.push(link(p, String(p), `Page ${p}`));
    }
  }
  if (state.page < pages) items.push(link(state.page + 1, 'Next', `Next page, ${state.page + 1}`));
  pagesNav.replaceChildren(...items);
  pagesNav.hidden = false;
}

function clearResults() {
  list.replaceChildren();
  pagesNav.hidden = true;
  pagesNav.replaceChildren();
}

// The cards for decision ids, in one multi-range request on cards.bin, parsed the way the
// client parses its own (docs/search-index.md, "Cards").
async function readCards(tree, ids) {
  if (!ids.length) return [];
  const { path, stride } = tree.s.meta.files.cards;
  const get = await tree.client.readRanges(tree.s, path, ids.map((id) => ({ start: id * stride, end: (id + 1) * stride })));
  const dec = new TextDecoder();
  return ids.map((id) => {
    try {
      return JSON.parse(dec.decode(get(id * stride, (id + 1) * stride)).trimEnd());
    } catch {
      return {};
    }
  });
}

// The client's session with its Dataset answering year ranges (`1920..1929`), for a query
// with one; facets.json says which years exist.
function rangeSession(tree) {
  const years = facets.years.map((y) => y.key).sort();
  const byKey = new Map(facets.courts.map((c) => [c.key, c.years]));
  return {
    ...tree.s,
    ds: rangeDataset(tree.s.ds, { years, courtYears: (k) => byKey.get(k) ?? null, decode: tree.client.decodeRoaring }),
  };
}

// The court and jurisdiction lists, once the filters are open; after any query under way,
// so facets.json never competes with a query's own reads.
function fillFiltersWhenOpen() {
  if (!filters.open || facets) return;
  inflight.then(() => {
    if (!filters.open) return;
    filterNote.textContent = 'Loading the courts…';
    return loadFacets().then(() => {
      filterNote.textContent = '';
      fillFilters(formState());
    }, (e) => {
      filterNote.textContent = e instanceof NoTree
        ? 'Search isn’t available for this index yet.'
        : 'The court list couldn’t load. Reload the page to try again.';
    });
  });
}

// The query under way, settled or not.
let inflight = Promise.resolve();

function run(state, opts) {
  const p = runQuery(state, opts);
  inflight = p.catch(() => {});
  return p;
}

async function runQuery(state, { focus = false } = {}) {
  const id = ++runId;
  fillForm(state);
  if (!state.q) {
    clearResults();
    setStatus('');
    document.title = 'Search case law · stare.pub';
    return;
  }
  document.title = `${state.q} · Search · stare.pub`;
  button.disabled = true;
  list.setAttribute('aria-busy', 'true');
  setStatus('Searching…');
  try {
    const tree = await openTree();
    let result = last && sameQuery(last.state, state) ? last.result : null;
    if (!result) {
      if ((state.from || state.to) && state.from !== state.to && !facets) {
        await loadFacets();
        if (id === runId) fillFilters(state);
      }
      const f = clientFilters(state, facets);
      const s = f.year?.includes('..') ? rangeSession(tree) : tree.s;
      result = await tree.client.search(s, state.q, { filters: f, limit: PAGE_SIZE, cards: false });
      if (id !== runId) return;
      last = { state, result };
    }
    const pages = pageCount(result.total);
    const page = Math.min(state.page, pages);
    const ids = result.ranked.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((h) => h.id);
    const cards = await readCards(tree, ids);
    if (id !== runId) return;
    list.replaceChildren(...cards.map((c) => card(cardFields(c))));
    renderPages({ ...state, page }, result.total);
    setStatus(summaryText(result, page));
    if (focus) heading.focus({ preventScroll: true });
    if (focus) heading.scrollIntoView({ block: 'start' });
  } catch (e) {
    if (id !== runId) return;
    clearResults();
    if (e instanceof NoTree) {
      setStatus('Search isn’t available for this index yet. You can still open a case by its citation on the home page.', 'note');
    } else {
      if (e?.cause) console.warn(e.cause);
      setStatus(`${e?.message || 'Search failed'}. Reload the page to try again.`, 'error');
    }
  } finally {
    if (id === runId) {
      button.disabled = false;
      list.removeAttribute('aria-busy');
    }
  }
}

function go(state, opts) {
  const url = `/search/${searchString(state)}`;
  if (url !== `${location.pathname}${location.search}`) history.pushState(null, '', url);
  run(state, opts);
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  go(formState());
});

filters.addEventListener('toggle', fillFiltersWhenOpen);

jurisdictionSel.addEventListener('change', () => {
  if (facets) fillFilters({ ...formState(), court: '' });
});

pagesNav.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-page]');
  if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  const state = parseSearchState(new URL(a.href).search);
  go(state, { focus: true });
});

window.addEventListener('popstate', () => run(parseSearchState(location.search)));

run(parseSearchState(location.search));
globalThis.stareBoot?.ready();
