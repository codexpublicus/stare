// Where the search page loads the search client from: stare-builder's reference client and
// roaringbuckets' JS client, bundled into one module by the `stare-search-client` hook in
// astro.config.mjs (src/lib/searchvendor.js). The directory is named for the two pinned
// commits in src/vendor/search-client.json, so a URL never changes content and _headers
// serves it immutable; web/tests/searchclient.test.js fails if the name and the pins differ.
export const SEARCH_CLIENT_DIR = 'vendor/stare-search-049b435-rb075b4fd';
export const SEARCH_CLIENT_URL = `/${SEARCH_CLIENT_DIR}/search.js`;
