// Mock eyecite — regex-based citation detection
// Will be replaced by eyecite-rs WASM when available

// Common reporter abbreviations we might have indexed
// This is a rough heuristic — eyecite-rs will do this properly
const CITE_PATTERN = /(\d{1,4})\s+([A-Z][A-Za-z.]+(?:\s+\d+[a-z]{1,2})?(?:\.\d+[a-z]{0,2})?)\s+(\d{1,4})/g;

/**
 * Detect citations in text and return structured results.
 * Each result: { raw, volume, reporter, page, start, end }
 */
export function detectCitations(text) {
  const results = [];
  let match;
  const re = new RegExp(CITE_PATTERN.source, 'g');
  while ((match = re.exec(text)) !== null) {
    results.push({
      raw: match[0],
      volume: parseInt(match[1], 10),
      reporter: match[2].trim(),
      page: parseInt(match[3], 10),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return results;
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

  // Check availability for each (parallel, batched by reporter/volume)
  const checks = unique.map(async (c) => {
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
    if (info.resolvable) {
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
