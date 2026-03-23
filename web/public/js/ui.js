export function renderReader(el, caseData) {
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
      .map(p => `<p>${formatText(p)}</p>`)
      .join('\n');
    html += `${authorLine}<div class="reader-text">${paragraphs}</div>`;
  }

  el.innerHTML = html;
}

export function renderSidebar(el, caseData, reporter, volume, allCases) {
  const citeBadges = (caseData.citations || [])
    .map((c, i) => `<span class="cite-badge${i === 0 ? ' primary' : ''}">${esc(c.cite)}</span>`)
    .join(' ');

  const citedCases = (caseData.cites_to || [])
    .map(c => {
      const citeStr = typeof c === 'string' ? c : (c.cite || JSON.stringify(c));
      return `<div class="cited-case">
        <span class="cited-status no">&#10007;</span>
        <span class="cited-case-unresolved">${esc(citeStr)}</span>
      </div>`;
    })
    .join('');

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
    ${citedCases ? `<div class="sidebar-section">
      <div class="sidebar-label">Cited Cases (${caseData.cites_to?.length || 0})</div>
      ${citedCases}
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
