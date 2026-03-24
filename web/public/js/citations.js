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

// ---------------------------------------------------------------------------
// External link templates for statutes/regulations
// ---------------------------------------------------------------------------

const EXTERNAL_LINKS = {
  'U.S.C.': (vol, page) => `https://www.law.cornell.edu/uscode/text/${vol}/${page}`,
  'Stat.': (vol, page) => `https://www.govinfo.gov/content/pkg/STATUTE-${vol}/pdf/STATUTE-${vol}-Pg${page}.pdf`,
  'C.F.R.': (vol, page) => `https://www.ecfr.gov/current/title-${vol}/section-${page}`,
};

function getExternalUrl(reporter, volume, page) {
  for (const [key, urlFn] of Object.entries(EXTERNAL_LINKS)) {
    if (reporter && reporter.includes(key.replace(/\./g, ''))) {
      return urlFn(volume, page);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Detection — citare WASM or regex fallback
// ---------------------------------------------------------------------------

/**
 * Detect citations using citare WASM.
 * Returns array of { raw, type, harvard_slug, volume, page, reporter, year, start, end, externalUrl? }
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
      externalUrl: c.harvard_slug ? null : getExternalUrl(c.reporter, c.volume, c.page),
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

function detectCitationsRegex(text) {
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
      start: match.index,
      end: match.index + match[0].length,
      externalUrl: null,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Availability checking
// ---------------------------------------------------------------------------

const availabilityCache = new Map();

export function guessSlug(reporter) {
  return reporter.toLowerCase().replace(/\./g, '').replace(/\s+/g, '');
}

export async function checkAvailability(slug, volume) {
  const key = `${slug}/${volume}`;
  if (availabilityCache.has(key)) return availabilityCache.get(key);

  try {
    const indexUrl = 'https://idx.stare.pub';
    const resp = await fetch(`${indexUrl}/${slug}/${volume}.bin`, { method: 'HEAD' });
    availabilityCache.set(key, resp.ok);
    return resp.ok;
  } catch {
    availabilityCache.set(key, false);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Process citations for a case
// ---------------------------------------------------------------------------

/**
 * Process all citations in a case's opinions.
 * Uses citare for detection, checks availability for each.
 */
export async function processCitations(caseData) {
  const allCites = [];

  for (const op of caseData.casebody?.opinions || []) {
    const detected = await detectCitations(op.text);
    allCites.push(...detected);
  }

  // Deduplicate by raw string
  const seen = new Set();
  const unique = allCites.filter(c => {
    if (seen.has(c.raw)) return false;
    seen.add(c.raw);
    return true;
  });

  // Check availability for case citations with harvard_slug
  const checks = unique.map(async (c) => {
    if (c.externalUrl) {
      return { ...c, slug: null, resolvable: false };
    }
    if (c.harvard_slug && c.volume && c.page) {
      const available = await checkAvailability(c.harvard_slug, c.volume);
      return { ...c, slug: c.harvard_slug, resolvable: available };
    }
    // No slug — try guessing
    if (c.reporter && c.volume) {
      const slug = guessSlug(c.reporter);
      const available = await checkAvailability(slug, c.volume);
      return { ...c, slug: available ? slug : null, resolvable: available };
    }
    return { ...c, slug: null, resolvable: false };
  });

  return Promise.all(checks);
}

// ---------------------------------------------------------------------------
// Highlighting
// ---------------------------------------------------------------------------

/**
 * Highlight citations in escaped text.
 * citationMap: Map of raw string → { slug, volume, page, resolvable, externalUrl }
 */
export function highlightCitations(escapedText, citationMap) {
  let result = escapedText;

  const entries = [...citationMap.entries()].sort((a, b) => b[0].length - a[0].length);

  for (const [raw, info] of entries) {
    const escaped = escapeRegex(raw);
    const re = new RegExp(escaped, 'g');
    if (info.externalUrl) {
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

export function setupCiteHovers(container, resolveFn) {
  container.querySelectorAll('a.cite-link:not(.cite-external)').forEach(el => {
    let tooltipEl = null;

    el.addEventListener('mouseenter', async () => {
      const hash = el.getAttribute('href');
      if (!hash || !hash.startsWith('#')) return;
      const parts = hash.slice(1).split('/');
      if (parts.length !== 3) return;
      const [slug, volStr, pageStr] = parts;
      const volume = parseInt(volStr, 10);

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
