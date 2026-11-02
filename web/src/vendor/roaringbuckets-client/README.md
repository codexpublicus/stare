# roaringbuckets' JS client, vendored

The `.js` files are byte-for-byte copies of `packages/client/src/` in lokkju/roaringbuckets
at the commit `../search-client.json` names (main at d2d393e: v0.3.0, the version
stare-builder's search build pins in `pipelines/search-index/uv.lock`, plus #61, which
aborts a ranged read a server answers with the whole file; no release has it yet), and
`LICENSE` is that repository's licence, PolyForm Shield 1.0.0. stare-builder's reference
query (`../stare-search/`) reads the search tree with it. Don't edit them; copy them in
again at a new pin.
