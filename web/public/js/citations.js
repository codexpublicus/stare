// Citation detection, through citare compiled to WASM. There is no fallback:
// if the WASM fails to load, detectCitations rejects with a WasmLoadError and
// callers show an error, not empty or degraded results.

import { fetchCached } from './cache.js';
import { hasVolume, indexPath, loadManifest, volumeCandidates } from './manifest.js';
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

export function guessSlug(reporter) {
  return reporter.toLowerCase().replace(/\./g, '').replace(/\s+/g, '');
}

/**
 * Whether stare.pub holds `volume` (as cited) of `slug`: the manifest lists the
 * folder, or lists parts of it when CAP split the volume over several folders
 * (a3d 138 and 138-2). `manifest` is injectable for tests.
 */
export async function checkAvailability(slug, volume, manifest = null) {
  const m = manifest || await loadManifest();
  return hasVolume(m, slug, volume) || Array.isArray(m.parts[slug]?.[String(volume)]);
}

// A volume folder's .bin, or null when it isn't indexed (a 404).
async function readBin(slug, volume) {
  const key = await indexPath(`${slug}/${volume}.bin`);
  try {
    return await fetchCached('bins', key, indexUrl(key));
  } catch (e) {
    if (e.message.startsWith('NOT_FOUND')) return null;
    throw e;
  }
}

/**
 * Whether a case starts at `page` in an indexed volume, from the volumes'
 * .bin files (a few KB, cached like the case viewer's). The folder as cited
 * is tried first, then, as resolve.js does, the other parts of a split volume
 * whose page range holds the page (138 A.3d 1012 is in folder a3d/138-2), as
 * the format 2 manifest lists them.
 * Null when that can't be told (a .bin or the WASM didn't load); callers then
 * treat the citation as resolvable, as they did before pages were checked.
 *
 * `deps` ({ manifest, readBin, lookup }) are injectable for tests, which can't
 * load the WASM or reach idx.stare.pub.
 */
export async function checkPage(slug, volume, page, deps = {}) {
  try {
    const p = parseInt(page, 10);
    const read = deps.readBin || readBin;
    let lookup = deps.lookup;
    if (!lookup) {
      const w = await loadWasm();
      lookup = (bin, pg) => w.lookup_page(bin, pg);
    }
    const cited = String(volume);
    const tried = [cited];
    let bin = await read(slug, cited);
    if (bin && lookup(bin, p) != null) return true;
    const m = deps.manifest || await loadManifest();
    // The legacy manifest can't name split volumes, and guessing "<n>-2" here,
    // as resolve.js does for one citation the reader asked for, would cost a
    // 404 for every page miss on the page. Until the format 2 manifest is up,
    // a citation into a second part shows as a held-volume miss, as it did
    // before #94.
    if (m.legacy) return false;
    for (const other of volumeCandidates(m, slug, cited, p)) {
      if (tried.includes(other)) continue;
      tried.push(other);
      bin = await read(slug, other);
      if (bin && lookup(bin, p) != null) return true;
    }
    return false;
  } catch {
    return null;
  }
}

/**
 * Availability for one detected citation, as the fields the renderers read:
 * - `slug`: the index slug when the volume is indexed, else null
 * - `volumeHeld`: the manifest lists the cited reporter and volume
 * - `resolvable`: held, and a case starts at the cited page (or that
 *   couldn't be checked)
 *
 * A held volume with no case at the page is not linked out: it may be an
 * index gap or a bad citation, and nothing here can tell which. Only a
 * volume stare.pub doesn't hold gets the outside links (citedCaseHtml).
 * `check` and `pageCheck` are injectable for tests, as in processCitations.
 */
export async function checkCitation(c, check = checkAvailability, pageCheck = checkPage) {
  const none = { ...c, slug: null, volumeHeld: false, resolvable: false };
  if (c.externalUrl) return none;
  // A blank page (`1 U.S. ___`) arrives as page: null and can't be looked
  // up, so it doesn't fall through to the slug guess below either.
  if (!c.page || !c.volume) return none;
  const slug = c.harvard_slug || (c.reporter ? guessSlug(c.reporter) : null);
  if (!slug) return none;
  const held = await check(slug, c.volume);
  if (!held) {
    // A guessed slug that isn't indexed is no slug at all.
    return { ...none, slug: c.harvard_slug ? slug : null };
  }
  const found = await pageCheck(slug, c.volume, c.page);
  return { ...c, slug, volumeHeld: true, resolvable: found !== false };
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
 * `check`, `detect` and `pageCheck` are injectable replacements for
 * `checkAvailability`, `detectCitations` and `checkPage`, used by tests to
 * stub the network fetch and the WASM, which Node can't load from the site
 * path. Rejects, with a WasmLoadError, if the WASM fails to load.
 */
export async function processCitations(caseData, check = checkAvailability, detect = detectCitations, pageCheck = checkPage) {
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

  const checks = deduped.map(c => checkCitation(c, check, pageCheck));

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
 * The outside links to offer for a citation to a volume stare.pub doesn't
 * hold: its `caseLinks` with a known source and an http(s) URL, in order.
 * Empty when the citation resolves here, links to a statute's text, or
 * cites a volume stare.pub holds (see heldVolumeMiss).
 */
export function caseLookupLinks(info) {
  if (!info || info.resolvable || info.volumeHeld || safeExternalUrl(info.externalUrl)) return [];
  return (info.caseLinks || []).filter(l =>
    l && Object.hasOwn(LOOKUP_SOURCES, l.source) && safeExternalUrl(l.url));
}

/**
 * "Not in stare.pub: may be at CourtListener", for a case link. "May be":
 * nothing checks that the case exists there (codexpublicus/citare#39).
 */
export function lookupLabel(link) {
  return `Not in stare.pub: may be at ${LOOKUP_SOURCES[link.source]}`;
}

/**
 * For a citation to a volume stare.pub holds where no case starts at the
 * cited page, the neutral note to show; else null. It claims nothing about
 * whether the case exists: an index gap and a bad citation look the same.
 */
export function heldVolumeMiss(info) {
  if (!info || info.resolvable || !info.volumeHeld || safeExternalUrl(info.externalUrl)) return null;
  return `No case found at this page in ${info.reporter || info.slug} vol. ${info.volume}`;
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
  const miss = heldVolumeMiss(info);
  if (miss) {
    return `<span class="cite-unresolved" title="${escapeHtml(miss)}">${inner}</span>`;
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
 * One entry in a cited-cases list (the case viewer's sidebar and /check),
 * and where the link-out decision is made: a case stare.pub holds links
 * here; a statute links to its text; a held volume with no case at the
 * cited page gets a neutral note and no outside link; a volume stare.pub
 * doesn't hold links to CourtListener and Google Scholar, labelled as
 * unverified.
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
  const miss = heldVolumeMiss(c);
  if (miss) {
    return `<div class="cited-case cited-case-lookup">
          <span class="cited-status no">&#10007;</span>
          <span class="cited-case-unresolved">${raw}</span>
          <span class="cited-lookup cited-miss">${escapeHtml(miss)}</span>
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
      const [slug, volume, pageStr] = parts;

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
