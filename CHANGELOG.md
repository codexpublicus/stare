# Changelog

Site releases of stare.pub. Each release is tagged `vYYYY.MM.DD.N` and deployed to production when its release PR merges.

## v2026.11.11.1 - 2026-11-11

### Features

- web: open /k/<key>/ and /c/ addresses in the reader
- web: open CAP cases and search snippets by the index's zip spans, one Range request each
- web: open /d/<id>/ decision addresses in the reader
- self-host mirror kit and the reader on a self-hosted copy

## v2026.11.05.1 - 2026-11-05

### Fixes

- deps: bump zip from 2.4.2 to 9.3.0

## v2026.11.04.1 - 2026-11-04

### Features

- search: read search format 3 beside format 2

## v2026.11.02.2 - 2026-11-02

### Features

- web: state the collection's size and range from the live index
- web: search page UI pass: filters, waiting states, results layout
- web: one box, one button: citations open, anything else searches

## v2026.11.02.1 - 2026-11-02

### Features

- site: full-text search page

## v2026.10.27.3 - 2026-10-27

### Fixes

- web: drop a case load's late results once another case replaces it
- web: bound the zip cache and never let IndexedDB stop a case opening

## v2026.10.27.2 - 2026-10-27

### Fixes

- web: open a case without moving the reader, and fetch its data while the WASM loads

## v2026.10.27.1 - 2026-10-27

### Features

- web: the Codex Publicus look, with metric-matched font fallbacks

### Fixes

- web: boot guard, lazy page views and typeahead, and a filter-list check
- web: boot guard ignores a blocked Cloudflare beacon; drop "no tracking"

### Performance

- web: cache content-hashed assets for a year, preload the module graph

## v2026.10.26.6 - 2026-10-26

### Features

- web: typeahead and the citation as written in the search boxes

### Fixes

- web: paint one selection highlight per line in the page views
- web: rename page-view scripts that content blockers block
- web: repaint the selection highlight when the OCR text's font arrives

## v2026.10.26.5 - 2026-10-26

### Features

- web: page views fit the screen, with a sticky toolbar, zoom modes and page links

### Dependencies

- deps: move to citare v0.7.5

## v2026.10.26.4 - 2026-10-26

### Features

- web: an Archival PDF view in the reader

## v2026.10.26.3 - 2026-10-26

### Fixes

- web: open a case hash on the reader, never the landing

## v2026.10.26.2 - 2026-10-26

### Features

- idx: label official-page aliases in every reporter, official:<slug>
- web: read Codex Publicus's archival PDFs from data.stare.pub

### Fixes

- web: stop the scan viewer shadowing tarUrl

## v2026.10.26.1 - 2026-10-26

### Dependencies

- deps: move to citare v0.7.4

## v2026.10.23.1 - 2026-10-23

### Features

- idx: label official-page aliases for the U.S. Reports
- cite: pick the case on a shared page by the citing text's case name
- cite: match the case name on the official page when a run's shared cases miss it
- cite: match the case name on the official page when a run's one shared case doesn't fit it

### Dependencies

- deps: move to citare v0.7.3 and retire the replaced reporters.json entries

## v2026.10.22.3 - 2026-10-22

### Features

- cite: count each form of a cited case, folding short forms into one line per kind
- web: credit CourtListener as a source and state what stare.pub adds

## v2026.10.22.2 - 2026-10-22

### Features

- idx: label nominative aliases as the U.S. Reports
- cite: count citations by the case they resolve to, comparing parallels against every case at a page

### Dependencies

- deps: move to citare v0.7.2, keeping p-r-r and cai-r in reporters.json for one release

## v2026.10.22.1 - 2026-10-22

### Features

- static agent files: reporters.json, openapi.json, JSON Schemas and JSON-LD
- state the data licences in stare.pub's machine-readable files
- attribute reporters-db, courts-db and CourtListener in published data
- list every source in published attribution and add based_on provenance

### Fixes

- web: keep every case at one /c/ path and allow the curated set by name

### Dependencies

- deps: move citare-core to v0.7.1

## v2026.10.20.1 - 2026-10-20

### Features

- resolve a parallel citation through its partner

### Dependencies

- deps: move citare-core to v0.7.0

## v2026.10.18.1 - 2026-10-18

### Features

- cite: resolve by citare's edition slug
- idx: resolve parallel citations through CourtListener aliases
- web: go from a cited case to where the text cites it, and filter the list
- web: serve robots.txt, sitemap.xml and llms.txt

### Fixes

- web: show a failed index lookup as unchecked, never as a link
- case: read source.text_field as a list and show source.cl_blocked
- resolve citations to labelled pages (xxix, Supp. 1)

## v2026.10.17.1 - 2026-10-17

### Features

- index: one per-volume index for every source

## v2026.10.11.1 - 2026-10-11

### Features

- web: render CourtListener records on a CAP miss

## v2026.10.08.1 - 2026-10-08

### Features

- web: link pin cites to the cited page
- web: show statutes, bump citare to 0.5.3

## v2026.10.06.2 - 2026-10-06

### Fixes

- release: keep every release in the changelog

## v2026.10.06.1 - 2026-10-06

### Features

- load citare's data bundle separately

## v2026.10.05.2 - 2026-10-05

### Fixes

- web: resolve short cites via antecedent

## v2026.10.05.1 - 2026-10-05

### Dependencies

- deps: bump citare to v0.5.0

## v2026.10.03.3 - 2026-10-03

### Features

- index build reports and /data page
- web: load the WASM in the background

### Performance

- wasm: shrink the stare-wasm module

## v2026.10.03.2 - 2026-10-03

### Features

- versioned index layout
- web: self-host subset web fonts

## v2026.10.03.1 - 2026-10-03

### Features

- link out for missing cases and statutes

### Fixes

- web: take the collection figures from one data file
- index: string volume keys for split volumes
- index: index every case, fail short volumes

## v2026.10.02.1 - 2026-10-02

### Features

- cite: bump citare to v0.4.0

### Fixes

- cite: link spaced U.S.C. and C.F.R. forms
- cite: bump citare to v0.4.1

## v2026.10.01.1 - 2026-10-01

### What stare.pub is
- Citation resolution runs in your browser. The page loads a WASM build of the same Rust core the command line tool uses and reads the citation index files from idx.stare.pub; there is no backend.
- The site has been served from the stare-pub Cloudflare Worker (Workers Static Assets) since 2026-09-29.
- Citations are highlighted in your text by their offsets, the way the resolver reports them, instead of by pattern replacement.
- The page shows a loading state while citations are being detected.
- The footer shows the site release and the date of the citation index.
- Every pull request gets a preview deployment that resolves citations too, and production deploys only from a merged release PR.


### Features

- fetch case zips from data.stare.pub
- web: /about rewrite, /updates and feed, no GitHub links, CalVer footer

### Fixes

- web: link only into this repo from the /about changelog

