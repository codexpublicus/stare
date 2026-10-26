// The search boxes' typeahead (#248): the landing's box and the top bar's citation editor
// are each an ARIA combobox (https://www.w3.org/WAI/ARIA/apg/patterns/combobox/) whose
// listbox suggests the reporter, then the volume, then the pages cases start on, as a
// citation is typed (suggest.js decides what). Arrow keys move through the suggestions,
// Enter takes one, Escape closes the list; the mouse works too.
//
// Typing is never held up: suggestions are worked out after a short pause, a result for
// text that has since changed is dropped, and a volume's case names (the one large read)
// are aborted when the typing moves to another volume. What each stage fetches, once:
// - reporter: /reporters.json (about 75 KB compressed) and the index manifest (about
//   40 KB, which a case page has already fetched);
// - volume: nothing more, the manifest says what is held;
// - page: the volume's .idx.gz (0.4 to 5 KB, kept in the cache), then the cases' names
//   from the volume's zip (casenames.js, volumeCaseNames, 70 to 380 KB, kept too); the
//   pages show before the names arrive.
//
// The box also remembers the case it was filled with (fill): while its text is
// unchanged, submitting it reopens that case, so a page several cases start on keeps the
// one shown.

import { volumeCaseNames } from './casenames.js';
import { readIdx } from './idx.js';
import { hasIdx, loadManifest } from './manifest.js';
import {
  buildReporterIndex, citeFromQuery, citeText, exactReporter, keptTarget, pageSuggestions,
  parseQuery, prefill, rankReporters, stageOf, volumeStatus,
} from './suggest.js';
import { loadWasm } from './wasm.js';

const DEBOUNCE_MS = 120;

let data = null;

// The reporter index and the manifest, fetched once, the first time a box is used. A
// failed fetch leaves the boxes without suggestions, and is tried again next time.
function loadData() {
  if (!data) {
    data = (async () => {
      const [map, manifest] = await Promise.all([
        fetch('/reporters.json').then((r) => (r.ok ? r.json() : null)),
        loadManifest(),
      ]);
      if (!map) throw new Error('No reporters.json');
      const index = buildReporterIndex(map);
      const count = (slug) => (manifest.unreachable ? null : (manifest.reporters[slug] || []).length);
      return { index, manifest, count };
    })();
    data.catch(() => { data = null; });
  }
  return data;
}

// A volume's index entries (idx.js), every part a page could be in: part 0, and the part
// the digits typed fall in when part 0's header splits the volume.
async function volumeEntries(slug, volume, digits) {
  const w = await loadWasm();
  const head = await readIdx(slug, volume, 0);
  if (!head) return [];
  const parsed = JSON.parse(w.parse_idx(head));
  const parts = (parsed.parts || []).map(Number);
  const want = Number(digits);
  let part = 0;
  parts.forEach((first, i) => { if (want >= first) part = i + 1; });
  if (!part) return parsed.entries;
  const tail = await readIdx(slug, volume, part);
  return tail ? JSON.parse(w.parse_idx(tail)).entries : parsed.entries;
}

// The years a reporter's editions span: `1892–1955`, `1938–` while one still runs.
const years = (r) => (r.start ? `${r.start}–${r.end || ''}` : '');

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * Make `input` a combobox over `listbox` (a `<ul>`), announcing what it suggests in
 * `status` (a polite live region). `onPick(target, text)` opens a case a page suggestion
 * names: `target` is `{ reporter, volume, page, seq }`. Returns `{ fill, kept, parse,
 * close }`: fill the box with a case's citation as written, the case it still names,
 * the citation its text names when nothing else reads it, and close the list.
 */
export function attachSearchBox(input, listbox, status, { onPick, position = null }) {
  const id = listbox.id;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', id);
  listbox.setAttribute('role', 'listbox');

  let options = [];
  let active = -1;
  let timer = null;
  let generation = 0;
  let filled = null;
  // The text the options shown were worked out for.
  let shownFor = null;
  // The names read in flight, by volume, and its abort.
  let names = null;

  function setActive(i) {
    const items = listbox.children;
    if (active >= 0 && items[active]) items[active].setAttribute('aria-selected', 'false');
    active = i;
    if (i >= 0 && items[i]) {
      items[i].setAttribute('aria-selected', 'true');
      input.setAttribute('aria-activedescendant', items[i].id);
      items[i].scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function close() {
    clearTimeout(timer);
    generation += 1;
    options = [];
    setActive(-1);
    listbox.replaceChildren();
    listbox.classList.add('hidden');
    input.setAttribute('aria-expanded', 'false');
  }

  // Show `opts` ({ main, detail, note, disabled, take }), keeping the active one when it
  // is still there.
  function render(opts, said, text) {
    const keep = active >= 0 ? options[active]?.key : null;
    shownFor = text;
    options = opts;
    active = -1;
    listbox.replaceChildren(...opts.map((o, i) => {
      const li = document.createElement('li');
      li.id = `${id}-${i}`;
      li.className = 'suggest-option';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      if (o.disabled) li.setAttribute('aria-disabled', 'true');
      const main = document.createElement('span');
      main.className = 'suggest-main';
      main.textContent = o.main;
      li.append(main);
      if (o.detail) {
        const detail = document.createElement('span');
        detail.className = 'suggest-detail';
        detail.textContent = o.detail;
        li.append(detail);
      }
      if (o.note) {
        const note = document.createElement('span');
        note.className = 'suggest-note';
        note.textContent = o.note;
        li.append(note);
      }
      return li;
    }));
    const open = opts.length > 0;
    listbox.classList.toggle('hidden', !open);
    input.setAttribute('aria-expanded', String(open));
    if (open && position) position(listbox);
    const again = keep ? opts.findIndex((o) => o.key === keep && !o.disabled) : -1;
    if (again >= 0) setActive(again);
    if (status) status.textContent = said || '';
  }

  // Put `text` in the box and work out its suggestions at once.
  function setText(text) {
    input.value = text;
    input.setSelectionRange(text.length, text.length);
    update();
  }

  function take(o) {
    if (!o || o.disabled) return;
    if (o.target) {
      input.value = o.text;
      close();
      onPick(o.target, o.text);
      return;
    }
    setText(o.text);
  }

  function reporterOptions(hits, q) {
    return hits.map((r) => ({
      key: `r:${r.slug}`,
      main: r.abbr,
      detail: [r.fullName, years(r)].filter(Boolean).join(', '),
      note: r.volumes ? plural(r.volumes, 'volume', 'volumes') : 'no volumes held',
      text: q.order === 'cite' ? `${citeText(r.abbr, q.volume)} ` : `${r.abbr} `,
    }));
  }

  function volumeOptions(r, volume, st) {
    const opt = (v, scans) => ({
      key: `v:${r.slug}/${v}`,
      main: citeText(r.abbr, v),
      detail: r.fullName,
      note: scans ? '' : 'no page scans',
      text: `${citeText(r.abbr, v)} `,
    });
    if (st.held) {
      return [{ ...opt(volume, st.scans), detail: 'in the index' }];
    }
    if (st.aliasOnly) {
      return [{ ...opt(volume, true), detail: 'parallel citations only' }];
    }
    const head = {
      key: 'v:none', disabled: true,
      main: `Vol. ${volume} isn't in the index`,
      detail: st.nearest.length ? 'nearest held:' : '',
    };
    return [head, ...st.nearest.map((n) => opt(n.volume, n.scans))];
  }

  function pageOptions(r, volume, pages, caseNames) {
    const out = [];
    for (const { page, cases } of pages) {
      for (const c of cases) {
        const text = citeText(r.abbr, volume, page);
        let detail = '';
        if (c.kind === 'cap') detail = caseNames?.[c.folder || volume]?.[c.caseFile] || '';
        else if (c.kind === 'alias') detail = 'parallel citation';
        else detail = 'CourtListener';
        out.push({
          key: `p:${r.slug}/${volume}/${page}-${c.seq || 1}`,
          main: text,
          detail,
          note: cases.length > 1 ? `${c.seq} of ${cases.length}` : '',
          text,
          target: { reporter: r.slug, volume, page, seq: c.kind === 'alias' ? null : c.seq },
        });
      }
    }
    return out;
  }

  async function update() {
    clearTimeout(timer);
    const mine = ++generation;
    const text = input.value;
    const q = parseQuery(text);
    const stage = stageOf(q);
    if (stage === 'none') {
      close();
      return;
    }
    let d;
    try {
      d = await loadData();
    } catch {
      return;
    }
    if (mine !== generation) return;
    if (stage === 'reporter') {
      const hits = rankReporters(d.index, q.reporter, d.count);
      render(reporterOptions(hits, q), hits.length ? plural(hits.length, 'reporter', 'reporters') : '', text);
      return;
    }
    const r = exactReporter(d.index, q.reporter, d.count) || rankReporters(d.index, q.reporter, d.count, 1)[0];
    if (!r) {
      close();
      return;
    }
    const volume = q.volume.replace(/-.*/, '');
    const st = volumeStatus(d.manifest, r.slug, volume);
    if (stage === 'volume' || !(st.held || st.aliasOnly) || !hasIdx(d.manifest)) {
      const opts = volumeOptions(r, volume, st);
      render(opts, st.held ? `Volume ${volume} is in the index` : opts[0].main, text);
      return;
    }
    let entries;
    try {
      entries = await volumeEntries(r.slug, volume, q.page.replace(/-.*/, ''));
    } catch {
      entries = null;
    }
    if (mine !== generation) return;
    const pages = pageSuggestions(entries || [], q.page);
    const said = pages.length ? plural(pages.length, 'page', 'pages') : '';
    const vkey = `${r.slug}/${volume}`;
    const folders = [...new Set(pages.flatMap((p) => p.cases.filter((c) => c.kind === 'cap').map((c) => c.folder || volume)))];
    const have = names?.key === vkey ? names.done : {};
    render(pageOptions(r, volume, pages, have), said, text);
    if (folders.length) addNames(mine, r, volume, pages, folders, said, text);
  }

  // Read the names of the cases on the pages shown, then show the pages again with them,
  // if the text hasn't changed meanwhile. Not waited on: the pages are usable without.
  async function addNames(mine, r, volume, pages, folders, said, text) {
    const vkey = `${r.slug}/${volume}`;
    if (names?.key !== vkey) {
      names?.abort.abort();
      names = { key: vkey, abort: new AbortController(), done: {} };
    }
    const current = names;
    const missing = folders.filter((f) => !current.done[f]);
    if (!missing.length) return;
    try {
      await Promise.all(missing.map(async (f) => {
        current.done[f] = await volumeCaseNames(r.slug, f, { signal: current.abort.signal });
      }));
    } catch {
      return;
    }
    if (mine !== generation || names !== current) return;
    render(pageOptions(r, volume, pages, current.done), said, text);
  }

  input.addEventListener('focus', () => { loadData().catch(() => {}); });

  input.addEventListener('input', () => {
    filled = null;
    clearTimeout(timer);
    timer = setTimeout(update, DEBOUNCE_MS);
  });

  // Move the active option by `step`, from outside the list onto its first or last.
  function move(step) {
    const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
    if (!enabled.length) return;
    const at = enabled.indexOf(active);
    const next = at < 0
      ? (step > 0 ? enabled[0] : enabled[enabled.length - 1])
      : enabled[(at + step + enabled.length) % enabled.length];
    setActive(next);
  }

  input.addEventListener('keydown', (e) => {
    const open = options.length > 0;
    // The list is for other text while the pause after typing hasn't ended.
    const fresh = shownFor === input.value;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      if (open && fresh) move(step);
      else update().then(() => move(step));
    } else if (e.key === 'Enter') {
      if (open && fresh && active >= 0) {
        e.preventDefault();
        e.stopImmediatePropagation();
        take(options[active]);
      } else {
        close();
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      }
    } else if (e.key === 'Tab') {
      close();
    }
  });

  input.addEventListener('blur', () => close());

  // A press on the list keeps the focus in the box (the top bar's editor closes on blur).
  listbox.addEventListener('mousedown', (e) => e.preventDefault());
  listbox.addEventListener('click', (e) => {
    const li = e.target.closest('[role="option"]');
    if (!li) return;
    const i = [...listbox.children].indexOf(li);
    if (i >= 0) take(options[i]);
  });

  return {
    // With no citation, the slug form until the reporter list says how the reporter is
    // written (a case that failed to open, from the page's hash).
    fill(cite, target) {
      const mine = prefill(cite, target);
      filled = mine;
      input.value = mine.text;
      close();
      if (cite || !mine.target || typeof mine.target.page !== 'number') return;
      loadData().then((d) => {
        const r = d.index.find((x) => x.slug === mine.target.reporter);
        if (!r || filled !== mine || input.value !== mine.text) return;
        mine.text = citeText(r.abbr, mine.target.volume, mine.target.page);
        input.value = mine.text;
      }).catch(() => {});
    },
    kept: () => keptTarget(filled, input.value),
    async parse() {
      try {
        const d = await loadData();
        return citeFromQuery(d.index, input.value, d.count);
      } catch {
        return null;
      }
    },
    close,
  };
}
