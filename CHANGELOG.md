# Changelog

Site releases of stare.pub. Each release is tagged `vYYYY.MM.DD.N` and deployed to production when its release PR merges.

## v2026.10.20.1 - 2026-10-20

### Features

- resolve a parallel citation through its partner

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

