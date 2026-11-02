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
// - facets.json and the filter panel's module (searchfilters.js), only for the filters (the
//   court and jurisdiction lists with their decisions, and the years for a year range).
// Each query then costs what the client reads for it: the words' term shards, a facet's
// shard, the low tiers' segments when the top tiers can't fill a page, and the page's
// cards, one multi-range request per cards segment they fall in. A query's ranking is kept,
// so the next page reads only its cards.
//
// While a query runs, the previous results stay on screen, dimmed; the first query shows
// a skeleton of the list at its final height instead, and says what it's loading. A new
// query aborts the reads of the one it replaces (the session's fetch carries the current
// query's signal). One announcement per result set goes to the live region (#search-live);
// the status line itself isn't live, so its progress messages aren't read out.
// Pages and new queries change the URL with pushState and run in place; Back and Forward
// run the URL they land on, and go back to where the page was scrolled.

import { SEARCH_CLIENT_URL } from './searchclient-path.js';
import { indexUrl } from './sources.js';
import {
  PAGE_SIZE, caseHref, cardFields, clientFilters, droppedWords, filterChips, formatDate,
  hasFilters, looksLikeCitation, nameSegments, noteText, pageCount, pageLinks,
  parseSearchState, sameQuery, searchString, statusText, summaryText,
} from './searchquery.js';

const $ = (id) => document.getElementById(id);
const form = $('search-form');
const input = $('search-q');
const button = $('search-btn');
const filters = $('search-filters');
const filterCount = $('search-filter-count');
const jurisdictionSel = $('search-jurisdiction');
const courtSel = $('search-court');
const courtFind = $('search-court-find');
const yearChart = $('search-year-chart');
const fromInput = $('search-from');
const toInput = $('search-to');
const clearBtn = $('search-clear');
const filterNote = $('search-filter-note');
const chips = $('search-chips');
const citeEl = $('search-cite');
const statusEl = $('search-status');
const noteEl = $('search-note');
const live = $('search-live');
const progress = $('search-progress');
const heading = $('search-results-heading');
const list = $('search-results');
const empty = $('search-empty');
const pagesNav = $('search-pages');

const pinnedTree = document.body.dataset.searchTree || '';
// A query still running after this long says so, with a way to try again.
const SLOW_MS = 8000;
// The progress bar shows only for a query that takes longer than this.
const PROGRESS_AFTER_MS = 150;

// Thrown when the index build has no search tree; shown as a note, not an error.
class NoTree extends Error {}

let basePromise = null;
let treePromise = null;
let facetsPromise = null;
let facets = null;
let panel = null;
let panelPromise = null;
// The last query's result: its state and the client's ranking, so another page of it
// reads only that page's cards.
let last = null;
// Each run checks it's still the latest before it touches the page.
let runId = 0;
// The running query's abort controller; the session's fetch reads its signal.
let current = null;

history.scrollRestoration = 'manual';

function setStatus(text, kind = '', retry = null) {
  const parts = [text];
  if (retry) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'search-retry';
    b.textContent = 'Try again';
    b.addEventListener('click', retry);
    parts.push(' ', b);
  }
  statusEl.replaceChildren(...parts);
  statusEl.classList.toggle('search-error', kind === 'error');
  statusEl.classList.toggle('search-note-status', kind === 'note');
  statusEl.classList.toggle('search-working', kind === 'working');
}

function setNote(text) {
  noteEl.textContent = text;
  noteEl.hidden = !text;
}

// One message per result set; cleared first, so the same words twice are read twice.
function announce(text) {
  live.textContent = '';
  requestAnimationFrame(() => { live.textContent = text; });
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

// The session's fetch: the running query's signal, with any of the client's own.
function queryFetch(url, init = {}) {
  const signal = current?.signal;
  if (!signal) return fetch(url, init);
  const both = init.signal && AbortSignal.any ? AbortSignal.any([init.signal, signal]) : (init.signal || signal);
  return fetch(url, { ...init, signal: both });
}

// The client and the opened tree, once a page. Not aborted by a newer query: the next one
// needs it too.
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
        s = await client.openSearch(base, { manifest: raw, fetch: queryFetch });
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

// facets.json and the panel's module, then the panel; once a page.
function loadPanel() {
  if (!panelPromise) {
    panelPromise = Promise.all([loadFacets(), import('./searchfilters.js')]).then(([f, mod]) => {
      panel = mod.mountFilters(f, {
        jurisdiction: jurisdictionSel, court: courtSel, courtFind, chart: yearChart, from: fromInput, to: toInput,
      });
      return panel;
    });
    panelPromise.catch(() => { panelPromise = null; });
  }
  return panelPromise;
}

function option(value, label, selected) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  if (selected) o.selected = true;
  return o;
}

// The filter lists: the panel's, once facets.json is in; until then each holds "Any" and
// the URL's value, so the form still submits it.
function fillFilters(state) {
  if (panel) {
    panel.fill(state);
    return;
  }
  const jur = state.jurisdiction;
  const court = state.court;
  jurisdictionSel.replaceChildren(option('', 'Any', !jur), ...(jur ? [option(jur, jur, true)] : []));
  courtSel.replaceChildren(option('', 'Any', !court), ...(court ? [option(court, court, true)] : []));
}

// The chips for the filters in use, each a button that drops its filter, and the count on
// the Filters toggle. `hint` names a court before facets.json is in (a card's court).
function renderChips(state, hint = {}) {
  const items = filterChips(state, facets, hint);
  filterCount.textContent = items.length ? ` (${items.length})` : '';
  clearBtn.hidden = !items.length;
  chips.hidden = !items.length;
  // The same chips again (a query's results naming the court) keep their buttons, and
  // with them the focus.
  const sig = JSON.stringify(items);
  if (sig === chips.dataset.sig) return;
  chips.dataset.sig = sig;
  // A chip's name can change under the focus (the court's key, then its name from a card
  // or facets.json); the focus stays on the same chip.
  const focused = [...chips.querySelectorAll('button')].indexOf(document.activeElement);
  if (!items.length) {
    chips.replaceChildren();
    return;
  }
  const lis = items.map((c) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'search-chip';
    b.dataset.remove = c.key;
    b.setAttribute('aria-label', `Remove filter: ${c.label}, ${c.text}`);
    const label = document.createElement('span');
    label.className = 'search-chip-label';
    label.textContent = `${c.label}: `;
    const x = document.createElement('span');
    x.className = 'search-chip-x';
    x.setAttribute('aria-hidden', 'true');
    x.textContent = '×';
    b.append(label, c.text, x);
    li.append(b);
    return li;
  });
  if (items.length > 1) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'search-chip-clear';
    b.dataset.remove = 'all';
    b.textContent = 'Clear all';
    li.append(b);
    lis.push(li);
  }
  chips.replaceChildren(...lis);
  if (focused >= 0) chips.querySelectorAll('button')[Math.min(focused, lis.length - 1)]?.focus();
}

function fillForm(state) {
  input.value = state.q;
  fromInput.value = state.from;
  toInput.value = state.to;
  fillFilters(state);
  renderChips(state);
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

function card(fields, tokens) {
  const li = document.createElement('li');
  li.className = 'search-card';
  const title = document.createElement('h3');
  title.className = 'search-card-name';
  const href = caseHref(fields.route);
  const name = fields.name || fields.citation || 'Untitled decision';
  const target = href ? Object.assign(document.createElement('a'), { href }) : title;
  for (const seg of nameSegments(name, fields.name ? tokens : [])) {
    if (seg.hit) {
      const m = document.createElement('mark');
      m.textContent = seg.text;
      target.append(m);
    } else {
      target.append(seg.text);
    }
  }
  if (href) title.append(target);
  const cite = document.createElement('span');
  cite.className = 'search-card-cite';
  cite.textContent = fields.citation;
  const court = document.createElement('span');
  court.className = 'search-card-court';
  court.textContent = fields.court;
  const date = document.createElement('span');
  date.className = 'search-card-date';
  date.textContent = formatDate(fields.date);
  const meta = document.createElement('p');
  meta.className = 'search-card-meta';
  meta.append(...[cite, court].filter((el) => el.textContent));
  li.append(title, date, meta);
  return li;
}

// Placeholder cards for a list being filled for the first time, as tall as cards are.
function skeleton() {
  const out = [];
  for (let i = 0; i < PAGE_SIZE; i++) {
    const li = document.createElement('li');
    li.className = 'search-card search-card-skel';
    li.setAttribute('aria-hidden', 'true');
    li.innerHTML = '<div class="search-card-name"><span></span></div><span class="search-card-date"><span></span></span><p class="search-card-meta"><span></span></p>';
    li.firstChild.firstChild.style.width = `${40 + ((i * 37) % 45)}%`;
    out.push(li);
  }
  return out;
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
  empty.hidden = true;
  empty.replaceChildren();
  pagesNav.hidden = true;
  pagesNav.replaceChildren();
  setNote('');
}

// What the results area says when nothing matched, or there was nothing to search for.
function renderEmpty(state, result) {
  const h = document.createElement('p');
  h.className = 'search-empty-title';
  const tips = [];
  if (!result.tokens.length) {
    h.textContent = 'Every word in that query is too common to search for.';
    tips.push('Add a more specific word, such as a party’s name or a term of art.');
  } else {
    h.textContent = `No decisions match ${state.q}.`;
    if (looksLikeCitation(state.q)) tips.push('To open the case that citation names, use Open in the reader above.');
    tips.push('Words are matched as written: negligent doesn’t find negligence.');
    if (result.tokens.length > 1) tips.push('Try fewer words. Every word has to be in the decision or its name.');
  }
  const ul = document.createElement('ul');
  for (const t of tips) ul.append(Object.assign(document.createElement('li'), { textContent: t }));
  const parts = [h, ul];
  if (hasFilters(state)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'search-empty-clear';
    b.textContent = 'Search without the filters';
    b.addEventListener('click', () => go({ ...state, jurisdiction: '', court: '', from: '', to: '', page: 1 }));
    parts.push(b);
  }
  empty.replaceChildren(...parts);
  empty.hidden = false;
}

// A query that reads like a citation offers to open it in the reader. The parser (the
// reader's WASM, through resolve.js) loads only when that's clicked.
function renderCite(state) {
  if (!looksLikeCitation(state.q)) {
    citeEl.hidden = true;
    citeEl.replaceChildren();
    return;
  }
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'search-cite-open';
  b.textContent = `Open ${state.q} in the reader`;
  const msg = document.createElement('span');
  msg.className = 'search-cite-msg';
  msg.setAttribute('role', 'status');
  b.addEventListener('click', async () => {
    b.disabled = true;
    msg.textContent = ' Reading the citation…';
    try {
      const [{ parseInput }, { pageSegment }] = await Promise.all([import('./resolve.js'), import('./pagekey.js')]);
      const p = await parseInput(state.q);
      if (!p) {
        msg.textContent = ' stare.pub can’t read that as a citation.';
        return;
      }
      const seq = p.seq ? `-${String(p.seq).padStart(2, '0')}` : '';
      location.assign(`/#${p.reporter}/${p.volume}/${pageSegment(p.page)}${seq}`);
    } catch (e) {
      console.warn(e);
      msg.textContent = ' The citation reader couldn’t load. Try it on the home page.';
    } finally {
      b.disabled = false;
    }
  });
  citeEl.replaceChildren('That looks like a citation. ', b, msg);
  citeEl.hidden = false;
}

// The cards for decision ids, one multi-range request per cards segment they fall in (the
// client's readRanges), parsed the way the client parses its own (docs/search-index.md,
// "Cards").
async function readCards(tree, ids) {
  if (!ids.length) return [];
  const cards = tree.s.meta.files.cards;
  const { stride } = cards;
  const get = await tree.client.readRanges(tree.s, cards, ids.map((id) => ({ start: id * stride, end: (id + 1) * stride })));
  const dec = new TextDecoder();
  return ids.map((id) => {
    try {
      return JSON.parse(dec.decode(get(id * stride, (id + 1) * stride)).trimEnd());
    } catch {
      return {};
    }
  });
}

// The filter panel, once the filters are open; after any query under way, so facets.json
// never competes with a query's own reads.
function fillFiltersWhenOpen() {
  if (!filters.open || panel) return;
  inflight.then(() => {
    if (!filters.open || panel) return;
    filterNote.textContent = 'Loading the courts…';
    yearChart.textContent = 'Loading the years…';
    return loadPanel().then(() => {
      filterNote.textContent = '';
      fillFilters(parseSearchState(location.search));
      renderChips(parseSearchState(location.search), chipHint);
    }, (e) => {
      if (e && !(e instanceof NoTree)) console.warn(e);
      yearChart.textContent = '';
      filterNote.textContent = e instanceof NoTree
        ? 'Search isn’t available for this index yet.'
        : 'The court list couldn’t load. Close and open Filters to try again.';
    });
  });
}

// The query under way, settled or not.
let inflight = Promise.resolve();
// A court's name before facets.json is in, from the results' cards.
let chipHint = {};

function run(state, opts) {
  const p = runQuery(state, opts);
  inflight = p.catch(() => {});
  return p;
}

const isAbort = (e) => e?.name === 'AbortError';

async function runQuery(state, { focus = false, scrollY = null } = {}) {
  const id = ++runId;
  current?.abort();
  const ctl = new AbortController();
  current = ctl;
  fillForm(state);
  renderCite(state);
  if (!state.q) {
    clearResults();
    setStatus('');
    document.title = 'Search case law · stare.pub';
    return;
  }
  document.title = `${state.q} · Search · stare.pub`;
  // The previous results stay, dimmed; a first query gets the skeleton.
  if (!list.querySelector('.search-card:not(.search-card-skel)')) {
    empty.hidden = true;
    setNote('');
    list.replaceChildren(...skeleton());
  }
  list.setAttribute('aria-busy', 'true');
  const showProgress = setTimeout(() => { if (id === runId) progress.hidden = false; }, PROGRESS_AFTER_MS);
  const retry = () => run(parseSearchState(location.search));
  const slow = setTimeout(() => {
    if (id === runId) setStatus('Still searching. A broad query or a slow connection can take a while.', 'working', retry);
  }, SLOW_MS);
  const fresh = !treePromise;
  setStatus(fresh ? 'Loading the search index, once per visit…' : 'Searching…', 'working');
  try {
    let result = null;
    let cards = null;
    let page = 1;
    // A read a superseded query shared with this one (a shard both asked for) can fail
    // with its abort; the client drops a failed load from its cache, so this one tries again.
    for (let attempt = 0; ; attempt++) {
      try {
        const tree = await openTree();
        if (id !== runId) return;
        if (fresh) setStatus('Searching…', 'working');
        result = last && sameQuery(last.state, state) ? last.result : null;
        if (!result) {
          if ((state.from || state.to) && state.from !== state.to && !facets) {
            await loadFacets();
          }
          const f = clientFilters(state, facets);
          result = await tree.client.search(tree.s, state.q, { filters: f, limit: PAGE_SIZE, cards: false });
          if (id !== runId) return;
          last = { state, result };
        }
        const pages = pageCount(result.total);
        page = Math.min(state.page, pages);
        // (a query whose words are all stopwords returns no `ranked`)
        const ids = (result.ranked ?? []).slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((h) => h.id);
        cards = await readCards(tree, ids);
        break;
      } catch (e) {
        if (id !== runId) return;
        if (isAbort(e) && !ctl.signal.aborted && attempt < 1) continue;
        throw e;
      }
    }
    if (id !== runId) return;
    const fields = cards.map(cardFields);
    if (state.court && fields[0]?.court) chipHint = { court: fields[0].court };
    renderChips(state, chipHint);
    list.replaceChildren(...fields.map((c) => card(c, result.tokens)));
    empty.hidden = true;
    if (!fields.length) renderEmpty(state, result);
    renderPages({ ...state, page }, result.total);
    setStatus(statusText(result, page));
    const dropped = result.tokens.length ? droppedWords(state.q, result.tokens) : [];
    const note = noteText(result);
    setNote([note, dropped.length ? `Left out as too common to search for: ${dropped.join(', ')}.` : ''].filter(Boolean).join(' '));
    announce(summaryText(result, page));
    if (focus) {
      heading.focus({ preventScroll: true });
      if (heading.getBoundingClientRect().top < 0) heading.scrollIntoView({ block: 'start' });
    }
    if (scrollY !== null) window.scrollTo(0, scrollY);
  } catch (e) {
    if (id !== runId) return;
    clearResults();
    if (e instanceof NoTree) {
      setStatus('Search isn’t available for this index yet. You can still open a case by its citation on the home page.', 'note');
      announce(statusEl.textContent);
    } else {
      console.warn(e?.cause ?? e);
      const why = isAbort(e) ? 'The search was interrupted' : (e?.message || 'Search failed');
      setStatus(`${why}.`, 'error', retry);
      announce(`${why}.`);
    }
  } finally {
    clearTimeout(showProgress);
    clearTimeout(slow);
    if (id === runId) {
      progress.hidden = true;
      list.removeAttribute('aria-busy');
      if (current === ctl) current = null;
    }
  }
}

// Remember where this entry was scrolled, then push the new one.
function go(state, opts) {
  const url = `/search/${searchString(state)}`;
  if (url !== `${location.pathname}${location.search}`) {
    history.replaceState({ scrollY: window.scrollY }, '');
    history.pushState(null, '', url);
  }
  run(state, opts);
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  go(formState());
});

filters.addEventListener('toggle', fillFiltersWhenOpen);

jurisdictionSel.addEventListener('change', () => panel?.jurisdictionChanged());

clearBtn.addEventListener('click', () => {
  go({ ...formState(), jurisdiction: '', court: '', from: '', to: '' });
});

// A chip drops its filter and runs the query; focus goes to the chip after it, or the
// Filters toggle when none is left.
chips.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-remove]');
  if (!b) return;
  const state = parseSearchState(location.search);
  const key = b.dataset.remove;
  const next = { ...state, page: 1 };
  if (key === 'all') Object.assign(next, { jurisdiction: '', court: '', from: '', to: '' });
  else if (key === 'years') Object.assign(next, { from: '', to: '' });
  else next[key] = '';
  const at = [...chips.querySelectorAll('button')].indexOf(b);
  go(next);
  const left = chips.querySelectorAll('button');
  (left[Math.min(at, left.length - 1)] ?? filters.querySelector('summary')).focus();
});

pagesNav.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-page]');
  if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  const state = parseSearchState(new URL(a.href).search);
  go(state, { focus: true });
});

window.addEventListener('popstate', (e) => run(parseSearchState(location.search), { scrollY: e.state?.scrollY ?? null }));

// Filters in the URL open the panel on a wide screen; on a phone the chips show them and
// the panel stays shut until asked for.
const initial = parseSearchState(location.search);
// The year chart's room, kept from the start so facets.json arriving moves nothing; with
// no script there's no chart.
yearChart.classList.add('search-year-chart-on');
if (hasFilters(initial) && window.matchMedia('(min-width: 700px)').matches) filters.open = true;
run(initial);
globalThis.stareBoot?.ready();
