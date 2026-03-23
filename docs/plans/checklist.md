# Codex Publicus — Master Checklist

## Phase 0: Data Acquisition (in progress)

- [x] Analyze static.case.law structure and file formats
- [x] Design mirror architecture (aria2 + Docker + NFS)
- [x] Generate URL list (203,113 URLs across 40,622 volumes)
- [x] Deploy mirror on ml-01 → TrueNAS `mega/codex-publicus`
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
- [ ] `--json` output flag on resolve for machine consumption
- [ ] Handle multi-case pages: `.multi` sidecar for -02, -03 entries
- [ ] Batch `build-index` across all zips (once mirror has them)
- [ ] Set up Cloudflare R2 buckets (`codex-index`, `codex-data`)
- [ ] Upload index + zips to R2
- [ ] Test full pipeline against live R2 bucket
- [ ] `stare list <reporter> <vol>` — list cases in a volume
- [ ] `stare download --reporters <slug>` — fetch index + zips locally

## Phase 2: Web Tool (WASM)

- [ ] Compile stare-core to WASM (split lib from CLI-specific code if needed)
- [ ] Rust/WASM citation parser (port eyeCite: Aho-Corasick over `reporters-db` JSON + Harvard slug field)
- [ ] WASM: zip extraction + case JSON rendering
- [ ] Simple web UI on Cloudflare Pages (stare.pub): citation input → text display
- [ ] PDF fallback: link to `/data/{reporter}/{vol}.pdf` for volume viewing
- [ ] Verify PDF OCR quality on a sample of volumes before investing further

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

## Phase 5: Page Viewer (tar-based)

- [ ] WASM: tar range access using tar.csv byte offsets
- [ ] WASM: ALTO XML parsing (word-level bounding boxes)
- [ ] WASM: page viewer — JPG page image + ALTO text overlay
- [ ] IPFS: pin tars + volume PDFs from TrueNAS
- [ ] BitTorrent: per-reporter torrents for bulk distribution

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

## Phase 8: DuckDB Extension (stretch)

- [ ] DuckDB extension that queries RoaringBuckets index
- [ ] `SELECT * FROM caselaw.cases WHERE case_id IN (SELECT * FROM roaring_search('negligence', jurisdiction='cal'))`
