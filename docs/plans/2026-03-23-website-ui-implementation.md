# Website UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the stare.pub website from a basic 3-field form into the two-panel case law reader described in the design spec.

**Architecture:** Single Astro page (SPA-like behavior via hash routing). CSS in Astro-imported files for bundling. JS as ES modules in `public/js/` loaded via `<script is:inline type="module">`. WASM bindings unchanged in `public/wasm/`.

**Tech Stack:** Astro 6, vanilla JS (ES modules), CSS custom properties, IndexedDB, stare-wasm (273 KB)

**Spec:** `docs/plans/2026-03-23-website-ui-design.md`

**Existing mockup:** `.superpowers/brainstorm/3612330-1774292807/full-mockup-dark-v3.html` — use this as the CSS reference.

---

## File Structure

```
web/src/
  pages/index.astro          — rewrite: HTML skeleton, head scripts, CSS/JS imports
  styles/
    theme.css                — create: CSS custom properties (light + dark tokens)
    layout.css               — create: topbar, two-panel, sidebar, tabs, mobile
    reader.css               — create: reader typography, citations, page markers
web/public/
  js/
    cache.js                 — create: IndexedDB caching layer with in-memory fallback
    resolve.js               — create: WASM init, fetch pipeline, error handling
    ui.js                    — create: DOM manipulation, state transitions, rendering
    router.js                — create: hash-based routing
    main.js                  — create: entry point, wires modules together
  data/a2d/31.bin            — exists: test index
  data/a2d/31.multi          — exists: test multi-case data
  wasm/                      — exists: WASM bindings (rebuilt via wasm-pack)
```

---

### Task 1: CSS Theme Tokens + FOUC Prevention

**Files:**
- Create: `web/src/styles/theme.css`
- Modify: `web/src/pages/index.astro`

- [ ] **Step 1: Create theme.css with all CSS custom properties**

Port the token definitions from the mockup HTML. Both `:root` (light) and `[data-theme="dark"]` sets.

```css
/* web/src/styles/theme.css */
* { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg: #fff; --bg-alt: #fafafa; --bg-surface: #f5f5f0;
  --text: #1a1a1a; --text-body: #333; --text-secondary: #888; --text-tertiary: #bbb;
  --border: #e8e8e8; --border-light: #eee;
  --topbar-bg: #1a1a1a; --topbar-text: #fff; --topbar-muted: #888;
  --topbar-divider: #555; --topbar-cite: #ccc; --topbar-edit-border: #444;
  --link: #2563eb; --link-hover: #1d4ed8;
  --unresolved: #999; --unresolved-border: #ccc;
  --status-ok: #22c55e; --status-no: #ddd;
  --cite-badge-bg: #e8e8e8; --cite-badge-text: #555;
  --cite-badge-primary-bg: #1a1a1a; --cite-badge-primary-text: #fff;
  --sidebar-action: #555; --sidebar-meta-strong: #555;
  --tab-active-border: #1a1a1a; --tab-active-text: #1a1a1a;
  --footnote-text: #666;
  --error-bg: #fef2f2; --error-border: #fecaca; --error-text: #dc2626;
  --status-bg: #f0f7ff; --status-border: #dbeafe; --status-text: #2563eb;
}

[data-theme="dark"] {
  --bg: #181818; --bg-alt: #1e1e1e; --bg-surface: #252525;
  --text: #e4e4e4; --text-body: #ccc; --text-secondary: #888; --text-tertiary: #555;
  --border: #333; --border-light: #2a2a2a;
  --topbar-bg: #111; --topbar-text: #e4e4e4; --topbar-muted: #777;
  --topbar-divider: #444; --topbar-cite: #aaa; --topbar-edit-border: #555;
  --link: #60a5fa; --link-hover: #93c5fd;
  --unresolved: #666; --unresolved-border: #444;
  --status-ok: #4ade80; --status-no: #444;
  --cite-badge-bg: #333; --cite-badge-text: #aaa;
  --cite-badge-primary-bg: #2563eb; --cite-badge-primary-text: #fff;
  --sidebar-action: #aaa; --sidebar-meta-strong: #bbb;
  --tab-active-border: #e4e4e4; --tab-active-text: #e4e4e4;
  --footnote-text: #888;
  --error-bg: #2d1b1b; --error-border: #5c2626; --error-text: #f87171;
  --status-bg: #1a2332; --status-border: #253344; --status-text: #60a5fa;
}

body {
  font-family: -apple-system, system-ui, 'Segoe UI', sans-serif;
  background: var(--bg); color: var(--text);
  transition: background 0.2s, color 0.2s;
}
```

- [ ] **Step 2: Add FOUC prevention inline script to index.astro head**

Replace the current `index.astro` head section. The inline script runs before first paint.

```html
<!-- In <head> of index.astro, before any CSS -->
<script is:inline>
  try {
    var theme = localStorage.getItem('stare-theme');
    if (theme === 'dark' || (!theme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  } catch(e) {}
</script>
```

- [ ] **Step 3: Import theme.css in index.astro frontmatter**

```astro
---
import '../styles/theme.css';
---
```

- [ ] **Step 4: Verify in browser — page loads with theme tokens, no FOUC**

Run: `npm run dev --prefix web`
Expected: page uses CSS variables, setting localStorage `stare-theme=dark` and reloading shows dark background without flash.

- [ ] **Step 5: Commit**

```bash
git add web/src/styles/theme.css web/src/pages/index.astro
git commit -m "feat(web): add CSS theme tokens with light/dark mode and FOUC prevention"
```

---

### Task 2: Layout CSS + HTML Skeleton

**Files:**
- Create: `web/src/styles/layout.css`
- Modify: `web/src/pages/index.astro`

- [ ] **Step 1: Create layout.css — topbar, two-panel, sidebar, tabs**

Port layout styles from mockup. Include topbar, `.layout` flex container, `.main`, `.sidebar`, `.view-tabs`, `.sidebar-section`, `.sidebar-toggle`, and mobile breakpoint.

Key classes:
```css
.topbar { position: sticky; top: 0; z-index: 10; background: var(--topbar-bg); ... }
.layout { display: flex; min-height: calc(100vh - 40px); }
.main { flex: 1; min-width: 0; border-right: 1px solid var(--border); }
.sidebar { width: 300px; min-width: 300px; background: var(--bg-alt); overflow-y: auto; }
.view-tabs { display: flex; border-bottom: 1px solid var(--border); background: var(--bg-alt); }
/* Landing state: centered input */
.landing { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 80vh; }
/* Hidden states */
.hidden { display: none !important; }
@media (max-width: 768px) {
  .sidebar { display: none; }
  .sidebar.open { display: block; position: fixed; right: 0; top: 40px; bottom: 0; z-index: 15; width: 300px; box-shadow: -2px 0 8px rgba(0,0,0,0.2); }
  .sidebar-toggle { display: block; }
  .reader { padding: 20px 16px 48px; }
  .topbar-case { display: none; }
}
```

- [ ] **Step 2: Rewrite index.astro HTML — landing + resolved skeleton**

Two states in the DOM, toggled via `.hidden` class:

```html
<body>
  <!-- Landing state -->
  <div id="landing" class="landing">
    <h1 class="landing-brand">stare.pub</h1>
    <p class="landing-subtitle">U.S. case law citation resolution</p>
    <form id="landing-form" class="landing-form">
      <input id="landing-input" type="text" placeholder="a2d 31 647" autocomplete="off" />
      <button type="submit" id="landing-btn">Resolve</button>
    </form>
    <div id="landing-status" class="status-line"></div>
  </div>

  <!-- Resolved state (hidden initially) -->
  <div id="resolved" class="hidden">
    <div class="topbar" id="topbar">
      <span class="topbar-brand">stare.pub</span>
      <span class="topbar-divider">|</span>
      <span class="topbar-cite" id="topbar-cite"></span>
      <span class="topbar-case" id="topbar-case"></span>
      <button id="theme-btn" class="theme-toggle" title="Toggle dark mode">&#9790;</button>
      <button id="edit-btn" class="topbar-edit">Edit</button>
    </div>
    <div id="status-bar" class="status-line hidden"></div>
    <div class="layout">
      <div class="main">
        <div class="view-tabs">
          <div class="view-tab active">Reader</div>
          <div class="view-tab" style="opacity:0.4;cursor:default" title="Coming soon">Original Pages</div>
        </div>
        <div id="reader" class="reader"></div>
      </div>
      <div class="sidebar" id="sidebar"></div>
    </div>
  </div>
  <button class="sidebar-toggle hidden" id="sidebar-toggle">&#9776;</button>
</body>
```

- [ ] **Step 3: Import layout.css in frontmatter**

```astro
---
import '../styles/theme.css';
import '../styles/layout.css';
---
```

- [ ] **Step 4: Verify — landing page is centered, skeleton elements visible when .hidden removed in devtools**

- [ ] **Step 5: Commit**

```bash
git add web/src/styles/layout.css web/src/pages/index.astro
git commit -m "feat(web): add two-panel layout skeleton with landing and resolved states"
```

---

### Task 3: Reader CSS

**Files:**
- Create: `web/src/styles/reader.css`
- Modify: `web/src/pages/index.astro` (import only)

- [ ] **Step 1: Create reader.css — typography, citations, page markers, sidebar elements**

```css
/* web/src/styles/reader.css */
.reader { max-width: 680px; margin: 0 auto; padding: 32px 24px 64px; }
.reader-header { margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid var(--border-light); }
.reader-title { font-family: Georgia, 'Times New Roman', serif; font-size: 22px; font-weight: 600; line-height: 1.3; color: var(--text); }
.reader-meta { margin-top: 6px; font-size: 14px; color: var(--text-secondary); }
.reader-author { font-family: Georgia, 'Times New Roman', serif; font-style: italic; color: var(--text-secondary); margin-bottom: 16px; font-size: 15px; }
.reader-text { font-family: Georgia, 'Times New Roman', serif; font-size: 16px; line-height: 1.8; color: var(--text-body); }
.reader-text p { margin-bottom: 16px; }

.cite-link { color: var(--link); text-decoration: none; border-bottom: 1px dotted var(--link); cursor: pointer; transition: all 0.15s; }
.cite-link:hover { color: var(--link-hover); border-bottom-style: solid; }
.cite-unresolved { color: var(--unresolved); border-bottom: 1px dotted var(--unresolved-border); cursor: default; }
.page-marker { font-family: -apple-system, system-ui, sans-serif; font-size: 11px; color: var(--text-tertiary); display: inline; margin: 0 2px; user-select: none; }

.cite-badge { display: inline-block; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; padding: 3px 10px; background: var(--cite-badge-bg); border-radius: 4px; margin: 2px 4px 2px 0; color: var(--cite-badge-text); transition: background 0.2s, color 0.2s; }
.cite-badge.primary { background: var(--cite-badge-primary-bg); color: var(--cite-badge-primary-text); font-weight: 500; }

.cited-case { padding: 6px 0; display: flex; align-items: center; gap: 6px; }
.cited-case + .cited-case { border-top: 1px solid var(--border-light); }
.cited-case-link { color: var(--link); text-decoration: none; font-size: 13px; flex: 1; }
.cited-case-link:hover { text-decoration: underline; }
.cited-case-unresolved { color: var(--unresolved); font-size: 13px; flex: 1; }
.cited-status { font-size: 11px; width: 14px; text-align: center; }
.cited-status.ok { color: var(--status-ok); }
.cited-status.no { color: var(--status-no); }

.sidebar-action { display: flex; align-items: center; gap: 8px; padding: 8px 0; color: var(--sidebar-action); text-decoration: none; font-size: 13px; cursor: pointer; transition: color 0.15s; }
.sidebar-action:hover { color: var(--text); }
.sidebar-action-icon { width: 16px; text-align: center; font-size: 14px; }

.multi-notice { padding: 8px 16px; background: var(--status-bg); border-bottom: 1px solid var(--status-border); font-size: 13px; color: var(--status-text); }
.multi-notice a { color: var(--link); }

.status-line { padding: 6px 16px; font-size: 13px; color: var(--status-text); min-height: 1.4em; }
.status-line.error { color: var(--error-text); background: var(--error-bg); border-bottom: 1px solid var(--error-border); }
```

- [ ] **Step 2: Import in frontmatter**

- [ ] **Step 3: Commit**

```bash
git add web/src/styles/reader.css web/src/pages/index.astro
git commit -m "feat(web): add reader typography and citation styles"
```

---

### Task 4: Caching Layer

**Files:**
- Create: `web/public/js/cache.js`

- [ ] **Step 1: Write cache.js — IndexedDB with in-memory fallback**

```javascript
// web/public/js/cache.js
const DB_NAME = 'stare-cache';
const DB_VERSION = 2; // v2 adds 'multi' store
const STORES = ['bins', 'multi', 'zips'];

let memoryCache = {}; // fallback when IndexedDB unavailable

function openDB() {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const store of STORES) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null); // fall back to memory
    } catch (e) {
      resolve(null); // IndexedDB not available (private browsing)
    }
  });
}

export async function cacheGet(store, key) {
  const db = await openDB();
  if (!db) return memoryCache[`${store}:${key}`] || null;
  return new Promise((resolve) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

export async function cacheSet(store, key, value) {
  const db = await openDB();
  if (!db) { memoryCache[`${store}:${key}`] = value; return; }
  return new Promise((resolve) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve(); // swallow cache write errors
  });
}

export async function fetchCached(store, key, url) {
  const cached = await cacheGet(store, key);
  if (cached) return cached;
  const resp = await fetch(url);
  if (!resp.ok) {
    if (resp.status === 404) throw new Error(`NOT_FOUND:${url}`);
    throw new Error(`HTTP ${resp.status} fetching ${url}`);
  }
  const data = new Uint8Array(await resp.arrayBuffer());
  await cacheSet(store, key, data);
  return data;
}

export async function fetchCachedText(store, key, url) {
  const cached = await cacheGet(store, key);
  if (cached) return cached;
  const resp = await fetch(url);
  if (resp.status === 404) return null; // .multi may not exist
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  const text = await resp.text();
  await cacheSet(store, key, text);
  return text;
}
```

- [ ] **Step 2: Commit**

```bash
git add web/public/js/cache.js
git commit -m "feat(web): add IndexedDB caching layer with in-memory fallback"
```

---

### Task 5: Resolve Pipeline

**Files:**
- Create: `web/public/js/resolve.js`

- [ ] **Step 1: Write resolve.js — WASM init, fetch chain, error classification**

```javascript
// web/public/js/resolve.js
import { fetchCached, fetchCachedText } from './cache.js';

const INDEX_URL = '/data';
const ZIP_URL = 'https://static.case.law';

let wasm = null;

export function parseInput(raw) {
  const parts = raw.trim().replace(/\//g, ' ').split(/\s+/);
  if (parts.length !== 3) return null;
  const [reporter, volStr, pageStr] = parts;
  const volume = parseInt(volStr, 10);
  const page = parseInt(pageStr, 10);
  if (isNaN(volume) || isNaN(page)) return null;
  return { reporter: reporter.toLowerCase(), volume, page };
}

export async function resolve(reporter, volume, page, onStatus) {
  // Step 1: WASM init
  if (!wasm) {
    onStatus('Loading...');
    const mod = await import('/wasm/stare_wasm.js');
    await mod.default();
    wasm = mod;
  }

  // Step 2: Fetch .bin index
  const binKey = `${reporter}/${volume}.bin`;
  onStatus('Fetching index...');
  let binData;
  try {
    binData = await fetchCached('bins', binKey, `${INDEX_URL}/${reporter}/${volume}.bin`);
  } catch (e) {
    if (e.message.startsWith('NOT_FOUND'))
      throw new Error(`This volume hasn't been indexed yet. We're still building the index — check back soon.`);
    throw new Error(`Couldn't reach the server. Check your connection and try again.`);
  }

  // Step 2b: Fetch .multi (optional, may not exist)
  const multiKey = `${reporter}/${volume}.multi`;
  const multiData = await fetchCachedText('multi', multiKey, `${INDEX_URL}/${reporter}/${volume}.multi`);

  // Step 3: Lookup page
  onStatus('Looking up page...');
  const caseFile = wasm.lookup_page(binData, page);
  if (!caseFile) {
    throw new Error(`No case starts at page ${page} in ${reporter} vol. ${volume}.`);
  }

  // Step 3b: Check for multi-case pages
  let allCases = [caseFile];
  if (multiData) {
    const allJson = wasm.lookup_page_all(binData, multiData, page);
    allCases = JSON.parse(allJson);
  }

  // Step 4: Fetch .zip
  const zipKey = `${reporter}/${volume}.zip`;
  onStatus('Fetching case data...');
  let zipData;
  try {
    zipData = await fetchCached('zips', zipKey, `${ZIP_URL}/${reporter}/${volume}.zip`);
  } catch (e) {
    throw new Error(`Couldn't reach the server. Check your connection and try again.`);
  }

  // Step 5: Extract case
  onStatus('Extracting case...');
  const caseJsonStr = wasm.extract_case(zipData, caseFile);
  const caseData = JSON.parse(caseJsonStr);

  return {
    reporter,
    volume,
    page,
    caseFile,
    allCases,
    caseData,
    zipData, // keep ref for switching between multi-case entries
  };
}

export function extractCase(zipData, caseFile) {
  if (!wasm) throw new Error('WASM not initialized');
  const caseJsonStr = wasm.extract_case(zipData, caseFile);
  return JSON.parse(caseJsonStr);
}
```

- [ ] **Step 2: Commit**

```bash
git add web/public/js/resolve.js
git commit -m "feat(web): add resolve pipeline with WASM init, fetch chain, error handling"
```

---

### Task 6: UI Rendering

**Files:**
- Create: `web/public/js/ui.js`

- [ ] **Step 1: Write ui.js — render case into reader + sidebar**

```javascript
// web/public/js/ui.js

export function renderReader(el, caseData) {
  const cite = caseData.citations?.[0]?.cite || '';
  const court = caseData.court?.name || '';
  const juris = caseData.jurisdiction?.name_long || '';

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
    // Split text into paragraphs, preserve page markers [*NNN]
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
  const cite = caseData.citations?.[0]?.cite || '';
  const citeBadges = (caseData.citations || [])
    .map((c, i) => `<span class="cite-badge${i === 0 ? ' primary' : ''}">${esc(c.cite)}</span>`)
    .join(' ');

  const citedCases = (caseData.cites_to || [])
    .map(c => {
      const citeStr = c.cite || c;
      return `<div class="cited-case">
        <span class="cited-status no">&#10007;</span>
        <span class="cited-case-unresolved">${esc(typeof citeStr === 'string' ? citeStr : JSON.stringify(citeStr))}</span>
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
  // Convert [*NNN] page markers to styled spans
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
```

- [ ] **Step 2: Commit**

```bash
git add web/public/js/ui.js
git commit -m "feat(web): add UI rendering for reader view and sidebar"
```

---

### Task 7: Router

**Files:**
- Create: `web/public/js/router.js`

- [ ] **Step 1: Write router.js — hash sync, hashchange handling**

```javascript
// web/public/js/router.js

export function getHashParams() {
  const hash = window.location.hash.slice(1);
  if (!hash) return null;
  const parts = hash.replace(/\//g, ' ').split(/\s+/);
  if (parts.length !== 3) return null;
  const [reporter, volStr, pageStr] = parts;
  const volume = parseInt(volStr, 10);
  const page = parseInt(pageStr, 10);
  if (isNaN(volume) || isNaN(page)) return null;
  return { reporter: reporter.toLowerCase(), volume, page };
}

export function setHash(reporter, volume, page) {
  const newHash = `#${reporter}/${volume}/${page}`;
  if (window.location.hash !== newHash) {
    window.location.hash = newHash;
  }
}

export function onHashChange(callback) {
  window.addEventListener('hashchange', () => {
    const params = getHashParams();
    if (params) callback(params);
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add web/public/js/router.js
git commit -m "feat(web): add hash-based router"
```

---

### Task 8: Main Entry Point — Wire Everything Together

**Files:**
- Create: `web/public/js/main.js`
- Modify: `web/src/pages/index.astro` (replace inline script with module import)

- [ ] **Step 1: Write main.js — orchestrates all modules**

```javascript
// web/public/js/main.js
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

  // Multi-case notice
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

  // Wire sidebar actions
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
  // Update whichever status element is visible
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
    setLandingStatus('Enter a citation as: reporter volume page (e.g., a2d 31 647)', true);
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
  if (localStorage.getItem('stare-theme') === 'dark') {
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
```

- [ ] **Step 2: Update index.astro — replace inline script with module import**

Remove the existing `<script is:inline type="module">` block and replace with:

```html
<script is:inline type="module" src="/js/main.js"></script>
```

- [ ] **Step 3: Build and test end-to-end**

Run: `npm run build --prefix web && npm run preview --prefix web`
Test: navigate to `http://localhost:4321/#a2d/31/647`
Expected: landing → loading states → resolved view with reader + sidebar.

- [ ] **Step 4: Test dark mode toggle, edit button, hash navigation**

- [ ] **Step 5: Commit**

```bash
git add web/public/js/main.js web/src/pages/index.astro
git commit -m "feat(web): wire all modules into working site with routing and dark mode"
```

---

### Task 9: Multi-Case Page Testing

**Files:** None new (already implemented in Task 6 + Task 8)

- [ ] **Step 1: Test multi-case page**

Navigate to `http://localhost:4321/#a2d/31/657`
Expected: "2 cases start on this page: **0657-01** | 0657-02" notice. Clicking 0657-02 switches to Waterman v. Railway Express Agency.

- [ ] **Step 2: Commit if any fixes needed**

---

### Task 10: Mobile Responsive Testing + Polish

**Files:**
- Modify: `web/src/styles/layout.css` (if adjustments needed)

- [ ] **Step 1: Test at 768px and below**

Use browser devtools responsive mode. Verify:
- Sidebar hidden
- Hamburger button visible
- Clicking hamburger opens sidebar as overlay
- Top bar hides case name
- Reader padding reduced

- [ ] **Step 2: Fix any responsive issues found**

- [ ] **Step 3: Commit**

```bash
git add -A web/
git commit -m "fix(web): responsive polish for mobile layout"
```

---

### Task 11: Final Integration Test + Push

- [ ] **Step 1: Full test matrix**

| Test | Expected |
|------|----------|
| `#a2d/31/647` | D'Elia & Marks case renders |
| `#a2d/31/657` | Multi-case notice, both cases accessible |
| `#a2d/31/999` | "No case starts at page 999" error |
| `#fake/1/1` | "Volume hasn't been indexed" error |
| Dark mode toggle | Theme switches, persists on reload |
| Edit button | Returns to landing with input preserved |
| Back button after citation nav | Returns to previous case |
| Mobile (375px) | Sidebar hidden, hamburger works |
| Repeat lookup | Instant (cached in IndexedDB) |

- [ ] **Step 2: Push to origin**

```bash
git push
```

---

## Deferred to Follow-Up

These spec requirements are intentionally deferred from this plan to avoid N+1 fetch storms and keep the initial build focused:

- **Cited case resolvability check**: requires HEAD requests to each cited volume's `.bin` file. Adds latency proportional to citation count. Defer until we have a reporter availability manifest (a static JSON listing which reporters/volumes are indexed).
- **PDF availability check**: requires HEAD request to each volume PDF. Defer — link always points to static.case.law, which has the PDFs. If it 404s, the user sees the browser's 404 page — acceptable for now.
- **Clipboard fallback**: `navigator.clipboard` works on HTTPS (Cloudflare Pages) and localhost. Fallback to readonly input is only needed for plain HTTP — not a launch concern.

## Note on `web/src/wasm/`

The WASM artifacts exist in both `web/src/wasm/` (old location from initial scaffold) and `web/public/wasm/` (correct location for serving). The `public/wasm/` copy is the one used at runtime. The `src/wasm/` copy can be deleted during cleanup.

## Summary

11 tasks, progressive build. After Task 8, the site is fully functional. Tasks 9-11 are testing and polish. Each task produces a commit. The WASM crate and .bin/.multi data files are unchanged — this plan only touches `web/`.
