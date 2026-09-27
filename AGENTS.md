# Codex Publicus — Agent Context

## Project Overview

**Codex Publicus** (stare.pub) is a free, serverless, publicly accessible system for resolving and searching U.S. case law citations. All interfaces are static files on object storage — no backend, no API, no database to run.

**Mission**: Preserve the complete Harvard Caselaw Access Project (CAP) dataset — full text, OCR data, and scanned reporter volumes — and build a permanent, open citation resolution and search system over that data.

## Repository Structure

```
crates/stare        — core lookup library (index parsing, zip/case extraction, resolve)
crates/stare-cli     — `stare` and `stare-admin` binaries
crates/stare-wasm    — wasm-bindgen bindings for the website (same core as the CLI)
data/                — committed index files (e.g. a2d/31.bin) and other build artifacts
web/                 — Astro site: landing, about, brief checker, case viewer
docs/plans/checklist.md             — Master checklist, iterate through this
docs/plans/cap-preservation-plan.md — Original plan: outreach, risk assessment, data sources
docs/plans/static-case-law-mirror.md — Mirror of static.case.law: status, file formats, aria2 setup
docs/plans/extraction-plan.md       — Citation index + data pipeline: bin index, R2 layout, WASM client
docs/plans/search-plan.md           — Search + data products: RoaringBuckets, DuckLake, comparisons
mirror/                             — Docker compose + config for the aria2 mirror job
```

## Architecture

Three interfaces to the same data, all static files:

| Interface | Purpose | Size | Consumer |
|-----------|---------|------|----------|
| **Citation index** (.bin files) | Citation → text + PDF | ~40 MB | MCP server, CLI, website |
| **RoaringBuckets search** (bitmaps) | Full-text + structured search | ~3-7 GB | Serverless website |
| **DuckLake** (Parquet + DuckDB catalog) | SQL queries, bulk analysis | ~25-35 GB | Researchers, data science |

### R2 Object Layout

```
/index/{reporter}/{vol}.bin       — citation lookup (page offset → case file)
/index/reporters.json             — abbreviation → slug mapping
/data/{reporter}/{vol}.zip        — case text JSONs (served as-is from mirror)
/data/{reporter}/{vol}.tar        — page images + ALTO OCR (range requests via tar.csv)
/data/{reporter}/{vol}.tar.csv    — tar byte offset manifest
/data/{reporter}/{vol}.pdf        — volume PDF fallback
/search/...                       — RoaringBuckets bitmap index
/ducklake/...                     — DuckLake Parquet + catalog
```

### Storage Split

- **R2**: index, zips, tar.csvs, search index, DuckLake (~$1-8/month)
- **IPFS**: tars, volume PDFs (pinned from homelab TrueNAS, $0)

### Client-Side Rendering (WASM)

All rendering runs client-side. Server serves only static files.
- Citation parsing: eyeCite (Python) or Rust port
- Zip extraction, tar range access, ALTO XML parsing: WASM
- On-demand PDF generation: BentoPDF or printpdf WASM module
- Page viewer: JPG + ALTO text overlay

## Data Source: static.case.law

Plain HTML directory listings served via Cloudflare (not JS-rendered). ~40,622 volumes across hundreds of reporter series.

Per volume:
- `.tar` (~97 MB): ALTO OCR XML, page images (JPG), METS, CASEMETS
- `.pdf` (~12 MB): full volume scan
- `.zip` (~400 KB): per-case JSON + HTML + metadata
- `.tar.csv`: tar byte offset manifest
- `.tar.sha256`: tar checksum

Total: ~4.4 TB across 203K files.

## Organization and infrastructure

This repo is `codexpublicus/stare` in the `codexpublicus` GitHub org, alongside
`codexpublicus/gorsuch-library`, `codexpublicus/infra` (shared zones, edge rules and the
LFS proxy) and `codexpublicus/codexpublicus.org` (umbrella site).

Shared Cloudflare values come from the Pulumi stack `organization/codexpublicus-infra/prod`,
not from any per-site config. That stack currently owns stare.pub's zone, its DNS and email
routing records, the `stare-pub` Pages project and the `stare-pub-idx` R2 bucket (moved
there from `lokkju-infra` on 2026-09-27; see codexpublicus/stare#3). This repo has no Pulumi
project or CI workflow of its own yet; deploys are run by hand with Wrangler.

Sites are moving to Workers Static Assets (`codexpublicus.org` is already there); stare.pub
follows as part of #3.

The published contact address is moving from `info@stare.pub` to `info@codexpublicus.org`
(#13), blocked on the email routing work in codexpublicus/infra#16.

For Pulumi, Wrangler and LFS rules that apply across the org, see
`codexpublicus/infra`'s `AGENTS.md`.

## Current Status

- **Live**: stare.pub serves the Astro site from the hand-deployed `stare-pub` Cloudflare
  Pages project.
- **Live**: `idx.stare.pub` (R2 bucket `stare-pub-idx`) serves the citation index files.
- **Mirror**: still running via aria2/Docker on ml-01 against TrueNAS `mega/codex-publicus`;
  completion percentage isn't verified for this document. See `docs/plans/checklist.md` and
  issue #14 for its current state, and don't trust a stale number here over those.
- **Pending, tracked by issue** (`gh issue list -R codexpublicus/stare`):
  - #3 — deploy from GitHub Actions with an in-repo Pulumi project; move stare.pub onto
    Workers Static Assets and the same pattern as gorsuch-library
  - #13 — switch the published contact address to `info@codexpublicus.org`
  - #14 — repoint the ml-01 mirror clone at `codexpublicus/stare` (still on the pre-rewrite
    `lokkju/codex-publicus` remote)
  - #10 — a computable court record key, a stable identifier for every decision
  - #9 — statutes and regulations: link out for now, hold them later
  - #8 — add case sources beyond CAP
  - #7 — pass-through citation resolver for cases this repo doesn't hold
  - #6 — offline, self-hosted law reference library, US then other countries
  - #5 — shared design system review across Codex Publicus sites
  - #4 — settle the code license and declare it everywhere
  - #2 — citation spans should be UTF-8 byte offsets, not characters
  - #1 — adopt the shared Codex Publicus page viewer

  Beyond these, see issues for anything not listed here.

## Development Phases

1. **Mirror static.case.law** (in progress) — aria2 downloading all tars, PDFs, zips, metadata
2. **Citation index + CLI tool** — reporters.json, .bin index builder, Python CLI (`stare resolve a2d 31 647` → text)
3. **Web tool (WASM)** — Rust/WASM citation parser, zip extraction, Cloudflare Pages UI; PDF as fallback viewer link
4. **DuckLake** — process zips into Parquet, build catalog, assign stable case IDs
5. **RoaringBuckets search** — generate bitmaps from DuckLake data, add search to web UI
6. **Page viewer** — tar range access + ALTO XML rendering in WASM (deferred; not needed for core text resolution)
7. **MCP server** — thin wrapper around core once CLI/web are proven (much later)
8. **IPFS distribution** — pin tars + PDFs from TrueNAS (alongside Phase 6)
9. **CourtListener integration** (phase 2) — citation graph first, then post-2018 cases (text-only), then full pre-2018 merge if warranted. See `search-plan.md` for decision rationale. Worth asking Free Law Project about PDFs/scans before committing to text-only tier.

## Language & Tooling Preferences

- **Rust** for CLI tool + core lookup library (compiles to native CLI and WASM from same codebase)
- **Python** (using `uv run python`, never bare `python`) for build tools: index builder, DuckLake pipeline, RoaringBuckets generator
- DuckDB for data processing and DuckLake
- `ruff` for Python linting/formatting
- Docker compose for services

## Infrastructure

- **ml-01** (192.168.32.210): k3s node, runs Docker, aria2 mirror
- **TrueNAS** (truenas.lodenheim.lokkju.com / 192.168.32.200): NFS storage
  - `mega/codex-publicus`: mirror data (NFS export to 192.168.32.0/24)
  - `mega/k8s`: k8s persistent volumes
- Access TrueNAS via NFS mounts and `showmount -e`, not SSH

## Key Context

- Harvard CAP API died March 2024. Search died September 2024. static.case.law still serves bulk data.
- PDFs + ALTO are the irreplaceable assets — text can be re-derived, scans cannot.
- Ravel/LexisNexis exclusivity expired March 2024. All data is public domain / CC0.
- Rate limit scraping: max 1-2 req/sec, identify in User-Agent.
