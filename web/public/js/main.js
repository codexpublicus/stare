import { parseInput, resolve, extractCase } from './resolve.js';
import { renderReader, renderSidebar, renderMultiNotice } from './ui.js';
import { getHashParams, setHash, onHashChange } from './router.js';
import { processCitations, setupCiteHovers } from './citations.js';
import { renderPageViewer } from './pageviewer.js';

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
const themeBtn = document.getElementById('theme-btn');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');
const statusBar = document.getElementById('status-bar');
const reader = document.getElementById('reader');
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const tabReader = document.getElementById('tab-reader');
const tabPages = document.getElementById('tab-pages');
const pageViewerEl = document.getElementById('page-viewer');
let pageViewerLoaded = false;

function showLanding() {
  landing.classList.remove('hidden');
  resolved.classList.add('hidden');
  sidebarToggle.classList.add('hidden');
  landingInput.focus();
}

function seqFromFile(caseFile) {
  return parseInt(caseFile.split('-')[1], 10) || 1;
}

function pageFromFile(caseFile) {
  return parseInt(caseFile.split('-')[0], 10);
}

function updatePrevNext(result, activeCaseFile) {
  const cases = result.volumeCases || [];
  const idx = cases.indexOf(activeCaseFile);

  if (idx > 0) {
    prevBtn.disabled = false;
    prevBtn.onclick = (e) => {
      e.preventDefault();
      const prevFile = cases[idx - 1];
      doResolve(result.reporter, result.volume, pageFromFile(prevFile), seqFromFile(prevFile));
    };
  } else {
    prevBtn.disabled = true;
    prevBtn.onclick = null;
  }

  if (idx >= 0 && idx < cases.length - 1) {
    nextBtn.disabled = false;
    nextBtn.onclick = (e) => {
      e.preventDefault();
      const nextFile = cases[idx + 1];
      doResolve(result.reporter, result.volume, pageFromFile(nextFile), seqFromFile(nextFile));
    };
  } else {
    nextBtn.disabled = true;
    nextBtn.onclick = null;
  }
}

function updateTopbar(caseData) {
  const cite = caseData.citations?.[0]?.cite || '';
  topbarCite.textContent = cite;
  topbarCase.textContent = caseData.name_abbreviation;
}

async function showResolved(result) {
  landing.classList.add('hidden');
  resolved.classList.remove('hidden');
  sidebarToggle.classList.remove('hidden');

  updateTopbar(result.caseData);
  updatePrevNext(result, result.caseFile);

  // Reset page viewer for new case
  pageViewerLoaded = false;
  pageViewerEl.innerHTML = '';
  pageViewerEl.classList.add('hidden');
  reader.classList.remove('hidden');
  tabReader.classList.add('active');
  tabPages.classList.remove('active');

  const multiEl = document.createElement('div');
  reader.innerHTML = '';
  reader.appendChild(multiEl);
  const readerContent = document.createElement('div');
  readerContent.className = 'reader';
  reader.appendChild(readerContent);

  renderMultiNotice(multiEl, result.allCases, result.caseFile, switchCase);
  renderReader(readerContent, result.caseData, null);
  renderSidebar(sidebar, result.caseData, result.reporter, result.volume, result.allCases, null);
  statusBar.classList.add('hidden');
  wireActions(result);

  reader.closest('.main')?.scrollTo(0, 0);

  // Process citations in background
  try {
    const detectedCitations = await processCitations(result.caseData);
    if (detectedCitations.length > 0) {
      const citationMap = new Map();
      for (const c of detectedCitations) {
        citationMap.set(c.raw, c);
      }
      result.citationMap = citationMap;
      result.detectedCitations = detectedCitations;
      renderReader(readerContent, result.caseData, citationMap);
      renderSidebar(sidebar, result.caseData, result.reporter, result.volume, result.allCases, detectedCitations);
      wireActions(result);
      setupCiteHovers(readerContent, resolve);
    }
  } catch (e) {
    console.warn('Citation detection failed:', e);
  }

  function switchCase(caseFile) {
    const caseData = extractCase(result.zipData, caseFile);
    const seq = seqFromFile(caseFile);
    const page = pageFromFile(caseFile);
    // Update URL to reflect the specific case
    setHash(result.reporter, result.volume, page, seq);
    updateTopbar(caseData);
    updatePrevNext(result, caseFile);
    renderReader(readerContent, caseData, result.citationMap || null);
    renderSidebar(sidebar, caseData, result.reporter, result.volume, result.allCases, result.detectedCitations || null);
    renderMultiNotice(multiEl, result.allCases, caseFile, switchCase);
    wireActions({ ...result, caseData, caseFile, seq });
  }
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

async function doResolve(reporter, volume, page, seq = null) {
  landingBtn.disabled = true;
  setStatus('', false);

  try {
    const result = await resolve(reporter, volume, page, (msg) => setStatus(msg, false), seq);
    currentResult = result;
    setHash(reporter, volume, page, result.seq);
    showResolved(result);
  } catch (err) {
    setStatus(err.message, true);
    // Only go to landing if we're not already showing a case
    // (i.e., this was a landing page search, not an inline edit)
    if (landing.classList.contains('hidden') && !currentResult) {
      showLanding();
      setStatus(err.message, true);
    }
  } finally {
    landingBtn.disabled = false;
  }
}

// Landing form submit
landingForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const parsed = await parseInput(landingInput.value);
  if (!parsed) {
    setStatus('Enter a citation (e.g., 31 A.2d 647 or a2d 31 647)', true);
    return;
  }
  doResolve(parsed.reporter, parsed.volume, parsed.page, parsed.seq);
});

// Inline citation editing in topbar
const topbarCiteInput = document.getElementById('topbar-cite-input');

function startEditing() {
  topbarCite.classList.add('hidden');
  topbarCiteInput.classList.remove('hidden');
  // Pre-fill with slug format (parseable), not display citation
  if (currentResult) {
    const seq = currentResult.seq || 1;
    topbarCiteInput.value = `${currentResult.reporter} ${currentResult.volume} ${currentResult.page}-${String(seq).padStart(2, '0')}`;
  } else {
    topbarCiteInput.value = '';
  }
  topbarCiteInput.focus();
  topbarCiteInput.select();
}

function stopEditing() {
  topbarCiteInput.classList.add('hidden');
  topbarCite.classList.remove('hidden');
}

let editSubmitting = false;

topbarCite.addEventListener('click', startEditing);

topbarCiteInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const parsed = await parseInput(topbarCiteInput.value);
    if (parsed) {
      editSubmitting = true;
      stopEditing();
      doResolve(parsed.reporter, parsed.volume, parsed.page, parsed.seq);
      editSubmitting = false;
    }
  }
  if (e.key === 'Escape') {
    stopEditing();
  }
});

topbarCiteInput.addEventListener('blur', () => {
  if (!editSubmitting) stopEditing();
});

// Dark mode toggle — shared across landing + resolved topbar
const landingThemeBtn = document.getElementById('landing-theme-btn');
const allThemeBtns = [themeBtn, landingThemeBtn].filter(Boolean);

function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (isDark) {
    document.documentElement.removeAttribute('data-theme');
    allThemeBtns.forEach(b => b.textContent = '\u263E');
    try { localStorage.setItem('stare-theme', 'light'); } catch(e) {}
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    allThemeBtns.forEach(b => b.textContent = '\u2600');
    try { localStorage.setItem('stare-theme', 'dark'); } catch(e) {}
  }
}

allThemeBtns.forEach(b => b.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  toggleTheme();
}));

try {
  if (localStorage.getItem('stare-theme') === 'dark' ||
      (!localStorage.getItem('stare-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    allThemeBtns.forEach(b => b.textContent = '\u2600');
  }
} catch(e) {}

// Sidebar toggle (mobile)
sidebarToggle.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  sidebar.classList.toggle('open');
});

// Tab switching
tabReader.addEventListener('click', () => {
  tabReader.classList.add('active');
  tabPages.classList.remove('active');
  reader.classList.remove('hidden');
  pageViewerEl.classList.add('hidden');
});

tabPages.addEventListener('click', async () => {
  tabPages.classList.add('active');
  tabReader.classList.remove('active');
  pageViewerEl.classList.remove('hidden');
  reader.classList.add('hidden');

  if (!pageViewerLoaded && currentResult) {
    pageViewerLoaded = true;
    await renderPageViewer(pageViewerEl, currentResult, (msg) => setStatus(msg, false));
  }
});

// Hash routing
onHashChange((params) => {
  landingInput.value = `${params.reporter} ${params.volume} ${params.page}`;
  doResolve(params.reporter, params.volume, params.page, params.seq);
});

// Auto-resolve from URL hash on load
const initial = getHashParams();
if (initial) {
  landingInput.value = `${initial.reporter} ${initial.volume} ${initial.page}`;
  doResolve(initial.reporter, initial.volume, initial.page, initial.seq);
}
