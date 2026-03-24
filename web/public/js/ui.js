import { highlightCitations } from './citations.js';

/**
 * Render the reader view.
 * @param {Element} el - container element
 * @param {Object} caseData - parsed case JSON
 * @param {Map|null} citationMap - map of raw cite string → { slug, volume, page, resolvable }
 */
export function renderReader(el, caseData, citationMap) {
  const cite = caseData.citations?.[0]?.cite || '';
  const court = caseData.court?.name || '';

  let html = `
    <div class="reader-header">
      <div class="reader-title">${esc(caseData.name_abbreviation)}</div>
      <div class="reader-meta">${esc(cite)} &mdash; ${esc(court)} &mdash; ${esc(caseData.decision_date)}</div>
    </div>
  `;

  for (const op of caseData.casebody?.opinions || []) {
    const authorLine = op.author
      ? `<div class="reader-author">${esc(op.author)}</div>`
      : '';
    const paragraphs = op.text
      .split(/\n+/)
      .filter(p => p.trim())
      .map(p => {
        let formatted = formatText(p);
        if (citationMap && citationMap.size > 0) {
          formatted = highlightCitations(formatted, citationMap);
        }
        return `<p>${formatted}</p>`;
      })
      .join('\n');
    html += `${authorLine}<div class="reader-text">${paragraphs}</div>`;
  }

  el.innerHTML = html;
}

/**
 * Render the sidebar.
 * @param {Element} el - sidebar container
 * @param {Object} caseData - parsed case JSON
 * @param {string} reporter - reporter slug
 * @param {number} volume - volume number
 * @param {Array} allCases - list of case files on this page
 * @param {Array|null} detectedCitations - citation objects from processCitations()
 */
export function renderSidebar(el, caseData, reporter, volume, allCases, detectedCitations) {
  const citeBadges = (caseData.citations || [])
    .map((c, i) => `<span class="cite-badge${i === 0 ? ' primary' : ''}">${esc(c.cite)}</span>`)
    .join(' ');

  // Use detected citations if available, fall back to cites_to
  let citedCasesHtml = '';
  if (detectedCitations && detectedCitations.length > 0) {
    const resolvable = detectedCitations.filter(c => c.resolvable);
    const external = detectedCitations.filter(c => c.externalUrl);
    const unresolvable = detectedCitations.filter(c => !c.resolvable && !c.externalUrl);

    const renderCite = (c) => {
      if (c.resolvable) {
        return `<div class="cited-case">
          <span class="cited-status ok">&#10003;</span>
          <a class="cited-case-link" href="#${c.slug}/${c.volume}/${c.page}">${esc(c.raw)}</a>
        </div>`;
      } else if (c.externalUrl) {
        return `<div class="cited-case">
          <span class="cited-status ext">&#8599;</span>
          <a class="cited-case-link" href="${c.externalUrl}" target="_blank" rel="noopener">${esc(c.raw)}</a>
        </div>`;
      } else {
        return `<div class="cited-case">
          <span class="cited-status no">&#10007;</span>
          <span class="cited-case-unresolved">${esc(c.raw)}</span>
        </div>`;
      }
    };

    citedCasesHtml = [...resolvable, ...external, ...unresolvable].map(renderCite).join('');
  } else {
    citedCasesHtml = (caseData.cites_to || [])
      .map(c => {
        const citeStr = typeof c === 'string' ? c : (c.cite || JSON.stringify(c));
        return `<div class="cited-case">
          <span class="cited-status no">&#10007;</span>
          <span class="cited-case-unresolved">${esc(citeStr)}</span>
        </div>`;
      })
      .join('');
  }

  const totalCites = detectedCitations
    ? detectedCitations.length
    : (caseData.cites_to?.length || 0);

  const pdfUrl = `https://static.case.law/${reporter}/${volume}.pdf`;

  el.innerHTML = `
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
    ${citedCasesHtml ? `<div class="sidebar-section">
      <div class="sidebar-label">Cited Cases (${totalCites})</div>
      ${citedCasesHtml}
    </div>` : ''}
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

function formatText(text) {
  return esc(text).replace(
    /\[\*(\d+)\]/g,
    '<span class="page-marker">[*$1]</span>'
  );
}

function esc(str) {
  if (!str) return '';
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}
