import { parseInput, resolve, extractCase, extractFile, getPageOrders } from './resolve.js';
import { renderReader, renderSidebar, updateCitationStatus, renderMultiNotice } from './ui.js';
import { caseHash, getHashParams, setHash, onHashChange } from './router.js';
import { aliasNoteHtml, processCitations, setupCiteHovers } from './citations.js';
import { attachCiteNav } from './citenav.js';
import { renderPageViewer } from './pageviewer.js';
import { footnoteParagraphs, pageBreaks, pageMarker } from './pages.js';
import { preloadWasm, WasmLoadError } from './wasm.js';
import { showWasmProgress } from './wasmbar.js';
import { filePage } from './pagekey.js';
import { hasScans, pdfPage } from './scans.js';

let currentResult = null;
// The shown case's cited-cases list wired to its text (citenav.js), and a
// place in the text (`~c=3`) to go to once its citations are found.
let citeNav = null;
let pendingCite = null;

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
const landingWasmSlot = document.getElementById('landing-wasm-progress');
const resolvedWasmSlot = document.getElementById('wasm-progress');
let pageViewerLoaded = false;
// The reader's scrolling container.
const scroller = () => reader.closest('.main-content') || reader.closest('.main');

// The page a pin cite pointed to (`@1023`). The reader scrolls to its
// marker and highlights it for a moment. Until the reader scrolls or
// presses a key, a re-render (once citations are found) or the web fonts
// loading, either of which can move the text, puts the marker back at the
// top.
const HIGHLIGHT_MS = 2500;
let target = null;

function markTarget() {
  const marker = target && pageMarker(reader, target.page);
  if (!marker) return;
  if (target.highlight) marker.classList.add('page-target');
  if (target.follow) marker.scrollIntoView({ block: 'start' });
}

for (const type of ['wheel', 'touchmove', 'keydown', 'mousedown']) {
  window.addEventListener(type, () => { if (target) target.follow = false; }, { passive: true });
}

/**
 * Scroll the reader to the marker for `page` and highlight it briefly; to
 * the top when `page` is null or the case has no marker for it.
 */
function goToPage(page) {
  for (const m of reader.querySelectorAll('.page-target')) m.classList.remove('page-target');
  if (target) clearTimeout(target.timer);
  target = null;
  if (!pageMarker(reader, page)) {
    scroller()?.scrollTo(0, 0);
    return;
  }
  const t = { page, follow: true, highlight: true };
  t.timer = setTimeout(() => {
    t.highlight = false;
    pageMarker(reader, page)?.classList.remove('page-target');
  }, HIGHLIGHT_MS);
  target = t;
  markTarget();
  document.fonts?.ready.then(() => { if (target === t) markTarget(); });
}

// The page breaks and footnotes in a case's opinions, from the case's CAP
// HTML in the volume zip; none when the zip has no HTML for it, or there's
// no zip (a CourtListener record, which has no pages).
function casePages(zipData, caseFile, caseData) {
  const none = { pages: null, footnotes: null };
  if (!zipData) return none;
  try {
    const html = extractFile(zipData, `html/${caseFile}.html`);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const opinions = caseData.casebody?.opinions || [];
    let footnotes = null;
    try {
      footnotes = footnoteParagraphs(html, opinions, () => doc);
    } catch {
      footnotes = null;
    }
    return { pages: pageBreaks(html, opinions, () => doc), footnotes };
  } catch {
    return none;
  }
}

// Put the shown case's place in the hash (`~c=3`), without a history entry
// or a hashchange, so the link can be shared.
function setCiteHash(n) {
  const p = getHashParams();
  if (!p) return;
  const hash = caseHash(p.reporter, p.volume, p.page, p.seq, null, n);
  if (window.location.hash === hash) return;
  history.replaceState(history.state, '', hash);
  lastResolvedHash = hash;
}

// Wire the sidebar's cited-cases list to the reader's text, and go to the
// place a `~c=` fragment named, if any.
function wireCiteNav(listEl, readerContent) {
  citeNav?.destroy();
  citeNav = attachCiteNav({ list: listEl, text: readerContent, onMove: setCiteHash });
  if (pendingCite) {
    const n = pendingCite;
    pendingCite = null;
    citeNav.goTo(n);
  }
}

function showLanding() {
  document.documentElement.removeAttribute('data-route');
  landing.classList.remove('hidden');
  resolved.classList.add('hidden');
  sidebarToggle.classList.add('hidden');
  landingInput.focus();
}

// Case files are "<first page>-<seq>"; the page can itself hold a hyphen
// ("1114-1140-01") or a bracket ("[106]-01"), or be a label ("xxix-01").
// The case's first page in its volume's PDF, from the zip's page orders; null when the
// zip doesn't give them (the link then opens the volume at its start).
function casePdfPage(zipData, caseFile) {
  if (!zipData) return null;
  try {
    return pdfPage(getPageOrders(zipData, caseFile)?.first);
  } catch {
    return null;
  }
}

function seqFromFile(caseFile) {
  return parseInt(caseFile.slice(caseFile.lastIndexOf('-') + 1), 10) || 1;
}

function pageFromFile(caseFile) {
  return filePage(caseFile);
}

function updatePrevNext(result, activeCaseFile) {
  // Cases on labelled pages (front matter, "Supp. 1") sort by name, apart from where
  // they fall in the volume, so the buttons step through the numbered pages only.
  const cases = (result.volumeCases || []).filter((f) => typeof pageFromFile(f) === 'number');
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

async function showResolved(result, pin = null, cite = null) {
  citeNav?.destroy();
  citeNav = null;
  pendingCite = cite;
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
  // A CourtListener record has no page scans to show, nor has a CAP volume without them.
  tabPages.classList.toggle('hidden', !result.zipData || !hasScans(result.reporter, result.volume));

  const multiEl = document.createElement('div');
  reader.innerHTML = '';
  // A citation that resolved through an alias (#151) says what was cited and where the
  // link came from.
  if (result.alias) reader.insertAdjacentHTML('beforeend', aliasNoteHtml(result.alias));
  reader.appendChild(multiEl);
  const readerContent = document.createElement('div');
  readerContent.className = 'reader';
  reader.appendChild(readerContent);

  // Citations processed per case file, so switching between the cases on
  // one page re-renders each with its own offsets.
  const citationsByCase = new Map();
  const pagesByCase = new Map();
  const pagesFor = (caseFile, caseData) => {
    if (!pagesByCase.has(caseFile)) pagesByCase.set(caseFile, casePages(result.zipData, caseFile, caseData));
    return pagesByCase.get(caseFile);
  };
  let shownCaseFile = null;
  // Handle on the cited-cases section's label/status/list elements for the
  // case currently shown, returned by renderSidebar. highlightCase updates
  // them in place through updateCitationStatus rather than calling
  // renderSidebar again, so the element carrying role="status"
  // aria-live="polite" stays the same node across the loading ->
  // done/error transition.
  let citationStatusHandle = null;

  renderMultiNotice(multiEl, result.allCases, result.caseFile, switchCase);
  statusBar.classList.add('hidden');
  const shown = showCase(result.caseFile, result.caseData, result);
  goToPage(cite ? null : pin);
  await shown;

  function showCase(caseFile, caseData, actions) {
    shownCaseFile = caseFile;
    const cached = citationsByCase.get(caseFile) || null;
    const layout = pagesFor(caseFile, caseData);
    citeNav?.destroy();
    citeNav = null;
    renderReader(readerContent, caseData, cached, layout.pages, layout.footnotes);
    citationStatusHandle = renderSidebar(
      sidebar, caseData, result.reporter, result.volume, result.allCases,
      cached?.unique || null, cached ? 'done' : 'loading', cached?.groups || null,
      casePdfPage(result.zipData, caseFile)
    );
    wireActions(actions);
    if (cached) {
      setupCiteHovers(readerContent, resolve);
      wireCiteNav(citationStatusHandle.listEl, readerContent);
      return Promise.resolve();
    }
    return highlightCase(caseFile, caseData, actions);
  }

  // Process citations in background, then re-render with them if this
  // case is still the one shown. Always updates the cited-cases live
  // region on completion (success or failure), so the "Finding
  // citations..." state never gets stuck. Updates the region in place
  // (updateCitationStatus) rather than re-rendering the whole sidebar, so
  // the element announcing the change is the one already on the page, not
  // a freshly created replacement a screen reader never saw appear.
  async function highlightCase(caseFile, caseData, actions) {
    const handle = citationStatusHandle;
    try {
      const { unique, occurrencesByOpinion, groups } = await processCitations(caseData);
      const citationMap = new Map(unique.map(c => [c.key, c]));
      const citations = { unique, citationMap, occurrencesByOpinion, groups };
      // Cache empty results too, so switching back doesn't detect again.
      citationsByCase.set(caseFile, citations);
      if (shownCaseFile !== caseFile) return;
      if (unique.length > 0) {
        const layout = pagesFor(caseFile, caseData);
        renderReader(readerContent, caseData, citations, layout.pages, layout.footnotes);
        markTarget();
      }
      updateCitationStatus(handle, caseData, unique, 'done', groups);
      setupCiteHovers(readerContent, resolve);
      wireCiteNav(handle.listEl, readerContent);
    } catch (e) {
      console.error('Citation detection failed:', e);
      if (shownCaseFile !== caseFile) return;
      updateCitationStatus(handle, caseData, null, 'error');
    }
  }

  function switchCase(caseFile) {
    if (!result.zipData) {
      // Several CourtListener records start on the page; each is its own fetch.
      doResolve(result.reporter, result.volume, result.page, result.allCases.indexOf(caseFile) + 1);
      return;
    }
    const caseData = extractCase(result.zipData, caseFile);
    const seq = seqFromFile(caseFile);
    const page = pageFromFile(caseFile);
    // Update URL to reflect the specific case
    setHash(result.reporter, result.volume, page, seq);
    updateTopbar(caseData);
    updatePrevNext(result, caseFile);
    renderMultiNotice(multiEl, result.allCases, caseFile, switchCase);
    showCase(caseFile, caseData, { ...result, caseData, caseFile, seq });
    goToPage(null);
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

// Shows the WASM loading bar under whichever status line is showing, if the
// WASM isn't ready. A WASM failure is reported there, with a Retry button
// that calls `redo` once the retry succeeds, so callers don't also put it in
// the status line.
function showWasmBar(redo) {
  const isLanding = !landing.classList.contains('hidden');
  showWasmProgress(isLanding ? landingWasmSlot : resolvedWasmSlot, { onRetryReady: redo });
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

async function doResolve(reporter, volume, page, seq = null, pin = null, cite = null) {
  landingBtn.disabled = true;
  setStatus('', false);
  showWasmBar(() => doResolve(reporter, volume, page, seq, pin, cite));

  try {
    const result = await resolve(reporter, volume, page, (msg) => setStatus(msg, false), seq);
    currentResult = result;
    // The folder the case is in, which can differ from the volume as cited (a3d/138-2).
    // A citation that resolved through an alias (#151) goes to the case it names, whose
    // pages a pin cite in the other printing doesn't number.
    if (result.alias) setHash(result.reporter, result.volume, result.page, result.seq, null);
    else setHash(reporter, result.volume, page, result.seq, pin, cite);
    lastResolvedHash = window.location.hash;
    showResolved(result, result.alias ? null : pin, result.alias ? null : cite);
  } catch (err) {
    if (!(err instanceof WasmLoadError)) setStatus(err.message, true);
    // Only go to landing if we're not already showing a case
    // (i.e., this was a landing page search, not an inline edit). A WASM
    // failure stays on the reader's shell, where its Retry button is.
    if (landing.classList.contains('hidden') && !currentResult && !(err instanceof WasmLoadError)) {
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
  setStatus('', false);
  if (landingInput.value.trim()) showWasmBar(() => landingForm.requestSubmit());
  let parsed;
  try {
    parsed = await parseInput(landingInput.value);
  } catch (err) {
    if (!(err instanceof WasmLoadError)) setStatus(err.message, true);
    return;
  }
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
    let parsed;
    showWasmBar(null);
    try {
      parsed = await parseInput(topbarCiteInput.value);
    } catch (err) {
      stopEditing();
      if (!(err instanceof WasmLoadError)) setStatus(err.message, true);
      return;
    }
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

  if (!pageViewerLoaded && currentResult?.zipData) {
    pageViewerLoaded = true;
    await renderPageViewer(pageViewerEl, currentResult, (msg) => setStatus(msg, false));
  }
});

// Hash routing — handle back/forward navigation
let lastResolvedHash = '';

// Whether hash params name the case already shown, so only the page differs.
function isShownCase(params) {
  const r = currentResult;
  return !!r && !resolved.classList.contains('hidden')
    && params.reporter === r.reporter && params.volume === r.volume
    && params.page === r.page && (params.seq || 1) === (r.seq || 1);
}

onHashChange((params) => {
  const currentHash = window.location.hash;
  if (currentHash === lastResolvedHash) return;
  if (isShownCase(params)) {
    lastResolvedHash = currentHash;
    if (params.cite) {
      // Before the citations are found, the place waits for them.
      if (!citeNav?.goTo(params.cite)) pendingCite = citeNav ? null : params.cite;
      return;
    }
    goToPage(params.pin);
    return;
  }
  landingInput.value = `${params.reporter} ${params.volume} ${params.page}`;
  doResolve(params.reporter, params.volume, params.page, params.seq, params.pin, params.cite);
});

// Handle back to empty hash (return to landing)
window.addEventListener('hashchange', () => {
  if (!window.location.hash || window.location.hash === '#') {
    showLanding();
  }
});

// Auto-resolve from URL hash on load. A case opens on the reader's shell, as
// index.astro's <head> script already showed it (data-route="case"), so the
// landing never flashes; a lookup that fails goes back to the landing with
// its error.
const initial = getHashParams();
document.documentElement.removeAttribute('data-route');
if (initial) {
  landing.classList.add('hidden');
  resolved.classList.remove('hidden');
  landingInput.value = `${initial.reporter} ${initial.volume} ${initial.page}`;
  doResolve(initial.reporter, initial.volume, initial.page, initial.seq, initial.pin, initial.cite);
}

// Fetch and compile the WASM in the background once the page has painted;
// nothing waits on it until a feature needs it.
preloadWasm();
