// The search client bundle's entry (searchvendor.js): the reference client's own exports,
// unchanged, and roaringbuckets' decodeRoaring for the page's year ranges
// (public/js/searchquery.js, rangeDataset).
export * from '../vendor/stare-search/search.mjs';
export { decodeRoaring } from '@roaringbuckets/client';
