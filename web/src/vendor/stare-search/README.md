# The index builder's search client for search format 3, vendored

`search.mjs` and `tokenize.mjs` are byte-for-byte copies of
`pipelines/search-index/client/search.mjs` and `tokenize.mjs` in the index builder
at the commit `../search-client.json` names under `stare-search` (6098a43, the change
that ranks by citation counts), with each file's SHA-256. `search.mjs` is the reference
query for the search tree in format 3 (the index builder's search-index spec): the tokens,
the rank tiers, the low-tier reads and their caps, and the scoring, the party-name rule
included. It opens a format-3 tree and refuses any other. The search page ranks with it
unchanged, so don't edit these: change the index builder, then copy them in again at the new
commit (`src/lib/searchvendor.js` says what else moves with the pin).

`search.mjs` imports `@roaringbuckets/client`, the copy in `../roaringbuckets-client/`. The
build bundles the two into one module (`src/lib/searchvendor.js`, the `stare-search-client`
hook in `astro.config.mjs`) and fails if either copy differs from its pin;
`web/tests/searchclient.test.js` does the same, and checks the copies rank the format-3
fixture tree as the index builder's own client did. `../stare-search-format2/` holds the client
for format 2 trees; `searchvendor.js` and `web/tests/searchclient.test.js` cover both.
