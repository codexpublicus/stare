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
pipelines/courtlistener/            - CourtListener bulk export to per-case records (#83, #84): uv project, RUNBOOK.md
```

## Architecture

Three interfaces to the same data, all static files:

| Interface | Purpose | Size | Consumer |
|-----------|---------|------|----------|
| **Citation index** (`.idx.gz` per volume) | Citation → text + PDF | ~44 MB | MCP server, CLI, website |
| **RoaringBuckets search** (bitmaps) | Full-text + structured search | ~3-7 GB | Serverless website |
| **DuckLake** (Parquet + DuckDB catalog) | SQL queries, bulk analysis | ~25-35 GB | Researchers, data science |

### R2 Object Layout

```
/index/manifest.json              — the live build's manifest plus `base` (`v/<version>/`), short max-age (crates/stare/src/manifest.rs)
/index/v/{version}/{reporter}/{vol}.idx.gz   — the unified index: `page,source,ref` lines for every source, gzip (application/gzip, no Content-Encoding); immutable
/index/v/{version}/{reporter}/{vol}.{n}.idx.gz — later parts of a volume split past 1,000 lines; immutable
/index/v/{version}/{reporter}/{vol}.bin    — CAP-only citation lookup (page offset → case file), kept for one release beside .idx.gz; immutable
/index/v/{version}/{reporter}/{vol}.multi  — pages with several cases, likewise; immutable
/index/v/{version}/manifest.json  — the build's own manifest (no `base`)
/index/v/{version}/report.json    — the build's report (schemas/index-report.v1.schema.json); immutable
/index/reports/index.json         — every published build's report totals, oldest first (schemas/reports-index.v1.schema.json); charted at stare.pub/data
/index/{reporter}/{vol}.bin       — the pre-versioning index, for clients that ignore `base`
/index/reporters.json             — abbreviation → slug mapping
/cap/{reporter}/{vol}.zip         — case text JSONs (codex-data bucket, served at data.stare.pub/cap)
/cl/c/{cluster_id}/{hash}.json.gz — one CourtListener record, CAP's case JSON shape plus `source` (codex-data, data.stare.pub/cl); immutable
/data/{reporter}/{vol}.tar        — page images + ALTO OCR (range requests via tar.csv)
/data/{reporter}/{vol}.tar.csv    — tar byte offset manifest
/data/{reporter}/{vol}.pdf        — volume PDF fallback
/search/...                       — RoaringBuckets bitmap index
/ducklake/...                     — DuckLake Parquet + catalog
```

### The unified index (`crates/stare/src/idx.rs`)

One gzipped text file per volume as cited, for every source (`docs/plans/courtlistener-mirror.md`,
"Index"; measured in #110). Each line is `page,source,ref`:

- `page`: a number, or a CAP page label lowercased (`xxix`, `supp. 1`).
- `cap` lines: `ref` is the case file in the volume's zip (`0647-01`). A volume CAP split
  over several folders is one file under the number as cited, and a case from another
  folder names it: `138-2/1012-01` is in `a3d/138-2.zip`.
- `cl` lines: `ref` is `<cluster_id>/<hash>`, the record below.
- Lines sharing a page keep CAP's first; readers show the first. A `cl` line on a page CAP
  has a case on is an alias for that case.
- A part ends at the first page boundary after 1,000 lines; part 0 then starts with
  `#parts,<first page of part 1>,...`, and readers fetch the part a page falls in.
- Readers trim, skip blank and `#` lines, skip (and report) malformed lines, and skip a
  source tag they don't know. Files are gzipped with mtime 0, so an unchanged volume is
  byte-identical across builds.

The manifest's `idx: 1` says a build has them; `reporters` then lists every source's
volumes, CourtListener-only ones included, while `volumes` and `entries` still count CAP's
folders. The site (`web/public/js/resolve.js`) and the CLI read `.idx.gz` when `idx` is 1
and fall back to `.bin`/`.multi` otherwise, or when a volume has no `.idx.gz`. A split
volume's other folder named directly (`a3d 138-2`) is read from its number's file, keeping
the lines that name that folder. A miss in a volume the index holds is a miss; it never
links out. The WASM exposes `parse_idx` and `lookup_idx`.

Slugs for reporters CAP never had come from citare's edition `slug` (citare#71, not yet in
a citare release). Until stare takes it, the build slugs them the same way
(`NY Slip Op` → `ny-slip-op`), and the resolvers, which look up by `harvard_slug`, reach
CourtListener cases only in reporters CAP has.

### CourtListener records (`crates/stare/src/cl.rs`, `web/public/js/cl.js`)

Cases CAP doesn't hold come from CourtListener's bulk data
(`docs/plans/courtlistener-mirror.md`). A record is CAP's case JSON with a `source` block
(`name: "courtlistener"`, the export date, CourtListener's ids, docket number, status and
URL); `<hash>` is the first 16 hex digits of its SHA-256. The unified index's `cl` lines
point at them; the site and the CLI fetch the record and render it like a CAP case with a
source line, and no page scans or PDF. `cl.rs` and `sources.js` are the only places that
build record paths. Nothing is published yet; the e2e tests serve a hand-made record
(`crates/stare/tests/fixtures/cl-record.json`) through routes.

### Index builds and publishing

Each index build is immutable and versioned with a CalVer data version (`vYYYY.MM.DD`, `.N`
for a later one the same day). Both steps are operator-run on ml-01 and never automatic:

- `mise run index-build <stare tag> [version] [--allow <file>] [--cl <manifest>]` builds
  `stare-admin` from the tag and runs `batch-index`, `build-manifest` and `build-report` in
  a throwaway container (no network, the mirror read-only) into
  `codexpublicus-index:/builds/<version>/`, with `build.log`, `build.json`,
  `batch-index.json` and `report.json`. `batch-index` writes the `.bin`/`.multi` files and
  the unified index from the same zips, folding split volumes by CAP's
  VolumesMetadata.json, plus `cl` lines from a CourtListener export manifest
  (`cl/exports/<date>/manifest.ndjson.gz`) given with `--cl`; `stare-admin build-idx`
  rebuilds the unified index from a finished build's `.bin`/`.multi`. The report
  (`schemas/index-report.v1.schema.json`) has the build's identity, totals, per-reporter
  counts, every allow-listed and failed volume, a diff against
  `/index/current/report.json` when the published build has one, and `idx`: the unified
  index's volumes, files, split and CourtListener-only volumes, lines per source, sizes and
  what the CourtListener input held.
- `mise run index-publish <version>` checks the build's exit status and counts and its
  report, uploads it to `stare-pub-idx/v/<version>/` (`Cache-Control: public,
  max-age=31536000, immutable`, `.idx.gz` as `application/gzip` with no Content-Encoding,
  `report.json` next to last, its manifest last), adds the
  build to `reports/index.json` (`max-age=60`), saves the old root `manifest.json` and
  `reports/index.json` to `codexpublicus-index:/published/`, writes the root
  `manifest.json` (the build's plus `base`, `max-age=60`), and points
  `codexpublicus-index:/current` at the build.
- Rolling back is `mise run index-publish <earlier version>` for a version still in `v/`: it
  only rewrites `reports/index.json` and the root manifest. To go back to the
  pre-versioning root, upload the saved copy from `published/` as `manifest.json`.

Nothing in `v/` is ever overwritten or deleted by these tasks.

The first build with the unified index keeps `.bin`/`.multi` beside it for one release, and
the next drops them. Release the site and CLI that read `.idx.gz` before publishing a
build whose `reporters` lists CourtListener-only volumes: older readers would count those
as held and report "not indexed yet" instead of linking out.

### Storage Split

- **R2**: index, zips, tar.csvs, search index, DuckLake (~$1-8/month)
- **IPFS**: tars, volume PDFs (pinned from homelab TrueNAS, $0)

### Client-Side Rendering (WASM)

All rendering runs client-side. Server serves only static files.
- Citation parsing: eyeCite (Python) or Rust port
- Zip extraction, tar range access, ALTO XML parsing: WASM
- On-demand PDF generation: BentoPDF or printpdf WASM module
- Page viewer: JPG + ALTO text overlay

### WASM module size (#73)

`web/public/wasm/stare_wasm_bg.wasm` is built by wasm-pack with the release profile in
`crates/stare-wasm/.cargo/config.toml` (opt-level `"z"`, fat LTO, one codegen unit,
`strip`; the regex stack, aho-corasick, memchr and citare-core at opt-level 3) and without
wasm-opt, which made the compressed module larger. Measured 2026-10-03 (gzip -9, brotli 11):

| Build | Raw | gzip | brotli |
|---|---:|---:|---:|
| main before #73 (wasm-pack defaults, wasm-opt -O) | 3,008,251 | 1,047,356 | 746,711 |
| #73 release profile, no wasm-opt | 2,769,808 | 877,310 | 606,251 |
| plus citare without unused regex Unicode tables (citare#46) | 2,538,007 | 815,660 | 582,080 |
| citare v0.5.0, which ships citare#46 | 2,553,624 | 826,044 | 588,268 |
| citare v0.5.2 without embedded data (#117), with #123, 2026-10-05 | 1,651,074 | 605,210 | 443,615 |
| its data bundle, `citare-data-d23ebb063eb8f24b.bin` | 424,260 | 124,747 | 97,901 |
| the same bundle with zopfli, as served (`.bin.gz`) | | 113,812 | |

The Worker compresses on the fly, less tightly than brotli 11. Bytes on the wire, same day:

| Build | br | zstd | gzip |
|---|---:|---:|---:|
| main preview before #73 | 969,934 | 981,923 | 1,048,261 |
| #73 preview | 783,415 | 790,873 | 875,281 |
| main preview before #117 (citare v0.5.0, embedded), 2026-10-05 | 777,748 | 787,495 | 852,556 |
| #117 preview, module | 561,305 | 578,475 | 604,320 |
| #117 preview, `.bin.gz` bundle, sent as is | 113,812 | 113,812 | 113,812 |
| #117 preview, module plus bundle | 675,117 | 692,287 | 718,132 |

Since #117 the module is built without citare's reporter, edition and court tables
(citare's `embedded-data` feature, off in stare-wasm through `stare`'s own). The build
exports them with `stare-admin export-citare-data`, gzipped with zopfli, to
`/data/citare/v1/citare-data-<SHA-256 prefix>.bin.gz`; the prefix is the uncompressed
bundle's, citare's own name for it. `_headers` serves it as `application/gzip`,
`immutable` for a year and with no Content-Encoding, so Cloudflare sends the file as it is
and the browser doesn't decompress it. `/wasm/stare_wasm_bg.json` names it with its gzipped
size, uncompressed size and SHA-256. `web/public/js/wasm.js` fetches it alongside the
module, counts the gzip bytes in the progress bar, gunzips it with `DecompressionStream`,
checks the length and hash, and loads it with `init_data` before `loadWasm()` resolves.
The name changes only when reporters-db or courts-db does, so a stare release
re-downloads the module alone, and a data change the bundle alone.

In Chromium on the previews (median of 9, two rounds, from ml-01, zstd chosen), a first
visit transfers 697,960 bytes of WASM files against 792,477 to 792,540 before; a repeat
visit to the same deploy 900 bytes either way (three 304s, and the bundle from the cache
with nothing sent); a repeat visit after a stare release about 579 KB against 787 KB.
`loadWasm()` takes 250 to 279 ms against 171 to 227 ms, since the gunzip, hash check and
table decode now happen inside it; the first `detect_citations` takes 133 to 140 ms against
227 to 238 ms, and a second one 18 to 21 ms against 101 to 102 ms. Most of the detection
speedup is citare v0.5.2's linear scaling (citare#59), not the split.

The module left is mostly code, the regex engines, plus the Unicode tables regex needs.
opt-level `"z"` everywhere was smaller still before #117 (540 KB brotli against 588 KB)
but doubles citation detection time; keep the matching engines at 3. Check
`twiggy top` and the brotli size when adding a dependency to `stare` or `stare-wasm`.

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

Every job runs on `runs-on: homelab`, the org's self-hosted runners: GARM in lokkju/infra
(`homelab/platform/garm/`, "CI runners (GARM)" in its `homelab/README.md`) starts an ephemeral
Kubernetes pod per job on ml-01, with a privileged Docker-in-Docker sidecar. The image is
actions-runner plus gh, git, curl, jq, ca-certificates, build-essential, pkg-config,
openssh-client and poppler-utils (lokkju/infra#81), and has no passwordless sudo
(lokkju/infra#105). `.github/actions/homelab-setup` checks that the packages a job names are
installed, tries `sudo -n apt-get` only for missing ones and fails naming them otherwise, and
sets `TMPDIR` to `$RUNNER_TEMP`, because the sidecar sees only the runner's work volume and a
`docker run -v` of a `/tmp` path would mount an empty directory. `build-site` asks it for
`build-essential pkg-config openssh-client`, the archival-pdf job for `poppler-utils`, and the
archival-image job for nothing but `TMPDIR`. Toolchains still come from their setup actions
(`setup-node`, `rust-toolchain`, `setup-uv`). The Playwright suite installs Chromium's
headless shell itself and checks its shared libraries with `ldd`; it runs
`playwright install-deps` only if some are missing and sudo works, so those libraries have to
be in the image. pip, uv and npm go through the homelab's Nexus proxy, set by the runner's
environment. A job on these runners can get root on ml-01 through the sidecar, so no workflow
may run code from a fork or check out PR code under `pull_request_target`.

- **Rust toolchain and cache** (#79): `rust-toolchain.toml` pins the Rust version, which CI
  reads; bump it on purpose, since a new rustc changes the cache key and the next `main` run
  starts cold. `Swatinem/rust-cache` uses one key (`shared-key: site`) for every job, and
  only pushes to `main` save it; PRs restore `main`'s and save nothing.
- **Pull requests** (`site.yml`, job "Preview PR") run `cargo fmt --check`, clippy with
  `-D warnings`, `cargo test --workspace`, the JS tests, the WASM build and the Astro build,
  then upload a Worker version and keep one updating comment with its preview URL
  (`https://<version>-stare-pub.nick-441.workers.dev`), then run the Playwright smoke suite
  (`web/e2e/`, `.github/actions/smoke-test`) against that URL.
- **Pushes to `main`** (`site.yml`, job "Preview main (not production)") run the same checks
  and upload a version to the `main` preview alias (and the `site-wasm` artifact `release.yml`
  deploys),
  `https://main-stare-pub.nick-441.workers.dev`, and smoke test the uploaded version's own URL.
  A green check on `main` is not a deploy, but a failed smoke test blocks the release, since
  `release.yml` refuses a merge commit whose checks failed.
- **The release PR** (`release-prepare.yml`, on every push to `main`): git-cliff collects the
  Conventional Commits since the last release tag and keeps one open PR from `release/next`,
  "chore(release): next site release", that updates `CHANGELOG.md`. Only `feat`, `fix` and
  `perf` commits touching the site (`web/`, `crates/stare`, `crates/stare-wasm`, `wrangler.jsonc`,
  `site.yml`, `.github/actions/build-site/` and `.github/actions/build-web/`) after the commit in `scripts/release-baseline` are releasable; docs, chore, ci, test, build, style and refactor are
  hidden, and with nothing releasable there's no PR. The version in the PR is a preview.
- **Releasing** (`release.yml`, when the bot's release PR from `release/next` merges into
  `main`): a read-only build job waits for the merge commit's push checks and refuses if any
  failed, then computes the tag from the tags as they stand after the wait, `vYYYY.MM.DD.N` in
  UTC with N one more than the day's highest existing release (`scripts/calver.mjs`). It
  doesn't rebuild the Rust side: it downloads the `site-wasm` artifact (the stare-wasm module
  and citare's data bundle) from the merge commit's successful `site` run on `main`, which
  ran cargo fmt, clippy, the tests and the smoke suite on that exact commit, and reruns only
  the Astro build (`.github/actions/build-web`), since the footer's tag and the changelog
  regenerated for it differ from the main preview's. It has no git credentials on disk while
  npm runs, and no citare deploy key at all. The artifact is kept 30 days, so re-running a
  release older than that fails at the download. A second job, which runs no build code,
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
the workflows need the operator's workflow-scoped token to merge. `release-prepare.yml` opens
its PRs with the yeet GitHub App's token (`YEET_APP_ID` and `YEET_APP_PRIVATE_KEY`, pushed by
codexpublicus/infra), so CI runs on them without an approval, and `release.yml` accepts a
release PR only from `codexpublicus-yeet[bot]`. Without those values `release-prepare.yml`
fails; there is no `GITHUB_TOKEN` fallback, and the repo setting "Allow GitHub Actions to
create and approve pull requests" is off. Wrangler is
pinned to 4.141.0, git-cliff to 2.14.2, and Actions by commit SHA. `.mise/config.toml` pins
wasm-bindgen to the version in `Cargo.lock`: wasm-pack runs whatever `wasm-bindgen` is on PATH
to check its version, and a global mise shim with no version set fails that check (#156).
Bump the pin with the lockfile. Locally, `mise run check`,
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

### CourtListener bulk export (`pipelines/courtlistener/`, #83)

`stare-cl` lists CourtListener's quarterly bulk export in its public S3 bucket, fetches one
export's tables resumably into `$STARE_CL_DIR/<date>/` with an `export.json` of sizes,
ETags and SHA-256s, re-verifies them, and reads the PostgreSQL CSV dialect. `stare-cl stage`,
`text` and `records` then classify each cluster against CAP's index (SQLite staging), keep
the selected clusters' opinion text, and write one CAP-shaped record per case with a
`source` block, an export manifest, a delta and a crosswalk of the CAP-held clusters
(local disk only; publishing is slice 5). `mise run cl-build <ref> --index <version>` builds
the `stare-cl` image on the host and runs the whole pipeline against the
`codexpublicus-courtlistener` volume.
`mise run cl-fetch` runs the fetch (operator-run on ml-01, about 63 GB); `mise run cl-test` runs ruff
and pytest, as CI (`.github/workflows/pipelines.yml`) does. See
`pipelines/courtlistener/RUNBOOK.md`.

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
