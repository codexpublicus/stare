// A line or two of each search result's own text under its card, around the first passage
// with the query's words (D171, #313), read client-side without the reader's WASM.
//
// Loaded by searchpage.js once a page of results is on screen. For each card as it comes
// into view (IntersectionObserver, 200px below the fold), its route (`a2d/142/148-02`) is
// looked up in the volume's unified index, read in JS (idx.js's idxEntriesJs, the
// reader's idx files and cache), then:
// - a CAP case: its JSON entry by the line's zip span (D180), one Range request to
//   data.stare.pub inflated with DecompressionStream (zipspan.js), and kept in the cache;
//   a line without a span, or a server that answers the range with the whole zip, gets no
//   snippet rather than a zip download;
// - a CourtListener record: its gzipped JSON from data.stare.pub/cl/, as the reader
//   fetches it, parsed here (no WASM).
// A route whose volume the index manifest doesn't list is skipped without a request.
//
// The passage is found with the search's own folding (searchquery.js's foldedWords, which
// searchquery.test.js checks against the vendored tokenize.mjs) against the client's
// `tokens` for the query, so a word is marked exactly when the search would have matched
// it. At most CONCURRENCY cases are read at once; a new query cancels the queue and aborts
// the range reads under way. Texts are kept for the page's life. A read that fails leaves
// the line empty: no error, no console message.

import { fetchCached, gunzip } from './cache.js';
import { idxEntriesJs } from './idx.js';
import { foldedInto, hasIdx, holdsVolume, hasAliasVolume, loadManifest } from './manifest.js';
import { pageKey } from './pagekey.js';
import { foldedWords, nameSegments } from './searchquery.js';
import { clRecordPath, clRecordUrl, zipUrl } from './sources.js';
import { parseSpan, readSpanText, spanKey } from './zipspan.js';

export const CONCURRENCY = 6;
// Characters shown before the first marked word, and in all.
const LEAD = 40;
const SPAN = 260;
// How far apart (in characters) the query's words may be and still count as one passage.
const WINDOW = 300;
const TIGHT = 60;

/**
 * A card's route as `{ reporter, volume, page, seq }`, or null: `a2d/142/148-02` is a2d
 * vol. 142 page 148, the second case there; `cal-app-4th/15/supp.%201` a labelled page.
 */
export function parseRoute(route) {
  const m = /^([a-z0-9][a-z0-9-]*)\/(\d[0-9a-z-]*)\/(.+)$/.exec(String(route ?? ''));
  if (!m) return null;
  let rest;
  try {
    rest = decodeURIComponent(m[3]);
  } catch {
    return null;
  }
  const s = /^(.+?)(?:-(\d+))?$/.exec(rest);
  const page = pageKey(s[1]);
  if (page === null) return null;
  return { reporter: m[1], volume: m[2], page, seq: s[2] ? parseInt(s[2], 10) : null };
}

/** A case's text as the search reads it, opinions first, then the head matter. */
export function caseTexts(caseData) {
  const body = caseData?.casebody?.data ?? caseData?.casebody ?? {};
  const out = [];
  for (const o of Array.isArray(body.opinions) ? body.opinions : []) {
    if (typeof o?.text === 'string' && o.text.trim()) out.push(o.text);
  }
  if (typeof body.head_matter === 'string' && body.head_matter.trim()) out.push(body.head_matter);
  return out;
}

// The words of `text` with their offsets and folded tokens, as nameSegments cuts them.
const WORD = /[\p{L}\p{N}](?:[\p{L}\p{N}'’.]|,(?=\d{3}))*/gu;

/**
 * The passage to show for `tokens` (the client's tokens for the query) in `texts`: the
 * first run of at most WINDOW characters holding every token, else the first holding the
 * most of them, as `{ text, start, found, of }`: the excerpt, cut at word boundaries with
 * an ellipsis where it was cut, and how many of the tokens it holds. Null when no token
 * is in any text.
 */
export function findPassage(texts, tokens) {
  const want = [...new Set(tokens)];
  if (!want.length) return null;
  let best = null;
  for (const text of texts) {
    // Hits: [offset, token], in order.
    const hits = [];
    for (const m of text.matchAll(WORD)) {
      for (const w of foldedWords(m[0].replace(/’/g, "'"))) {
        if (want.includes(w)) hits.push([m.index, w]);
      }
    }
    // The first tight run with every token: the earliest end, then the latest start that
    // still has them all, so the excerpt starts at the passage, not at a stray earlier hit.
    // A run within TIGHT characters (most of a phone's line) wins over an earlier, looser one.
    const count = new Map();
    let l = 0;
    let loose = null;
    for (let j = 0; j < hits.length; j++) {
      count.set(hits[j][1], (count.get(hits[j][1]) || 0) + 1);
      while (count.size === want.length && count.get(hits[l][1]) > 1) {
        count.set(hits[l][1], count.get(hits[l][1]) - 1);
        l++;
      }
      if (count.size === want.length) {
        const span = hits[j][0] - hits[l][0];
        if (span <= TIGHT) return excerpt({ text, at: hits[l][0], found: want.length }, want.length);
        if (span <= WINDOW && !loose) loose = { text, at: hits[l][0], found: want.length };
        count.delete(hits[l][1]);
        l++;
      }
    }
    if (loose && (!best || best.found < want.length)) best = loose;
    if (best?.found === want.length) continue;
    // Else the first run of WINDOW characters with the most of them.
    for (let i = 0; i < hits.length; i++) {
      const seen = new Set();
      for (let j = i; j < hits.length && hits[j][0] - hits[i][0] <= WINDOW; j++) seen.add(hits[j][1]);
      if (!best || seen.size > best.found) best = { text, at: hits[i][0], found: seen.size };
    }
  }
  return best ? excerpt(best, want.length) : null;
}

function excerpt({ text, at, found }, of) {
  let start = Math.max(0, at - LEAD);
  if (start > 0) {
    const sp = text.lastIndexOf(' ', at - 1);
    start = sp >= start - 20 && sp >= 0 ? sp + 1 : start;
    // A paragraph break just before the hit starts the excerpt there instead.
    const nl = text.lastIndexOf('\n', at - 1);
    if (nl >= start) start = nl + 1;
  }
  let end = Math.min(text.length, start + SPAN);
  if (end < text.length) {
    const sp = text.lastIndexOf(' ', end);
    if (sp > at) end = sp;
  }
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return { text: `${start > 0 ? '… ' : ''}${body}${end < text.length ? ' …' : ''}`, start, found, of };
}

// The case behind a route, as a function that reads its JSON (taking an AbortSignal);
// null when the index has nothing at the route or no way to read it in one request.
// `deps` ({ manifest, idxEntries, readSpan, readRecord }) are injectable for tests.
export async function caseReader(route, deps = {}) {
  const r = parseRoute(route);
  if (!r) return null;
  const m = deps.manifest || await loadManifest();
  if (m.unreachable || !hasIdx(m)) return null;
  // Only volumes the index lists; anything else would be a request for a 404.
  if (!holdsVolume(m, r.reporter, r.volume) && !hasAliasVolume(m, r.reporter, r.volume)) return null;
  const number = foldedInto(m, r.reporter, r.volume);
  let entries = await (deps.idxEntries || idxEntriesJs)(r.reporter, number || r.volume, r.page);
  if (!entries?.length) return null;
  if (number) entries = entries.filter((e) => e.source === 'cap' && !e.reporter && e.folder === r.volume);
  const first = entries[0];
  if (!first) return null;
  if (first.source === 'cap') {
    let pick = first;
    if (!first.reporter && r.seq) {
      const folder = first.folder || null;
      const same = entries.filter((e) => e.source === 'cap' && !e.reporter && (e.folder || null) === folder);
      pick = same.find((e) => parseInt(e.case_file.slice(e.case_file.lastIndexOf('-') + 1), 10) === r.seq) || first;
    }
    const span = parseSpan(pick.zip);
    if (!span) return null;
    const reporter = pick.reporter || r.reporter;
    const folder = pick.folder || r.volume;
    const read = deps.readSpan || readSpanText;
    return async (signal) => {
      const got = await read(zipUrl(reporter, folder), span, { signal, key: spanKey(m.base, reporter, folder, span) });
      return got.whole ? null : JSON.parse(got.text);
    };
  }
  const cl = entries.filter((e) => e.source === 'cl');
  const n = r.seq && r.seq <= cl.length ? r.seq : 1;
  return async () => (deps.readRecord || readRecord)(cl[n - 1]);
}

// A CourtListener record, as the reader caches it (cl.js), parsed without the WASM.
async function readRecord(entry) {
  const gz = await fetchCached('zips', clRecordPath(entry.cluster_id, entry.hash), clRecordUrl(entry.cluster_id, entry.hash));
  return JSON.parse(new TextDecoder().decode(await gunzip(gz)));
}

// Each route's texts, read once a page: a promise of the texts, or of null.
const texts = new Map();

function readTexts(route, signal) {
  if (!texts.has(route)) {
    const p = (async () => {
      const read = await caseReader(route);
      if (!read) return null;
      const data = await read(signal);
      return data ? caseTexts(data) : null;
    })();
    texts.set(route, p);
    // An aborted or failed read may be tried again by a later query.
    p.catch(() => texts.delete(route));
  }
  return texts.get(route);
}

function render(el, passage, tokens) {
  const parts = [];
  for (const seg of nameSegments(passage.text, tokens)) {
    if (seg.hit) {
      const mk = document.createElement('mark');
      mk.textContent = seg.text;
      parts.push(mk);
    } else {
      parts.push(seg.text);
    }
  }
  el.replaceChildren(...parts);
  el.classList.add('search-card-snippet-on');
}

/**
 * Snippets for one result set: `items` are `{ el, route }` (the card's empty snippet line
 * and its route), `tokens` the client's tokens for the query. Returns `{ cancel }`, which a
 * new query calls. `onEvent(name, detail)` reports progress, for measurement.
 */
export function attachSnippets(items, tokens, { onEvent = () => {} } = {}) {
  const ctl = new AbortController();
  const queue = [];
  let running = 0;
  let cancelled = false;
  const pending = new Set(items.map((it) => it.el));

  const pump = () => {
    while (!cancelled && running < CONCURRENCY && queue.length) {
      const it = queue.shift();
      running++;
      readTexts(it.route, ctl.signal)
        .then((t) => {
          if (cancelled) return;
          const p = t && findPassage(t, tokens);
          if (p) render(it.el, p, tokens);
          onEvent(p ? 'shown' : 'empty', { route: it.route, found: p?.found ?? 0, of: p?.of ?? tokens.length });
        }, () => { if (!cancelled) onEvent('failed', { route: it.route }); })
        .finally(() => { running--; pump(); });
    }
  };

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting || !pending.has(e.target)) continue;
      pending.delete(e.target);
      io.unobserve(e.target);
      const it = items.find((x) => x.el === e.target);
      if (it?.route && tokens.length) queue.push(it);
      else onEvent('empty', { route: it?.route });
    }
    pump();
  }, { rootMargin: '0px 0px 200px 0px' });
  for (const it of items) io.observe(it.el);

  return {
    cancel() {
      cancelled = true;
      queue.length = 0;
      io.disconnect();
      ctl.abort();
    },
  };
}
