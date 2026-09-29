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
- `.tar`: per page, a color JPG scan, a bitonal (1-bit G4) TIFF, ALTO OCR XML (every word with
  coordinates), plus METS and CASEMETS (which pages belong to which case)
- `.pdf`: the bitonal TIFFs re-wrapped by ReportLab; no text layer, no color, no case structure
- `.zip`: per-case JSON + HTML + metadata
- `.tar.csv`: tar byte offset manifest
- `.tar.sha256`: tar checksum

Measured on the mirror 2026-09-29: 40,622 zips (76.7 GiB), 39,964 `.tar.csv` (9.7 GiB), 39,964
PDFs (1.79 TiB, about 49 MB on average), and the tars making up most of the rest of the ~10.4 TB.
Sizes vary widely by volume: a2d/31's tar is 102 MB (83 MB of it JPGs) and its PDF 12 MB.

## Organization and infrastructure

This repo is `codexpublicus/stare` in the `codexpublicus` GitHub org, alongside
`codexpublicus/gorsuch-library`, `codexpublicus/infra` (shared zones, edge rules and the
LFS proxy) and `codexpublicus/codexpublicus.org` (umbrella site).

Shared Cloudflare values come from the Pulumi stack `organization/codexpublicus-infra/prod`,
not from any per-site config. That stack owns stare.pub's zone and DNS, the `stare-pub-idx`
R2 bucket and `idx.stare.pub` (moved there from
`lokkju-infra` on 2026-09-27; see codexpublicus/stare#3), the `codex-data` R2 bucket, the
Workers deploy token, the citare deploy key and the three Actions secrets that carry them
(`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CITARE_DEPLOY_KEY`). This repo runs no
Pulumi of its own.

stare.pub has no email of its own. The published contact address is `info@codexpublicus.org`.

### Site deploys (`.github/workflows/site.yml`, `wrangler.jsonc`)

stare.pub is the `stare-pub` Worker (Workers Static Assets, `web/dist`), attached to the apex
as a Wrangler custom domain. Every pull request runs `cargo fmt --check`, clippy with
`-D warnings`, `cargo test --workspace`, the WASM build and the Astro build, then uploads a
preview version and comments its URL (`https://<version>-stare-pub.nick-441.workers.dev`).
A push to `main` runs the same checks and `wrangler deploy`. Wrangler is pinned to 4.141.0,
and Actions are pinned by commit SHA. Locally, `mise run check`, `mise run build-wasm` and
`mise run build-web` run the same steps. Nobody deploys by hand; the one exception was the
first deploy that created the Worker.

`idx.stare.pub`'s CORS allows `stare.pub`, its subdomains and the account's workers.dev
subdomain, so previews resolve citations too.

`stare-pub-idx` holds the deployed index. It is protected and `retain_on_delete` in
codexpublicus-infra and must never be deleted or recreated; back it up before any change to
its declaration.

Infrastructure changes go through PRs to codexpublicus/infra, not this repo. See that
repo's `AGENTS.md` for the Pulumi, Wrangler and LFS rules that apply across the org.

## Current Status

- **Live**: stare.pub serves the Astro site from the `stare-pub` Worker, deployed by CI on
  every push to `main` (since 2026-09-29; the old Pages project is deleted by #41).
- **Live**: `idx.stare.pub` (R2 bucket `stare-pub-idx`) serves the citation index files.
- **Mirror**: complete. TrueNAS `mega/codexpublicus/cap-mirror` holds 40,622 zips and 39,964
  each of tars, `.tar.csv` and PDFs (verified 2026-09-29); the dataset is read-only and the
  aria2 `codex-mirror` container is stopped.
- **Pending, tracked by issue** (`gh issue list -R codexpublicus/stare`):
  - #42: `codex-data` contents and `data.stare.pub` exposure (tier 1 uploaded 2026-09-29)
  - #51: archival per-volume PDFs (pipeline in `pipelines/archival-pdf/`)
  - #52, #61: Akoma Ntoso case text (profile in codexpublicus/exemplar); parallel-citation display
  - #60, #63: CalVer releases and version display; the index manifest
  - #10 — a computable court record key, a stable identifier for every decision
  - #9 — statutes and regulations: link out for now, hold them later
  - #8 — add case sources beyond CAP
  - #7 — pass-through citation resolver for cases this repo doesn't hold
  - #6 — offline, self-hosted law reference library, US then other countries
  - #5 — shared design system review across Codex Publicus sites
  - #4 — settle the code license and declare it everywhere
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
  - `mega/codexpublicus/`: one parent dataset for the org's data, each child its own NFS
    export to 192.168.32.0/24 (MapRoot: root):
    - `cap-mirror`: the static.case.law mirror, **read-only** (ZFS `readonly=on` and a
      read-only export). Renamed from `mega/codex-publicus` on 2026-09-29.
    - `derived`: pipeline outputs (archival PDFs and manifests, later Akoma Ntoso documents)
    - `index`: citation index builds (`stare-pub-idx/`, the files served at idx.stare.pub)
    - `backups`: restore points (e.g. `stare/stare-pub-idx-2026-09-27`)
  - `mega/k8s`: k8s persistent volumes
- Access TrueNAS via NFS mounts and `showmount -e`, not SSH
- Inspect corpus files from the mirror, never from static.case.law. On ml-01 the Docker volumes
  `codexpublicus-cap-mirror` (read-only), `codexpublicus-derived`, `codexpublicus-index` and
  `codexpublicus-backups` mount those exports; corpus files are at
  `downloads/<reporter>/<volume>.<ext>`, e.g.
  `ssh ml-01 'docker run --rm -v codexpublicus-cap-mirror:/data:ro rclone/rclone:latest cat /data/downloads/a2d/31.tar.csv'`.
  The read-write datasets are owned by uid 1000; run containers that write to them as
  `--user 1000:1000`.

## Key Context

- Harvard CAP API died March 2024. Search died September 2024. static.case.law still serves bulk data.
- The tars are the irreplaceable assets: the color scans, the bitonal images and the ALTO word geometry exist only there. The PDFs can be regenerated from the tars' TIFFs; the text can be re-derived.
- Ravel/LexisNexis exclusivity expired March 2024. All data is public domain / CC0.
- Rate limit scraping: max 1-2 req/sec, identify in User-Agent.
