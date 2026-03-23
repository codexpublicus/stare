# Codex Publicus — Agent Context

## Project Overview

**Codex Publicus** (stare.pub) is a free, serverless, publicly accessible system for resolving and searching U.S. case law citations. All interfaces are static files on object storage — no backend, no API, no database to run.

**Mission**: Preserve the complete Harvard Caselaw Access Project (CAP) dataset — full text, OCR data, and scanned reporter volumes — and build a permanent, open citation resolution and search system over that data.

## Repository Structure

```
cap-preservation-plan.md    — Original plan: outreach, risk assessment, data sources
static-case-law-mirror.md   — Mirror of static.case.law: status, file formats, aria2 setup
extraction-plan.md          — Citation index + data pipeline: bin index, R2 layout, WASM client
search-plan.md              — Search + data products: RoaringBuckets, DuckLake, comparisons
mirror/                     — Docker compose + config for the aria2 mirror job
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

## Current Status

- **Mirror**: running on ml-01 via Docker (aria2 + AriaNg). Writing to TrueNAS `mega/codex-publicus` via NFS. ~10% complete, ETA ~7 days. Web UI at http://ml-01:8280/
- **Citation index**: designed, not yet built
- **DuckLake**: designed, not yet built
- **RoaringBuckets search**: designed, not yet built
- **MCP server**: not yet started
- **Website**: not yet started

## Development Phases

1. **Mirror static.case.law** (in progress) — aria2 downloading all tars, PDFs, zips, metadata
2. **Build citation index** — process zips → .bin files, build reporter mapping
3. **Build DuckLake** — process zips into Parquet, build catalog, assign stable case IDs
4. **Build RoaringBuckets search** — generate bitmaps from DuckLake data
5. **Build MCP server** — citation resolution tool for LLMs
6. **Build website** — serverless WASM app on Cloudflare Pages
7. **IPFS distribution** — pin tars + PDFs from TrueNAS
8. **CourtListener integration** (phase 2) — citation graph first, then post-2018 cases (text-only), then full pre-2018 merge if warranted. See `search-plan.md` for decision rationale. Worth asking Free Law Project about PDFs/scans before committing to text-only tier.

## Language & Tooling Preferences

- Python (using `uv run python`, never bare `python`)
- Rust for WASM modules
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
