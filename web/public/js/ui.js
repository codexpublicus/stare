import { citationSummary, citedListHtml, groupCitations, renderTextHtml } from './citations.js';
import { blockedLineHtml, isClRecord, sourceLineHtml } from './cl.js';
import { insertPageMarkers } from './pages.js';
import { pdfUrl as volumePdfUrl } from './sources.js';

/**
 * Render the reader view.
 * @param {Element} el - container element
 * @param {Object} caseData - parsed case JSON
 * @param {Object|null} citations - `{ citationMap, occurrencesByOpinion }`:
 *   citationMap maps each entry's `key` to it, from processCitations();
 *   occurrencesByOpinion is processCitations()' per-opinion occurrence list
 *   for this same caseData. Null renders without highlighting.
 * @param {Array|null} pages - page breaks for each opinion, from pageBreaks()
 *   in pages.js; shown as `[*1023]` markers with the id `page-1023`.
 * @param {Array|null} footnotes - each opinion's footnote paragraphs, from
 *   footnoteParagraphs() in pages.js: `[{ paragraph, label }]`. Each is
 *   rendered as `<p class="reader-footnote" data-footnote="3">`.
 */
export function renderReader(el, caseData, citations, pages = null, footnotes = null) {
  const cite = caseData.citations?.[0]?.cite || '';
  const court = caseData.court?.name || '';

  let html = `
    <div class="reader-header">
      <div class="reader-title">${esc(caseData.name_abbreviation)}</div>
      <div class="reader-meta">${esc(cite)} &mdash; ${esc(court)} &mdash; ${esc(caseData.decision_date)}</div>
      ${sourceLineHtml(caseData)}
      ${blockedLineHtml(caseData)}
    </div>
  `;

  (caseData.casebody?.opinions || []).forEach((op, i) => {
    const authorLine = op.author
      ? `<div class="reader-author">${esc(op.author)}</div>`
      : '';
    const occurrences = citations?.occurrencesByOpinion?.[i] || [];
    const notes = new Map((footnotes?.[i] || []).map(f => [f.paragraph, f.label]));
    const paragraphs = renderTextHtml(op.text, occurrences, citations?.citationMap || null)
      .map((p, j) => (notes.has(j)
        ? `<p class="reader-footnote" data-footnote="${esc(notes.get(j))}">${p}</p>`
        : `<p>${p}</p>`))
      .join('\n');
    html += `${authorLine}<div class="reader-text">${paragraphs}</div>`;
  });

  el.innerHTML = html;
  insertPageMarkers(el, pages);
}

/**
 * Compute the cited-cases section's label, short status announcement, and
 * list markup for a given citation status. Shared by renderSidebar (first
 * paint) and updateCitationStatus (in-place update), so the two never
 * drift apart.
 *
 * `statusText` is short by design: it is the only piece that lives in the
 * aria-live region, so it must never contain the list itself, or a screen
 * reader would read every citation aloud on each transition.
 *
 * @param {Object} caseData - parsed case JSON
 * @param {Array|null} detectedCitations - citation objects from processCitations()
 * @param {'loading'|'error'|'done'|undefined} citationStatus
 * @param {Array|null} groups - processCitations()' `groups` for them; without
 *   it they are grouped here, with no counts and no parallels
 */
function citationStatusParts(caseData, detectedCitations, citationStatus, groups = null) {
  const isLoading = citationStatus === 'loading';
  const isError = citationStatus === 'error';

  let listHtml = '';
  let statusText = '';
  let totalCites = 0;

  if (isLoading) {
    statusText = 'Finding citations…';
  } else if (isError) {
    statusText = "Couldn't check citations.";
  } else if (detectedCitations && detectedCitations.length > 0) {
    // Held here, then statutes linked to their text, then cases to look
    // for elsewhere, then the rest; bare section references aren't
    // listed or counted. Only http(s) URLs are ever linked.
    // One entry per cited case (#159), with its full citations, short forms
    // and parallel citations together.
    const caseHref = (c) => `${window.location.pathname}#${c.slug}/${c.volume}/${c.page}`;
    const cases = groups || groupCitations(null, detectedCitations);
    listHtml = citedListHtml(cases, caseHref);
    totalCites = cases.length;
    statusText = citationSummary(detectedCitations);
  } else {
    listHtml = (caseData.cites_to || [])
      .map(c => {
        const citeStr = typeof c === 'string' ? c : (c.cite || JSON.stringify(c));
        return `<div class="cited-case">
          <span class="cited-status no">&#10007;</span>
          <span class="cited-case-unresolved">${esc(citeStr)}</span>
        </div>`;
      })
      .join('');
    totalCites = caseData.cites_to?.length || 0;
    // Nothing was actually detected here (this is the cites_to fallback),
    // so there is nothing worth announcing.
    statusText = '';
  }

  const label = isLoading || isError ? 'Cited Cases' : `Cited Cases (${totalCites})`;
  return { label, statusText, listHtml };
}

/**
 * A handle on the cited-cases section's three persistent pieces, as
 * returned by renderSidebar and consumed by updateCitationStatus.
 * @typedef {Object} CitationStatusHandle
 * @property {Element} labelEl - "Cited Cases" / "Cited Cases (N)" header
 * @property {Element} statusEl - role="status" aria-live="polite"; short
 *   text only ("Finding citations...", "N citations found", the failure
 *   note). Never holds the list, so a screen reader announces one short
 *   sentence per transition, not every citation.
 * @property {Element} listEl - the cited-cases list itself. Not a live
 *   region; updated in place alongside statusEl, but silently.
 */

/**
 * Fill (or refill) the cited-cases section's three pieces. Used both for
 * their first paint, in renderSidebar, and for later in-place updates, in
 * updateCitationStatus. None of the three elements' identity changes here,
 * only their contents.
 * @param {CitationStatusHandle} handle
 */
function fillCitationStatus(handle, caseData, detectedCitations, citationStatus, groups = null) {
  const { label, statusText, listHtml } = citationStatusParts(caseData, detectedCitations, citationStatus, groups);
  handle.labelEl.textContent = label;
  handle.statusEl.textContent = statusText;
  handle.statusEl.className = citationStatus === 'error'
    ? 'citation-status-text citation-status-error'
    : 'citation-status-text';
  handle.listEl.innerHTML = listHtml;
}

/**
 * Render the sidebar.
 * @param {Element} el - sidebar container
 * @param {Object} caseData - parsed case JSON
 * @param {string} reporter - reporter slug
 * @param {string} volume - CAP volume folder (e.g. "31", "138-2")
 * @param {Array} allCases - list of case files on this page
 * @param {Array|null} detectedCitations - citation objects from processCitations()
 * @param {'loading'|'error'|'done'|undefined} citationStatus - state of async
 *   citation detection. 'loading' shows a "Finding citations..." status in
 *   place of the cited-cases list; 'error' shows a short failure note when
 *   detection or availability checks threw. 'done' (or omitted, for callers
 *   that never run async detection) renders detectedCitations, falling back
 *   to caseData.cites_to when there are none.
 * @param {Array|null} groups - processCitations()' `groups` for
 *   detectedCitations (one list entry per cited case, with counts)
 * @returns {CitationStatusHandle} pass this to updateCitationStatus once
 *   detection finishes or fails, instead of calling renderSidebar again,
 *   so the same role="status" aria-live="polite" node is updated in place
 *   rather than torn down and recreated (which would keep screen readers
 *   from ever announcing the change), and so the list itself, which is not
 *   a live region, doesn't get read aloud wholesale.
 */
export function renderSidebar(el, caseData, reporter, volume, allCases, detectedCitations, citationStatus, groups = null) {
  const citeBadges = (caseData.citations || [])
    .map((c, i) => `<span class="cite-badge${i === 0 ? ' primary' : ''}">${esc(c.cite)}</span>`)
    .join(' ');

  // A CourtListener record has no scans, so no volume PDF; its source line says
  // where it came from instead.
  const fromCl = isClRecord(caseData);
  const docket = caseData.docket_number || (fromCl ? caseData.source.docket_number : null);
  const pdfAction = fromCl ? '' : `
      <a class="sidebar-action" href="${volumePdfUrl(reporter, volume)}" target="_blank" rel="noopener">
        <span class="sidebar-action-icon">&#128196;</span>View original PDF
      </a>`;

  const beforeHtml = `
    <div class="sidebar-section">
      <div class="sidebar-label">Case</div>
      <div class="sidebar-title">${esc(caseData.name_abbreviation)}</div>
      <div class="sidebar-meta">
        <strong>Date:</strong> ${esc(caseData.decision_date)}<br>
        <strong>Court:</strong> ${esc(caseData.court?.name || '')}<br>
        ${docket ? `<strong>Docket:</strong> ${esc(docket)}<br>` : ''}
        <strong>Jurisdiction:</strong> ${esc(caseData.jurisdiction?.name_long || '')}
      </div>
      ${sourceLineHtml(caseData, 'sidebar-meta sidebar-source', { docket: false })}
      ${blockedLineHtml(caseData, 'sidebar-meta sidebar-blocked')}
    </div>
    <div class="sidebar-section">
      <div class="sidebar-label">Citations</div>
      ${citeBadges}
    </div>
  `;

  const afterHtml = `
    <div class="sidebar-section">
      <div class="sidebar-label">Actions</div>${pdfAction}
      <a class="sidebar-action" href="#" id="copy-link-btn">
        <span class="sidebar-action-icon">&#128279;</span>Copy permalink
      </a>
      <a class="sidebar-action" href="#" id="view-json-btn">
        <span class="sidebar-action-icon">{}</span>View as JSON
      </a>
    </div>
  `;

  // The cited-cases section is built as three real, standalone elements
  // (not strings spliced into the rest of the sidebar's markup) and
  // reserved for the whole lifetime of this case's render, whatever its
  // status, so there's no layout shift when the list replaces the loading
  // message. Everything else in the sidebar is replaced wholesale on every
  // call, as before; only these three elements' identity is kept stable
  // across calls, via updateCitationStatus. Only statusEl carries
  // role="status" aria-live="polite", and it only ever holds a short
  // sentence, never the list, which lives in listEl, a plain sibling.
  const labelEl = document.createElement('div');
  labelEl.className = 'sidebar-label';

  const statusEl = document.createElement('div');
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');

  const listEl = document.createElement('div');
  listEl.className = 'citation-status-list';

  const handle = { labelEl, statusEl, listEl };
  fillCitationStatus(handle, caseData, detectedCitations, citationStatus, groups);

  const region = document.createElement('div');
  region.className = 'sidebar-section citation-status';
  region.appendChild(labelEl);
  region.appendChild(statusEl);
  region.appendChild(listEl);

  el.innerHTML = '';
  el.insertAdjacentHTML('beforeend', beforeHtml);
  el.appendChild(region);
  el.insertAdjacentHTML('beforeend', afterHtml);

  return handle;
}

/**
 * Update the cited-cases section in place, after renderSidebar's initial
 * paint, without touching the rest of the sidebar. `handle` is the value
 * renderSidebar returned for this case. A screen reader announces
 * statusEl's change because it is the same node throughout, not a
 * replacement, and announces only its short text, not listEl's markup,
 * because listEl carries no aria-live of its own.
 *
 * @param {CitationStatusHandle|null} handle - value returned by
 *   renderSidebar; a no-op if null (e.g. the case changed before
 *   detection finished)
 * @param {Object} caseData - parsed case JSON
 * @param {Array|null} detectedCitations - citation objects from processCitations()
 * @param {'error'|'done'} citationStatus
 * @param {Array|null} groups - processCitations()' `groups`, as for renderSidebar
 */
export function updateCitationStatus(handle, caseData, detectedCitations, citationStatus, groups = null) {
  if (!handle) return;
  fillCitationStatus(handle, caseData, detectedCitations, citationStatus, groups);
}

export function renderMultiNotice(el, allCases, currentFile, onSwitch) {
  if (allCases.length <= 1) { el.innerHTML = ''; return; }
  const links = allCases.map(f =>
    f === currentFile
      ? `<strong>${f}</strong>`
      : `<a href="#" class="multi-link" data-case="${f}">${f}</a>`
  ).join(' | ');
  el.innerHTML = `<div class="multi-notice">${allCases.length} cases start on this page: ${links}</div>`;
  el.querySelectorAll('.multi-link').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      onSwitch(a.dataset.case);
    });
  });
}

function esc(str) {
  if (!str) return '';
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}
