// Citation detection — uses citare WASM when available, regex fallback

let wasm = null;

async function getWasm() {
  if (!wasm) {
    const mod = await import('/wasm/stare_wasm.js');
    await mod.default();
    wasm = mod;
  }
  return wasm;
}

// External URL generation is now in Rust (stare::cite::external_url)

// ---------------------------------------------------------------------------
// Detection — citare WASM or regex fallback
// ---------------------------------------------------------------------------

/**
 * Detect citations using citare WASM.
 * Returns array of { raw, type, harvard_slug, volume, page, reporter, year, start, end, externalUrl? }
 *
 * `start`/`end` are Unicode code point offsets into `text`, matching
 * gorsuch-library's page viewer convention, not UTF-16 code units. Convert
 * to UTF-16 offsets before using them with String.prototype.slice or any
 * other native JS string indexing. renderTextHtml, below, highlights by
 * these offsets.
 */
export async function detectCitations(text) {
  try {
    const w = await getWasm();
    const json = w.detect_citations(text);
    const raw = JSON.parse(json);

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
    }));
  } catch (e) {
    console.warn('Citare WASM failed, falling back to regex:', e);
    return detectCitationsRegex(text);
  }
}

/**
 * Regex fallback — same patterns as before.
 */
const CASE_PATTERN = /(\d{1,4})\s+([A-Z][A-Za-z.]+(?:\s+\d+[a-z]{1,2})?(?:\.\d+[a-z]{0,2})?)\s+(\d{1,4})/g;

export function detectCitationsRegex(text) {
  const results = [];
  let match;
  const re = new RegExp(CASE_PATTERN.source, 'g');
  while ((match = re.exec(text)) !== null) {
    results.push({
      raw: match[0],
      type: 'case',
      harvard_slug: null,
      volume: parseInt(match[1], 10),
      page: match[3],
      reporter: match[2].trim(),
      // match.index and match[0].length are UTF-16 code unit offsets (JS
      // regex's native unit). Convert to Unicode code point offsets so this
      // fallback path agrees with the WASM path's span, above.
      start: codePointOffset(text, match.index),
      end: codePointOffset(text, match.index + match[0].length),
      externalUrl: null,
    });
  }
  return results;
}

/**
 * Convert a UTF-16 code unit offset (a native JS string index) to a Unicode
 * code point offset. Spreading a string iterates by code point, not code
 * unit, so this is a correct, if not the fastest, conversion.
 */
export function codePointOffset(text, utf16Index) {
  return [...text.slice(0, utf16Index)].length;
}

// ---------------------------------------------------------------------------
// Availability checking
// ---------------------------------------------------------------------------

let manifest = null;

async function loadManifest() {
  if (manifest) return manifest;
  try {
    const resp = await fetch('https://idx.stare.pub/manifest.json');
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
 * `check` is an injectable replacement for `checkAvailability`, used by
 * tests to stub availability lookups without a network fetch.
 */
export async function processCitations(caseData, check = checkAvailability) {
  const allCites = [];
  const occurrencesByOpinion = [];

  for (const op of caseData.casebody?.opinions || []) {
    const detected = await detectCitations(op.text);
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
    if (c.harvard_slug && c.volume && c.page) {
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

/**
 * Markup for one citation occurrence. `inner` is the already formatted
 * citation text; `info` is the citation's entry from processCitations.
 */
function citationHtml(raw, inner, info) {
  const externalUrl = safeExternalUrl(info.externalUrl);
  if (externalUrl) {
    return `<a class="cite-link cite-external" href="${escapeHtml(externalUrl)}" target="_blank" rel="noopener" title="View on external site">${inner}</a>`;
  }
  if (info.resolvable) {
    const slug = escapeHtml(info.slug);
    const volume = escapeHtml(String(info.volume));
    const page = escapeHtml(String(info.page));
    return `<a class="cite-link" href="#${slug}/${volume}/${page}" data-slug="${slug}" data-volume="${volume}" data-page="${page}" title="${escapeHtml(raw)}">${inner}</a>`;
  }
  return `<span class="cite-unresolved" title="Not yet indexed">${inner}</span>`;
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
