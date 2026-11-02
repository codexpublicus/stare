# stare-builder's search client, vendored

`search.mjs` and `tokenize.mjs` are byte-for-byte copies of
`pipelines/search-index/client/search.mjs` and `tokenize.mjs` in codexpublicus/stare-builder
at the commit `../search-client.json` names, with each file's SHA-256. `search.mjs` is the
reference query for the search tree (stare-builder's `docs/search-index.md`): the tokens,
the rank tiers, the low-tier reads and their caps, and the scoring. The search page ranks
with it unchanged, so don't edit these: change stare-builder, then copy them in again at
the new commit (`src/lib/searchvendor.js` says what else moves with the pin).

`search.mjs` imports `@roaringbuckets/client`, the copy in `../roaringbuckets-client/`. The
build bundles the two into one module (`src/lib/searchvendor.js`, the `stare-search-client`
hook in `astro.config.mjs`) and fails if either copy differs from its pin;
`web/tests/searchclient.test.js` does the same, and checks the copies rank the fixture tree
as stare-builder's own client did.
