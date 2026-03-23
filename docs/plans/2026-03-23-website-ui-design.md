# Website UI Design — stare.pub

**Date:** 2026-03-23

## Overview

Serverless case law citation resolution website. All client-side via WASM (273 KB). Fetches .bin index and .zip case data over HTTP (from the site itself for bins, static.case.law for zips — later both from R2). Caches both in IndexedDB for instant repeat lookups.

## Layout

Two-panel layout:

- **Left (main)**: switchable between Reader view and Original Pages view (tab bar)
- **Right (sidebar)**: case metadata, citations, cited cases list, actions. Collapsible — hidden on mobile with hamburger toggle.

## Input Bar

Unified text field on the landing page. Accepts structured input today (`a2d 31 647` or `a2d/31/647`). When eyecite-rs lands, also accepts citation strings (`31 A.2d 647`).

After resolving, the input collapses into a slim sticky dark top bar showing:
- Brand (`stare.pub`)
- Citation (from case JSON `citations[0].cite`, e.g., `31 A.2d 647` — displayed only after zip is fetched and parsed)
- Case name (`D'Elia & Marks Co. v. Lyon`)
- Dark mode toggle (moon/sun)
- Edit button (re-expands to full input)

**Input parsing** (pre-eyecite-rs): split on whitespace or `/`. Normalize slug to lowercase. Reject if not exactly 3 parts or if volume/page aren't numeric. Show inline validation error.

## Typography & Visual Tone

- **Chrome** (header, sidebar, tabs): system sans-serif (`-apple-system, system-ui`), clean/modern
- **Body text** (reader view): Georgia serif, 16px, 1.8 line height, max-width 680px — warm, readable
- **Author line**: italic serif
- **Page break markers** (`[*648]`): small sans-serif, muted color, non-selectable

## Loading & Error States

**Loading pipeline** (3 sequential async steps):
1. WASM init (273 KB, first load only) — status text: "Loading..."
2. `.bin` fetch — status text: "Fetching index..."
3. `.zip` fetch (~400 KB) — status text: "Fetching case data..."
4. WASM extract — status text: "Extracting case..."

Status text shown below the input bar (landing) or below the top bar (collapsed). Input field is not disabled during load — user can edit while fetching. Button shows a spinner and is disabled until complete.

**Error states:**
- **Volume not indexed** (`.bin` returns 404): "This volume hasn't been indexed yet. We're still building the index — check back soon."
- **Page not found** (lookup returns null): "No case starts at page {N} in {reporter} vol. {volume}."
- **Network error** (fetch fails): "Couldn't reach the server. Check your connection and try again."
- **WASM init failure**: "Failed to load — try refreshing the page."
- **Invalid input** (can't parse): "Enter a citation as: reporter volume page (e.g., a2d 31 647)"

Errors shown as a red-tinted status line below the top bar. Dismissible on next input.

## Multi-Case Pages

When a page has multiple cases (e.g., page 657 has 0657-01 and 0657-02), the primary case (-01) is shown by default. A notice appears above the case text: "2 cases start on this page" with links to switch between them. The `.multi` file is fetched alongside the `.bin` and cached in IndexedDB.

## Dark Mode

CSS custom properties for all colors. Two token sets (light/dark) defined on `:root` and `[data-theme="dark"]`.

- Respects `prefers-color-scheme: dark` by default
- Manual toggle via moon/sun button in top bar
- Persisted to localStorage (`stare-theme`)
- Warm dark palette (#181818 bg, not pure black)
- Links shift to lighter blue (#60a5fa) for contrast
- **FOUC prevention**: inline `<script>` in `<head>` reads localStorage and sets `data-theme` before first paint

## Cited Cases

**Pre-eyecite-rs (now):** The case JSON `cites_to` array already lists cited cases. Populate the sidebar "Cited Cases" section from this data immediately — no parsing needed. Resolvability check: attempt to fetch the cited volume's `.bin` (may 404 = not indexed).

**Post-eyecite-rs:** Additionally detect and highlight citations inline in the opinion text:
- **Resolvable** (we have the index): blue, dotted underline, clickable — navigates to that case
- **Not indexed**: gray, dotted underline, not clickable — hover shows "not yet indexed"

In the sidebar "Cited Cases" section:
- Green checkmark + clickable link for resolvable
- Gray X + dimmed text for not indexed
- Clicking a sidebar citation scrolls to its first occurrence in the text

## Sidebar Sections

1. **Case** — name, date, court, docket, jurisdiction
2. **Citations** — primary citation from case JSON `citations[0].cite`. Parallel citations slot shown when the case has multiple entries in the `citations` array (today), or when cross-citation index provides additional forms (future). Hidden if only one citation.
3. **Cited Cases** — list grouped by resolvable/not, with status indicators
4. **Actions** — View original PDF (links to `static.case.law/{reporter}/{vol}.pdf`; disabled with "PDF not available" if 404), Copy permalink (clipboard API; falls back to selecting text in a readonly input on HTTP), View as JSON (opens raw case JSON in a new tab)

## Reader / Original Pages Toggle

Tab bar below the top bar:
- **Reader**: clean typography, parsed case text from JSON
- **Original Pages**: (Phase 5) tar-based ALTO page images with text overlay

## Caching

- **IndexedDB** for .bin index files, .multi files, and .zip case data (too large for localStorage)
- Repeat lookups are instant — no re-fetching
- Keyed by `{reporter}/{volume}.bin`, `{reporter}/{volume}.multi`, and `{reporter}/{volume}.zip`
- No eviction policy for now — IndexedDB storage is generous on desktop. Safari may evict after 7 days of non-use; accept this for initial launch.
- If IndexedDB is unavailable (private browsing), fall back to in-memory cache for the session.

## Mobile

- Sidebar hidden by default, opened via floating hamburger button
- Sidebar overlays as fixed panel from the right
- Case name hidden from top bar to save space
- Reader padding reduced

## URL Scheme

Hash-based routing: `#reporter/volume/page`

Example: `stare.pub/#a2d/31/647` pre-fills and auto-resolves.

Navigating to a cited case changes the hash. Browser back button triggers `hashchange` → re-resolves the previous case.

## Tech Stack

- **Astro** static site (Cloudflare Pages)
- **WASM** (stare-wasm crate, 273 KB) for index lookup + zip extraction
- **Vanilla JS** for UI — no framework needed for this complexity
- **CSS custom properties** for theming — no preprocessor needed

## What's Deferred

- Citation string parsing (waiting on eyecite-rs port)
- Original Pages tab content (Phase 5, tar + ALTO)
- Parallel citations display (waiting on cross-citation index)
- Search (Phase 4, RoaringBuckets)
