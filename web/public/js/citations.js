// Mock eyecite — regex-based citation detection
// Will be replaced by citare WASM when integrated

// Case law: "31 A.2d 647", "138 U.S. 529"
const CASE_PATTERN = /(\d{1,4})\s+([A-Z][A-Za-z.]+(?:\s+\d+[a-z]{1,2})?(?:\.\d+[a-z]{0,2})?)\s+(\d{1,4})/g;

// Statutes: "42 U.S.C. § 1983", "42 U.S.C. 1983", "28 U.S.C. §§ 1331"
const USC_PATTERN = /(\d{1,2})\s+U\.?S\.?C\.?(?:\.?A\.?)?\s*(?:§+\s*)?(\d[\d.a-z-]*)/gi;

// Statutes at Large: "56 Stat. 195"
const STAT_PATTERN = /(\d{1,3})\s+Stat\.\s+(\d{1,5})/g;

// CFR: "40 C.F.R. § 122.1"
const CFR_PATTERN = /(\d{1,2})\s+C\.?F\.?R\.?\s*(?:§+\s*)?(\d[\d.]*)/gi;

/**
 * Detect all citations in text. Returns structured results.
 * Each: { raw, type, volume, reporter, page, start, end, externalUrl? }
 */
export function detectCitations(text) {
  const results = [];

  // Case citations
  let match;
  const caseRe = new RegExp(CASE_PATTERN.source, 'g');
  while ((match = caseRe.exec(text)) !== null) {
    results.push({
      raw: match[0],
      type: 'case',
      volume: parseInt(match[1], 10),
      reporter: match[2].trim(),
      page: parseInt(match[3], 10),
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  // U.S. Code
  const uscRe = new RegExp(USC_PATTERN.source, 'gi');
  while ((match = uscRe.exec(text)) !== null) {
    const title = match[1];
    const section = match[2];
    results.push({
      raw: match[0],
      type: 'statute',
      volume: parseInt(title, 10),
      reporter: 'U.S.C.',
      page: section,
      start: match.index,
      end: match.index + match[0].length,
      externalUrl: `https://www.law.cornell.edu/uscode/text/${title}/${section}`,
    });
  }

  // Statutes at Large
  const statRe = new RegExp(STAT_PATTERN.source, 'g');
  while ((match = statRe.exec(text)) !== null) {
    results.push({
      raw: match[0],
      type: 'statute',
      volume: parseInt(match[1], 10),
      reporter: 'Stat.',
      page: match[2],
      start: match.index,
      end: match.index + match[0].length,
      externalUrl: `https://www.govinfo.gov/content/pkg/STATUTE-${match[1]}/pdf/STATUTE-${match[1]}-Pg${match[2]}.pdf`,
    });
  }

  // CFR
  const cfrRe = new RegExp(CFR_PATTERN.source, 'gi');
  while ((match = cfrRe.exec(text)) !== null) {
    const title = match[1];
    const section = match[2];
    results.push({
      raw: match[0],
      type: 'regulation',
      volume: parseInt(title, 10),
      reporter: 'C.F.R.',
      page: section,
      start: match.index,
      end: match.index + match[0].length,
      externalUrl: `https://www.ecfr.gov/current/title-${title}/section-${section}`,
    });
  }

  // Sort by position, deduplicate overlapping spans
  results.sort((a, b) => a.start - b.start);
  return deduplicateSpans(results);
}

/**
 * Remove overlapping citations, keeping the longer match.
 */
function deduplicateSpans(results) {
  const filtered = [];
  let lastEnd = -1;
  for (const r of results) {
    if (r.start >= lastEnd) {
      filtered.push(r);
      lastEnd = r.end;
    } else if (r.end - r.start > (filtered[filtered.length - 1]?.end - filtered[filtered.length - 1]?.start || 0)) {
      filtered[filtered.length - 1] = r;
      lastEnd = r.end;
    }
  }
  return filtered;
}

/**
 * Attempt to guess a slug from a reporter abbreviation.
 * e.g., "A.2d" → "a2d", "U.S." → "us", "App.D.C." → "appdc"
 * This is a rough heuristic — eyecite-rs will handle this properly.
 */
export function guessSlug(reporter) {
  return reporter
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+/g, '');
}

/**
 * Check if we have an index for a given reporter/volume.
 * Returns true if the .bin file exists (non-404).
 * Results are cached to avoid repeated HEAD requests.
 */
const availabilityCache = new Map();

export async function checkAvailability(reporter, volume) {
  const slug = guessSlug(reporter);
  const key = `${slug}/${volume}`;
  if (availabilityCache.has(key)) return availabilityCache.get(key);

  try {
    const resp = await fetch(`/data/${slug}/${volume}.bin`, { method: 'HEAD' });
    const available = resp.ok;
    availabilityCache.set(key, available ? slug : null);
    return available ? slug : null;
  } catch {
    availabilityCache.set(key, null);
    return null;
  }
}

/**
 * Process all citations in a case's opinions.
 * Returns { citations: [...], byReporter: Map } with availability info.
 */
export async function processCitations(caseData) {
  const allCites = [];

  for (const op of caseData.casebody?.opinions || []) {
    const detected = detectCitations(op.text);
    allCites.push(...detected);
  }

  // Deduplicate by raw string
  const seen = new Set();
  const unique = allCites.filter(c => {
    if (seen.has(c.raw)) return false;
    seen.add(c.raw);
    return true;
  });

  // Check availability: statutes/regulations already have external URLs,
  // case citations need a .bin check
  const checks = unique.map(async (c) => {
    if (c.externalUrl) {
      return { ...c, slug: null, resolvable: false };
    }
    const slug = await checkAvailability(c.reporter, c.volume);
    return { ...c, slug, resolvable: slug !== null };
  });

  const resolved = await Promise.all(checks);
  return resolved;
}

/**
 * Highlight citations in a text string.
 * Returns HTML with citation spans (blue for resolvable, gray for not).
 * `citationMap` is a Map of raw citation string → { slug, volume, page, resolvable }
 */
export function highlightCitations(escapedText, citationMap) {
  let result = escapedText;

  // Sort by length descending to avoid partial replacements
  const entries = [...citationMap.entries()].sort((a, b) => b[0].length - a[0].length);

  for (const [raw, info] of entries) {
    const escaped = escapeRegex(raw);
    const re = new RegExp(escaped, 'g');
    if (info.externalUrl) {
      // Statute/regulation — link to external source
      result = result.replace(re,
        `<a class="cite-link cite-external" href="${info.externalUrl}" target="_blank" rel="noopener" title="View on external site">${raw}</a>`
      );
    } else if (info.resolvable) {
      result = result.replace(re,
        `<a class="cite-link" href="#${info.slug}/${info.volume}/${info.page}" title="${raw}">${raw}</a>`
      );
    } else {
      result = result.replace(re,
        `<span class="cite-unresolved" title="Not yet indexed">${raw}</span>`
      );
    }
  }

  return result;
}

/**
 * Lazy-load case preview (title, date, court) for a citation on hover.
 * Uses the resolve pipeline: fetch .bin → lookup page → fetch .zip → extract case.
 * Results cached per citation so subsequent hovers are instant.
 */
const previewCache = new Map();

export async function fetchCasePreview(slug, volume, page, resolveFn, extractFn) {
  const key = `${slug}/${volume}/${page}`;
  if (previewCache.has(key)) return previewCache.get(key);

  // Mark as loading to prevent duplicate fetches
  const promise = (async () => {
    try {
      const result = await resolveFn(slug, volume, page, () => {});
      const c = result.caseData;
      const preview = {
        name: c.name_abbreviation,
        date: c.decision_date,
        court: c.court?.name || '',
        cite: c.citations?.[0]?.cite || '',
      };
      return preview;
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
 * Set up hover tooltips on cite-link elements.
 * Call this after rendering the reader content.
 */
export function setupCiteHovers(container, resolveFn, extractFn) {
  container.querySelectorAll('a.cite-link').forEach(el => {
    let tooltipEl = null;

    el.addEventListener('mouseenter', async () => {
      const hash = el.getAttribute('href');
      if (!hash || !hash.startsWith('#')) return;
      const parts = hash.slice(1).split('/');
      if (parts.length !== 3) return;
      const [slug, volStr, pageStr] = parts;
      const volume = parseInt(volStr, 10);
      const page = parseInt(pageStr, 10);

      // Show loading tooltip with spinner
      tooltipEl = createTooltip(el);
      tooltipEl.innerHTML = `<span class="spinner"></span> Loading...`;

      const preview = await fetchCasePreview(slug, volume, page, resolveFn, extractFn);
      if (!tooltipEl) return; // mouse already left

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

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
