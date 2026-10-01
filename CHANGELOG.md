# Changelog

Site releases of stare.pub. Each release is tagged `vYYYY.MM.DD.N` and deployed to production when its release PR merges.

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

