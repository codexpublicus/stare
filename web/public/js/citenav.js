// From a cited case in a cited-cases list to the places the text cites it,
// and a filter for the list (#159). Used by the case viewer's sidebar and by
// /check, over the list citedListHtml renders and the text renderTextHtml
// renders: a list entry and each of its citations in the text share a
// `data-cite-group`.
//
// - An entry's "in text" control goes to the case's first place in the text
//   and highlights every place; then its previous and next controls, or `[`
//   and `]` while focus is in the entry, step through them, with an `n of m`
//   position announced through an aria-live region. A place is where the text
//   cites the case (#198): the printings of a parallel run (`261 Conn. 941,
//   808 A.2d 1132`) share a `data-cite-place` and are one place, highlighted
//   together. A short form is marked apart from a full citation
//   (`data-cite-form="short"`).
// - Hovering or focusing a citation in the text highlights its entry.
// - The filter box narrows the list as the reader types, by case name, any
//   citation form or reporter, ignoring case and punctuation; status chips
//   narrow it by citeCategory. Escape clears it.
//
// Every marked citation is numbered in text order (`data-cite-n`, from 1),
// the number the case viewer's `~c=` fragment names (router.js); going to one
// goes to the place it is part of.

import { CITE_CATEGORIES, filterTokens, matchesFilter } from './citations.js';

const PLACE = 'cite-place';
const CURRENT = 'cite-place-current';

/**
 * Wire a rendered list to its text. `onMove(n)` is called with the place's
 * number whenever the reader moves to one. Returns `{ goTo(n), destroy() }`:
 * goTo moves to place `n` (false when there is none); destroy removes the
 * listeners, the filter and the highlights.
 */
export function attachCiteNav({ list, text, onMove = null }) {
  const doc = list.ownerDocument;
  const ac = new AbortController();
  const on = (el, type, fn) => el.addEventListener(type, fn, { signal: ac.signal });

  const marked = [...text.querySelectorAll('[data-cite-group]')];
  // Each group's places in text order, a place being the citations that share a
  // `data-cite-place` (one alone without it).
  const byGroup = new Map();
  const placeOf = new Map();
  marked.forEach((el, i) => {
    el.dataset.citeN = String(i + 1);
    const g = el.dataset.citeGroup;
    if (!byGroup.has(g)) byGroup.set(g, []);
    const places = byGroup.get(g);
    const id = el.dataset.citePlace;
    let place = id !== undefined ? places.find(p => p.id === id) : null;
    if (!place) {
      place = { id, els: [] };
      places.push(place);
    }
    place.els.push(el);
    placeOf.set(el, place);
  });
  const elsOf = (group) => (byGroup.get(group) || []).flatMap(p => p.els);

  const entries = [...list.querySelectorAll('.cited-entry')];
  const entryOf = new Map(entries.map(e => [e.dataset.citeGroup, e]));
  // The count is the places actually marked in the text, which can be fewer
  // than were detected (a citation across a paragraph break isn't marked).
  for (const e of entries) {
    const nav = e.querySelector('.cited-nav');
    if (!nav) continue;
    const n = byGroup.get(e.dataset.citeGroup)?.length || 0;
    if (!n) { nav.remove(); continue; }
    const count = e.querySelector('.cited-count');
    if (count) count.textContent = `${n}×`;
    const show = e.querySelector('.cited-show');
    show?.setAttribute('aria-label', show.getAttribute('aria-label').replace(/\d+ places?$/, `${n} ${n === 1 ? 'place' : 'places'}`));
  }

  const live = doc.createElement('div');
  live.className = 'sr-only cited-live';
  // aria-live without role="status": the section's one status is its
  // "N case citations found" line (ui.js).
  live.setAttribute('aria-live', 'polite');
  list.after(live);

  let active = null; // { group, index }

  function clearActive() {
    if (!active) return;
    for (const el of elsOf(active.group)) el.classList.remove(PLACE, CURRENT);
    const e = entryOf.get(active.group);
    if (e) {
      e.classList.remove('cited-entry-active');
      const step = e.querySelector('.cited-step');
      if (step) step.hidden = true;
    }
    active = null;
  }

  function describe(place, n, m) {
    const [el] = place.els;
    const short = el.dataset.citeForm === 'short' ? ' (short form)' : '';
    const note = el.closest('.reader-footnote')?.dataset.footnote;
    const where = note !== undefined ? `, in footnote ${note}` : '';
    const cited = place.els.map(e => e.textContent.trim()).join(', ');
    return `${n} of ${m}: ${cited}${short}${where}`;
  }

  function activate(group, index) {
    const places = byGroup.get(group);
    if (!places?.length) return false;
    const i = ((index % places.length) + places.length) % places.length;
    if (active?.group !== group) {
      clearActive();
      for (const el of elsOf(group)) el.classList.add(PLACE);
    } else {
      for (const el of places[active.index]?.els || []) el.classList.remove(CURRENT);
    }
    active = { group, index: i };
    const place = places[i];
    for (const el of place.els) el.classList.add(CURRENT);
    const el = place.els[0];
    el.scrollIntoView({ block: 'center' });
    const e = entryOf.get(group);
    if (e) {
      e.classList.add('cited-entry-active');
      const step = e.querySelector('.cited-step');
      if (step) step.hidden = false;
      const pos = e.querySelector('.cited-pos');
      if (pos) pos.textContent = `${i + 1} of ${places.length}`;
    }
    live.textContent = describe(place, i + 1, places.length);
    onMove?.(Number(el.dataset.citeN));
    return true;
  }

  function step(group, delta) {
    if (active?.group !== group) return activate(group, delta < 0 ? -1 : 0);
    return activate(group, active.index + delta);
  }

  on(list, 'click', (ev) => {
    const btn = ev.target.closest('.cited-show, .cited-prev, .cited-next');
    const e = btn?.closest('.cited-entry');
    if (!e) return;
    ev.preventDefault();
    const g = e.dataset.citeGroup;
    if (btn.classList.contains('cited-show')) activate(g, active?.group === g ? active.index : 0);
    else step(g, btn.classList.contains('cited-prev') ? -1 : 1);
  });

  on(list, 'keydown', (ev) => {
    if (ev.key !== '[' && ev.key !== ']') return;
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const e = ev.target.closest?.('.cited-entry');
    if (!e || !e.querySelector('.cited-nav')) return;
    ev.preventDefault();
    step(e.dataset.citeGroup, ev.key === '[' ? -1 : 1);
  });

  // The text's citations, in reverse: hovering or focusing one highlights its entry.
  const hover = (ev, add) => {
    const el = ev.target.closest?.('[data-cite-group]');
    if (!el || !text.contains(el)) return;
    entryOf.get(el.dataset.citeGroup)?.classList.toggle('cited-entry-hover', add);
  };
  on(text, 'mouseover', (ev) => hover(ev, true));
  on(text, 'mouseout', (ev) => hover(ev, false));
  on(text, 'focusin', (ev) => hover(ev, true));
  on(text, 'focusout', (ev) => hover(ev, false));

  const filter = entries.length > 1 ? buildFilter(doc, entries) : null;
  if (filter) {
    list.before(filter.el);
    on(filter.input, 'input', filter.apply);
    on(filter.input, 'keydown', (ev) => {
      if (ev.key !== 'Escape' || (!filter.input.value && !filter.pressed().length)) return;
      ev.preventDefault();
      filter.clear();
    });
    for (const chip of filter.chips) {
      on(chip, 'click', () => {
        chip.setAttribute('aria-pressed', String(chip.getAttribute('aria-pressed') !== 'true'));
        filter.apply();
      });
      on(chip, 'keydown', (ev) => {
        if (ev.key !== 'Escape') return;
        ev.preventDefault();
        filter.clear();
        filter.input.focus();
      });
    }
  }

  return {
    goTo(n) {
      const el = marked[n - 1];
      if (!el) return false;
      const g = el.dataset.citeGroup;
      return activate(g, byGroup.get(g).indexOf(placeOf.get(el)));
    },
    destroy() {
      ac.abort();
      clearActive();
      for (const e of entries) e.classList.remove('cited-entry-hover');
      live.remove();
      filter?.el.remove();
      for (const e of entries) e.hidden = false;
    },
  };
}

// The filter box and status chips above a list of `entries`.
function buildFilter(doc, entries) {
  const el = doc.createElement('div');
  el.className = 'cited-filter';
  const input = doc.createElement('input');
  input.type = 'search';
  input.className = 'cited-filter-input';
  input.placeholder = 'Filter: name, citation, reporter';
  input.setAttribute('aria-label', 'Filter cited cases');
  input.autocomplete = 'off';
  input.spellcheck = false;
  el.appendChild(input);

  // Chips only for the categories the list has, and only when it has more than one.
  const present = new Set(entries.map(e => e.dataset.citeCategory));
  const chips = [];
  if (present.size > 1) {
    const group = doc.createElement('div');
    group.className = 'cited-chips';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Show only');
    for (const [category, label] of CITE_CATEGORIES) {
      if (!present.has(category)) continue;
      const chip = doc.createElement('button');
      chip.type = 'button';
      chip.className = 'cited-chip';
      chip.dataset.category = category;
      chip.setAttribute('aria-pressed', 'false');
      chip.textContent = label;
      group.appendChild(chip);
      chips.push(chip);
    }
    el.appendChild(group);
  }

  const count = doc.createElement('div');
  count.className = 'cited-filter-count';
  count.setAttribute('aria-live', 'polite');
  el.appendChild(count);

  const pressed = () => chips.filter(c => c.getAttribute('aria-pressed') === 'true').map(c => c.dataset.category);
  function apply() {
    const tokens = filterTokens(input.value);
    const cats = pressed();
    let shown = 0;
    for (const e of entries) {
      const keep = matchesFilter(e.dataset.citeSearch, tokens)
        && (!cats.length || cats.includes(e.dataset.citeCategory));
      e.hidden = !keep;
      if (keep) shown++;
    }
    count.textContent = tokens.length || cats.length ? `${shown} of ${entries.length}` : '';
  }
  function clear() {
    input.value = '';
    for (const c of chips) c.setAttribute('aria-pressed', 'false');
    apply();
  }
  return { el, input, chips, pressed, apply, clear };
}
