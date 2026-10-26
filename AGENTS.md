# Codex Publicus — Agent Context

## Project Overview

**Codex Publicus** (stare.pub) is a free, serverless, publicly accessible system for resolving and searching U.S. case law citations. All interfaces are static files on object storage — no backend, no API, no database to run.

**Mission**: Preserve the complete Harvard Caselaw Access Project (CAP) dataset — full text, OCR data, and scanned reporter volumes — and build a permanent, open citation resolution and search system over that data.

## Repository Structure

```
crates/stare        — core lookup library (index parsing, zip/case extraction, resolve) and the
                      readers and writers for the published formats
crates/stare-cli     — the `stare` binary
crates/stare-site    — `stare-site export-citare-data` and `export-reporters`: the site build's
                      citare data bundle and /reporters.json
crates/stare-wasm    — wasm-bindgen bindings for the website (same core as the CLI)
data/                — committed index files (e.g. a2d/31.bin) and other build artifacts
web/                 — Astro site: landing, about, brief checker, case viewer
docs/plans/checklist.md             — Master checklist, iterate through this
docs/plans/cap-preservation-plan.md — Original plan: outreach, risk assessment, data sources
docs/plans/static-case-law-mirror.md — Mirror of static.case.law: status, file formats, aria2 setup
docs/plans/extraction-plan.md       — Citation index + data pipeline: bin index, R2 layout, WASM client
docs/plans/search-plan.md           — Search + data products: RoaringBuckets, DuckLake, comparisons
```

### The data build: codexpublicus/stare-builder

The producer side moved to codexpublicus/stare-builder with its history (#163):
`stare-admin` (the index build, `build-manifest`, `build-report`, `build-idx`),
`pipelines/archival-pdf` and `pipelines/courtlistener`, the aria2 mirror job and tar audit
(`mirror/`), the operator mise tasks (`index-build`, `index-publish`, `cl-fetch`,
`cl-build`, `cl-test`, `archival-*`), their
runbooks and the homelab notes. Its AGENTS.md covers them.

This repo is the reader: the site, the CLI, stare-wasm, `crates/stare` with the readers
and writers for every published format (the per-volume index, the manifest, records), and
the format specs, including `schemas/` for the build report and `reports/index.json` that
`/data` reads. `stare::schemas` compiles them in, and stare-builder's report test validates
against that at its pinned rev. A
change to a published format lands here first, in the format's reader, writer and the docs
below; stare-builder pins `crates/stare` by a site release tag (`vYYYY.MM.DD.N`) and picks
it up when it bumps the pin, so a change it needs ships in a release first.
stare-builder depends on stare, never the other way round, and nothing here may depend on
it. stare's CI builds no pipeline.

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
/index/reporters.json             — planned, never published; the reporter map is stare.pub/reporters.json (#161, below)
/cap/{reporter}/{vol}.zip         — case text JSONs (codex-data bucket, served at data.stare.pub/cap)
/cl/c/{cluster_id}/{hash}.json.gz — one CourtListener record, CAP's case JSON shape plus `source` (codex-data, data.stare.pub/cl); immutable
/data/{reporter}/{vol}.tar        — page images + ALTO OCR (range requests via tar.csv)
/data/{reporter}/{vol}.tar.csv    — tar byte offset manifest
/pdf/{jur}/{reporter}/{vol}.pdf   — our archival PDF of the volume (codex-data, data.stare.pub/pdf; D120, D122); immutable
/pdf/{jur}/{reporter}/{vol}.json  — its manifest: provenance, SHA-256, size, pages and their METS ORDERs, bookmarks
/pdf/manifest.json                — the index of every CAP volume, with its PDF or under no_scans; max-age 60
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
- Aliases (#151): a `cap` ref can name a case in another volume, `<slug>/<folder>/<file>`,
  with trailing `key=value` fields; `via=cl:<cluster>` says it came from CourtListener's
  `citations` table (publisher, scraper and import metadata, never eyecite, never
  `html_with_citations` or the citation-map): `287,cap,neb/128/0783-01,via=cl:8077312`
  in `n-w/260.idx.gz`. `via=nominative:us` (stare-builder#32) files a case in U.S. Reports
  volumes 1 to 90 under its early reporter's name and volume as well (`wall/22.idx.gz`:
  `238,cap,us/89/0238-01,via=nominative:us`), labelled "Resolved as the U.S. Reports under
  its reporter's name". `via=official:<slug>` (stare-builder#41, #48) files a case whose
  official citation gives another page than CAP's scan numbers it by (a reprint paged
  differently, an orders section CAP numbers on from the opinions, a misnumbered page) at
  its official page, in its own volume (`us/8.idx.gz`: `29,cap,us/8/0018-01,via=official:us`,
  `8 U.S. 29` at the reprint's page 18; `ohio/20.idx.gz`:
  `119,cap,ohio/20/0101-01,via=official:ohio`), labelled "Resolved by the reporter's official
  page; CAP's scan numbers the case on another page"; the build leaves out an own line at a
  page another case is officially at. A page's own CAP cases sort before its aliases, and aliases before
  `cl` lines, so CAP's case wins (#160). Readers label a link that came through one
  "Resolved through CourtListener's citation metadata" and never call it verified. CAP
  case files can hold a comma (`11, 12-01`) or `=` (`1265=1275-01`), so fields are parsed
  only from the end of a line. The manifest's `aliases` lists volumes whose file has only
  aliases; they aren't in `reporters`, and a miss in one links out like any volume
  stare.pub doesn't hold. Readers from before aliases skip the lines as malformed and
  ignore `aliases`, so the format stays `idx: 1`.
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

A labelled page (#154) is a page in every reader: `cai-cas 1 xxix`, `cal-app-4th 15 Supp. 1`
and a citation citare reads with a label (`1 Cai. Cas. xxix`) resolve in the CLI and on the
site, and `stare check` and the brief checker look them up. The site's hash carries the
label URI-encoded (`#cal-app-4th/15/supp.%201-01`), and `web/public/js/pagekey.js` keys
pages the way `idx::parse_page` and `index::page_key` do. Without `.idx.gz` a label is
read from the folder's `.multi`.

Every reporter's directory is citare's edition `slug` (citare#71, citare v0.6.0): CAP's
slug where CAP has the reporter, else one citare derives from the edition name
(`NY Slip Op` → `ny-slip-op`). Year-volume neutral citations share the CAP reporter's slug
at volumes CAP's can't reach (`2019-Ohio-1234` is `ohio/2019`, `2021 ND 123` is `nd/2021`).
`resolvable_citations`, the CLI and the site (`citedSlug` in `manifest.js`) look citations
up by it; with a data bundle older than v0.6.0, which has no slugs, by `harvard_slug`.
A reporter citare reads as a variation of an edition with another name (citare#86, v0.7.0:
`127 Ohio 545` is the Ohio State Reports, since the Ohio Reports end at volume 20) keeps
`reporter` as cited and gets that edition's slug, with the edition's name in
`corrected_reporter`. The site's link says "Read as 127 Ohio St. 545", and the miss notes,
the CLI's `stare check` and the CourtListener and Scholar links use the edition's name.
stare-builder's `stare-admin --cl` files each CourtListener citation under the slugs of the editions citare
finds in its citation string, or of its reporter's edition name when citare can't read the
string (CourtListener writes `2019 T.C. Memo. 123`); a name citare splits between reporters
(`Hill`, `Ct. Cl.`) is filed under each of its slugs. The pipeline's manifest carries
citare's slugs too, from its copy of `data/edition-slugs.json` (stare-builder's
`crates/stare-admin/tests/edition_slugs.rs` checks the copy against the citare its stare pin
brings); the build counts any that disagree as `slugs_differ`.
`crates/stare/tests/fixtures/cl-sample-build.json` is a sample build that the Rust and JS
tests resolve end to end.

### Parallel citations (#160, `crates/stare/src/parallel.rs`)

citare reads a run of citations as one decision (`128 Neb. 783, 260 N.W. 287`, the
detected citation's `parallel_of`); the index says what each member opens. After the
lookups, reconciliation applies the owner's D35 rulings: a member that misses (a volume
stare.pub doesn't hold, or a page CAP redacted in one it does) resolves through the run's
preferred printing when the members that resolve all open one case, labelled "Reported at
128 Neb. 783, inferred from the citing text" and never called verified; members that open
different cases are both shown, flagged "needs review", and kept apart in the list; and the
preferred printing is the official reporter's (`DetectedCitation::official`: a state's, or
the U.S. Reports) when stare.pub holds it. The rules are one function,
`stare::parallel::reconcile`, tested on `crates/stare/tests/fixtures/parallel-reconcile.json`:
`stare check` calls it directly, and the site's `checkCitations` through the WASM export
`reconcile_parallels` (#185). A member found at a page several cases start on is looked up
as every one of them (`stare::parallel::page_cases`, `pageCases` in `citations.js`), and
members are consistent when they share a case (#204): they open that one, which can be the
page's second (`#md/163/481-02`). A data alias (`via=cl:`) still wins: it resolves the member on
its own, with its own label. When nothing else settles which case at such a page a citation means (no alias
names one, and its run's printings, if any, share more than one; `Verdict::tied`), the citing
text's case name does (#212, D72 (2), `stare::byname::pick`): its telling words and year
against each case's names and decision date, the way stare-builder matches CourtListener
clusters to shared pages (stare-builder#37), taking a case only when it is the one clear
match. When a run's printings share several cases, none of them fits the name, and exactly
one case on the official printing's whole page does (D90,
`stare::byname::pick_on_official_page`; the U.S. Reports for `State v. Gordon, ..., cert.
denied, 455 U.S. 989, 102 S. Ct. 1612, 71 L. Ed. 2d 848`, whose L. Ed. aliases leave out
Connecticut v. Gordon), every printing opens that case, a printing whose own page doesn't
list it without a `via`, and the note says "among the 12 cases on the official page, 455
U.S. 989; the cases its parallel citations share don't include it". The same goes for a
run whose printings share one case that clearly isn't the one the name names, having
telling words and none of the name's (D98 (1): CourtListener gives 143 L. Ed. 2d 111 to
Compagnie Euralair's cluster alone, so `State v. Shabazz, ..., 525 U.S. 1179, 119 S. Ct.
1116, 143 L. Ed. 2d 111` shares only Euralair); the note then ends "the case its parallel
citations share doesn't fit the name". A nameless citation in another's subsequent history (`Segreto v. Bristol, ..., cert.
denied, 261 Conn. 941`) takes the name it follows (`DetectedCitation::history_name`). The
names come from each case's JSON, read out of its volume's zip by range requests
(`stare::ziprange`; `web/public/js/casenames.js`), or a CourtListener record. The link says
"Matched by case name among the 3 cases on this page" ("... the 2 cases its parallel
citations share" when the run narrowed them), and so does `stare check`; case URLs don't
change. The JS tests load the built WASM (`web/tests/wasm-node.js`) for
these rules, so CI builds it before running them, and `mise run test-js` runs `build-wasm`
first.

### Cited cases (#159, #198, `crates/stare/src/cited.rs`)

The sidebar, /check and `stare check` list one entry per cited case and count the places
in the text that cite it. `stare::cited::group` gathers the citations that resolve to one
case (its printings, a reprint resolved through its partner, an alias, and the short forms
that refer to any of them), falls back to the citation's reporter, volume and page for one
that resolves to nothing, and keeps the members of a run flagged "needs review" apart. A
parallel run is one place, and each short form one more. A case cited in more than one
form lists each form with its own count of places (`entry_counts`; D72): a run counts once
for each of its printings, and a short form where it appears. On the site (`citedForms`),
full citations with the same text are one form, and the short forms fold into one "Also
cited as" line for each kind (D81): `Id.`, `supra`, and "a short cite" (`ShortCaseCitation`
and `ReferenceCitation`, such as `303 Conn. at 850`), each with its count of places (a
place two of its short forms share counts once) and their texts in its title. The CLI keeps a line for each
short form, since each has its own status and antecedent. `stare check` calls it directly,
and the site's `groupCitations` through the WASM export `group_citations`. The text's
citations carry the place as `data-cite-place`, and `citenav.js` steps through places,
highlighting a run's printings together; `~c=` still numbers every marked citation. The
summaries count cited cases ("2 cited cases found (2 resolvable), 1 statute").

### CourtListener records (`crates/stare/src/cl.rs`, `web/public/js/cl.js`)

Cases CAP doesn't hold come from CourtListener's bulk data
(`docs/plans/courtlistener-mirror.md`). A record is CAP's case JSON with a `source` block
(`name: "courtlistener"`, the export date, CourtListener's ids, docket number, status and
URL); `<hash>` is the first 16 hex digits of its SHA-256. The unified index's `cl` lines
point at them; the site and the CLI fetch the record and render it like a CAP case with a
source line, and no page scans or PDF. `cl.rs` and `sources.js` are the only places that
build record paths. Index v2026.10.22 is the first live build with them: 900,342 records
from CourtListener's 2026-09-30 export, at `data.stare.pub/cl/c/` (the exports under
`data.stare.pub/cl/exports/` are not served, 403, and nothing links them). The e2e tests that
need a fixed case serve a hand-made record (`crates/stare/tests/fixtures/cl-record.json`)
through routes. The site credits CourtListener on /about, /data, `llms.txt`, `openapi.json`,
the `/data` JSON-LD and the README (#206), with the record count, the export date and the
index version from `web/src/data/collection.json`'s `courtlistener`.

### Index builds and publishing

Index builds run from codexpublicus/stare-builder (`mise run index-build`, `mise run
index-publish`, operator-run on ml-01); its AGENTS.md has the steps. Each build is immutable
under `v/<version>/` with a CalVer data version (`vYYYY.MM.DD`, `.N` for a later one the
same day), and the root `manifest.json`'s `base` names the live one. Rolling back is
publishing an earlier version.

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
- Page views: the archival PDF through PDF.js with its text layer, and the raw scans (JPG + ALTO text overlay)

### The search boxes (#248: `web/public/js/searchbox.js`, `suggest.js`)

The landing's box and the top bar's citation editor are the same component. Both take a
citation as written (`32 Misc. 426`, read by citare), the slug form (`misc 32 426-01`,
`a2d/31/647`), or a reporter typed first by its abbreviation (`Misc. 32 426`), which only
the typeahead's reporter list reads (`citeFromQuery`). Clicking the top bar's citation
fills the editor with the case's citation as written, not the slug form; the landing's
box shows the same once a case opens. The box remembers the case it was filled with
(`prefill`, `keptTarget`), from the hash, so the unchanged text reopens that case even on
a page several cases start on; the sequence never goes in the text, and any edit drops it.

Each box is an ARIA combobox (`role="combobox"`, `aria-expanded`, `aria-controls`,
`aria-activedescendant` over a `role="listbox"` of options) with a polite live region
saying what it suggests. Arrow keys move, Enter takes the active suggestion (a reporter or
volume fills the box; a page opens its case), and Escape closes the list before it closes
the top bar's editor. Suggestions are worked out 120 ms after typing stops, and a result
for text that has since changed is dropped, so nothing blocks typing. `suggest.js` is pure
(unit tests in `web/tests/suggest.test.js`); `searchbox.js` does the DOM and the fetches.
What each stage suggests, and fetches the first time:

- **Reporter**, while letters are typed: `/reporters.json` (about 75 KB compressed) and
  the index manifest (about 40 KB; a case page already has it). A reporter matches by its
  names, its variations and its slug, ignoring case, spaces and periods (`misc`, `Misc`),
  then by its editions' full names word by word (`N.Y. Misc.` finds New York
  Miscellaneous Reports). Reporters the index holds volumes of come first, then exact
  matches before prefixes before word matches, then the most volumes in the live
  manifest. Each shows its abbreviation, full name, years and volume count.
  reporters.json has no jurisdiction, so the suggestions don't show one yet.
- **Volume**, after a volume number: nothing more is fetched. Whether the manifest holds
  it (`holdsVolume`), a volume of parallel citations only (`aliases`), or, when it holds
  neither, the four held volumes nearest it; a volume CAP published without scans
  (`scans.js`) is marked "no page scans".
- **Page**, after page digits: the volume's `.idx.gz` (0.4 to 5 KB, in the cache's `bins`
  store; a split volume's later part when the digits fall in it), parsed by the WASM's
  `parse_idx`, gives the pages starting with those digits, or the pages either side of a
  page no case starts on (a pin cite). A page's cases are the resolver's (`casesAt`): CAP's
  own, one per sequence, else the alias, else CourtListener's records. The pages show at
  once, and the cases' names follow from the volume zip's `metadata/CasesMetadata.json`,
  read by range requests (`casenames.js`, `volumeCaseNames`: the zip's 64 KB tail, then
  that one entry, 70 to 380 KB per volume in the ten volumes measured on #248), kept in
  the cache's `multi` store as `names/<slug>/<folder>`, and aborted when the typing moves
  to another volume. The index lines carry no names; a names column added to the index
  files in stare-builder would cost 0.2 to 8 KB more per volume compressed (the index
  files grow about threefold) and would replace the range read.

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
| main before #153 (citare v0.5.3), 2026-10-17 | 1,777,038 | 644,193 | 470,543 |
| citare v0.6.0 with edition slugs (#153) | 1,778,036 | 645,197 | 470,490 |
| its bundle, `citare-data-72bb280b4d192063.bin` (v0.5.3's `a1dbd84e5cd5ff0a`: 433,931, 125,483, 99,852) | 449,928 | 132,941 | 106,407 |
| the same bundle with zopfli, as served (v0.5.3's: 116,249) | | 123,689 | |
| main before citare v0.7.0, 2026-10-18 | 1,802,588 | 653,599 | 477,547 |
| citare v0.7.0 | 1,808,401 | 656,040 | 478,513 |
| its bundle, `citare-data-0d5ed0510f1b34b4.bin` | 450,896 | 133,024 | 106,464 |
| the same bundle with zopfli, as served | | 123,748 | |
| main before citare v0.7.1, 2026-10-20 | 1,808,632 | 656,368 | 478,918 |
| citare v0.7.1 (its bundle is v0.7.0's, `citare-data-0d5ed0510f1b34b4.bin`) | 1,811,049 | 656,082 | 479,319 |
| main before citare v0.7.2, 2026-10-22 | 1,854,644 | 667,204 | 494,449 |
| citare v0.7.2 | 1,858,787 | 668,148 | 495,198 |
| its bundle, `citare-data-8058901af64a1aff.bin` | 454,062 | 133,306 | 106,908 |
| the same bundle with zopfli, as served | | 124,108 | |
| main before citare v0.7.3, 2026-10-23 | 1,891,970 | 682,319 | 506,108 |
| citare v0.7.3 | 1,891,971 | 681,587 | 505,784 |
| its bundle, `citare-data-389bc858cd837989.bin` | 455,708 | 133,968 | 107,230 |
| the same bundle with zopfli, as served | | 124,517 | |
| citare v0.7.4, 2026-10-25 (main before it built the v0.7.3 row's module; its bundle is v0.7.3's, `citare-data-389bc858cd837989.bin`) | 1,892,055 | 681,637 | 505,662 |

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
exports them with `stare-site export-citare-data`, gzipped with zopfli, to
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
`codexpublicus/stare-builder` (the data build), `codexpublicus/gorsuch-library`, `codexpublicus/infra` (shared zones, edge rules and the
LFS proxy) and `codexpublicus/codexpublicus.org` (umbrella site).

Shared Cloudflare values come from the Pulumi stack `organization/codexpublicus-infra/prod`,
not from any per-site config. That stack owns stare.pub's zone and DNS, the `stare-pub-idx`
R2 bucket and `idx.stare.pub` (moved there from
`lokkju-infra` on 2026-09-27; see codexpublicus/stare#3), the `codex-data` R2 bucket, the
Workers deploy token, the citare deploy key and the three Actions secrets that carry them
(`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CITARE_DEPLOY_KEY`), plus
`CITARE_DEPLOY_KEY` again as a Dependabot secret. This repo runs no
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
`build-essential pkg-config openssh-client`. Toolchains still come from their setup actions
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
  `-D warnings`, `cargo test --workspace`, the WASM build, the JS tests and the Astro build,
  then upload a Worker version and keep one updating comment with its preview URL
  (`https://<version>-stare-pub.nick-441.workers.dev`), then run the Playwright smoke suite
  (`web/e2e/`, `.github/actions/smoke-test`) against that URL. Dependabot's PRs stop after
  the build: a workflow Dependabot triggers sees only Dependabot secrets, and infra stores
  `CITARE_DEPLOY_KEY` there but not the Workers token, since a dependency bump runs the new
  version's build scripts and the token can deploy production (codexpublicus/stare-builder#6).
- **Pushes to `main`** (`site.yml`, job "Preview main (not production)") run the same checks
  and upload a version to the `main` preview alias (and the `site-wasm` artifact `release.yml`
  deploys),
  `https://main-stare-pub.nick-441.workers.dev`, and smoke test the uploaded version's own URL.
  A green check on `main` is not a deploy, but a failed smoke test blocks the release, since
  `release.yml` refuses a merge commit whose checks failed.
- **The release PR** (`release-prepare.yml`, on every push to `main`): git-cliff collects the
  Conventional Commits since the last release tag and keeps one open PR from `release/next`,
  "chore(release): next site release", that updates `CHANGELOG.md`. Only `feat`, `fix` and
  `perf` commits touching the site (`web/`, `crates/stare`, `crates/stare-wasm`, `crates/stare-site`, `wrangler.jsonc`,
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
the live index's data version from the manifest's `version`, and the sources its `based_on`
names (`Index v2026.10.22 · Sources: Caselaw Access Project, CourtListener bulk data`), read in
the browser by `web/public/js/dataversion.js`, and the manifest's Last-Modified date for a
manifest without a version.

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

Before each site release, the doc review (`.claude/skills/doc-review/`, #201) checks the
site's pages, the agent files, this file, the READMEs and the CLI's help against what merged
since the commit in `docs/.reviewed-at` and the live static files, and opens one PR with the
fixes. `scripts/changes.sh` there lists the merged PRs, releases and live state.

`idx.stare.pub`'s CORS allows `stare.pub`, its subdomains and the account's workers.dev
subdomain, so previews resolve citations too.

`stare-pub-idx` holds the deployed index. It is protected and `retain_on_delete` in
codexpublicus-infra and must never be deleted or recreated; back it up before any change to
its declaration.

Infrastructure changes go through PRs to codexpublicus/infra, not this repo. See that
repo's `AGENTS.md` for the Pulumi, Wrangler and LFS rules that apply across the org.

### Crawlers and agents (`web/src/lib/robots.js`, `src/data/curated.json`, `public/llms.txt`, `src/lib/sitemap.js`; #171, #161)

The crawl design is D41 and D44 on #171: one canonical URL per case, a sitemap of the site pages
plus a curated set of case pages, and the rest of the corpus not crawled. Every case keeps one
permanent page at `/c/<slug>/<volume>/<page>/` (`CASE_PREFIX` and `casePath` in
`src/lib/robots.js`), and no URL changes when a case's crawl status does. When several cases
start on one page, each gets `/c/<slug>/<volume>/<page>/<n>/` in CAP's file order and the bare
page path lists them (D59 on #171); an `Allow:` on the page path covers all of them. That
segment applies once case pages ship. `robots.txt` has
`Disallow: /c/` plus an `Allow:` line per curated case; the longer rule wins. The one list is
`src/data/curated.json` (empty until #172 picks the set): `src/pages/robots.txt.js` renders
`robots.txt` from it at build time, and the sitemap lists the same cases with each entry's
`lastmod`. Joining or leaving the set changes those two files only. Google reads 500 KiB of
robots.txt, about 10,000 case lines; past that, list a reporter (`"a2d/"`) or volume
(`"a2d/31/"`) as a subpath entry, which replaces the case lines under it in `robots.txt` while
the sitemap keeps listing the cases. `renderRobots` and the build both fail past 500 KiB. No case
pages exist yet, and nothing was ever served under `/case/`, the curated prefix of the first
design. `robots.txt` states the content signals `search=yes, ai-input=yes` (D40) with
Cloudflare's Content Signals Policy text, and `ai-train` stays unstated until decided. Cloudflare's
managed robots.txt is off on the zone: before this file existed, stare.pub served the free-plan
default, the policy text with no signals and no rules, which a robots.txt from the Worker replaces.
Turning managed robots.txt on would prepend Cloudflare's own block, AI-crawler disallows included.

The build writes `sitemap.xml` (`stare-crawl-files` in `astro.config.mjs`). Each page's
`<lastmod>` is the last commit touching the page or a file it imports (components, `src/lib`,
`src/data`, `CHANGELOG.md`), not its stylesheets; in a shallow clone, which is every
`site.yml` build, lastmod is left out, and the release build (full history) dates every page.
The same hook fails the build if `robots.txt`, `llms.txt` or the sitemap is missing or wouldn't
parse, if `robots.txt` passes 500 KiB or its `/c/` Allow lines aren't the curated set, or if the
sitemap lists a page `robots.txt` disallows. `llms.txt` is the citation recipe
in plain GETs (manifest, per-volume `.idx.gz` or the volume zip's `CasesMetadata.json`, the case);
update it with any change to the published formats. `idx.stare.pub` and `data.stare.pub` get
their own `Disallow: /` robots.txt from stare-builder's publish tasks.

### Archival PDFs and CourtListener records

The archival per-volume PDF pipeline (#51) and the CourtListener bulk-export pipeline (#83)
are in codexpublicus/stare-builder, with their runbooks. What they publish, and how the site
and CLI read it, is above: `/cl/c/...` records (`crates/stare/src/cl.rs`) and the archival
PDFs at `pdf/<jurisdiction>/<reporter>/<volume>.pdf`, which stare-builder's `pdf-publish`
uploads (D120, D122). `{jur}` is the reporter's jurisdiction code, `us` except the
territories' own reporters (`PDF_JURISDICTIONS` in `web/public/js/sources.js`, a copy of
stare-builder's `pipelines/pdf-publish/reporter-jurisdictions.json`; the two change together
or not at all, since the paths are fixed once published). Every PDF's pages are its METS
ORDERs 1 to N, so a case's pages are its `first_page_order` to `last_page_order`.

The case view has three tabs, in this order, with Reader the default; the tab isn't in the
URL hash:

- **Reader**: the case's text.
- **Archival PDF** (`web/public/js/pdfviewer.js`, `pdfpages.js`): the case's pages of the
  volume's archival PDF, drawn by PDF.js to a canvas at the device pixel ratio, with PDF.js's
  text layer from the PDF's own invisible OCR text, so it can be selected and copied. It
  fetches the PDF by range requests only (a `PDFDataRangeTransport`, 32 KiB chunks,
  `disableAutoFetch`, `disableStream`): the first chunk gives the length and the
  linearization header, then the cross-reference section and each page shown, and it
  prefetches the next page once one is drawn. A 404 says the volume's PDF isn't published
  yet (f-appx/660, stare-builder#24) and offers the Raw Scans.
- **Raw Scans** (`web/public/js/pageviewer.js`): CAP's color JPEGs from the volume's tar on
  static.case.law, by range requests through its `.tar.csv`, with the ALTO text.

Both page views have the same toolbar and keys (←/→ pages, +/-/0 zoom), and load nothing
until their tab is first opened. CourtListener records and the 658 volumes CAP published
without scans (`web/public/js/scans.js`, from the index's `no_scans`) hide both tabs, and the
sidebar says "No page scans exist for this volume" instead of the PDF link. The sidebar's
"Download archival PDF" opens the whole volume's PDF at `#page=<first_page_order>`, for
saving or printing.

PDF.js is pdfjs-dist's legacy build, pinned exactly in `web/package.json` and self-hosted:
the `stare-pdfjs` hook in `web/astro.config.mjs` copies `pdf.min.mjs`, the worker,
`jbig2.wasm` (pdfjs-dist 6 decodes JBIG2 in WebAssembly) and their licences into
`web/public/vendor/pdfjs-<version>-p<patch>/` (gitignored) before the dev server or the
build reads `public/`, and `_headers` serves it immutable. The worker is patched
(`web/src/lib/pdfjs-vendor.js`): unpatched, PDF.js finds a page by fetching every page's
dictionary in the flat page tree qpdf writes, which for these linearized files meant
reading most of the volume before the first page showed: in Chromium on 2026-10-26, 2.2 MB
of a2d/142's 3.3 MB and 42 MB of f2d/500's 84 MB, in 1,297 requests. Patched, opening a case
there took 142 KB in 5 requests and 183 KB in 6.
A pdfjs-dist bump updates the version in `web/public/js/pdfjs-path.js` with it, and the
build fails if the patch no longer applies. The site sends no Content-Security-Policy; if
one is added, the view needs `worker-src 'self'`, `connect-src https://data.stare.pub` and
`'wasm-unsafe-eval'`, and no `'unsafe-eval'` (it passes `isEvalSupported: false`).

### Agent files (#161: `reporters.json`, `openapi.json`, `/schemas/`, JSON-LD)

Everything an agent uses is a static file; nothing runs per request (the owner's rule of
2026-10-17 on #161: no Worker routes, no `run_worker_first`). A runtime an agent wants, such as
`stare mcp` (#162), runs on the agent's side against these files.

- **`/reporters.json`** is generated, never hand-written: `stare-site export-reporters
  --manifest <file> web/public/reporters.json` (`crates/stare/src/reporters.rs`) takes the
  names and variations from the citare bundle stare is built with (the edition table, and the
  literal spellings in its reporter map's variation extractors) and the volumes from an index
  manifest. `build-site` and `mise run build-wasm` fetch the live manifest for it, so the site
  build needs idx.stare.pub to be up, and the `site-wasm` artifact carries the file to the
  release like the bundle. Its volumes are a snapshot; the live manifest stays the authority.
  The format is `schemas/reporters.v1.schema.json` (`stare::schemas::REPORTERS_V1`); change
  the schema, the module and `FORMAT` together. A slug citare stops assigning stays in
  `reporters` for one site release with `replaced_by`, the slug that took its editions, and
  no names (`reporters::REPLACED`, D78), then is dropped from `REPLACED`. It is empty now:
  `p-r-r` and `cai-r`, replaced by `pr` and `cai` in citare v0.7.2 (citare#105), were kept
  for site release v2026.10.22.2 and lost `replaced_by` with citare v0.7.3. `p-r-r` is still
  listed, with no names, while the index build holds a volume under it (v2026.10.22: 83).
- **`/openapi.json`** (`web/public/openapi.json`) is hand-written OpenAPI 3.1 for the static
  GETs: the idx manifest, per-volume `.idx.gz` and its parts, the build reports, the CAP zips,
  the CourtListener records (`getClRecord`) and the site's own files, each with its content
  type and Cache-Control as served. GET only, no query parameters, no request bodies. Update it
  with any change to a published path or header.
- **`/schemas/<file>`**: `src/pages/schemas/[name].json.js` publishes `schemas/*.schema.json`
  at the URL each `$id` names, and fails the build if one doesn't match.
- **JSON-LD**: a `WebSite` on `/` and a `Dataset` on `/data` (`src/lib/jsonld.js`,
  `components/JsonLd.astro`), with figures from `collection.json`. The Dataset's `hasPart`
  gives each licence its own sub-dataset (below).
- **Licences** (the owner's ruling of 2026-10-20, D63(1)): CC0 1.0 for the CAP case files
  and anything else republished under its source's CC0 terms; CC BY-NC-ND 4.0, crediting
  stare.pub, for everything else the project produces (the citation index, the manifest and
  build reports, the reporter map, the OpenAPI document and schemas, case pages, other site
  data). `crates/stare/src/license.rs` and `web/src/lib/license.js` hold the two. They appear
  as `license` in `reporters.json` and `cap-glyphs.json`, `info.license` in `openapi.json`,
  `x-license` in each schema, a `license` per `hasPart` and per download in the `/data`
  JSON-LD, and in prose in `llms.txt` and on `/data`. A new published JSON file must
  state one, or the tests below fail. The code licence (Polyform Shield) is separate.
- **Upstream attribution** (the owner's ruling D65, 2026-10-20). Where stare.pub republishes
  another project's data, that data keeps its own licence and credit:
  - reporters-db and courts-db (Free Law Project, BSD 2-Clause): `license.rs` has
    `REPORTERS_DB` and `COURTS_DB`, with their LICENSE files copied verbatim into
    `crates/stare/src/licenses/` (`tests/upstream_licenses.rs` checks the copies against the
    submodules in the citare checkout stare is built with; a citare bump that changes one
    fails there). `reporters.json` has `sources`: reporters-db, the commit the citare bundle
    records, its licence and text, and the fields from it (`REPORTERS_DB_FIELDS`). The citare
    data bundle is binary, so `export-citare-data` writes a sidecar next to it,
    `/data/citare/v1/citare-data-<hash>.json` (`stare::data::Sidecar`), with the bundle's CC
    BY-NC-ND licence and both upstreams' sections, commits, licences and texts. `_headers`
    serves the sidecar as JSON. The `/data` JSON-LD names both in `isBasedOn` on the reporter
    map and the `#citare-data` part.
  - `sources` is a list with one entry per source, each saying what it `contributes` (the
    owner's ruling D67, 2026-10-21). Some names, variations and editions come from citare's own
    supplements (`data/reporters-local.json`, `data/laws-local.json` in codexpublicus/citare),
    so both `sources` lists end with a citare entry (`stare::license::citare`): the citare
    commit stare is built with (`CITARE_COMMIT`, checked against `Cargo.lock`'s by
    `tests/upstream_licenses.rs`, so a citare bump fails until it's updated) and the project's
    CC BY-NC-ND licence with stare.pub as the source, no text or copyright line. Rows aren't
    marked by source. The JSON-LD adds citare's supplements to both parts' `isBasedOn`.
  - CourtListener records carry the Public Domain Mark 1.0 that CourtListener puts on its bulk
    data (`PUBLIC_DOMAIN_MARK`), in `license`, and `attribution`: CourtListener, Free Law
    Project, and the export date (`COURTLISTENER`; `CaseJson::license`/`attribution`).
    stare-builder's record writer adds both. The JSON-LD's CourtListener `isBasedOn` states the
    mark, and the records are their own part (`#courtlistener-records`) under it.
  - The index manifest (`Manifest::license`), build reports and `reports/index.json` take a
    `license` (CC BY-NC-ND, stare.pub as the source) that stare-builder writes; the report
    schemas accept it, and files from before it have none.
  - They also take an optional `based_on` (D67, `Manifest::based_on`, the report schema's
    `$defs/based_on`): what the build is made from, as facts with URLs, the Caselaw Access
    Project (CC0 1.0) and CourtListener's bulk data (Public Domain Mark 1.0, Free Law Project).
    stare-builder writes `stare::license::index_based_on()`. No licence terms or legal
    conclusions go in it.

`crates/stare-site/tests/agent_files.rs` validates an exported `reporters.json` against its
schema and `openapi.json` against the OpenAPI 3.1 schema (vendored in `tests/fixtures/`), and
checks that the OpenAPI describes GETs only and that its refs resolve. `web/tests/agentfiles.test.js`
covers the JSON-LD and `llms.txt`'s links; both check that every published JSON file states a
licence, and `web/e2e/agents.spec.js` checks the deployed
site serves all of it.

Per-case JSON (`data.stare.pub/case/<slug>/<vol>/<page>.json`, the issue's third static piece)
waits on stare-builder: it's a one-time write of about 7M objects from the zips plus the
CourtListener records, a new data build rather than a site change.

## Current Status

- **Live**: stare.pub serves the Astro site from the `stare-pub` Worker (since 2026-09-29; the
  old Pages project is deleted by #41). CI deploys it when a release PR merges (#60), so
  production is the latest `vYYYY.MM.DD.N` release tag, and `main` can be ahead of it.
- **Live**: `idx.stare.pub` (R2 bucket `stare-pub-idx`) serves the citation index files. The
  live build is the one the root `manifest.json`'s `version` names; on 2026-10-22 that was
  `v2026.10.22`, the unified `.idx.gz` index (`idx: 1`) with `.bin`/`.multi` beside it: CAP's
  40,622 volume folders under 401 slugs and 6,920,598 cases, plus 1,101,715 `cl` lines into
  the 900,342 CourtListener records (export 2026-09-30) and `via=cl:` aliases, with 589 slugs in
  `reporters` and its `based_on` naming CAP and CourtListener's bulk data.
- **Zips**: the site and the CLI fetch case zips from `https://data.stare.pub/cap/<reporter>/<volume>.zip`
  (our copy, #27), and the volume PDF link opens our archival PDF at
  `https://data.stare.pub/pdf/<jurisdiction>/<reporter>/<volume>.pdf#page=N`. Tars and
  `.tar.csv` still point at static.case.law.
- **Mirror**: complete. TrueNAS `mega/codexpublicus/cap-mirror` holds 40,622 zips and 39,964
  each of tars, `.tar.csv` and PDFs (counted 2026-09-29; checksums not yet audited, and a2d/142.tar fails its `.tar.sha256`, see #77); the dataset is read-only and the
  aria2 `codex-mirror` container is stopped.
- **Pending, tracked by issue** (`gh issue list -R codexpublicus/stare`):
  - #42: `codex-data` contents and `data.stare.pub` exposure (tier 1 uploaded 2026-09-29)
  - #51: archival per-volume PDFs (pipeline in codexpublicus/stare-builder)
  - #52, #61: Akoma Ntoso case text (profile in codexpublicus/exemplar); parallel-citation display
  - #10 — a computable court record key, a stable identifier for every decision
  - #8 — add case sources beyond CAP
  - #7 — pass-through citation resolver for cases this repo doesn't hold
  - #6 — offline, self-hosted law reference library, US then other countries
  - #5 — shared design system review across Codex Publicus sites
  - #4 — settle the code license and declare it everywhere
  - #1 — adopt the shared Codex Publicus page viewer

  Beyond these, see issues for anything not listed here.

## Development Phases

1. **Mirror static.case.law** (done 2026-09-29): every tar, PDF, zip and metadata file, on TrueNAS
2. **Citation index + CLI tool** (done): the per-volume index at idx.stare.pub, built in codexpublicus/stare-builder, and the Rust `stare` CLI (`stare resolve a2d 31 647` → text)
3. **Web tool (WASM)** (live at stare.pub): citare and stare-wasm in the browser, zip extraction, served by the `stare-pub` Worker; PDF as fallback viewer link
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

The homelab (ml-01, TrueNAS and the `codexpublicus-*` Docker volumes) runs the data build
and the CI runners; codexpublicus/stare-builder's AGENTS.md describes it. Inspect corpus
files from the mirror there, never from static.case.law.

## Key Context

- Harvard CAP API died March 2024. Search died September 2024. static.case.law still serves bulk data.
- The tars are the irreplaceable assets: the color scans, the bitonal images and the ALTO word geometry exist only there. The PDFs can be regenerated from the tars' TIFFs; the text can be re-derived.
- Ravel/LexisNexis exclusivity expired March 2024. All data is public domain / CC0.
- Rate limit scraping: max 1-2 req/sec, identify in User-Agent.
