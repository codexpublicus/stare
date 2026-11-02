// One box, one button (D163, #296): the landing's box, the top bar's and the search page's
// each take a citation or words to search for, and route them themselves. A citation opens
// in the reader; anything else goes to the full-text search.
//
// Deciding costs nothing up front: `routeOf` is a few regular expressions over the text,
// run as it is typed, and it sets the button's label ("Open citation" or "Search"). Only
// text it reads as a citation waits for the parser (the reader's WASM, through resolve.js)
// when the box is submitted, and the parser has the last word: a citation it can't read
// goes to the search after all. Text the expressions read as words never loads the parser.
//
// Each result offers the other way: a case opened from typed text says "Search for this text
// instead", and a search for text shaped like a citation asks "Did you mean 347 U.S. 483?".
// The text a box sent the reader, or a citation the parser turned down, crosses to the other
// page through sessionStorage (`handOff`, `takeHandOff`, `markNotCitation`), so a link to
// either page shares neither.

// A reporter as typed after the volume: `U.S.`, `A.2d`, `F. Supp. 2d`, `N.Y.S.2d`, `US`.
const REPORTER = String.raw`[A-Za-z][A-Za-z0-9.' &]{0,40}?`;
// A page: digits, or a labelled page (`xxix`, `Supp. 1`, #154).
const PAGE = String.raw`(?:\d{1,5}|[ivxlcdm]{1,8}|supp\.?\s?\d{1,3})`;
// A whole box that is a citation: `347 U.S. 483`, `31 A.2d 647, 650 (1943)`.
const CITED = new RegExp(String.raw`^(\d{1,4}\s+${REPORTER}\s+${PAGE})(?:\s*,\s*\d{1,5}(?:\s*[-–]\s*\d{1,5})?)?(?:\s*\([^)]{0,40}\))?$`, 'i');
// The reader's slug form: `a2d 31 647`, `a2d/31/647-01`, `misc 32 426`.
const SLUG = /^[a-z][a-z0-9-]{0,30}[\s/]+\d{1,4}(?:-\d+)?[\s/]+\d{1,5}(?:-\d{1,2})?$/i;
// A reporter typed first by its abbreviation, which the typeahead reads (`Misc. 32 426`).
const REPORTER_FIRST = /^[A-Za-z][A-Za-z0-9.' &]{0,30}?\.\s*\d{1,4}\s+\d{1,5}$/;
// A neutral citation written with dashes: `2019-Ohio-1234`.
const NEUTRAL = /^\d{4}-[A-Za-z]{2,12}-\d{1,6}$/;
// A citation inside longer text, such as a case name before it (`Brown v. Board of
// Education, 347 U.S. 483 (1954)`). The reporter has to look like one here, abbreviated with
// periods or in capitals, so that `the 5 Justices in 1954` stays words.
const EMBEDDED = /(?:^|[\s,;(])(\d{1,4}\s+(?:[A-Z][A-Za-z0-9']*\.(?:\s?[A-Za-z0-9']+\.?){0,4}|[A-Z]{1,5}(?:\s?\d[a-z]{1,2})?)\s+\d{1,5})(?=$|[\s,;.)])/;
// Statutes and regulations read like citations, but none opens a case.
const STATUTE = /\b(?:U\.?\s?S\.?\s?C|C\.?\s?F\.?\s?R|Stat)\b/i;

/**
 * The citation in `text` as the expressions read it (`347 U.S. 483`, without a pin cite or
 * parenthetical), or null when the text reads as words. A cheap guess, not a parse.
 */
export function citationIn(text) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (!t || !/\d/.test(t) || t.length > 300) return null;
  let found = null;
  const m = t.match(CITED);
  if (m) found = m[1];
  else if (SLUG.test(t) || REPORTER_FIRST.test(t) || NEUTRAL.test(t)) found = t;
  else found = t.match(EMBEDDED)?.[1] ?? null;
  if (found && STATUTE.test(found)) return null;
  return found;
}

/** Whether a query reads like a citation. */
export const looksLikeCitation = (text) => citationIn(text) !== null;

/** Where a box sends `text`: 'cite' (the reader, once the parser agrees), 'search', or '' for nothing. */
export function routeOf(text) {
  if (!String(text ?? '').trim()) return '';
  return looksLikeCitation(text) ? 'cite' : 'search';
}

/** The search page's URL for `text`. */
export const searchHref = (text) => `/search/?q=${encodeURIComponent(String(text).trim())}`;

// What a screen reader hears when the route changes, once typing pauses.
const SPOKEN = { cite: 'Enter opens the citation', search: 'Enter searches' };
// How long typing has to pause before a changed route is announced.
export const ANNOUNCE_AFTER_MS = 700;

/**
 * Keep `button`'s label on the route `input`'s text takes. The button holds both labels,
 * one over the other (`.route-btn`, `data-goes`), so it is always as wide as the longer and
 * a change moves nothing; the hidden one is `visibility: hidden`, out of its accessible name.
 * `live`, a polite live region, hears the route only when it changes and typing has paused,
 * never on each keystroke, and never for text put in the box rather than typed.
 * Returns `{ update }` for text set from script.
 */
export function attachRouteLabel(input, button, live, { delay = ANNOUNCE_AFTER_MS } = {}) {
  let spoken = routeOf(input.value) || 'search';
  let timer = null;
  const show = (route) => { button.dataset.goes = route || 'search'; };
  const update = () => {
    clearTimeout(timer);
    const route = routeOf(input.value);
    show(route);
    spoken = route || spoken;
  };
  input.addEventListener('input', () => {
    const route = routeOf(input.value);
    show(route);
    clearTimeout(timer);
    if (!live || !route) return;
    timer = setTimeout(() => {
      if (route === spoken || document.activeElement !== input) return;
      spoken = route;
      live.textContent = SPOKEN[route];
    }, delay);
  });
  show(routeOf(input.value));
  return { update };
}

const HANDOFF_KEY = 'stare-box-handoff';
const NOT_CITE_KEY = 'stare-not-citation';

function store(key, value) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch { /* no storage: the other page just offers nothing */ }
}

function stored(key) {
  try {
    return JSON.parse(sessionStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

/** Before leaving for the reader at `hash`: the text that named the case, for its switch-back link. */
export const handOff = (hash, text) => store(HANDOFF_KEY, { hash, text: String(text).trim() });

/** The text a box sent to the reader at `hash`, once; null when it came another way. */
export function takeHandOff(hash) {
  const h = stored(HANDOFF_KEY);
  if (!h) return null;
  store(HANDOFF_KEY, null);
  return h.hash === hash && h.text ? h.text : null;
}

/** The parser turned `text` down: its search doesn't ask "Did you mean". */
export const markNotCitation = (text) => store(NOT_CITE_KEY, String(text).trim());

/** Whether the parser turned `text` down in this tab. */
export const isNotCitation = (text) => stored(NOT_CITE_KEY) === String(text).trim();

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The reader's note over a case a box opened from `text`: what it was opened as, and a link
 * to search for the text instead.
 */
export function routeNoteHtml(text) {
  const t = String(text).trim();
  return `<p class="route-note">Opened “${escapeHtml(t)}” as a citation. `
    + `<a class="route-note-search" href="${escapeHtml(searchHref(t))}">Search for this text instead</a></p>`;
}
