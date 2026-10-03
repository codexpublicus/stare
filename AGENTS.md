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
pipelines/archival-pdf/             - archival per-volume PDF builder (#51): uv project, image, RUNBOOK.md
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
/index/manifest.json              — data version, indexed volume folders, split volumes' parts and page ranges (crates/stare/src/manifest.rs)
/cap/{reporter}/{vol}.zip         — case text JSONs (codex-data bucket, served at data.stare.pub/cap)
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

### Site releases and deploys (`.github/workflows/`, `cliff.toml`, `wrangler.jsonc`)

stare.pub is the `stare-pub` Worker (Workers Static Assets, `web/dist`), attached to the apex
as a Wrangler custom domain. The one sanctioned path to production is merging the release PR.
It is not the only possible one: this private repo is on GitHub Free, so `main` has no branch
protection and there are no environment protection rules, and a same-repo PR runs its own copy
of `site.yml` with `CLOUDFLARE_API_TOKEN`. A PR that edits a workflow to run `wrangler deploy`
would deploy production without a release, and a Workers token can't be scoped to preview
uploads only. Review workflow changes in PRs with that in mind.

- **Pull requests** (`site.yml`, job "Preview PR") run `cargo fmt --check`, clippy with
  `-D warnings`, `cargo test --workspace`, the JS tests, the WASM build and the Astro build,
  then upload a Worker version and keep one updating comment with its preview URL
  (`https://<version>-stare-pub.nick-441.workers.dev`), then run the Playwright smoke suite
  (`web/e2e/`, `.github/actions/smoke-test`) against that URL.
- **Pushes to `main`** (`site.yml`, job "Preview main (not production)") run the same checks
  and upload a version to the `main` preview alias,
  `https://main-stare-pub.nick-441.workers.dev`, and smoke test the uploaded version's own URL.
  A green check on `main` is not a deploy, but a failed smoke test blocks the release, since
  `release.yml` refuses a merge commit whose checks failed.
- **The release PR** (`release-prepare.yml`, on every push to `main`): git-cliff collects the
  Conventional Commits since the last release tag and keeps one open PR from `release/next`,
  "chore(release): next site release", that updates `CHANGELOG.md`. Only `feat`, `fix` and
  `perf` commits touching the site (`web/`, `crates/stare`, `crates/stare-wasm`, `wrangler.jsonc`,
  `site.yml` and `.github/actions/build-site/`) after the commit in `scripts/release-baseline` are releasable; docs, chore, ci, test, build, style and refactor are
  hidden, and with nothing releasable there's no PR. The version in the PR is a preview.
- **Releasing** (`release.yml`, when the bot's release PR from `release/next` merges into
  `main`): a read-only build job waits for the merge commit's push checks and refuses if any
  failed, then computes the tag from the tags as they stand after the wait, `vYYYY.MM.DD.N` in
  UTC with N one more than the day's highest existing release (`scripts/calver.mjs`), and
  rebuilds with the same checks (the composite action `.github/actions/build-site`), with no
  git credentials on disk while cargo and npm run. A second job, which runs no build code,
  creates the tag on the merge commit through the API (refusing if it exists elsewhere),
  refuses if a newer release tag exists, creates the GitHub Release with the git-cliff notes,
  runs `wrangler deploy` on the built `web/dist`, and dispatches `release-prepare.yml`. The
  tag, release and deploy share a job because tags and releases made with `GITHUB_TOKEN`
  don't trigger other workflows, so nothing may depend on `on: push: tags` or `on: release`.
  Re-running a failed release reuses the tag already on the merge commit, and refuses once a
  newer release exists, so an old run can't roll production back.
- **After a release**, the dispatched `release-prepare.yml` closes a release PR with nothing
  left in it, and if the merged `CHANGELOG.md` kept a preview heading that turned out wrong
  (the PR merged on a later day), opens "chore(release): sync CHANGELOG.md with the release
  tags" from `release/changelog-sync`. Merging that releases nothing.

The footer on every page (`web/src/components/SiteFooter.astro`, `web/src/lib/version.js`)
credits Codex Publicus and lokkju and shows the build: on a release, the CalVer tag linking
to `/updates#<tag>`; on any other build (PR previews, the main preview, local), `preview` and
the commit date. It never shows a commit SHA; the SHA is only in a `data-commit` attribute.
The values come from `PUBLIC_RELEASE`, `PUBLIC_COMMIT` and `PUBLIC_BUILD_DATE`. It also shows
the index manifest's data version once #63 adds one, and until then the manifest's
Last-Modified date.

`CHANGELOG.md` is rendered at build time three ways: every release on `/updates` (each with
an anchor named for its tag), the latest three on /about's "What's new", and the Atom feed
`/updates.xml` (`web/src/lib/feed.js`). The codexpublicus/stare source isn't published, so
the site links to no GitHub page: the cliff.toml template emits no commit, PR or release
links, and `web/src/lib/changelog.js` strips any link from a CHANGELOG line.

Don't hand-edit `CHANGELOG.md` or push `v*` tags yourself; the workflows own both. Changes to
the workflows need the operator's workflow-scoped token to merge, and `release-prepare.yml`
needs the repo setting "Allow GitHub Actions to create and approve pull requests". Wrangler is
pinned to 4.141.0, git-cliff to 2.14.2, and Actions by commit SHA. Locally, `mise run check`,
`mise run build-wasm` and `mise run build-web` run the same steps, `mise run e2e [url]` runs
the smoke suite against a deployed site (the main preview by default), and
`scripts/cliff --unreleased --tag "$(node scripts/calver.mjs)"` previews the next release's notes (`scripts/cliff` is git-cliff with the baseline range; the first release's hand-written summary is in `cliff.toml`).
Nobody deploys by hand; the one exception was the first deploy that created the Worker.

`idx.stare.pub`'s CORS allows `stare.pub`, its subdomains and the account's workers.dev
subdomain, so previews resolve citations too.

`stare-pub-idx` holds the deployed index. It is protected and `retain_on_delete` in
codexpublicus-infra and must never be deleted or recreated; back it up before any change to
its declaration.

Infrastructure changes go through PRs to codexpublicus/infra, not this repo. See that
repo's `AGENTS.md` for the Pulumi, Wrangler and LFS rules that apply across the org.

### Archival PDF pipeline (`pipelines/archival-pdf/`, #51)

`stare-archival` builds one PDF/A-3b per volume from the mirror's tars (lossless JBIG2
generic region images, the ALTO words as an invisible text layer, METS page labels, a
bookmark per case; linearized, so a reader fetches any one page by HTTP range request
instead of the whole volume), verifies every page's pixels and text against the tar, and writes a
manifest per volume. `build-all` runs volumes in parallel and resumes from passing
manifests for the same tar SHA-256, commit and tool versions. `mise run archival-test`
runs ruff and pytest; `mise run archival-image` builds the pipeline image (native jbig2,
poppler, rclone; bases pinned by digest) and `mise run archival-image-test` builds the
fixture volume inside it. CI (`.github/workflows/pipelines.yml`) runs both.

The operator runs it on ml-01 from `pipelines/archival-pdf/RUNBOOK.md`: the mirror is the
read-only Docker volume `codexpublicus-cap-mirror`, the output goes to
`codexpublicus-derived` (`cap-pdf/<reporter>/<volume>.pdf`,
`cap-pdf/_manifests/<reporter>/<volume>.json`), and rclone uploads `cap-pdf/` to
`codex-data/cap-pdf/`. Nothing in the pipeline writes to the mirror.

## Current Status

- **Live**: stare.pub serves the Astro site from the `stare-pub` Worker (since 2026-09-29; the
  old Pages project is deleted by #41). CI deploys it when a release PR merges (#60); until
  the first release, production is the last `main` push deployed before #60 landed.
- **Live**: `idx.stare.pub` (R2 bucket `stare-pub-idx`) serves the citation index files.
- **Zips**: the site and the CLI fetch case zips from `https://data.stare.pub/cap/<reporter>/<volume>.zip`
  (our copy, #27). Tars, `.tar.csv` and the volume PDF link still point at static.case.law.
- **Mirror**: complete. TrueNAS `mega/codexpublicus/cap-mirror` holds 40,622 zips and 39,964
  each of tars, `.tar.csv` and PDFs (counted 2026-09-29; checksums not yet audited, and a2d/142.tar fails its `.tar.sha256`, see #77); the dataset is read-only and the
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
