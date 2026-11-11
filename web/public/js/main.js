import { parseInput, resolve, extractCase, extractFile, getPageOrders } from './resolve.js';
import { renderReader, renderSidebar, updateCitationStatus, renderMultiNotice } from './ui.js';
import { caseHash, getHashParams, parseHash, setHash, onHashChange, replaceHash, routePath, setRoute } from './router.js';
import { citationPath, clusters, keyPath, parseCasePath, pickPrinting, resolveKey } from './caseaddress.js';
import { pdfJurisdiction } from './sources.js';
import { aliasNoteHtml, processCitations, setupCiteHovers } from './citations.js';
import { attachCiteNav } from './citenav.js';
import { NotInCopyError, notInCopyHtml, notInCopyNodes, hasFeature, upstreamUrl } from './mirror.js';
import { footnoteParagraphs, pageBreaks, pageMarker } from './pages.js';
import { preloadWasm, WasmLoadError } from './wasm.js';
import { showWasmProgress } from './wasmbar.js';
import { filePage } from './pagekey.js';
import { hasScans, pdfPage } from './scans.js';
import { pdfUrl as volumePdfUrl } from './sources.js';
import { generations } from './generation.js';
import { attachRouteLabel, markNotCitation, routeNoteHtml, routeOf, searchHref, takeHandOff } from './boxroute.js';

// The reader's own modules are imported above; the page views (scanviewer.js, pdfviewer.js
// and pageshell.js with theirs) and the search boxes' typeahead (searchbox.js, suggest.js,
// casenames.js) are imported when first wanted (#265). A module that fails to load, a
// content blocker's doing or a 404 mid-deploy, then costs its own feature, with a message
// saying so, and the Reader keeps working. Anything that fails above stops main.js from
// running at all, which the boot guard in index.astro's <head> (src/lib/bootguard.js)
// reports instead of leaving "Loading..." up.

let currentResult = null;
// The case load under way or shown (#267): each doResolve starts one and ends the one
// before it, and every step of a load checks it's still current before it touches the
// DOM or the state below, so a late result from a replaced case is dropped.
const loads = generations();
// The shown case's cited-cases list wired to its text (citenav.js), and a
// place in the text (`~c=3`) to go to once its citations are found.
let citeNav = null;
let pendingCite = null;
// The page view a `~v=pdf&p=3` fragment named, opened once the case is shown.
let pendingView = null;

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
const tabPdf = document.getElementById('tab-pdf');
const tabPages = document.getElementById('tab-pages');
const pdfViewerEl = document.getElementById('pdf-viewer');
const pageViewerEl = document.getElementById('page-viewer');
const landingWasmSlot = document.getElementById('landing-wasm-progress');
const resolvedWasmSlot = document.getElementById('wasm-progress');
// Each box's one button says where Enter takes its text, a citation or words (D163,
// boxroute.js); its label follows the text as it's typed.
const landingRoute = attachRouteLabel(landingInput, landingBtn, document.getElementById('landing-route-status'));
// A search box with its typeahead (searchbox.js, #248), loaded the first time the input is
// focused. Until it loads, or if it can't, the input is a plain text box: `fill` puts the
// citation in it and routeBox reads it with the parser alone. `fill`s before the load are
// passed on once it's in, if the text is still theirs, so the box still remembers the case.
function lazySearchBox(input, listbox, status, opts) {
  // The button's label follows text the typeahead puts in the box too.
  opts = { ...opts, onText: () => opts.route?.update() };
  let box = null;
  let loading = null;
  let early = null;
  function load() {
    if (!loading) {
      loading = import('./searchbox.js').then((m) => {
        box = m.attachSearchBox(input, listbox, status, opts);
        const focused = document.activeElement === input;
        if (early && input.value === early.text) {
          box.fill(early.cite, early.target);
          opts.onText();
        }
        else if (focused && input.value) input.dispatchEvent(new Event('input'));
        early = null;
        // The box fetches what it suggests from on focus; the focus that loaded it came first.
        if (focused) input.dispatchEvent(new FocusEvent('focus'));
        return box;
      }).catch((e) => {
        console.warn('The search suggestions could not load; citations still work without them.', e);
        return null;
      });
    }
    return loading;
  }
  input.addEventListener('focus', load);
  return {
    fill(cite, target) {
      if (box) {
        box.fill(cite, target);
        opts.onText();
        return;
      }
      const text = typeof cite === 'string' ? cite.trim() : '';
      input.value = text;
      early = { cite, target, text };
      opts.onText();
    },
    close: () => box?.close(),
    // The box once loaded, or null when it can't be.
    load,
  };
}

// The landing's box suggests citations as it is typed in (#248); a page suggestion opens
// its case.
const landingBox = lazySearchBox(landingInput, document.getElementById('landing-suggest'),
  document.getElementById('landing-suggest-status'), {
    onPick: (t) => doResolve(t.reporter, t.volume, t.page, t.seq),
    route: landingRoute,
  });
let pageViewerLoaded = false;
let pdfViewerLoaded = false;
// The page views' modules, once loaded: pdfviewer.js and scanviewer.js.
const viewModules = { pdf: null, scans: null };
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
  if (!zipData) return NO_PAGES;
  try {
    return htmlPages(extractFile(zipData, `html/${caseFile}.html`), caseData);
  } catch {
    return NO_PAGES;
  }
}

const NO_PAGES = { pages: null, footnotes: null };

// The page breaks and footnotes in a case's CAP HTML.
function htmlPages(html, caseData) {
  const none = NO_PAGES;
  try {
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
  replaceHash(hash);
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

// The landing's status line as the page starts, empty (#282): a lookup's progress goes
// there while the landing is showing, and nothing else takes it down.
function clearLandingStatus() {
  landingStatus.textContent = '';
  landingStatus.className = 'status-line';
}

// Back to the landing, its status line cleared; doResolve's failure path sets its error
// after this.
function showLanding() {
  document.documentElement.removeAttribute('data-route');
  clearLandingStatus();
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

// The sidebar's archival PDF link for a case read by its zip span (D180), which has no
// zip to read the case's page orders from: the link opens the volume at its start until
// they're read, by range (resolve.js's spanZip), when the link is about to be used (a
// pointer over it, focus, a touch). A click before they're in opens the tab at once and
// sends it to the case's page when they arrive, so the click still counts as the user's.
function wireLazyPdfLink(sidebarEl, result, caseFile) {
  const link = sidebarEl.querySelector('#pdf-link');
  if (!link || !result.zip) return;
  let orders = null;
  const load = () => {
    orders ??= result.zip.pageOrders(caseFile).then((o) => {
      const n = pdfPage(o?.first);
      if (n && link.isConnected) link.href = volumePdfUrl(result.reporter, result.volume, n);
      return n;
    }).catch(() => null);
    return orders;
  };
  for (const type of ['pointerenter', 'focus', 'touchstart']) link.addEventListener(type, load, { once: true, passive: true });
  link.addEventListener('click', (e) => {
    if (link.href.includes('#page=')) return;
    e.preventDefault();
    const tab = window.open('', '_blank');
    load().then((n) => {
      const url = volumePdfUrl(result.reporter, result.volume, n);
      if (!tab) {
        window.open(url, '_blank', 'noopener');
        return;
      }
      tab.opener = null;
      tab.location.href = url;
    });
  });
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
  // The landing's box keeps the case shown, as written (#248), for going back to it.
  landingBox.fill(cite, getHashParams());
}

// Reset the page views for a new case, and show the Reader.
function resetPageViews() {
  pageViewerLoaded = false;
  viewPages.pdf = 1;
  viewPages.scans = 1;
  viewModules.scans?.resetPageViewer();
  pageViewerEl.innerHTML = '';
  pdfViewerLoaded = false;
  viewModules.pdf?.resetPdfViewer();
  pdfViewerEl.innerHTML = '';
  showView('reader');
}

// Show a resolved case. `load` is the case load it came from (generation.js); its
// citation pass writes nothing once another load has started.
async function showResolved(result, pin, cite, load, fromText = null) {
  citeNav?.destroy();
  citeNav = null;
  pendingCite = cite;
  landing.classList.add('hidden');
  clearLandingStatus();
  resolved.classList.remove('hidden');
  sidebarToggle.classList.remove('hidden');

  updateTopbar(result.caseData);
  updatePrevNext(result, result.caseFile);

  resetPageViews();
  // A CourtListener record has no page scans or archival PDF to show, nor has a CAP
  // volume without scans.
  const scans = (!!result.zipData || !!result.zip) && hasScans(result.reporter, result.volume);
  tabPdf.classList.toggle('hidden', !scans);
  tabPages.classList.toggle('hidden', !scans);
  const wantView = pendingView;
  pendingView = null;
  if (scans && wantView) openPageView(wantView.view, wantView.page);

  const multiEl = document.createElement('div');
  reader.innerHTML = '';
  // A citation that resolved through an alias (#151) says what was cited and where the
  // link came from.
  if (result.alias) reader.insertAdjacentHTML('beforeend', aliasNoteHtml(result.alias));
  // A case opened from text typed in a box offers to search for that text instead (D163).
  if (fromText) reader.insertAdjacentHTML('beforeend', routeNoteHtml(fromText));
  reader.appendChild(multiEl);
  const readerContent = document.createElement('div');
  readerContent.className = 'reader';
  reader.appendChild(readerContent);

  // Citations processed per case file, so switching between the cases on
  // one page re-renders each with its own offsets.
  const citationsByCase = new Map();
  const pagesByCase = new Map();
  // A case read by its zip span (D180) has no zip in memory: its CAP HTML is read by range
  // after the text is shown (spanZip's html), and the reader is drawn again with the page
  // markers and footnotes once it's in, going to the pin cite's page if there was one.
  const pagesFor = (caseFile, caseData) => {
    if (pagesByCase.has(caseFile)) return pagesByCase.get(caseFile);
    if (result.zipData || !result.zip) {
      pagesByCase.set(caseFile, casePages(result.zipData, caseFile, caseData));
      return pagesByCase.get(caseFile);
    }
    pagesByCase.set(caseFile, NO_PAGES);
    result.zip.html(caseFile).then((html) => {
      const layout = htmlPages(html, caseData);
      pagesByCase.set(caseFile, layout);
      if (!load.current() || shownCaseFile !== caseFile || !layout.pages) return;
      const cached = citationsByCase.get(caseFile) || null;
      renderReader(readerContent, caseData, cached, layout.pages, layout.footnotes);
      if (cached) {
        setupCiteHovers(readerContent, resolve);
        wireCiteNav(citationStatusHandle.listEl, readerContent);
      }
      if (pendingPin !== null) goToPage(pendingPin);
      else markTarget();
      pendingPin = null;
    }, () => {});
    return NO_PAGES;
  };
  // A pin cite waiting for the page markers of a case read by its span.
  let pendingPin = null;
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
  if (!cite && pin && !target && !pagesByCase.get(result.caseFile)?.pages) pendingPin = pin;
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
    if (!result.zipData) wireLazyPdfLink(sidebar, result, caseFile);
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
    // Whether this case is still the one on screen: another case of the page, or another
    // load altogether, may have replaced it while its citations were being found.
    const shown = () => load.current() && shownCaseFile === caseFile;
    try {
      const { unique, occurrencesByOpinion, groups } = await processCitations(
        caseData, undefined, undefined, undefined, undefined, undefined, { signal: load.signal },
      );
      const citationMap = new Map(unique.map(c => [c.key, c]));
      const citations = { unique, citationMap, occurrencesByOpinion, groups };
      // Cache empty results too, so switching back doesn't detect again.
      citationsByCase.set(caseFile, citations);
      if (!shown()) return;
      if (unique.length > 0) {
        const layout = pagesFor(caseFile, caseData);
        renderReader(readerContent, caseData, citations, layout.pages, layout.footnotes);
        markTarget();
      }
      updateCitationStatus(handle, caseData, unique, 'done', groups);
      setupCiteHovers(readerContent, resolve);
      wireCiteNav(handle.listEl, readerContent);
    } catch (e) {
      // A pass ended by another load (its AbortError) is no failure.
      if (!load.current()) return;
      console.error('Citation detection failed:', e);
      if (!shown()) return;
      updateCitationStatus(handle, caseData, null, 'error');
    }
  }

  let switching = 0;
  async function switchCase(caseFile) {
    if (!result.zipData && !result.zip) {
      // Several CourtListener records start on the page; each is its own fetch.
      doResolve(result.reporter, result.volume, result.page, result.allCases.indexOf(caseFile) + 1);
      return;
    }
    // A case read by its span (D180) reads the other by its own span; the zip, when a page
    // view has fetched it, has them all.
    const turn = ++switching;
    let caseData;
    try {
      caseData = result.zipData ? extractCase(result.zipData, caseFile) : await result.zip.caseData(caseFile);
    } catch {
      if (turn === switching && load.current()) doResolve(result.reporter, result.volume, pageFromFile(caseFile), seqFromFile(caseFile));
      return;
    }
    if (turn !== switching || !load.current()) return;
    const seq = seqFromFile(caseFile);
    const page = pageFromFile(caseFile);
    // The case shown is now this one (#268): the hash names it, and the hashchange that
    // follows is ours, not a new case to resolve. A new object, so a page view still
    // opening for the case before sees it isn't current (openPageView).
    const shownResult = { ...result, caseData, caseFile, seq };
    currentResult = shownResult;
    setHash(result.reporter, result.volume, page, seq);
    lastResolvedHash = window.location.hash;
    if (!routePath()) showKeyNotice(null);
    updateTopbar(caseData);
    updatePrevNext(result, caseFile);
    renderMultiNotice(multiEl, result.allCases, caseFile, switchCase);
    resetPageViews();
    showCase(caseFile, caseData, shownResult);
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

// A copy of stare.pub without the case's text (sources.js hasFeature): the status line says
// so, with a link to the same case on stare.pub, where the case would have been. A case
// opened from a link goes back to the landing, as a failed lookup does.
function notInCopy(err, reporter, volume, page, seq, fromText) {
  const path = window.location.pathname.length > 1
    ? `${window.location.pathname}${window.location.hash}`
    : `/${caseHash(reporter, volume, page, seq)}`;
  const shown = Object.assign(new NotInCopyError(err.feature), { href: upstreamUrl(path) });
  if (landing.classList.contains('hidden') && !currentResult) {
    showLanding();
    landingBox.fill(fromText || '', { reporter, volume, page, seq });
  }
  const isLanding = !landing.classList.contains('hidden');
  setStatus(shown.message, false);
  (isLanding ? landingStatus : statusBar).replaceChildren(...notInCopyNodes(document, shown));
}

// `fromText` is the text a box opened the case from, for the reader's "Search for this text
// instead"; null when the case came from a link, a suggestion or the arrows.
async function doResolve(reporter, volume, page, seq = null, pin = null, cite = null, view = null, fromText = null) {
  // Ends any load still under way: from here on only this one sets the hash, the status
  // line and the case shown (#267).
  const load = loads.start();
  landingBtn.disabled = true;
  setStatus('', false);
  showWasmBar(() => doResolve(reporter, volume, page, seq, pin, cite, view, fromText));

  try {
    const result = await resolve(reporter, volume, page, (msg) => { if (load.current()) setStatus(msg, false); }, seq);
    if (!load.current()) return;
    currentResult = result;
    // The folder the case is in, which can differ from the volume as cited (a3d/138-2).
    // A citation that resolved through an alias (#151) goes to the case it names, whose
    // pages a pin cite in the other printing doesn't number.
    if (result.alias) setHash(result.reporter, result.volume, result.page, result.seq, null);
    else setHash(reporter, result.volume, page, result.seq, pin, cite, cite ? null : view);
    lastResolvedHash = window.location.hash;
    if (!routePath()) showKeyNotice(null);
    pendingView = result.alias || cite ? null : view;
    showResolved(result, result.alias ? null : pin, result.alias ? null : cite, load, fromText);
  } catch (err) {
    if (!load.current()) return;
    if (err instanceof NotInCopyError) {
      notInCopy(err, reporter, volume, page, seq, fromText);
      return;
    }
    if (!(err instanceof WasmLoadError)) setStatus(err.message, true);
    // Only go to landing if we're not already showing a case
    // (i.e., this was a landing page search, not an inline edit). A WASM
    // failure stays on the reader's shell, where its Retry button is.
    if (landing.classList.contains('hidden') && !currentResult && !(err instanceof WasmLoadError)) {
      if (routePath()) {
        setRoute(null);
        noIndex();
      }
      showLanding();
      setStatus(err.message, true);
      landingBox.fill(fromText || '', { reporter, volume, page, seq });
    }
  } finally {
    if (load.current()) landingBtn.disabled = false;
  }
}

const SITE = 'https://stare.pub';
const keyNotice = document.getElementById('key-notice');
// Each openAddress call; a lookup that returns after another started is dropped.
let addressSeq = 0;

// Tells crawlers that render the page not to index it: the fallback serves the reader with
// a 200 for an address that names nothing, so the page says so itself.
function noIndex() {
  if (document.head.querySelector('meta[name="robots"]')) return;
  const meta = document.createElement('meta');
  meta.name = 'robots';
  meta.content = 'noindex';
  document.head.appendChild(meta);
}

// The landing with `msg` as its error, for an address that names no case.
function notFound(msg) {
  loads.cancel();
  setRoute(null);
  noIndex();
  showKeyNotice(null);
  showLanding();
  setStatus(msg, true);
}

function showKeyNotice(msg) {
  if (!keyNotice) return;
  keyNotice.textContent = msg || '';
  keyNotice.classList.toggle('hidden', !msg);
}

// Opens a permanent address (#283): `/k/<key>/` from the minted-key ledger, `/c/.../` from
// the per-volume index like a typed citation. `at` is parseCasePath's; `extra`, the hash's
// params, for a place in the case (`/k/<key>/#a2d/31/647-01~c=3`).
async function openAddress(at, extra = null) {
  const seq = ++addressSeq;
  if (at.kind === 'bad') {
    notFound(at.prefix === 'k'
      ? `${location.pathname} isn't a case key. A key looks like /k/us/dc/69/1943-05-11/.`
      : `${location.pathname} isn't a citation address. One looks like /c/us/a2d/31/647/.`);
    return;
  }
  landing.classList.add('hidden');
  resolved.classList.remove('hidden');
  showKeyNotice(null);
  let target;
  if (at.kind === 'c') {
    // The index has no jurisdiction level yet (D97): a reporter's jurisdiction is the one
    // its PDFs are filed under, and an address with another is corrected to it.
    const jurisdiction = pdfJurisdiction(at.reporter);
    const path = citationPath(jurisdiction, at.reporter, at.volume, at.page, at.n);
    if (path !== location.pathname) history.replaceState(history.state, '', path + location.hash);
    setRoute(path, SITE + path);
    target = { reporter: at.reporter, volume: at.volume, page: at.page, seq: at.n };
  } else {
    setStatus('Looking up the case key...', false);
    let hit;
    try {
      hit = await resolveKey(at.key);
    } catch (e) {
      if (seq !== addressSeq) return;
      console.warn('Key lookup failed:', e);
      notFound(`Couldn't reach the key ledger to look up ${at.key}. Check your connection and try again.`);
      return;
    }
    if (seq !== addressSeq) return;
    if (!hit.found) {
      notFound(`stare.pub has no case with the key ${at.key}. A decision that's held for review or `
        + 'that the key rules refuse has no key yet; try its citation instead.');
      return;
    }
    // A replaced key names its decision's current key, which the address shows instead.
    const path = keyPath(hit.current);
    if (path !== location.pathname) history.replaceState(history.state, '', path + location.hash);
    const printing = pickPrinting(hit.decision?.sources, hit.current);
    if (!printing) {
      const cl = clusters(hit.decision?.sources);
      notFound(`The decision ${hit.current} has no printing stare.pub holds`
        + (cl.length ? ` yet; its CourtListener record is https://www.courtlistener.com/opinion/${cl[0]}/.` : '.'));
      return;
    }
    setRoute(path, SITE + path);
    if (hit.provisional) {
      showKeyNotice('This key is provisional: trustworthy sources disagree about a fact it is computed from, '
        + 'so it may be corrected.');
    }
    target = printing;
  }
  landingInput.value = `${target.reporter} ${target.volume} ${target.page}`;
  landingRoute.update();
  // A place in the case the hash names, when it's the case the address opens.
  const place = extra && extra.reporter === target.reporter && extra.volume === target.volume
    && extra.page === target.page ? extra : null;
  doResolve(target.reporter, target.volume, target.page, target.seq ?? place?.seq ?? null,
    place?.pin ?? null, place?.cite ?? null,
    place?.view ? { view: place.view, page: place.viewPage } : null);
}

// Where a box's text goes (D163): `{ cite, text }` for a case to open, `{ search }` for the
// full-text search (search.astro). Text routeOf reads as words goes straight to the search,
// without loading the typeahead or the parser's WASM. Text it reads as a citation opens the
// case the box was filled with while the text is unchanged (searchbox.js), else what the
// parser reads, else a reporter typed first by its abbreviation (`Misc. 32 426`), which only
// the typeahead's reporter list knows; a citation none of them reads goes to the search,
// which then doesn't ask "Did you mean". `onParse` runs before the parser is awaited. A WASM
// that fails to load throws (WasmLoadError).
async function routeBox(box, input, onParse) {
  const text = input.value.trim();
  if (routeOf(text) !== 'cite') return { search: text };
  const b = await box.load();
  const kept = b?.kept();
  if (kept) return { cite: kept, text };
  onParse?.();
  const parsed = await parseInput(text) || await b?.parse() || null;
  if (parsed) return { cite: parsed, text };
  markNotCitation(text);
  return { search: text };
}

const EMPTY_BOX = 'Enter a citation (e.g., 31 A.2d 647 or a2d 31 647), or words to search for';

// Landing form submit
landingForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  landingBox.close();
  setStatus('', false);
  const text = landingInput.value.trim();
  if (!text) {
    setStatus(EMPTY_BOX, true);
    return;
  }
  let to;
  try {
    to = await routeBox(landingBox, landingInput, () => showWasmBar(() => landingForm.requestSubmit()));
  } catch (err) {
    if (!(err instanceof WasmLoadError)) setStatus(err.message, true);
    return;
  }
  if (to.search) {
    location.assign(searchHref(to.search));
    return;
  }
  const p = to.cite;
  doResolve(p.reporter, p.volume, p.page, p.seq, null, null, null, to.text);
});

// Inline citation editing in topbar
const topbarCiteInput = document.getElementById('topbar-cite-input');
const topbarSuggest = document.getElementById('topbar-suggest');
const topbarGo = document.getElementById('topbar-go');
const topbarRoute = attachRouteLabel(topbarCiteInput, topbarGo, document.getElementById('topbar-route-status'));

// The top bar's editor suggests citations as it is typed in (#248); a page suggestion
// opens its case. Attached before the editor's own keys below, so it takes Enter and
// Escape first while its list is open.
const topbarBox = lazySearchBox(topbarCiteInput, topbarSuggest, document.getElementById('topbar-suggest-status'), {
  onPick: (t) => {
    editSubmitting = true;
    stopEditing();
    doResolve(t.reporter, t.volume, t.page, t.seq);
    editSubmitting = false;
  },
  // Under the editor; at phone width the stylesheet spans it across the screen instead.
  position: (list) => list.style.setProperty('--suggest-left', `${topbarCiteInput.offsetLeft}px`),
  route: topbarRoute,
});

function startEditing() {
  topbarCite.classList.add('hidden');
  topbarCiteInput.classList.remove('hidden');
  topbarGo.classList.remove('hidden');
  // Pre-fill with the citation as written (#248), remembering the case shown, so the
  // same text reopens it even on a page several cases start on.
  if (currentResult) {
    topbarBox.fill(topbarCite.textContent, getHashParams() || currentResult);
  } else {
    topbarBox.fill('', null);
  }
  topbarCiteInput.focus();
  topbarCiteInput.select();
}

function stopEditing() {
  topbarBox.close();
  topbarCiteInput.classList.add('hidden');
  topbarGo.classList.add('hidden');
  topbarCite.classList.remove('hidden');
}

let editSubmitting = false;

topbarCite.addEventListener('click', startEditing);

// The top bar's box routes its text like the landing's (routeBox): a citation opens, words
// go to the search.
async function submitTopbar() {
  if (!topbarCiteInput.value.trim()) return;
  let to;
  try {
    to = await routeBox(topbarBox, topbarCiteInput, () => showWasmBar(null));
  } catch (err) {
    stopEditing();
    if (!(err instanceof WasmLoadError)) setStatus(err.message, true);
    return;
  }
  if (to.search) {
    location.assign(searchHref(to.search));
    return;
  }
  editSubmitting = true;
  stopEditing();
  doResolve(to.cite.reporter, to.cite.volume, to.cite.page, to.cite.seq, null, null, null, to.text);
  editSubmitting = false;
}

// On the top bar rather than the input: the typeahead attaches to the input when it loads,
// after this, and it must see Enter and Escape first while its list is open.
document.getElementById('topbar').addEventListener('keydown', (e) => {
  if (e.target !== topbarCiteInput) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    submitTopbar();
  }
  if (e.key === 'Escape') {
    stopEditing();
  }
});

// The button keeps the focus in the box when clicked, so the box's blur doesn't close the
// editor first; tabbed to, it keeps the editor open too.
topbarGo.addEventListener('mousedown', (e) => e.preventDefault());
topbarGo.addEventListener('click', () => submitTopbar());
topbarGo.addEventListener('blur', (e) => {
  if (!editSubmitting && e.relatedTarget !== topbarCiteInput) stopEditing();
});

topbarCiteInput.addEventListener('blur', (e) => {
  if (!editSubmitting && e.relatedTarget !== topbarGo) stopEditing();
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

// Tab switching: the Reader (the case's text), the Archival PDF (our PDF of the volume,
// pdfviewer.js) and the Raw Scans (CAP's page images from the volume's tar,
// scanviewer.js). Neither page view loads anything until its tab is first opened. A page
// view and its page are in the hash (`~v=pdf&p=3`), so a page can be linked; the Reader
// takes them out.
const VIEWS = {
  reader: [tabReader, reader],
  pdf: [tabPdf, pdfViewerEl],
  scans: [tabPages, pageViewerEl],
};

function showView(name) {
  for (const [key, [tab, el]] of Object.entries(VIEWS)) {
    tab.classList.toggle('active', key === name);
    el.classList.toggle('hidden', key !== name);
  }
}

// The page each page view is on, for the hash when its tab is shown again.
const viewPages = { pdf: 1, scans: 1 };

// Put the page view and its page in the hash (`~v=pdf&p=3`), or take them out (`view`
// null), without a history entry or a hashchange.
function setViewHash(view) {
  const p = getHashParams();
  if (!p) return;
  const hash = caseHash(p.reporter, p.volume, p.page, p.seq, null, view ? null : p.cite,
    view ? { view, page: viewPages[view] } : null);
  if (window.location.hash === hash) return;
  replaceHash(hash);
  lastResolvedHash = hash;
}

const onViewPage = (view) => (i) => {
  viewPages[view] = i;
  if (!VIEWS[view][1].classList.contains('hidden')) setViewHash(view);
};

// Each page view's module, imported the first time its tab opens (#265).
const VIEW_IMPORTS = {
  pdf: () => import('./pdfviewer.js'),
  scans: () => import('./scanviewer.js'),
};
const VIEW_NAMES = { pdf: 'The Archival PDF view', scans: 'The Raw Scans view' };

// What a page view shows when its module didn't load; the Reader is unaffected. Reloading
// keeps the view in the hash, so it is tried again.
function viewFailed(view, el) {
  el.innerHTML = `<div class="pdf-view-message" role="status" data-view-failed="${view}">${VIEW_NAMES[view]}`
    + ' couldn\u2019t load: its script was blocked or failed to download. A content blocker (an ad or'
    + ' tracker blocker) is the most likely cause; allow stare.pub in it, then'
    + ' <a href="" class="view-reload">reload the page</a>. The Reader still works.</div>';
  el.querySelector('.view-reload').addEventListener('click', (e) => {
    e.preventDefault();
    window.location.reload();
  });
}

// Show a page view, at the case's page `page` when given (the hash's), loading it the
// first time.
async function openPageView(view, page = null) {
  showView(view);
  if (page) viewPages[view] = page;
  setViewHash(view);
  if (!currentResult?.zipData && !currentResult?.zip) return;
  const el = VIEWS[view][1];
  // A copy of stare.pub without the archival PDFs or the raw scans says so in the view.
  const feature = view === 'pdf' ? 'pages' : 'raw-scans';
  if (!hasFeature(feature)) {
    const r = currentResult;
    el.innerHTML = notInCopyHtml(Object.assign(new NotInCopyError(feature), {
      href: upstreamUrl(`/${caseHash(r.reporter, r.volume, r.page, r.seq, null, null, { view, page: viewPages[view] })}`),
    }));
    return;
  }
  if (view === 'pdf' ? pdfViewerLoaded : pageViewerLoaded) {
    if (page) goToViewPage(el, page);
    return;
  }
  if (view === 'pdf') pdfViewerLoaded = true;
  else pageViewerLoaded = true;
  const result = currentResult;
  try {
    viewModules[view] = await VIEW_IMPORTS[view]();
  } catch (e) {
    console.error(`${VIEW_NAMES[view]} could not load:`, e);
    // Another case shown meanwhile has reset the view.
    if (currentResult !== result) return;
    if (view === 'pdf') pdfViewerLoaded = false;
    else pageViewerLoaded = false;
    viewFailed(view, el);
    return;
  }
  if (currentResult !== result) return;
  // A case read by its zip span (D180) fetches the zip now: the views read the case's page
  // orders and printed page labels out of it, as before.
  if (!result.zipData) {
    el.innerHTML = '<div class="page-viewer-loading"><span class="spinner"></span> Loading the volume\'s case data...</div>';
    try {
      result.zipData = await result.zip.loadZip();
    } catch {
      if (currentResult !== result) return;
      if (view === 'pdf') pdfViewerLoaded = false;
      else pageViewerLoaded = false;
      el.innerHTML = '<div class="pdf-view-message">Couldn\'t reach the server. Check your connection and try again.</div>';
      return;
    }
    if (currentResult !== result) return;
  }
  if (view === 'pdf') {
    await viewModules.pdf.renderPdfViewer(pdfViewerEl, currentResult, {
      openScans: () => openPageView('scans'), page: viewPages.pdf, onPage: onViewPage('pdf'),
    });
  } else {
    await viewModules.scans.renderPageViewer(pageViewerEl, currentResult, { page: viewPages.scans, onPage: onViewPage('scans') });
  }
}

// A page view already open goes to the case's page `page`. pageshell.js came in with the
// view, so this import doesn't fetch.
async function goToViewPage(el, page) {
  let shell;
  try {
    shell = await import('./pageshell.js');
  } catch {
    return;
  }
  const view = shell.pageViewIn(el);
  if (view && view.index !== page) view.go(page);
}

tabReader.addEventListener('click', () => {
  showView('reader');
  setViewHash(null);
});
tabPdf.addEventListener('click', () => openPageView('pdf'));
tabPages.addEventListener('click', () => openPageView('scans'));

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
    if (params.view && !tabPdf.classList.contains('hidden')) {
      openPageView(params.view, params.viewPage);
      return;
    }
    showView('reader');
    if (params.cite) {
      // Before the citations are found, the place waits for them.
      if (!citeNav?.goTo(params.cite)) pendingCite = citeNav ? null : params.cite;
      return;
    }
    goToPage(params.pin);
    return;
  }
  landingInput.value = `${params.reporter} ${params.volume} ${params.page}`;
  landingRoute.update();
  doResolve(params.reporter, params.volume, params.page, params.seq, params.pin, params.cite,
    params.view ? { view: params.view, page: params.viewPage } : null);
});

// Handle back to empty hash (return to landing). A case still loading is dropped, so it
// can't open over the landing when it arrives, and Forward opens the case again.
window.addEventListener('hashchange', () => {
  if (parseCasePath(location.pathname)) return;
  if (!window.location.hash || window.location.hash === '#') {
    loads.cancel();
    lastResolvedHash = '';
    landingBtn.disabled = false;
    showLanding();
  }
});

// Auto-resolve from URL hash on load. A case opens on the reader's shell, as
// index.astro's <head> script already showed it (data-route="case"), so the landing never
// flashes; a lookup that fails goes back to the landing with its error. A permanent
// address (`/k/<key>/`, `/c/.../`, #283) opens the same way, and any other path the
// single-page-application fallback served the reader for says there's nothing there.
const initial = getHashParams();
const initialPath = parseCasePath(location.pathname);
document.documentElement.removeAttribute('data-route');
if (initialPath) {
  openAddress(initialPath, initial);
} else if (location.pathname !== '/' && location.pathname !== '/index.html') {
  notFound(`There's no page at ${location.pathname}.`);
} else if (initial) {
  landing.classList.add('hidden');
  resolved.classList.remove('hidden');
  landingInput.value = `${initial.reporter} ${initial.volume} ${initial.page}`;
  landingRoute.update();
  // The search page's box sends a citation here with the text it was typed as (boxroute.js).
  doResolve(initial.reporter, initial.volume, initial.page, initial.seq, initial.pin, initial.cite,
    initial.view ? { view: initial.view, page: initial.viewPage } : null, takeHandOff(window.location.hash));
}

// Back or Forward to a permanent address the page isn't showing opens it again (the ledger
// and the index files are cached, so it's quick). One the page shows is the hashchange
// handler's.
window.addEventListener('popstate', () => {
  const at = parseCasePath(location.pathname);
  if (!at || routePath() === location.pathname) return;
  openAddress(at, parseHash(location.hash));
});

// Fetch and compile the WASM in the background once the page has painted;
// nothing waits on it until a feature needs it.
preloadWasm();

// Everything above ran: the boot guard in <head> (src/lib/bootguard.js) stops waiting.
globalThis.stareBoot?.ready();
