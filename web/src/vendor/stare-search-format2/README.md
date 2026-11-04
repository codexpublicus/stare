# stare-builder's search client for search format 2, vendored

`search.mjs` and `tokenize.mjs` are byte-for-byte copies of
`pipelines/search-index/client/search.mjs` and `tokenize.mjs` in codexpublicus/stare-builder
at the commit `../search-client.json` names under `stare-search-format2` (d419b9e,
stare-builder#85), with each file's SHA-256. It is the reference query for a search tree
in format 2, and opens no other format. The live tree for index build v2026.10.26.2 is in
format 2, so the search page keeps this copy beside format 3's (`../stare-search/`) and
loads whichever the tree's manifest names (`metadata.search.format_version`). Once no
published tree the site reads is in format 2, this directory, its pin and its fixture
(`web/tests/fixtures/search-tree/`) go.

Don't edit these. The build bundles them with `../roaringbuckets-client/` into their own
module (`src/lib/searchvendor.js`) and fails if a copy differs from its pin;
`web/tests/searchclient.test.js` checks they still rank the format-2 fixture tree as
stare-builder's own client did at d419b9e.
