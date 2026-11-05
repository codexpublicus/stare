// Where the search page loads a search client from: the index builder's reference client for one
// search format and the RoaringBuckets JS client, bundled into one module per format by the
// `stare-search-client` hook in astro.config.mjs (src/lib/searchvendor.js). Each directory is
// named for its two pinned commits in src/vendor/search-client.json, so a URL never changes
// content and _headers serves it immutable; web/tests/searchclient.test.js fails if the names
// and the pins differ. The page reads the tree's manifest first and loads the client for its
// `metadata.search.format_version`.
export const SEARCH_CLIENT_DIRS = {
  2: 'vendor/stare-search-d419b9e-rbd2d393e',
  3: 'vendor/stare-search-6098a43-rbd2d393e',
};

/** The client module for a search format, or null for a format this site has no client for. */
export function searchClientUrl(formatVersion) {
  const dir = Object.hasOwn(SEARCH_CLIENT_DIRS, formatVersion) ? SEARCH_CLIENT_DIRS[formatVersion] : null;
  return dir ? `/${dir}/search.js` : null;
}
