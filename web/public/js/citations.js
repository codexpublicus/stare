// Citation detection, through citare compiled to WASM. There is no fallback:
// if the WASM fails to load, detectCitations rejects with a WasmLoadError and
// callers show an error, not empty or degraded results.

import { indexUrl } from './sources.js';
import { loadWasm } from './wasm.js';

// External URL generation is now in Rust (stare::cite::external_url)

// ---------------------------------------------------------------------------
// Detection — citare WASM
// ---------------------------------------------------------------------------

/**
 * Detect citations using citare WASM.
 * Returns array of { raw, type, harvard_slug, volume, page, reporter, year, start, end, externalUrl, caseLinks }
 *
 * `caseLinks` are the Rust `case_links`: `{ source, kind, url }` for places
 * outside stare.pub that may hold a case citation, offered only when the
 * index doesn't (see caseLookupLinks).
 *
 * `start`/`end` are Unicode code point offsets into `text`, matching
 * gorsuch-library's page viewer convention, not UTF-16 code units. Convert
 * to UTF-16 offsets before using them with String.prototype.slice or any
 * other native JS string indexing. renderTextHtml, below, highlights by
 * these offsets.
 */
export async function detectCitations(text) {
  const w = await loadWasm();
  const raw = JSON.parse(w.detect_citations(text));

  return raw.map(c => ({
    raw: c.matched_text,
    type: c.citation_type,
    harvard_slug: c.harvard_slug || null,
    volume: c.volume ? parseInt(c.volume, 10) : null,
    page: c.page || null,
    reporter: c.reporter || null,
    year: c.year || null,
    start: c.span[0],
    end: c.span[1],
    externalUrl: c.external_url || null,
    caseLinks: Array.isArray(c.case_links) ? c.case_links : [],
  }));
}

// ---------------------------------------------------------------------------
// Availability checking
// ---------------------------------------------------------------------------

let manifest = null;

async function loadManifest() {
  if (manifest) return manifest;
  try {
    const resp = await fetch(indexUrl('manifest.json'));
    if (resp.ok) {
      manifest = await resp.json();
    } else {
      manifest = {};
    }
  } catch {
    manifest = {};
  }
  return manifest;
}

export function guessSlug(reporter) {
  return reporter.toLowerCase().replace(/\./g, '').replace(/\s+/g, '');
}

export async function checkAvailability(slug, volume) {
  const m = await loadManifest();
  const volumes = m[slug];
  if (!volumes) return false;
  return volumes.includes(typeof volume === 'number' ? volume : parseInt(volume, 10));
}

// ---------------------------------------------------------------------------
// Process citations for a case
// ---------------------------------------------------------------------------

/**
 * Process all citations in a case's opinions.
 * Uses citare for detection, checks availability for each.
 *
 * Returns `{ unique, occurrencesByOpinion }`:
 * - `unique`: one entry per distinct raw citation string, with availability
 *   (`slug`, `resolvable`) resolved; the sidebar's list.
 * - `occurrencesByOpinion`: for each opinion in `casebody.opinions`, in
 *   order, every detected occurrence as `{ raw, start, end }`, where
 *   `start`/`end` are code point offsets into that opinion's `text`. The
 *   reader highlights from these, looking each `raw` up in `unique`.
 *
 * `check` and `detect` are injectable replacements for `checkAvailability`
 * and `detectCitations`, used by tests to stub the network fetch and the
 * WASM, which Node can't load from the site path. Rejects, with a
 * WasmLoadError, if the WASM fails to load.
 */
export async function processCitations(caseData, check = checkAvailability, detect = detectCitations) {
  const allCites = [];
  const occurrencesByOpinion = [];

  for (const op of caseData.casebody?.opinions || []) {
    const detected = await detect(op.text);
    allCites.push(...detected);
    occurrencesByOpinion.push(detected.map(({ raw, start, end }) => ({ raw, start, end })));
  }

  // Deduplicate by raw string
  const seen = new Set();
  const deduped = allCites.filter(c => {
    if (seen.has(c.raw)) return false;
    seen.add(c.raw);
    return true;
  });

  // Check availability for case citations with harvard_slug
  const checks = deduped.map(async (c) => {
    if (c.externalUrl) {
      return { ...c, slug: null, resolvable: false };
    }
    // A blank page (`1 U.S. ___`) arrives as page: null and can't be looked
    // up, so it doesn't fall through to the slug guess below either.
    if (!c.page) {
      return { ...c, slug: null, resolvable: false };
    }
    if (c.harvard_slug && c.volume) {
      const available = await check(c.harvard_slug, c.volume);
      return { ...c, slug: c.harvard_slug, resolvable: available };
    }
    // No slug — try guessing
    if (c.reporter && c.volume) {
      const slug = guessSlug(c.reporter);
      const available = await check(slug, c.volume);
      return { ...c, slug: available ? slug : null, resolvable: available };
    }
    return { ...c, slug: null, resolvable: false };
  });

  return { unique: await Promise.all(checks), occurrencesByOpinion };
}

// ---------------------------------------------------------------------------
// Highlighting (DOM-free, so node --test covers it)
// ---------------------------------------------------------------------------

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Escape text for use in HTML element content or a quoted attribute value.
 */
export function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

/**
 * Escape opinion text and wrap `[*123]` page markers.
 */
export function formatPlainText(text) {
  return escapeHtml(text).replace(
    /\[\*(\d+)\]/g,
    '<span class="page-marker">[*$1]</span>'
  );
}

/**
 * `url` if it is an http(s) URL, else null. External citation links, in
 * the reader and the sidebar, are emitted only for URLs this accepts.
 */
export function safeExternalUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

// Links that leave stare.pub open in a new tab and send no referrer, so the
// other site doesn't learn which page or brief the reader came from.
const OUTBOUND = 'target="_blank" rel="noopener noreferrer"';

/** Display names for the `source` of a case link (Rust `CaseLink`). */
export const LOOKUP_SOURCES = {
  courtlistener: 'CourtListener',
  google_scholar: 'Google Scholar',
};

/**
 * The outside links to offer for a citation stare.pub doesn't hold: its
 * `caseLinks` with a known source and an http(s) URL, in order. Empty when
 * the citation resolves here or links to a statute's text instead.
 */
export function caseLookupLinks(info) {
  if (!info || info.resolvable || safeExternalUrl(info.externalUrl)) return [];
  return (info.caseLinks || []).filter(l =>
    l && Object.hasOwn(LOOKUP_SOURCES, l.source) && safeExternalUrl(l.url));
}

/** "Not in stare.pub: find on CourtListener", for a case link. */
export function lookupLabel(link) {
  return `Not in stare.pub: find on ${LOOKUP_SOURCES[link.source]}`;
}

/**
 * Markup for one citation occurrence. `inner` is the already formatted
 * citation text; `info` is the citation's entry from processCitations.
 */
function citationHtml(raw, inner, info) {
  const externalUrl = safeExternalUrl(info.externalUrl);
  if (externalUrl) {
    return `<a class="cite-link cite-external" href="${escapeHtml(externalUrl)}" ${OUTBOUND} title="View on external site">${inner}</a>`;
  }
  if (info.resolvable) {
    const slug = escapeHtml(info.slug);
    const volume = escapeHtml(String(info.volume));
    const page = escapeHtml(String(info.page));
    return `<a class="cite-link" href="#${slug}/${volume}/${page}" data-slug="${slug}" data-volume="${volume}" data-page="${page}" title="${escapeHtml(raw)}">${inner}</a>`;
  }
  const [lookup] = caseLookupLinks(info);
  if (lookup) {
    return `<a class="cite-lookup" href="${escapeHtml(lookup.url)}" ${OUTBOUND} title="${escapeHtml(lookupLabel(lookup))}">${inner}</a>`;
  }
  return `<span class="cite-unresolved" title="Not yet indexed">${inner}</span>`;
}

/**
 * Sort citations for a cited-cases list: ones stare.pub holds, then
 * statutes linked to their text, then cases to look for elsewhere, then
 * the rest. Stable within each group.
 */
export function orderCitedCases(citations) {
  const rank = (c) => {
    if (c.resolvable) return 0;
    if (safeExternalUrl(c.externalUrl)) return 1;
    if (caseLookupLinks(c).length) return 2;
    return 3;
  };
  return citations
    .map((c, i) => ({ c, i, r: rank(c) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(({ c }) => c);
}

/**
 * One entry in a cited-cases list (the case viewer's sidebar and /check).
 * `caseHref(c)` gives the stare.pub link for a citation it holds; that link
 * opens in a new tab with `caseRel` (pass '' for none).
 */
export function citedCaseHtml(c, caseHref, caseRel = 'noopener') {
  const raw = escapeHtml(c.raw);
  if (c.resolvable) {
    const rel = caseRel ? ` rel="${escapeHtml(caseRel)}"` : '';
    return `<div class="cited-case">
          <span class="cited-status ok">&#10003;</span>
          <a class="cited-case-link" href="${escapeHtml(caseHref(c))}" target="_blank"${rel}>${raw}</a>
        </div>`;
  }
  const externalUrl = safeExternalUrl(c.externalUrl);
  if (externalUrl) {
    return `<div class="cited-case">
          <span class="cited-status ext">&#8599;</span>
          <a class="cited-case-link" href="${escapeHtml(externalUrl)}" ${OUTBOUND}>${raw}</a>
        </div>`;
  }
  const links = caseLookupLinks(c);
  if (links.length) {
    const [first, ...rest] = links;
    const more = rest.map(l =>
      ` <a class="cited-lookup-link" href="${escapeHtml(l.url)}" ${OUTBOUND}>or ${escapeHtml(LOOKUP_SOURCES[l.source])}</a>`).join('');
    return `<div class="cited-case cited-case-lookup">
          <span class="cited-status lookup">&#8599;</span>
          <span class="cited-case-unresolved">${raw}</span>
          <span class="cited-lookup"><a class="cited-lookup-link" href="${escapeHtml(first.url)}" ${OUTBOUND}>${escapeHtml(lookupLabel(first))}</a>${more}</span>
        </div>`;
  }
  return `<div class="cited-case">
          <span class="cited-status no">&#10007;</span>
          <span class="cited-case-unresolved">${raw}</span>
        </div>`;
}

/**
 * Render one paragraph as HTML, highlighting citations by offset.
 *
 * `text` is the paragraph; `paragraphStart` is its code point offset in the
 * text the occurrences were detected in. `occurrences` are `{ raw, start,
 * end }` with code point offsets into that same text; only those lying
 * wholly inside this paragraph are highlighted, and of overlapping ones the
 * earliest (then longest) wins. `citationMap` maps raw string to citation
 * info; an occurrence without an entry stays plain. `formatPlain` turns a
 * raw text segment into HTML.
 */
export function renderParagraphHtml(text, paragraphStart, occurrences, citationMap, formatPlain = formatPlainText) {
  // UTF-16 index of each code point boundary in the paragraph.
  const utf16At = [0];
  for (const ch of text) utf16At.push(utf16At[utf16At.length - 1] + ch.length);
  const length = utf16At.length - 1;

  const inside = (occurrences || [])
    .map(o => ({ ...o, start: o.start - paragraphStart, end: o.end - paragraphStart }))
    .filter(o => Number.isInteger(o.start) && Number.isInteger(o.end))
    .filter(o => o.start >= 0 && o.end <= length && o.start < o.end && citationMap?.get(o.raw))
    .sort((a, b) => a.start - b.start || b.end - a.end);

  let html = '';
  let cursor = 0;
  for (const o of inside) {
    if (o.start < cursor) continue;
    const from = utf16At[o.start];
    const to = utf16At[o.end];
    html += formatPlain(text.slice(utf16At[cursor], from));
    html += citationHtml(o.raw, formatPlain(text.slice(from, to)), citationMap.get(o.raw));
    cursor = o.end;
  }
  html += formatPlain(text.slice(utf16At[cursor]));
  return html;
}

/**
 * Split `text` into paragraphs on runs of newlines, drop blank ones, and
 * render each with renderParagraphHtml. Returns the paragraphs' inner HTML.
 * `occurrences` carry code point offsets into the whole of `text`; one that
 * crosses a paragraph break is left unhighlighted.
 */
export function renderTextHtml(text, occurrences, citationMap, formatPlain = formatPlainText) {
  const paragraphs = [];
  const breaks = /\n+/g;
  let from = 0;
  let codePoints = 0;
  for (;;) {
    const m = breaks.exec(text);
    const to = m ? m.index : text.length;
    const p = text.slice(from, to);
    if (p.trim()) {
      paragraphs.push(renderParagraphHtml(p, codePoints, occurrences, citationMap, formatPlain));
    }
    if (!m) break;
    // Newlines are one code point each, so the break adds its own length.
    codePoints += [...p].length + m[0].length;
    from = breaks.lastIndex;
  }
  return paragraphs;
}

// ---------------------------------------------------------------------------
// Hover previews
// ---------------------------------------------------------------------------

const previewCache = new Map();

export async function fetchCasePreview(slug, volume, page, resolveFn) {
  const key = `${slug}/${volume}/${page}`;
  if (previewCache.has(key)) return previewCache.get(key);

  const promise = (async () => {
    try {
      const result = await resolveFn(slug, volume, parseInt(page, 10), () => {});
      const c = result.caseData;
      return {
        name: c.name_abbreviation,
        date: c.decision_date,
        court: c.court?.name || '',
        cite: c.citations?.[0]?.cite || '',
      };
    } catch {
      return null;
    }
  })();

  previewCache.set(key, promise);
  const result = await promise;
  previewCache.set(key, result);
  return result;
}

/**
 * Set up hover tooltips and click-to-open on citation links.
 * Resolvable citations open in a new tab. Hover shows preview tooltip.
 */
export function setupCiteHovers(container, resolveFn) {
  container.querySelectorAll('a.cite-link:not(.cite-external)').forEach(el => {
    let tooltipEl = null;
    let savedTitle = null;

    el.addEventListener('mouseenter', async () => {
      const hash = el.getAttribute('href');
      if (!hash || !hash.startsWith('#')) return;
      const parts = hash.slice(1).split('/');
      if (parts.length !== 3) return;
      const [slug, volStr, pageStr] = parts;
      const volume = parseInt(volStr, 10);

      // Suppress browser tooltip while our custom one is showing
      savedTitle = el.getAttribute('title');
      el.removeAttribute('title');

      tooltipEl = createTooltip(el);
      tooltipEl.innerHTML = `<span class="spinner"></span> Loading...`;

      const preview = await fetchCasePreview(slug, volume, pageStr, resolveFn);
      if (!tooltipEl) return;

      if (preview) {
        tooltipEl.innerHTML = `<div><strong>${esc(preview.name)}</strong><br><span style="opacity:0.7">${esc(preview.cite)} &mdash; ${esc(preview.date)}</span></div>`;
      } else {
        tooltipEl.innerHTML = 'Could not load preview';
      }
    });

    el.addEventListener('mouseleave', () => {
      if (tooltipEl) {
        tooltipEl.remove();
        tooltipEl = null;
      }
      // Restore title for accessibility
      if (savedTitle !== null) {
        el.setAttribute('title', savedTitle);
        savedTitle = null;
      }
    });

    // Click opens citation in new tab
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const href = el.getAttribute('href');
      if (href) {
        window.open(window.location.pathname + href, '_blank');
      }
    });
  });
}

function createTooltip(anchor) {
  const tip = document.createElement('div');
  tip.className = 'cite-tooltip';
  document.body.appendChild(tip);
  const rect = anchor.getBoundingClientRect();
  tip.style.left = rect.left + 'px';
  tip.style.top = (rect.bottom + 4) + 'px';
  return tip;
}

function esc(str) {
  if (!str) return '';
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}
