# Codex Publicus — Master Checklist

## Phase 0: Data Acquisition (in progress)

- [x] Analyze static.case.law structure and file formats
- [x] Design mirror architecture (aria2 + Docker + NFS)
- [x] Generate URL list (203,113 URLs across 40,622 volumes)
- [x] Deploy mirror on ml-01 → TrueNAS `mega/codex-publicus`
- [ ] Mirror complete (~10% as of 2026-03-22, ETA ~7 days)
- [ ] Verify completeness: all 40,622 volumes × 5 file types present
- [ ] Verify checksums: sha256sum against `.tar.sha256` files

## Phase 1: Citation Index + MCP Server

- [ ] Download `ReportersMetadata.json` from static.case.law
- [ ] Build `reporters.json` (abbreviation → slug mapping, 401 reporters)
- [ ] Write index builder: `CasesMetadata.json` from each zip → `.bin` files
- [ ] Handle multi-case pages: `.multi` sidecar for -02, -03 entries
- [ ] Test core lookup end-to-end: `resolve("a2d", 31, 647)` → case text
- [ ] Build Python MCP server (`resolve_case(reporter, volume, page)` — structured input, no citation parsing yet)
- [ ] Set up Cloudflare R2 buckets (`codex-index`, `codex-data`)
- [ ] Upload index + a small data subset to R2
- [ ] Test full pipeline against live R2 bucket
- [ ] Add citation string parsing front-end to MCP server (eyeCite)

## Phase 2: DuckLake

- [ ] Write zip → Parquet processor (schema: cases, citations, courts, jurisdictions)
- [ ] Process all zips, assign stable case IDs
- [ ] Build DuckLake catalog (`.ducklake` file)
- [ ] Partition by jurisdiction + decade
- [ ] Build metadata FTS index (case names, court names)
- [ ] Publish DuckLake to R2 (`/ducklake/`)
- [ ] Verify: `duckdb -c "ATTACH 'ducklake:https://...' AS caselaw; SELECT COUNT(*) FROM caselaw.cases"`

## Phase 3: RoaringBuckets Search Index

- [ ] Build structured dimensions: jurisdiction, court, year, decade, reporter bitmaps
- [ ] Build case name token bitmaps (~50K tokens)
- [ ] Build full-text term bitmaps, sharded by 2-char prefix (~500K terms)
- [ ] Pre-compute BM25 scores per term
- [ ] Publish search index to R2 (`/search/`)
- [ ] Test query flow: "negligence cases in California 1990-2000" → case IDs

## Phase 4: Website + Distribution

- [ ] Rust/WASM citation parser (port eyeCite: Aho-Corasick over `reporters-db` JSON)
- [ ] WASM: zip extraction + case JSON rendering
- [ ] WASM: tar range access + ALTO XML parsing
- [ ] WASM: page viewer (JPG + ALTO text overlay)
- [ ] WASM: on-demand PDF generation (printpdf or BentoPDF)
- [ ] Static website on Cloudflare Pages (stare.pub)
- [ ] IPFS: pin tars + volume PDFs from TrueNAS
- [ ] BitTorrent: per-reporter torrents for bulk distribution

## Phase 5: CourtListener Integration

- [ ] Contact Mike Lissner (Free Law Project) — ask about PDFs/scans before committing to text-only tier
- [ ] Pull citation graph (`citation-map` table) → add to DuckLake
- [ ] Add post-2018 cases as text-only tier (separate Parquet partition + R2 prefix)
- [ ] Full pre-2018 merge with Harvard CAP (only if CL metadata is meaningfully better for specific courts)
- [ ] Quarterly update pipeline (download new dump → diff → rebuild affected index shards)

## Phase 6: DuckDB Extension (stretch)

- [ ] DuckDB extension that queries RoaringBuckets index
- [ ] `SELECT * FROM caselaw.cases WHERE case_id IN (SELECT * FROM roaring_search('negligence', jurisdiction='cal'))`
