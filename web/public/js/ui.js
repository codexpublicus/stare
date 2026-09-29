import { escapeHtml, renderTextHtml, safeExternalUrl } from './citations.js';

/**
 * Render the reader view.
 * @param {Element} el - container element
 * @param {Object} caseData - parsed case JSON
 * @param {Object|null} citations - `{ citationMap, occurrencesByOpinion }`:
 *   citationMap maps raw cite string to its entry from processCitations();
 *   occurrencesByOpinion is processCitations()' per-opinion occurrence list
 *   for this same caseData. Null renders without highlighting.
 */
export function renderReader(el, caseData, citations) {
  const cite = caseData.citations?.[0]?.cite || '';
  const court = caseData.court?.name || '';

  let html = `
    <div class="reader-header">
      <div class="reader-title">${esc(caseData.name_abbreviation)}</div>
      <div class="reader-meta">${esc(cite)} &mdash; ${esc(court)} &mdash; ${esc(caseData.decision_date)}</div>
    </div>
  `;

  (caseData.casebody?.opinions || []).forEach((op, i) => {
    const authorLine = op.author
      ? `<div class="reader-author">${esc(op.author)}</div>`
      : '';
    const occurrences = citations?.occurrencesByOpinion?.[i] || [];
    const paragraphs = renderTextHtml(op.text, occurrences, citations?.citationMap || null)
      .map(p => `<p>${p}</p>`)
      .join('\n');
    html += `${authorLine}<div class="reader-text">${paragraphs}</div>`;
  });

  el.innerHTML = html;
}

/**
 * Compute the cited-cases section's label and body markup for a given
 * citation status. Shared by renderSidebar (first paint) and
 * updateCitationStatus (in-place update of the same live region), so the
 * two never drift apart.
 *
 * @param {Object} caseData - parsed case JSON
 * @param {Array|null} detectedCitations - citation objects from processCitations()
 * @param {'loading'|'error'|'done'|undefined} citationStatus
 */
function citationStatusContent(caseData, detectedCitations, citationStatus) {
  const isLoading = citationStatus === 'loading';
  const isError = citationStatus === 'error';

  let body = '';
  let totalCites = 0;

  if (isLoading) {
    body = `<div class="cited-status-message">Finding citations&hellip;</div>`;
  } else if (isError) {
    body = `<div class="cited-status-message cited-status-error">Couldn't check citations.</div>`;
  } else if (detectedCitations && detectedCitations.length > 0) {
    // Use detected citations if available, fall back to cites_to
    const resolvable = detectedCitations.filter(c => c.resolvable);
    // Only http(s) external URLs are linked; others list as unresolved.
    const external = detectedCitations.filter(c => !c.resolvable && safeExternalUrl(c.externalUrl));
    const unresolvable = detectedCitations.filter(c => !c.resolvable && !safeExternalUrl(c.externalUrl));

    const renderCite = (c) => {
      if (c.resolvable) {
        const href = `${window.location.pathname}#${c.slug}/${c.volume}/${c.page}`;
        return `<div class="cited-case">
          <span class="cited-status ok">&#10003;</span>
          <a class="cited-case-link" href="${href}" target="_blank" rel="noopener">${esc(c.raw)}</a>
        </div>`;
      } else if (safeExternalUrl(c.externalUrl)) {
        return `<div class="cited-case">
          <span class="cited-status ext">&#8599;</span>
          <a class="cited-case-link" href="${escapeHtml(c.externalUrl)}" target="_blank" rel="noopener">${esc(c.raw)}</a>
        </div>`;
      } else {
        return `<div class="cited-case">
          <span class="cited-status no">&#10007;</span>
          <span class="cited-case-unresolved">${esc(c.raw)}</span>
        </div>`;
      }
    };

    body = [...resolvable, ...external, ...unresolvable].map(renderCite).join('');
    totalCites = detectedCitations.length;
  } else {
    body = (caseData.cites_to || [])
      .map(c => {
        const citeStr = typeof c === 'string' ? c : (c.cite || JSON.stringify(c));
        return `<div class="cited-case">
          <span class="cited-status no">&#10007;</span>
          <span class="cited-case-unresolved">${esc(citeStr)}</span>
        </div>`;
      })
      .join('');
    totalCites = caseData.cites_to?.length || 0;
  }

  const label = isLoading || isError ? 'Cited Cases' : `Cited Cases (${totalCites})`;
  return { label, body };
}

/**
 * Fill (or refill) the cited-cases live region's content. Used both for
 * the region's first paint, in renderSidebar, and for later in-place
 * updates, in updateCitationStatus. The region element's identity never
 * changes here, only its contents, which is what lets its
 * role="status" aria-live="polite" actually announce the transition.
 */
function fillCitationStatus(region, caseData, detectedCitations, citationStatus) {
  const { label, body } = citationStatusContent(caseData, detectedCitations, citationStatus);
  region.innerHTML = `<div class="sidebar-label">${label}</div>${body}`;
}

/**
 * Render the sidebar.
 * @param {Element} el - sidebar container
 * @param {Object} caseData - parsed case JSON
 * @param {string} reporter - reporter slug
 * @param {number} volume - volume number
 * @param {Array} allCases - list of case files on this page
 * @param {Array|null} detectedCitations - citation objects from processCitations()
 * @param {'loading'|'error'|'done'|undefined} citationStatus - state of async
 *   citation detection. 'loading' shows a "Finding citations..." status in
 *   place of the cited-cases list; 'error' shows a short failure note when
 *   detection or availability checks threw. 'done' (or omitted, for callers
 *   that never run async detection) renders detectedCitations, falling back
 *   to caseData.cites_to when there are none.
 * @returns {Element} the cited-cases live region element. Pass this to
 *   updateCitationStatus once detection finishes or fails, instead of
 *   calling renderSidebar again, so the same role="status" aria-live="polite"
 *   node is updated in place rather than torn down and recreated (which
 *   would keep screen readers from ever announcing the change).
 */
export function renderSidebar(el, caseData, reporter, volume, allCases, detectedCitations, citationStatus) {
  const citeBadges = (caseData.citations || [])
    .map((c, i) => `<span class="cite-badge${i === 0 ? ' primary' : ''}">${esc(c.cite)}</span>`)
    .join(' ');

  const pdfUrl = `https://static.case.law/${reporter}/${volume}.pdf`;

  const beforeHtml = `
    <div class="sidebar-section">
      <div class="sidebar-label">Case</div>
      <div class="sidebar-title">${esc(caseData.name_abbreviation)}</div>
      <div class="sidebar-meta">
        <strong>Date:</strong> ${esc(caseData.decision_date)}<br>
        <strong>Court:</strong> ${esc(caseData.court?.name || '')}<br>
        ${caseData.docket_number ? `<strong>Docket:</strong> ${esc(caseData.docket_number)}<br>` : ''}
        <strong>Jurisdiction:</strong> ${esc(caseData.jurisdiction?.name_long || '')}
      </div>
    </div>
    <div class="sidebar-section">
      <div class="sidebar-label">Citations</div>
      ${citeBadges}
    </div>
  `;

  const afterHtml = `
    <div class="sidebar-section">
      <div class="sidebar-label">Actions</div>
      <a class="sidebar-action" href="${pdfUrl}" target="_blank" rel="noopener">
        <span class="sidebar-action-icon">&#128196;</span>View original PDF
      </a>
      <a class="sidebar-action" href="#" id="copy-link-btn">
        <span class="sidebar-action-icon">&#128279;</span>Copy permalink
      </a>
      <a class="sidebar-action" href="#" id="view-json-btn">
        <span class="sidebar-action-icon">{}</span>View as JSON
      </a>
    </div>
  `;

  // The cited-cases section is built as a real, standalone element (not a
  // string spliced into the rest of the sidebar's markup) and reserved for
  // the whole lifetime of this case's render, whatever its status, so
  // there's no layout shift when the list replaces the loading message.
  // Everything else in the sidebar is replaced wholesale on every call, as
  // before; only this element's identity is kept stable across calls, via
  // updateCitationStatus, so its aria-live actually has something to
  // observe.
  const region = document.createElement('div');
  region.className = 'sidebar-section citation-status';
  region.setAttribute('role', 'status');
  region.setAttribute('aria-live', 'polite');
  fillCitationStatus(region, caseData, detectedCitations, citationStatus);

  el.innerHTML = '';
  el.insertAdjacentHTML('beforeend', beforeHtml);
  el.appendChild(region);
  el.insertAdjacentHTML('beforeend', afterHtml);

  return region;
}

/**
 * Update the cited-cases live region in place, after renderSidebar's
 * initial paint, without touching the rest of the sidebar. `region` is the
 * element renderSidebar returned for this case. A screen reader announces
 * this change because the element carrying role="status" aria-live="polite"
 * is the same node throughout, not a replacement.
 *
 * @param {Element|null} region - element returned by renderSidebar; a
 *   no-op if null (e.g. the case changed before detection finished)
 * @param {Object} caseData - parsed case JSON
 * @param {Array|null} detectedCitations - citation objects from processCitations()
 * @param {'error'|'done'} citationStatus
 */
export function updateCitationStatus(region, caseData, detectedCitations, citationStatus) {
  if (!region) return;
  fillCitationStatus(region, caseData, detectedCitations, citationStatus);
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
