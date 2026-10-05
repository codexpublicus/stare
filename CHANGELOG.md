# Changelog

Site releases of stare.pub. Each release is tagged `vYYYY.MM.DD.N` and deployed to production when its release PR merges.

## v2026.10.05.1 - 2026-10-05

### Features

- fetch case zips from data.stare.pub
- web: /about rewrite, /updates and feed, no GitHub links, CalVer footer
- cite: bump citare to v0.4.0
- link out for missing cases and statutes
- versioned index layout
- web: self-host subset web fonts
- index build reports and /data page
- web: load the WASM in the background

### Fixes

- web: link only into this repo from the /about changelog
- cite: link spaced U.S.C. and C.F.R. forms
- cite: bump citare to v0.4.1
- web: take the collection figures from one data file
- index: string volume keys for split volumes
- index: index every case, fail short volumes

### Performance

- wasm: shrink the stare-wasm module

### Dependencies

- deps: bump citare to v0.5.0

