# Codex Publicus — Master Checklist

## Phase 0: Data Acquisition (in progress)

- [x] Analyze static.case.law structure and file formats
- [x] Design mirror architecture (aria2 + Docker + NFS)
- [x] Generate URL list (203,113 URLs across 40,622 volumes)
- [x] Deploy mirror on ml-01 → TrueNAS `mega/codex-publicus` (now `mega/codexpublicus/cap-mirror`, read-only)
- [ ] Mirror complete (~10% as of 2026-03-22, ETA ~7 days)
- [ ] Verify completeness: all 40,622 volumes × 5 file types present
- [ ] Verify checksums: sha256sum against `.tar.sha256` files

## Phase 1: Citation Index + CLI Tool

### Done
- [x] Rust project setup (workspace, stare crate, rustls)
- [x] Binary index format (.bin): parse, lookup, build — 6 tests
- [x] Zip case extraction: extract_from_zip, list_cases_in_zip — 3 tests
- [x] Core resolve: resolve_local (index + zip → case text) — 3 tests
- [x] Remote resolve: resolve_remote (local .bin + HTTP fetch .zip from static.case.law) — 1 network test
- [x] CLI: `stare build-index <zip>` builds .bin from any volume zip
- [x] CLI: `stare resolve <reporter> <vol> <page>` with --index-dir, --base-url, --local
- [x] Pre-built a2d/31.bin index committed to data/
- [x] End-to-end test: `stare resolve a2d 31 647` → full case text from static.case.law

### Remaining
- [x] `--json` output flag on resolve for machine consumption
- [x] Handle multi-case pages: `.multi` sidecar for -02, -03 entries
- [x] Batch `build-index` across all zips (parallel via rayon)
- [ ] Non-standard page number indexing — currently skipped with warnings:
  - `Supp. 1-01` — supplement pages. Need offset convention or separate file + URL scheme
  - `LXXXVIII-01` — Roman numeral pages (front matter). Parse roman → integer
  - `000?-01` — unknown page numbers from Harvard OCR failures. Skip or flag
  - `428e-01`, `1028A-01` — lettered sub-pages (trailing). Now parsed (strips letter, indexes at base page)
  - `B174-01`, `A174-01` — lettered section prefixes. Currently extracts digits (174) which collides if both A and B sections exist. Needs section-aware addressing.
- [ ] Set up Cloudflare R2 buckets (`codex-index`, `codex-data`)
- [ ] Upload index + zips to R2
- [ ] Test full pipeline against live R2 bucket
- [x] `stare list <reporter> <vol>` — list cases in a volume
- [x] `stare download --reporters <slug>` — fetch index + zips locally

## Phase 2: Web Tool (WASM)

### Done
- [x] Compile stare-core to WASM (index + case modules, 273 KB binary)
- [x] stare-wasm crate with wasm-bindgen: lookup_page, extract_case, list_cases, extract_file, extract_cases_metadata, get_page_orders
- [x] WASM: zip extraction + case JSON rendering
- [x] Astro site: two-panel reader with dark mode, collapsible sidebar
- [x] IndexedDB caching for .bin, .multi, .zip, tar.csv files
- [x] URL hash with case sequence: #reporter/vol/page-seq
- [x] Mock citation detection (regex): inline highlighting (blue=resolvable, gray=not), sidebar grouping
- [x] Hover tooltips on citations: lazy-load case name/date with spinner
- [x] Prev/Next case navigation in topbar (traverses full volume case list)
- [x] Original Pages tab (now Raw Scans): tar range requests for individual JPG pages via tar.csv byte offsets
- [x] Archival PDF tab: the case's pages of the volume's archival PDF through self-hosted PDF.js, by range requests, with its text layer (#1, #75)
- [x] Fixed tab bar (Reader/Archival PDF/Raw Scans tabs stay pinned, content scrolls)
- [x] Error returns to landing (no stale case display)
- [x] Core: extract_file_from_zip, extract_cases_metadata, get_page_orders (shared CLI + WASM)

### Remaining
- [ ] Rust/WASM citation parser (port eyeCite: Aho-Corasick over `reporters-db` JSON + Harvard slug field) — in progress externally
- [ ] Deploy to Cloudflare Pages (stare.pub)
- [ ] Deep linking to text selections (URL fragment → highlight specific passage)
- [ ] Image/text mapping: overlay OCR text on page images (via ALTO or HTML region data)
- [ ] PDF fallback: link to `/data/{reporter}/{vol}.pdf` for volume viewing

## Phase 3: DuckLake (Python + DuckDB)

- [ ] Write zip → Parquet processor (schema: cases, citations, courts, jurisdictions)
- [ ] Process all zips, assign stable case IDs
- [ ] Build DuckLake catalog (`.ducklake` file)
- [ ] Partition by jurisdiction + decade
- [ ] Build metadata FTS index (case names, court names)
- [ ] Publish DuckLake to R2 (`/ducklake/`)
- [ ] Verify: `duckdb -c "ATTACH 'ducklake:https://...' AS caselaw; SELECT COUNT(*) FROM caselaw.cases"`

## Phase 4: RoaringBuckets Search Index

- [ ] Build structured dimensions: jurisdiction, court, year, decade, reporter bitmaps
- [ ] Build case name token bitmaps (~50K tokens)
- [ ] Build full-text term bitmaps, sharded by 2-char prefix (~500K terms)
- [ ] Pre-compute BM25 scores per term
- [ ] Publish search index to R2 (`/search/`)
- [ ] Add search to web UI
- [ ] Test query flow: "negligence cases in California 1990-2000" → case IDs

## Phase 5: Page Viewer Enhancements

### Done (basic viewer in Phase 2)
- [x] Tar range access using tar.csv byte offsets (JS, not WASM — works fine)
- [x] Page viewer with prev/next navigation, page counter
- [x] ALTO XML parsing in Rust: parse_alto_gz in stare core crate, WASM binding, 4 tests
- [x] ALTO fetched in parallel with page image via tar range requests

### Remaining: alto.js component
Build a WASM-driven interactive text overlay component ("alto.js"):
- [ ] Rust/WASM canvas or SVG renderer — draws selection highlights from ALTO bounding boxes
- [ ] Custom selection state machine: mousedown/mousemove on ALTO word rects
- [ ] Copy to clipboard via Clipboard API
- [ ] Highlight specific words/passages (for deep linking, search results)
- [ ] Deep linking: URL fragment encodes text selection → highlight on load
- [ ] Image/text sync: click text in reader → scroll to that position in page viewer

### Distribution
- [ ] IPFS: pin tars + volume PDFs from TrueNAS
- [ ] BitTorrent: per-reporter torrents for bulk distribution
- [ ] Fully decentralized hosting: serve stare.pub itself from IPFS (site + WASM + data = one content-addressed bundle, no traditional hosting required)

## Phase 6: MCP Server

- [ ] MCP server wrapping core `resolve(reporter, volume, page)` lookup
- [ ] `resolve_case(reporter, volume, page)` tool — structured input
- [ ] `resolve_citation(cite_string)` tool — adds eyeCite front-end
- [ ] Publish to MCP registry

## Phase 7: CourtListener Integration

- [ ] Contact Mike Lissner (Free Law Project) — ask about PDFs/scans before committing to text-only tier
- [ ] Pull citation graph (`citation-map` table) → add to DuckLake
- [ ] Add post-2018 cases as text-only tier (separate Parquet partition + R2 prefix)
- [ ] Full pre-2018 merge with Harvard CAP (only if CL metadata is meaningfully better for specific courts)
- [ ] Quarterly update pipeline (download new dump → diff → rebuild affected index shards)

## Phase 8: Statutes as "Reporters"

Statutes use the same resolve(slug, volume, page) architecture — just different source data.

### External link fallback (now)
Until we mirror statutes, link out to the least-bad external sources:
- [ ] U.S. Code → `law.cornell.edu/uscode/text/{title}/{section}` (stable URLs, ugly)
- [ ] Statutes at Large → `govinfo.gov` (official, URLs are rough)
- [ ] CFR → `ecfr.gov` (actually decent UI)
- [ ] Wire into citation detector: statute citations get external links instead of unresolvable gray

### Build pipeline (convert to common format at build time)
All sources normalized to JSON-in-zip at build time. Viewer only knows one format.
Common schema: `{ type, title, heading, body, citations, source, effective_date }`
Page images: included when available (Statutes at Large scans), "Original Pages" tab hidden when not.

### Federal
- [ ] Mirror USLM XML from uscode.house.gov (U.S. Code, bulk download, ~1-2 GB)
- [ ] Build pipeline: USLM XML → common JSON → zip per title, .bin index
- [ ] Slug: `usc/{title}/{section}` (e.g., `usc/42/1983` → 42 U.S.C. § 1983)
- [ ] Mirror Statutes at Large from govinfo.gov (session laws cited in case law)
- [ ] Slug: `stat/{volume}/{page}` (e.g., `stat/56/195` → 56 Stat. 195)
- [ ] Add to eyecite-rs: detect statute citations alongside case citations

### State (per state, as resources allow)
- [ ] Identify mirrorable sources per state (many states publish XML/HTML)
- [ ] Same pattern: `{state-code-slug}/{title}/{section}`
- [ ] e.g., `cal-civ/0/1714` → Cal. Civ. Code § 1714

### Architecture note
No structural changes needed — website, CLI, MCP server, brief checker all work unchanged. Just more slugs in the index. Bidirectional linking between cases and statutes comes for free.

## Phase 9: DuckDB Extension (stretch)

- [ ] DuckDB extension that queries RoaringBuckets index
- [ ] `SELECT * FROM caselaw.cases WHERE case_id IN (SELECT * FROM roaring_search('negligence', jurisdiction='cal'))`
