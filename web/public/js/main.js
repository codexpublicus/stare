import { parseInput, resolve, extractCase } from './resolve.js';
import { renderReader, renderSidebar, renderMultiNotice } from './ui.js';
import { getHashParams, setHash, onHashChange } from './router.js';

let currentResult = null;

// DOM refs
const landing = document.getElementById('landing');
const resolved = document.getElementById('resolved');
const landingForm = document.getElementById('landing-form');
const landingInput = document.getElementById('landing-input');
const landingBtn = document.getElementById('landing-btn');
const landingStatus = document.getElementById('landing-status');
const topbarCite = document.getElementById('topbar-cite');
const topbarCase = document.getElementById('topbar-case');
const editBtn = document.getElementById('edit-btn');
const themeBtn = document.getElementById('theme-btn');
const statusBar = document.getElementById('status-bar');
const reader = document.getElementById('reader');
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');

function showLanding() {
  landing.classList.remove('hidden');
  resolved.classList.add('hidden');
  sidebarToggle.classList.add('hidden');
  landingInput.focus();
}

function showResolved(result) {
  landing.classList.add('hidden');
  resolved.classList.remove('hidden');
  sidebarToggle.classList.remove('hidden');

  const cite = result.caseData.citations?.[0]?.cite || '';
  topbarCite.textContent = cite;
  topbarCase.textContent = result.caseData.name_abbreviation;

  const multiEl = document.createElement('div');
  reader.innerHTML = '';
  reader.appendChild(multiEl);
  const readerContent = document.createElement('div');
  readerContent.className = 'reader';
  reader.appendChild(readerContent);

  function switchCase(caseFile) {
    const caseData = extractCase(result.zipData, caseFile);
    renderReader(readerContent, caseData);
    renderSidebar(sidebar, caseData, result.reporter, result.volume, result.allCases);
    renderMultiNotice(multiEl, result.allCases, caseFile, switchCase);
    wireActions({ ...result, caseData });
  }

  renderMultiNotice(multiEl, result.allCases, result.caseFile, switchCase);
  renderReader(readerContent, result.caseData);
  renderSidebar(sidebar, result.caseData, result.reporter, result.volume, result.allCases);
  statusBar.classList.add('hidden');

  wireActions(result);
}

function wireActions(result) {
  const copyBtn = document.getElementById('copy-link-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const url = window.location.href;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url);
      }
    });
  }
  const jsonBtn = document.getElementById('view-json-btn');
  if (jsonBtn) {
    jsonBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const blob = new Blob([JSON.stringify(result.caseData, null, 2)], { type: 'application/json' });
      window.open(URL.createObjectURL(blob));
    });
  }
}

function setStatus(msg, isError) {
  const isLanding = !landing.classList.contains('hidden');
  const target = isLanding ? landingStatus : statusBar;
  target.textContent = msg;
  target.className = isError ? 'status-line error' : 'status-line';
  if (msg) {
    target.classList.remove('hidden');
  } else if (!isLanding) {
    target.classList.add('hidden');
  }
}

async function doResolve(reporter, volume, page) {
  landingBtn.disabled = true;
  setStatus('', false);

  try {
    const result = await resolve(reporter, volume, page, (msg) => setStatus(msg, false));
    currentResult = result;
    setHash(reporter, volume, page);
    showResolved(result);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    landingBtn.disabled = false;
  }
}

// Landing form submit
landingForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const parsed = parseInput(landingInput.value);
  if (!parsed) {
    setStatus('Enter a citation as: reporter volume page (e.g., a2d 31 647)', true);
    return;
  }
  doResolve(parsed.reporter, parsed.volume, parsed.page);
});

// Edit button — back to landing
editBtn.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  showLanding();
});

// Dark mode toggle
themeBtn.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (isDark) {
    document.documentElement.removeAttribute('data-theme');
    themeBtn.textContent = '\u263E';
    try { localStorage.setItem('stare-theme', 'light'); } catch(e) {}
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    themeBtn.textContent = '\u2600';
    try { localStorage.setItem('stare-theme', 'dark'); } catch(e) {}
  }
});

// Restore dark mode button state
try {
  if (localStorage.getItem('stare-theme') === 'dark' ||
      (!localStorage.getItem('stare-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    themeBtn.textContent = '\u2600';
  }
} catch(e) {}

// Sidebar toggle (mobile)
sidebarToggle.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  sidebar.classList.toggle('open');
});

// Hash routing
onHashChange((params) => {
  landingInput.value = `${params.reporter} ${params.volume} ${params.page}`;
  doResolve(params.reporter, params.volume, params.page);
});

// Auto-resolve from URL hash on load
const initial = getHashParams();
if (initial) {
  landingInput.value = `${initial.reporter} ${initial.volume} ${initial.page}`;
  doResolve(initial.reporter, initial.volume, initial.page);
}
